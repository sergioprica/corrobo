import type { EvidenceState, ReasonCode, RecoveryDisposition, RetryPolicy } from "./types";

/**
 * What decideDisposition needs to know to tell a settled NOT_APPLIED (safe to retry now) from
 * one observed while the failed attempt could still land (see EffectContract.maxInFlightMs).
 */
export interface SettlementInput {
  /** true when execute() returned a response — the request is no longer in flight. */
  transportOk: boolean;
  /** ISO time the attempt was reserved, before execute() was called. */
  attemptStartedAt: string;
  /** ISO time of the decision (the observation it is based on was just made). Passed in so this stays pure. */
  now: string;
  maxInFlightMs?: number;
}

export interface DecideDispositionInput {
  evidenceState: EvidenceState;
  attemptNumber: number;
  retryPolicy: RetryPolicy;
  settlement: SettlementInput;
}

export interface DecideDispositionResult {
  disposition: RecoveryDisposition | null;
  reason: ReasonCode;
  /** Set only with RETRY when the retry must wait for the in-flight window to pass. */
  retryNotBefore?: string;
}

function reason(code: string, summary: string, metadata?: Record<string, unknown>): ReasonCode {
  return metadata ? { code, summary, metadata } : { code, summary };
}

/**
 * Pure, deterministic mapping from evidence state to recovery disposition.
 * This is the ONLY place that mapping happens — no other code should infer
 * a disposition from evidence state directly.
 */
export function decideDisposition(input: DecideDispositionInput): DecideDispositionResult {
  const { evidenceState, attemptNumber, retryPolicy, settlement } = input;

  switch (evidenceState) {
    case "APPLIED":
      return {
        disposition: "COMPLETE",
        reason: reason("EFFECT_CONFIRMED", "Authoritative observation confirms the intended effect.")
      };

    case "CONFLICTED":
      return {
        disposition: "REPLAN",
        reason: reason(
          "STATE_CONFLICT",
          "Authoritative state diverged from what the plan assumed; a new plan is required, not a retry of this operation."
        )
      };

    case "UNKNOWN":
      return {
        disposition: "INVESTIGATE",
        reason: reason(
          "EVIDENCE_INSUFFICIENT",
          "Available evidence cannot establish whether the effect occurred. Retrying blindly would risk a duplicate."
        )
      };

    case "PENDING":
      return {
        disposition: null,
        reason: reason(
          "AWAITING_CONVERGENCE",
          "The effect is acknowledged but not yet confirmed. Re-observe later; do not retry or treat as failure."
        )
      };

    case "NOT_APPLIED": {
      const retryable = retryPolicy.retryOnNotApplied;
      const hasAttemptsRemaining = attemptNumber < retryPolicy.maxAttempts;
      if (retryable && hasAttemptsRemaining) {
        return decideRetry(settlement);
      }
      return {
        disposition: "INVESTIGATE",
        reason: reason(
          "RETRY_NOT_SAFE_OR_EXHAUSTED",
          "The effect did not occur, but retry is exhausted or not permitted for this operation type.",
          { attemptNumber, maxAttempts: retryPolicy.maxAttempts, retryable }
        )
      };
    }
  }
}

/**
 * NOT_APPLIED with retry permitted. A response from execute() means the request is finished,
 * so the observation is final. A transport failure (or an attempt whose outcome was never
 * recorded) means the request may still be in flight: the "not applied" observation is only
 * final once the contract's maxInFlightMs window has passed — and without a declared window,
 * never, so it becomes INVESTIGATE rather than a retry that could duplicate a late landing.
 */
function decideRetry(settlement: SettlementInput): DecideDispositionResult {
  const safeRetry: DecideDispositionResult = {
    disposition: "RETRY",
    reason: reason("SAFE_RETRY", "Evidence shows the effect did not occur and this operation type is safe to retry.")
  };
  if (settlement.transportOk) {
    return safeRetry;
  }
  if (settlement.maxInFlightMs === undefined) {
    return {
      disposition: "INVESTIGATE",
      reason: reason(
        "IN_FLIGHT_NOT_RULED_OUT",
        "The effect was not observed, but execute() failed at the transport level and this contract declares no " +
          "maxInFlightMs, so a late landing of that request cannot be ruled out. Retrying could duplicate it."
      )
    };
  }
  const settleAtMs = Date.parse(settlement.attemptStartedAt) + settlement.maxInFlightMs;
  if (Date.parse(settlement.now) >= settleAtMs) {
    return safeRetry;
  }
  const retryNotBefore = new Date(settleAtMs).toISOString();
  return {
    disposition: "RETRY",
    reason: reason(
      "SAFE_RETRY_AFTER_SETTLEMENT",
      "The effect was not observed, but the failed request could still land until retryNotBefore. " +
        "Call again after that time; the effect is re-observed before any new attempt.",
      { retryNotBefore, maxInFlightMs: settlement.maxInFlightMs }
    ),
    retryNotBefore
  };
}
