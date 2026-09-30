// The README's quickstart is the region below, verbatim (tests/quickstart.test.ts checks this).
// Run it: npm run quickstart
import { createPaymentsApi } from "./payments-api";

const payments = createPaymentsApi(); // your real API client goes here

// #region readme
import { runEffect, InMemoryStore, defineContract, observed, reconciled } from "corrobo";

const refundOrder = defineContract<{ orderId: string; amountCents: number }>()({
  operationType: "payments/refund",
  retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
  maxInFlightMs: 10_000, // your request timeout + how long the API may take to apply a request

  // 1. Make the write. Send the operation id so the API can be asked about it afterwards.
  execute: ({ intent, identity }) => payments.createRefund({ ...intent, reference: identity.id }),

  // 2. Ask the API what is actually true. Never infer it from execute()'s outcome.
  observe: async ({ identity }) =>
    observed((await payments.findRefunds(identity.id)).length, { source: "payments.findRefunds", authoritative: true }),

  // 3. Compare what you intended with what you observed.
  reconcile: ({ observation }) => {
    if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "Could not read refunds.");
    const found = observation.data;
    if (found === 0) return reconciled("NOT_APPLIED", "NO_REFUND", "No refund exists.");
    if (found === 1) return reconciled("APPLIED", "REFUNDED", "Exactly one refund exists.");
    return reconciled("CONFLICTED", "DUPLICATES", `${found} refunds exist.`);
  }
});

async function main() {
  payments.loseNextResponse(); // the refund goes through, but the response is lost

  const result = await runEffect(new InMemoryStore(), refundOrder, {
    identity: "refund-order-1001",
    intent: { orderId: "1001", amountCents: 5_000 }
  });

  console.log(result.evidenceState, result.disposition); // APPLIED COMPLETE
  console.log("refunds made:", payments.refundCount()); // refunds made: 1
}
// #endregion

main();
