import type { EffectContract, EvidenceState, ObservationResult, ReasonCode, ReconciliationResult } from "./types";

/**
 * Defines an effect contract with the observation and evidence types inferred from your
 * observe() and execute() — only the intent type needs to be named. Purely a typing aid: it
 * returns the contract unchanged.
 *
 *   const refund = defineContract<RefundIntent>()({ operationType: "payments/refund", ... });
 */
export function defineContract<Intent>() {
  return <Observation, Evidence>(contract: EffectContract<Intent, Observation, Evidence>) => contract;
}

/**
 * Builds an `observed` result for observe(). `authoritative` is deliberately required: say
 * whether this read can prove what happened (a lookup by your own id) or not (a search, a
 * lagging replica), so reconcile() can map a weak "not found" to UNKNOWN.
 */
export function observed<Observation>(
  data: Observation,
  options: { source: string; authoritative: boolean; observedAt?: string }
): Extract<ObservationResult<Observation>, { status: "observed" }> {
  return {
    status: "observed",
    data,
    authoritative: options.authoritative,
    source: options.source,
    observedAt: options.observedAt ?? new Date().toISOString()
  };
}

/** Builds reconcile()'s answer: an evidence state and the reason for it. */
export function reconciled(
  evidenceState: EvidenceState,
  code: string,
  summary: string,
  metadata?: ReasonCode["metadata"]
): ReconciliationResult {
  return { evidenceState, reason: metadata ? { code, summary, metadata } : { code, summary } };
}
