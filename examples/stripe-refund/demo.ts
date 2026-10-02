import { InMemoryStore, runEffect } from "../../src/core";
import { createRefundContract } from "./contract";
import { FakeStripeClient } from "./fake-stripe-client";

function log(label: string, result: unknown): void {
  console.log(`\n-- ${label} --`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const store = new InMemoryStore();
  const client = new FakeStripeClient();
  const contract = createRefundContract({ client, reviewThresholdCents: 1_000_000 });

  // 1. Normal success.
  client.seedCharge("ch_1", 5000);
  const r1 = await runEffect(store, contract, {
    identity: { id: "refund-1", operationType: contract.operationType },
    intent: { chargeId: "ch_1", amountCents: 5000 }
  });
  log("normal success -> APPLIED / COMPLETE", { evidenceState: r1.evidenceState, disposition: r1.disposition });

  // 2. Timeout BEFORE Stripe ever processes the request. Unlike a plain REST API with no
  //    native idempotency, this self-heals in a SINGLE run() call: observe()'s idempotency-key
  //    replay both discovers nothing was created yet and safely creates it, atomically from
  //    the caller's point of view.
  client.seedCharge("ch_2", 5000);
  client.scheduleFault("ch_2", { createFailures: 1, mode: "beforeCommit" });
  const identity2 = { id: "refund-2", operationType: contract.operationType };
  const intent2 = { chargeId: "ch_2", amountCents: 5000 };
  const r2a = await runEffect(store, contract, { identity: identity2, intent: intent2 });
  log("timeout before Stripe saw the request -> resolved in one call via idempotency replay", {
    evidenceState: r2a.evidenceState,
    disposition: r2a.disposition
  });
  console.log(`exactly ${client.createdRefundCount} refund(s) created so far (expect 2: ch_1, ch_2)`);

  // 3. HEADLINE: timeout AFTER Stripe committed the refund. The response is lost, but the
  //    refund genuinely exists. Corrobo must not create a duplicate.
  client.seedCharge("ch_3", 5000);
  client.scheduleFault("ch_3", { createFailures: 1, mode: "afterCommit" });
  const identity3 = { id: "refund-3", operationType: contract.operationType };
  const intent3 = { chargeId: "ch_3", amountCents: 5000 };
  const r3a = await runEffect(store, contract, { identity: identity3, intent: intent3 });
  log("timeout after write -> APPLIED / COMPLETE despite the throw", { evidenceState: r3a.evidenceState, disposition: r3a.disposition });
  const r3b = await runEffect(store, contract, { identity: identity3, intent: intent3 });
  log("calling run() again with the same identity -> cached, no re-execution", {
    evidenceState: r3b.evidenceState,
    disposition: r3b.disposition,
    attemptsRecorded: r3b.attempts.length
  });
  console.log(`Stripe (fake) genuinely created ${client.createdRefundCount} refund(s) total so far (expect 3: ch_1, ch_2, ch_3)`);

  // 4. Conflict: the charge was already fully refunded by something else.
  client.seedCharge("ch_4", 5000, { alreadyRefunded: true });
  const r4 = await runEffect(store, contract, {
    identity: { id: "refund-4", operationType: contract.operationType },
    intent: { chargeId: "ch_4", amountCents: 5000 }
  });
  log("charge already refunded -> CONFLICTED / REPLAN", { evidenceState: r4.evidenceState, disposition: r4.disposition, reason: r4.evidenceReason });

  // 5. Asynchronous convergence (e.g. a bank-debit-funded refund): PENDING, then resolves later
  //    with no second refund created.
  client.seedCharge("ch_5", 5000, { convergeAsync: true });
  const identity5 = { id: "refund-5", operationType: contract.operationType };
  const intent5 = { chargeId: "ch_5", amountCents: 5000 };
  const r5a = await runEffect(store, contract, { identity: identity5, intent: intent5 });
  log("async convergence, first observe -> PENDING / no disposition", { evidenceState: r5a.evidenceState, disposition: r5a.disposition });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const r5b = await runEffect(store, contract, { identity: identity5, intent: intent5 });
  log("caller re-observes later -> APPLIED / COMPLETE, still one refund", {
    evidenceState: r5b.evidenceState,
    disposition: r5b.disposition,
    attemptsRecorded: r5b.attempts.length
  });

  // 6. Ambiguous: both the create call and the idempotency-replay observation fail.
  client.seedCharge("ch_6", 5000);
  client.scheduleFault("ch_6", { createFailures: 2, mode: "beforeCommit" });
  const r6 = await runEffect(store, contract, {
    identity: { id: "refund-6", operationType: contract.operationType },
    intent: { chargeId: "ch_6", amountCents: 5000 }
  });
  log("execute AND the idempotency-replay observation both fail -> UNKNOWN / INVESTIGATE", {
    evidenceState: r6.evidenceState,
    disposition: r6.disposition
  });

  // 7. High-value refund requires human review before Stripe is ever called.
  client.seedCharge("ch_7", 2_000_000);
  const identity7 = { id: "refund-7", operationType: contract.operationType };
  const intent7 = { chargeId: "ch_7", amountCents: 2_000_000 };
  const r7a = await runEffect(store, contract, { identity: identity7, intent: intent7 });
  log("above review threshold -> REVIEW, Stripe never called", { disposition: r7a.disposition, createdRefundsSoFar: client.createdRefundCount });
  const r7b = await runEffect(store, contract, { identity: identity7, intent: intent7, reviewDecision: { decision: "approved", reviewer: "ops@example.com" } });
  log("after approval -> APPLIED / COMPLETE", { evidenceState: r7b.evidenceState, disposition: r7b.disposition });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
