// The README's quickstart is the region below, verbatim (tests/quickstart.test.ts checks this).
// Run it: npm run quickstart
import { createPaymentsApi } from "./payments-api";

const payments = createPaymentsApi(); // your real API client goes here

// #region readme
import { runEffect, InMemoryStore, type EffectContract } from "corrobo";

type RefundIntent = { orderId: string; amountCents: number };

const refundOrder: EffectContract<RefundIntent, { found: number }, unknown> = {
  operationType: "payments/refund",
  capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
  retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
  maxInFlightMs: 10_000, // your request timeout + how long the API may take to apply a request

  // 1. Make the write. Send the operation id so the API can be asked about it afterwards.
  execute: ({ intent, identity }) => payments.createRefund({ ...intent, reference: identity.id }),

  // 2. Ask the API what is actually true. Never infer it from execute()'s outcome.
  observe: async ({ identity }) => ({
    status: "observed",
    data: { found: (await payments.findRefunds(identity.id)).length },
    authoritative: true,
    source: "payments.findRefunds",
    observedAt: new Date().toISOString()
  }),

  // 3. Compare what you intended with what you observed.
  reconcile: ({ observation }) => {
    if (observation.status !== "observed") {
      return { evidenceState: "UNKNOWN", reason: { code: "NO_READ", summary: "Could not read refunds." } };
    }
    return observation.data.found === 0
      ? { evidenceState: "NOT_APPLIED", reason: { code: "NO_REFUND", summary: "No refund exists." } }
      : observation.data.found === 1
        ? { evidenceState: "APPLIED", reason: { code: "REFUNDED", summary: "Exactly one refund exists." } }
        : { evidenceState: "CONFLICTED", reason: { code: "DUPLICATES", summary: "More than one refund exists." } };
  }
};

async function main() {
  payments.loseNextResponse(); // the refund goes through, but the response is lost

  const result = await runEffect(new InMemoryStore(), refundOrder, {
    identity: { id: "refund-order-1001", operationType: refundOrder.operationType },
    intent: { orderId: "1001", amountCents: 5_000 }
  });

  console.log(result.evidenceState, result.disposition); // APPLIED COMPLETE
  console.log("refunds made:", payments.refundCount()); // refunds made: 1
}
// #endregion

main();
