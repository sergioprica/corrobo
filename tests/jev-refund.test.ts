import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { reviewEffect, runEffect } from "../src/core/runtime";
import { createJevRefundContract, idempotencyKeyFor } from "../examples/jev-refund/contract";
import { FakeRefundLedger } from "../examples/jev-refund/fake-refund-ledger";
import { MockRefundJudgmentProvider } from "../examples/jev-refund/judgment-provider";
import type { RefundJudgment, RefundJudgmentInput, RefundJudgmentProvider } from "../examples/jev-refund/judgment-provider";

/** Counts calls so tests can assert Jev is consulted exactly once (in authorize()) and never again. */
class SpyJudgmentProvider implements RefundJudgmentProvider {
  callCount = 0;
  constructor(private readonly judgment: RefundJudgment) {}
  async assess(_input: RefundJudgmentInput): Promise<RefundJudgment> {
    this.callCount += 1;
    return this.judgment;
  }
}

describe("Jev + corrobo refund example", () => {
  it("A. low-risk, sufficient-confidence judgment -> no review, executes, APPLIED / COMPLETE", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new MockRefundJudgmentProvider();
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-a", operationType: contract.operationType };
    const intent = { requestText: "I was charged twice, please refund the duplicate.", chargeId: "ch_a", amountCents: 3_000 };

    const result = await runEffect(store, contract, { identity, intent });

    expect(result.disposition).toBe("COMPLETE");
    expect(result.evidenceState).toBe("APPLIED");
    expect(ledger.createdRefundCount).toBe(1);
  });

  it("B. high-risk judgment -> REVIEW, and the effect is NOT executed while awaiting review", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.9, confidence: 0.95 }, // clearly above the risk threshold, high confidence
      model: "mock-jev/high-risk"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-b", operationType: contract.operationType };
    const intent = { requestText: "Refund my order please.", chargeId: "ch_b", amountCents: 500_000 };

    const result = await runEffect(store, contract, { identity, intent });

    expect(result.disposition).toBe("REVIEW");
    expect(result.status).toBe("AWAITING_REVIEW");
    expect(result.dispositionReason.code).toBe("JEV_HIGH_RISK");
    expect(ledger.createdRefundCount).toBe(0); // proof: the effect was never attempted
  });

  it("low-confidence judgment -> REVIEW, independent of the risk score", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.1, confidence: 0.4 }, // low risk, but Jev itself is not confident
      model: "mock-jev/low-confidence"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-low-confidence", operationType: contract.operationType };
    const intent = { requestText: "Not sure but maybe refund this?", chargeId: "ch_lc", amountCents: 1_000 };

    const result = await runEffect(store, contract, { identity, intent });

    expect(result.disposition).toBe("REVIEW");
    expect(result.dispositionReason.code).toBe("JEV_LOW_CONFIDENCE");
    expect(ledger.createdRefundCount).toBe(0);
  });

  it("approved review proceeds correctly, executing exactly once", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.9, confidence: 0.95 },
      model: "mock-jev/high-risk"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-approve", operationType: contract.operationType };
    const intent = { requestText: "Refund my order please.", chargeId: "ch_approve", amountCents: 500_000 };

    const awaiting = await runEffect(store, contract, { identity, intent });
    expect(awaiting.disposition).toBe("REVIEW");
    expect(ledger.createdRefundCount).toBe(0);

    await reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewer: "reviewer@example.com" } });

    const approved = await runEffect(store, contract, { identity, intent });
    expect(approved.disposition).toBe("COMPLETE");
    expect(approved.evidenceState).toBe("APPLIED");
    expect(ledger.createdRefundCount).toBe(1);

    // Jev is consulted exactly once — during the original authorize() call — never again,
    // including on the approval call itself.
    expect(judgmentProvider.callCount).toBe(1);
  });

  it("C. timeout after write is resolved by authoritative observation, not Jev, with no duplicate", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.1, confidence: 0.9 }, // clears the deterministic policy: no review
      model: "mock-jev/low-risk"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-c", operationType: contract.operationType };
    const intent = { requestText: "Please refund my order.", chargeId: "ch_c", amountCents: 2_000 };

    ledger.scheduleTimeoutAfterWrite(idempotencyKeyFor(identity.id));
    const result = await runEffect(store, contract, { identity, intent });

    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
    expect(ledger.createdRefundCount).toBe(1); // exactly one refund, despite the ambiguous transport error
    // Jev answered once, before execute() was ever attempted; the ambiguity introduced by the
    // simulated timeout was resolved entirely by the ledger's authoritative read-back.
    expect(judgmentProvider.callCount).toBe(1);
  });

  it("Jev's judgment is never consulted again once PENDING/re-observation is involved", async () => {
    // Reuses the same contract shape but forces a second runEffect() call on an already-closed
    // operation to further demonstrate authorize() (and therefore Jev) runs exactly once.
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.1, confidence: 0.9 },
      model: "mock-jev/low-risk"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-recheck", operationType: contract.operationType };
    const intent = { requestText: "Please refund my order.", chargeId: "ch_recheck", amountCents: 2_000 };

    await runEffect(store, contract, { identity, intent });
    await runEffect(store, contract, { identity, intent }); // same identity, already CLOSED

    expect(judgmentProvider.callCount).toBe(1);
    expect(ledger.createdRefundCount).toBe(1);
  });

  it("no provider API key is persisted anywhere in corrobo's operation record", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.9, confidence: 0.95 },
      model: "mock-jev/high-risk"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-no-secrets", operationType: contract.operationType };
    const intent = { requestText: "Refund my order please.", chargeId: "ch_secret", amountCents: 500_000 };

    await runEffect(store, contract, { identity, intent });
    const record = await store.getOperation(identity.id);
    const serialized = JSON.stringify(record);

    expect(serialized).not.toMatch(/TYPESAFE_API_KEY|sk_|api[_-]?key/i);
  });

  it("no raw provider response object is persisted — only the small, intentional audit fields", async () => {
    const ledger = new FakeRefundLedger();
    const judgmentProvider = new SpyJudgmentProvider({
      isRefundRequest: { noul: 0.9 },
      risk: { score: 0.9, confidence: 0.95 },
      model: "mock-jev/high-risk"
    });
    const store = new InMemoryStore();
    const contract = createJevRefundContract({ judgmentProvider, ledger });
    const identity = { id: "jev-small-audit", operationType: contract.operationType };
    const intent = { requestText: "Refund my order please.", chargeId: "ch_audit", amountCents: 500_000 };

    const result = await runEffect(store, contract, { identity, intent });
    const metadata = result.dispositionReason.metadata as Record<string, unknown> | undefined;

    expect(metadata).toEqual({
      model: "mock-jev/high-risk",
      isRefundRequestProbability: 0.9,
      riskScore: 0.9,
      riskConfidence: 0.95,
      confidenceThreshold: 0.7,
      riskThreshold: 0.4
    });
  });
});
