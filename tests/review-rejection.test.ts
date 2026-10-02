import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { reviewEffect, runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

function makeReviewedContract(executeCalls: { count: number }): EffectContract<Record<string, never>, unknown, unknown> {
  return {
    operationType: "test/reviewed",
    capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    authorize: () => ({
      requiresReview: true,
      reason: { code: "HIGH_RISK", summary: "needs sign-off" }
    }),
    async execute() {
      executeCalls.count += 1;
      return { done: true };
    },
    async observe() {
      return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
    },
    reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
  };
}

describe("REVIEW rejection", () => {
  it("rejection calls execute() zero times", async () => {
    const executeCalls = { count: 0 };
    const store = new InMemoryStore();
    const contract = makeReviewedContract(executeCalls);
    const identity = { id: "review-reject-1", operationType: contract.operationType };

    const awaiting = await runEffect(store, contract, { identity, intent: {} });
    expect(awaiting.disposition).toBe("REVIEW");
    expect(awaiting.status).toBe("AWAITING_REVIEW");

    const rejected = await reviewEffect(store, contract, { identity, decision: { decision: "rejected", reviewer: "reviewer@example.com" } });

    await runEffect(store, contract, { identity, intent: {} });
    expect(rejected.disposition).toBe("REVIEW");
    expect(rejected.status).toBe("CLOSED");
    expect(rejected.dispositionReason.code).toBe("POLICY_REVIEW_REJECTED");
    expect(executeCalls.count).toBe(0);
  });

  it("repeated calls after rejection remain closed and never execute", async () => {
    const executeCalls = { count: 0 };
    const store = new InMemoryStore();
    const contract = makeReviewedContract(executeCalls);
    const identity = { id: "review-reject-2", operationType: contract.operationType };

    await runEffect(store, contract, { identity, intent: {} });
    await reviewEffect(store, contract, { identity, decision: { decision: "rejected", reviewer: "reviewer@example.com" } });
    await runEffect(store, contract, { identity, intent: {} });

    const again1 = await runEffect(store, contract, { identity, intent: {} });
    await reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewer: "reviewer@example.com" } });
    const again2 = await runEffect(store, contract, { identity, intent: {} });
    expect(again1.status).toBe("CLOSED");
    expect(again2.status).toBe("CLOSED");
    expect(again1.dispositionReason.code).toBe("POLICY_REVIEW_REJECTED");
    expect(again2.dispositionReason.code).toBe("POLICY_REVIEW_REJECTED");
    expect(executeCalls.count).toBe(0);
  });

  it("approval still executes exactly once", async () => {
    const executeCalls = { count: 0 };
    const store = new InMemoryStore();
    const contract = makeReviewedContract(executeCalls);
    const identity = { id: "review-approve-1", operationType: contract.operationType };

    await runEffect(store, contract, { identity, intent: {} });
    await reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewer: "reviewer@example.com" } });
    const approved = await runEffect(store, contract, { identity, intent: {} });
    expect(approved.disposition).toBe("COMPLETE");
    expect(executeCalls.count).toBe(1);

    const again = await runEffect(store, contract, { identity, intent: {} });
    expect(again.disposition).toBe("COMPLETE");
    expect(executeCalls.count).toBe(1);
  });
});
