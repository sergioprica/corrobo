import { InMemoryStore, reviewEffect, runEffect } from "../../src/core";
import { createJevRefundContract, idempotencyKeyFor } from "./contract";
import { FakeRefundLedger } from "./fake-refund-ledger";
import { MockRefundJudgmentProvider } from "./judgment-provider";

/**
 * Deterministic mock-mode demo. No network calls, no TYPESAFE_API_KEY required — this is what
 * `npm run example:jev` runs, and what CI exercises. For the optional live-Jev variant, see
 * live.ts and docs/jev-integration.md #12.
 */

function log(label: string, result: unknown): void {
  console.log(`\n-- ${label} --`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const store = new InMemoryStore();
  const ledger = new FakeRefundLedger();
  const judgmentProvider = new MockRefundJudgmentProvider();
  const contract = createJevRefundContract({ judgmentProvider, ledger });

  // A. Low-risk, sufficient confidence: Jev clears the deterministic policy, authorize()
  // returns no review required, the effect executes, and authoritative observation confirms it.
  const identityA = { id: "jev-refund-a", operationType: contract.operationType };
  const intentA = { requestText: "I was charged twice for order #4471, please refund the duplicate charge.", chargeId: "ch_a", amountCents: 3_000 };
  const resultA = await runEffect(store, contract, { identity: identityA, intent: intentA });
  log("A. low-risk -> no review, executes, APPLIED / COMPLETE", {
    evidenceState: resultA.evidenceState,
    disposition: resultA.disposition,
    refundsCreatedSoFar: ledger.createdRefundCount
  });

  // B. High-risk / low-confidence: Jev's judgment falls outside the deterministic threshold,
  // authorize() returns requiresReview, and the ledger is never touched.
  const identityB = { id: "jev-refund-b", operationType: contract.operationType };
  const intentB = {
    requestText: "I don't recognize this charge at all, this might be fraud, please dispute it.",
    chargeId: "ch_b",
    amountCents: 150_000
  };
  const resultB1 = await runEffect(store, contract, { identity: identityB, intent: intentB });
  log("B. high-risk/uncertain -> REVIEW, ledger never called", {
    disposition: resultB1.disposition,
    status: resultB1.status,
    reviewReasonCode: resultB1.dispositionReason.code,
    refundsCreatedSoFar: ledger.createdRefundCount
  });
  console.log(`proof the effect was NOT executed while awaiting review: createdRefundCount === ${ledger.createdRefundCount} (expect 1, unchanged from A)`);

  // The review screen records the decision; the worker then acts on it.
  await reviewEffect(store, contract, { identity: identityB, decision: { decision: "approved", reviewer: "ops@example.com" } });
  const resultB2 = await runEffect(store, contract, { identity: identityB, intent: intentB });
  log("B (continued). after human approval -> executes, APPLIED / COMPLETE", {
    evidenceState: resultB2.evidenceState,
    disposition: resultB2.disposition,
    refundsCreatedSoFar: ledger.createdRefundCount
  });

  // C. Timeout-after-write: authorization already cleared (this is a plain low-risk refund).
  // execute() experiences an ambiguous transport outcome, but the write actually landed.
  // Authoritative observe() resolves it in the SAME run() call — Jev is not consulted again.
  const identityC = { id: "jev-refund-c", operationType: contract.operationType };
  const intentC = { requestText: "Please refund my order, it arrived damaged.", chargeId: "ch_c", amountCents: 4_200 };
  ledger.scheduleTimeoutAfterWrite(idempotencyKeyFor(identityC.id));
  const resultC = await runEffect(store, contract, { identity: identityC, intent: intentC });
  log("C. timeout after write -> resolved by authoritative observation, not Jev, APPLIED / COMPLETE", {
    evidenceState: resultC.evidenceState,
    disposition: resultC.disposition,
    refundsCreatedSoFar: ledger.createdRefundCount
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
