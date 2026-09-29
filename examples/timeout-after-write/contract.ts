import type { EffectContract } from "../../src/core/types";
import type { Credit } from "./ledger-server";

/**
 * Issuing an account credit through the demo ledger, as a corrobo Effect Contract.
 *
 * The one design decision that makes it work: the corrobo operation identity is sent as the
 * credit's `reference`, so afterwards the ledger itself can be asked "does a credit for this
 * operation exist?" — an authoritative answer that doesn't depend on the lost response.
 */

export interface CreditIntent {
  accountId: string;
  amountCents: number;
}

export interface CreditObservation {
  credits: Credit[];
}

/** Client-side bound on one POST. A request that hits it is abandoned, not undone. */
export const REQUEST_TIMEOUT_MS = 1_000;
/** The demo ledger commits synchronously on receipt; a real API needs a real, measured bound. */
const LEDGER_APPLY_BOUND_MS = 50;

export function createIssueCreditContract(
  baseUrl: string,
  options: { requestTimeoutMs?: number } = {}
): EffectContract<CreditIntent, CreditObservation, Credit> {
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    operationType: "ledger/issue-credit",
    capabilities: {
      nativeIdempotency: false, // the ledger happily creates two credits for two identical POSTs
      callerGeneratedIdentity: true, // ...but it stores our reference and can be queried by it
      optimisticConcurrency: false,
      convergence: false
    },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    // A POST that failed could still be applied until it times out and the ledger has finished
    // applying what it received. Until then, "no credit yet" is not proof there won't be one.
    maxInFlightMs: requestTimeoutMs + LEDGER_APPLY_BOUND_MS,

    async execute({ intent, identity }) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/credits`, {
          method: "POST",
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...intent, reference: identity.id })
        });
      } catch (err) {
        throw new Error(describeFetchError(err)); // corrobo records this as transport evidence only
      }
      if (res.status !== 201) {
        throw new Error(`ledger answered HTTP ${res.status}`);
      }
      return (await res.json()) as Credit;
    },

    // Never trusts execute()'s result: asks the ledger directly, by our own reference.
    async observe({ identity }) {
      const res = await fetch(`${baseUrl}/credits?reference=${encodeURIComponent(identity.id)}`);
      if (!res.ok) {
        throw new Error(`ledger read failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as CreditObservation;
      return { status: "observed", data: body, authoritative: true, source: "ledger GET /credits?reference", observedAt: new Date().toISOString() };
    },

    reconcile({ intent, observation }) {
      if (observation.status !== "observed") {
        return {
          evidenceState: "UNKNOWN",
          reason: { code: "LEDGER_UNREADABLE", summary: "Could not read the ledger, so whether the credit exists is unknown." }
        };
      }
      const found = observation.data!.credits;
      if (found.length === 0) {
        return { evidenceState: "NOT_APPLIED", reason: { code: "NO_CREDIT", summary: "The ledger has no credit for this operation." } };
      }
      if (found.length > 1 || found[0].amountCents !== intent.amountCents || found[0].accountId !== intent.accountId) {
        return {
          evidenceState: "CONFLICTED",
          reason: {
            code: "LEDGER_DISAGREES",
            summary: "The ledger holds credits for this operation that don't match exactly one intended credit.",
            metadata: { creditIds: found.map((c) => c.id) }
          }
        };
      }
      return {
        evidenceState: "APPLIED",
        reason: { code: "CREDIT_FOUND", summary: `The ledger holds exactly the intended credit (${found[0].id}).` },
        observedEffect: found[0]
      };
    }
  };
}

/**
 * The code this demo is arguing against: the common catch-and-retry loop. Nothing is wrong with
 * it syntactically — it even sends a reference — but it treats "no response" as "didn't happen".
 */
export async function naiveIssueCredit(
  baseUrl: string,
  intent: CreditIntent,
  reference: string,
  maxAttempts = 3
): Promise<{ attempts: number; errors: string[] }> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/credits`, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...intent, reference })
      });
      if (res.status === 201) return { attempts: attempt, errors };
      errors.push(`HTTP ${res.status}`);
    } catch (err) {
      errors.push(describeFetchError(err));
    }
  }
  return { attempts: maxAttempts, errors };
}

/** fetch() reports every network failure as "fetch failed"; surface the underlying reason. */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : err.message;
  }
  return String(err);
}
