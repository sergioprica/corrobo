import type { EffectContract } from "../../src/core/types";
import { FaultSchedule, withFaultInjection, withObservationFault } from "../../src/testing/faults";

/**
 * ONE generic, understandable example: cancelling an order via a plain HTTP mutation.
 * No claims/insurance framing, no vendor SDK — this is what wrapping "an existing HTTP
 * mutation you don't fully trust" with corrobo looks like.
 */

export interface CancelOrderIntent {
  orderId: string;
  expectedVersion: number;
  convergeAsync?: boolean;
}

export interface CancelTransportEvidence {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface OrderObservation {
  id: string;
  status: "open" | "cancelling" | "cancelled";
  version: number;
}

/** Client-side bound on one cancel request. A request that times out is abandoned, not undone. */
const REQUEST_TIMEOUT_MS = 200;
/**
 * How long this example server can take to apply a request it has already received (it applies
 * synchronously on receipt). A real API needs a real number here — ask the provider or measure it.
 */
const SERVER_APPLY_BOUND_MS = 50;

async function callCancel(baseUrl: string, intent: CancelOrderIntent): Promise<CancelTransportEvidence> {
  const res = await fetch(`${baseUrl}/orders/${intent.orderId}/cancel`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: intent.expectedVersion, convergeAsync: intent.convergeAsync ?? false })
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { httpStatus: res.status, body };
}

async function getOrder(baseUrl: string, orderId: string): Promise<OrderObservation | null> {
  const res = await fetch(`${baseUrl}/orders/${orderId}`);
  if (res.status === 404) return null;
  return (await res.json()) as OrderObservation;
}

export function createCancelOrderContract(options: {
  baseUrl: string;
  faultSchedule: FaultSchedule;
}): EffectContract<CancelOrderIntent, OrderObservation | { notFound: true }, CancelTransportEvidence> {
  const { baseUrl, faultSchedule } = options;
  let lastAttemptNumber = 0;

  return {
    operationType: "generic-rest/cancel-order",
    capabilities: {
      nativeIdempotency: false,
      callerGeneratedIdentity: true,
      optimisticConcurrency: true,
      convergence: true
    },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    // A cancel that failed at the transport level could still be applied until its request
    // times out and the server has had time to finish applying anything it already received.
    // Until then, "not cancelled yet" is not proof it never will be, so a retry waits.
    maxInFlightMs: REQUEST_TIMEOUT_MS + SERVER_APPLY_BOUND_MS,

    async execute({ intent, attemptNumber }) {
      lastAttemptNumber = attemptNumber;
      const call = withFaultInjection(() => callCancel(baseUrl, intent), faultSchedule, attemptNumber);
      return await call();
    },

    async observe({ intent }) {
      const fetchOrder = withObservationFault(() => getOrder(baseUrl, intent.orderId), faultSchedule, lastAttemptNumber);
      const data = await fetchOrder();
      const observedAt = new Date().toISOString();

      if (!data) {
        return { status: "observed", data: { notFound: true }, authoritative: true, source: "orders-api:get", observedAt };
      }
      if (data.status === "cancelling") {
        return { status: "pending", authoritative: true, source: "orders-api:get", observedAt, data };
      }
      return { status: "observed", data, authoritative: true, source: "orders-api:get", observedAt };
    },

    reconcile({ transport, observation }) {
      if (observation.status === "observation_failed") {
        return {
          evidenceState: "UNKNOWN",
          reason: {
            code: "READBACK_UNAVAILABLE",
            summary: "Authoritative read-back failed after a mutation attempt with possible side effects.",
            metadata: { error: observation.error.message }
          }
        };
      }

      if (observation.status === "pending") {
        return {
          evidenceState: "PENDING",
          reason: {
            code: "AWAITING_CONVERGENCE",
            summary: "The order is cancelling but has not yet converged to a terminal state."
          },
          observedEffect: observation.data
        };
      }

      const data = observation.data as OrderObservation | { notFound: true };

      if (transport.ok && transport.evidence.httpStatus === 409) {
        return {
          evidenceState: "CONFLICTED",
          reason: {
            code: "VERSION_CONFLICT",
            summary: "Authoritative version diverged from what the plan assumed.",
            metadata: { currentVersion: transport.evidence.body.currentVersion }
          },
          observedEffect: data
        };
      }

      if ("notFound" in data) {
        return {
          evidenceState: "UNKNOWN",
          reason: { code: "OBSERVED_RESOURCE_MISSING", summary: "Read-back could not find the order at all." }
        };
      }

      if (data.status === "cancelled") {
        return {
          evidenceState: "APPLIED",
          reason: { code: "EFFECT_CONFIRMED", summary: "Read-back confirms the order is cancelled." },
          observedEffect: data
        };
      }

      return {
        evidenceState: "NOT_APPLIED",
        reason: { code: "EFFECT_ABSENT", summary: "Read-back confirms the order is still open." },
        observedEffect: data
      };
    }
  };
}
