import type { EffectContract, ObservationResult } from "../../src/core/types";
import { isConflictCode, isDefiniteRejection } from "./types";
import type { RefundIntent, RefundLike, StripeClientLike } from "./types";

/**
 * The flagship example: refunding a charge. Nothing here is bespoke to corrobo's testing
 * machinery — this contract would work identically against the real `stripe` package
 * (see live-smoke.ts), because it only depends on the minimal StripeClientLike shape.
 */

export type RefundTransportEvidence =
  | { kind: "responded"; refundId: string; status: RefundLike["status"] }
  | { kind: "rejected"; code?: string; message: string };

export type RefundObservationData =
  | { exists: true; refundId: string; status: RefundLike["status"]; amount: number }
  | { exists: false; rejectionCode?: string; rejectionMessage?: string };

/**
 * The Corrobo operation identity IS the logical refund. The Stripe Idempotency-Key is
 * derived deterministically from it, so every attempt of the SAME logical refund reuses
 * the SAME key (Stripe will never create a second refund for it), while a genuinely new
 * logical refund requires a new identity — and therefore a new key — by construction.
 */
export function idempotencyKeyFor(operationId: string): string {
  return `refund:${operationId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Stripe retains an idempotency key for at least 24 hours. Past that window a replayed
 * create-refund call is no longer guaranteed to return the cached prior result — it can
 * create a genuine second refund. This default (22h) is a conservative margin under Stripe's
 * documented guarantee, not the guarantee itself.
 */
export const DEFAULT_IDEMPOTENCY_REPLAY_SAFE_WINDOW_MS = 22 * 60 * 60 * 1000;

export function createRefundContract(options: {
  client: StripeClientLike;
  /** Refunds at or above this amount require human authorization before execute() is attempted. */
  reviewThresholdCents?: number;
  /**
   * How long after an attempt started it's still safe to replay create-refund (with the same
   * idempotency key) as an observation strategy. Overridable only so tests can model the
   * expiry deterministically without a real 24h wait — real callers should rely on the default.
   */
  idempotencyReplaySafeWindowMs?: number;
}): EffectContract<RefundIntent, RefundObservationData, RefundTransportEvidence> {
  const reviewThresholdCents = options.reviewThresholdCents ?? Number.POSITIVE_INFINITY;
  const replaySafeWindowMs = options.idempotencyReplaySafeWindowMs ?? DEFAULT_IDEMPOTENCY_REPLAY_SAFE_WINDOW_MS;

  return {
    operationType: "stripe/refund",
    capabilities: {
      nativeIdempotency: true,
      callerGeneratedIdentity: true,
      optimisticConcurrency: false,
      convergence: true
    },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    // Every attempt sends the same Idempotency-Key (derived from the operation identity), so if a
    // failed request lands late, a retry is deduplicated by Stripe instead of refunding twice.
    // That is what makes 0 honest here. (Past Stripe's ~24h key retention it would not be.)
    maxInFlightMs: 0,

    authorize(intent) {
      if (intent.amountCents >= reviewThresholdCents) {
        return {
          requiresReview: true,
          reason: {
            code: "REFUND_ABOVE_THRESHOLD",
            summary: "This refund amount exceeds the autonomous threshold and requires human sign-off.",
            metadata: { amountCents: intent.amountCents, thresholdCents: reviewThresholdCents }
          }
        };
      }
      return { requiresReview: false };
    },

    async execute({ intent, identity }) {
      const idempotencyKey = idempotencyKeyFor(identity.id);
      try {
        const refund = await options.client.refunds.create(
          { charge: intent.chargeId, amount: intent.amountCents, reason: intent.reason },
          { idempotencyKey }
        );
        return { kind: "responded", refundId: refund.id, status: refund.status };
      } catch (err) {
        if (isDefiniteRejection(err)) {
          return { kind: "rejected", code: err.code, message: err.message };
        }
        throw err; // ambiguous (network/timeout/5xx) — the runtime captures this as transport.ok === false
      }
    },

    async observe({ intent, identity, transport, attemptStartedAt }) {
      const idempotencyKey = idempotencyKeyFor(identity.id);

      // Strongest available evidence: we have a stable refund id, so look it up directly.
      // Always preferred over replay, and never subject to the replay-window check below,
      // since a direct retrieve-by-id carries no idempotency-key expiry risk at all.
      if (transport.ok && transport.evidence.kind === "responded") {
        const refund = await options.client.refunds.retrieve(transport.evidence.refundId);
        return observationFromRefund(refund);
      }

      // No stable refund id yet — either execute() threw, or Stripe told us synchronously
      // nothing was created. The strongest evidence available now is Stripe's own idempotency
      // semantics: replaying the SAME key either returns the definitive prior outcome or, if
      // nothing was ever recorded, performs the (still-idempotent) creation for real. But that
      // is only safe within Stripe's idempotency-key retention window — past it, a replay is
      // just a new request and could create a genuine second refund, which would be exactly
      // the failure this project exists to prevent. Refuse it once we can't safely assume the
      // window still holds, and report the truth: we don't know what happened.
      const elapsedMs = Date.now() - new Date(attemptStartedAt).getTime();
      if (elapsedMs > replaySafeWindowMs) {
        return {
          status: "observation_failed",
          error: {
            message:
              `Stripe's idempotency key can no longer be safely assumed to resolve to the original ` +
              `request (~${Math.round(elapsedMs / 3_600_000)}h since the attempt started). Refusing ` +
              `to replay create-refund, since that could create a second refund. A human should check ` +
              `Stripe directly for charge ${intent.chargeId} before deciding what to do next.`
          },
          source: "stripe:idempotency-window-expired",
          observedAt: nowIso()
        };
      }

      try {
        const refund = await options.client.refunds.create(
          { charge: intent.chargeId, amount: intent.amountCents, reason: intent.reason },
          { idempotencyKey }
        );
        return observationFromRefund(refund);
      } catch (err) {
        if (isDefiniteRejection(err)) {
          return {
            status: "observed",
            data: { exists: false, rejectionCode: err.code, rejectionMessage: err.message },
            authoritative: true,
            source: "stripe:refunds.create-replay",
            observedAt: nowIso()
          };
        }
        throw err; // genuinely can't establish the truth — safeObserve turns this into observation_failed
      }
    },

    reconcile({ observation }) {
      if (observation.status === "observation_failed") {
        return {
          evidenceState: "UNKNOWN",
          reason: {
            code: "READBACK_UNAVAILABLE",
            summary: "Neither a direct lookup nor an idempotency-key replay could establish whether the refund exists.",
            metadata: { error: observation.error.message }
          }
        };
      }

      if (observation.status === "pending") {
        return {
          evidenceState: "PENDING",
          reason: {
            code: "AWAITING_CONVERGENCE",
            summary: "Stripe has acknowledged the refund but it has not yet reached a terminal status."
          },
          observedEffect: observation.data
        };
      }

      const data = observation.data;

      if (!data.exists) {
        if (isConflictCode(data.rejectionCode)) {
          return {
            evidenceState: "CONFLICTED",
            reason: {
              code: "REFUND_PRECONDITION_CONFLICT",
              summary: "The charge's refundable state no longer matches what the plan assumed.",
              metadata: { stripeCode: data.rejectionCode }
            }
          };
        }
        return {
          evidenceState: "NOT_APPLIED",
          reason: {
            code: "REFUND_NOT_CREATED",
            summary: "Stripe confirms no refund exists for this operation.",
            metadata: { stripeCode: data.rejectionCode }
          }
        };
      }

      if (data.status === "succeeded") {
        return {
          evidenceState: "APPLIED",
          reason: { code: "REFUND_CONFIRMED", summary: "Stripe confirms the refund succeeded." },
          observedEffect: data
        };
      }

      // status is "failed" or "canceled": a refund object exists, but the business effect
      // (funds returned) did not happen, and Stripe will not retry the underlying bank transfer
      // on a replayed key. Modeled honestly as NOT_APPLIED; once this operation's retries are
      // exhausted, the resulting INVESTIGATE correctly signals that a NEW logical refund (a new
      // operation identity, not a retry of this one) is what a human should consider next.
      return {
        evidenceState: "NOT_APPLIED",
        reason: {
          code: "REFUND_TERMINALLY_FAILED",
          summary: "A refund attempt exists but did not succeed, and Stripe will not retry it under the same key.",
          metadata: { stripeStatus: data.status }
        },
        observedEffect: data
      };
    }
  };
}

function observationFromRefund(refund: RefundLike): ObservationResult<RefundObservationData> {
  const observedAt = nowIso();
  if (refund.status === "pending" || refund.status === "requires_action") {
    return {
      status: "pending",
      authoritative: true,
      source: "stripe:refunds",
      observedAt,
      data: { exists: true, refundId: refund.id, status: refund.status, amount: refund.amount }
    };
  }
  return {
    status: "observed",
    data: { exists: true, refundId: refund.id, status: refund.status, amount: refund.amount },
    authoritative: true,
    source: "stripe:refunds",
    observedAt
  };
}
