import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import { createRefundContract, idempotencyKeyFor } from "../examples/stripe-refund/contract";
import { FakeStripeClient } from "../examples/stripe-refund/fake-stripe-client";

describe("Stripe refund example", () => {
  it("normal success -> APPLIED / COMPLETE", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_1", 5000);
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-1", operationType: contract.operationType },
      intent: { chargeId: "ch_1", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);
  });

  it("HEADLINE: timeout after Stripe commits the refund does not create a duplicate", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_2", 5000);
    client.scheduleFault("ch_2", { createFailures: 1, mode: "afterCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-2", operationType: contract.operationType };
    const intent = { chargeId: "ch_2", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("APPLIED");
    expect(r1.disposition).toBe("COMPLETE");

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("timeout BEFORE Stripe ever processes the request self-heals in one call via the idempotency replay", async () => {
    // Unlike a plain REST API with no native idempotency, a timeout before Stripe saw the
    // request and a timeout after it committed both flow through the SAME observe() replay
    // path here — and Stripe's own idempotency semantics (cache-or-create) resolve the
    // ambiguity authoritatively. The caller never needs to distinguish the two: this call
    // both discovers nothing was created yet AND safely creates it, in one run() call.
    const client = new FakeStripeClient();
    client.seedCharge("ch_3", 5000);
    client.scheduleFault("ch_3", { createFailures: 1, mode: "beforeCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-3", operationType: contract.operationType };
    const intent = { chargeId: "ch_3", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("APPLIED");
    expect(r1.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("a definitive rejection that is NOT a state conflict (e.g. an invalid charge) is NOT_APPLIED, safely retryable once fixed", async () => {
    const client = new FakeStripeClient(); // ch_11 not seeded yet -> resource_missing on first attempt
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-11", operationType: contract.operationType };
    const intent = { chargeId: "ch_11", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("NOT_APPLIED");
    expect(r1.disposition).toBe("RETRY");
    expect(client.createdRefundCount).toBe(0);

    client.seedCharge("ch_11", 5000); // the underlying problem is now fixed
    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);
  });

  it("reuses the same Stripe idempotency key across attempts of the same logical operation", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_4", 5000);
    client.scheduleFault("ch_4", { createFailures: 1, mode: "beforeCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-4", operationType: contract.operationType };
    const intent = { chargeId: "ch_4", amountCents: 5000 };

    await runEffect(store, contract, { identity, intent });
    await runEffect(store, contract, { identity, intent });

    const record = await store.getOperation("refund-4");
    const latest = record?.attempts[0];
    expect(latest?.status).toBe("RESOLVED");
    const observations = latest && latest.status === "RESOLVED" ? latest.observations : [];
    const refundId =
      (observations[0] as { data?: { refundId?: string } })?.data?.refundId ??
      (observations[observations.length - 1] as { data?: { refundId?: string } })?.data?.refundId;
    expect(refundId).toBeDefined();
    expect(client.getRefundState(refundId as string)).toBeDefined();
    // A single Stripe key was ever used for this logical operation, and it produced one refund.
    expect(client.idempotencyKeysReceived.length).toBeGreaterThanOrEqual(2); // the failed create + at least one more call
    expect(new Set(client.idempotencyKeysReceived).size).toBe(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("a NEW logical operation (new identity) never reuses an old idempotency key", () => {
    expect(idempotencyKeyFor("refund-a")).not.toBe(idempotencyKeyFor("refund-b"));
    expect(idempotencyKeyFor("refund-a")).toBe(idempotencyKeyFor("refund-a"));
  });

  it("async convergence: PENDING, then re-observe resolves to APPLIED with no second refund", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_5", 5000, { convergeAsync: true });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-5", operationType: contract.operationType };
    const intent = { chargeId: "ch_5", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("PENDING");
    expect(r1.disposition).toBeNull();
    expect(client.createdRefundCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("observation failure (execute and the idempotency-replay both ambiguous) -> UNKNOWN / INVESTIGATE", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_6", 5000);
    client.scheduleFault("ch_6", { createFailures: 2, mode: "beforeCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-6", operationType: contract.operationType },
      intent: { chargeId: "ch_6", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(client.createdRefundCount).toBe(0);
  });

  it("a failed read-back on an otherwise-successful create is honestly UNKNOWN, not assumed APPLIED", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_6b", 5000);
    client.scheduleFault("ch_6b", { retrieveFailures: 1 });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-6b", operationType: contract.operationType },
      intent: { chargeId: "ch_6b", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(client.createdRefundCount).toBe(1); // the refund really was created; we just couldn't confirm it yet
  });

  it("a charge already refunded by something else -> CONFLICTED / REPLAN", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_7", 5000, { alreadyRefunded: true });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-7", operationType: contract.operationType },
      intent: { chargeId: "ch_7", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("CONFLICTED");
    expect(result.disposition).toBe("REPLAN");
  });

  it("a requested amount exceeding the refundable balance -> CONFLICTED / REPLAN", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_8", 100);
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-8", operationType: contract.operationType },
      intent: { chargeId: "ch_8", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("CONFLICTED");
    expect(result.disposition).toBe("REPLAN");
  });

  it("a terminal Stripe-side failure is modeled as NOT_APPLIED, not silently retried into success", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_9", 5000, { terminalFailure: true });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-9", operationType: contract.operationType },
      intent: { chargeId: "ch_9", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("NOT_APPLIED");
    expect(result.disposition).toBe("RETRY");
    expect(result.evidenceReason?.code).toBe("REFUND_TERMINALLY_FAILED");
  });

  it("refunds above the review threshold require authorization before Stripe is ever called", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_10", 2_000_000);
    const store = new InMemoryStore();
    const contract = createRefundContract({ client, reviewThresholdCents: 1_000_000 });
    const identity = { id: "refund-10", operationType: contract.operationType };
    const intent = { chargeId: "ch_10", amountCents: 2_000_000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.disposition).toBe("REVIEW");
    expect(r1.evidenceState).toBeNull();
    expect(client.createdRefundCount).toBe(0);

    const r2 = await runEffect(store, contract, { identity, intent, reviewDecision: "approved" });
    expect(r2.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);
  });

  describe("idempotency-key replay safety window", () => {
    it("replay observation inside the safe window resolves normally", async () => {
      const client = new FakeStripeClient();
      client.seedCharge("ch_12", 5000);
      client.scheduleFault("ch_12", { createFailures: 1, mode: "beforeCommit" });
      const store = new InMemoryStore();
      // A generous window: the fake execute()/observe() pair here completes in milliseconds.
      const contract = createRefundContract({ client, idempotencyReplaySafeWindowMs: 60_000 });
      const identity = { id: "refund-12", operationType: contract.operationType };
      const intent = { chargeId: "ch_12", amountCents: 5000 };

      const result = await runEffect(store, contract, { identity, intent });
      expect(result.evidenceState).toBe("APPLIED");
      expect(result.disposition).toBe("COMPLETE");
      expect(client.createdRefundCount).toBe(1);
    });

    it("replay beyond the safe window is refused — UNKNOWN/INVESTIGATE, no second refund ever created", async () => {
      const client = new FakeStripeClient();
      // convergeAsync so the first (in-window) replay creates a real but still-PENDING refund,
      // exercising the exact re-observation path that keeps re-attempting replay over time.
      client.seedCharge("ch_13", 5000, { convergeAsync: true });
      client.scheduleFault("ch_13", { createFailures: 1, mode: "beforeCommit" });
      const store = new InMemoryStore();
      const contract = createRefundContract({ client, idempotencyReplaySafeWindowMs: 30 });
      const identity = { id: "refund-13", operationType: contract.operationType };
      const intent = { chargeId: "ch_13", amountCents: 5000 };

      const first = await runEffect(store, contract, { identity, intent });
      expect(first.evidenceState).toBe("PENDING");
      expect(client.createdRefundCount).toBe(1); // the in-window replay created exactly one refund

      await new Promise((resolve) => setTimeout(resolve, 60)); // now past the 30ms safe window

      const second = await runEffect(store, contract, { identity, intent });
      expect(second.evidenceState).toBe("UNKNOWN");
      expect(second.disposition).toBe("INVESTIGATE");
      expect(client.createdRefundCount).toBe(1); // refusing to replay meant no second refund was created
    });

    it("once execute() itself returns a stable refund id, later re-observations use direct retrieve, never replay", async () => {
      const client = new FakeStripeClient();
      client.seedCharge("ch_14", 5000, { convergeAsync: true }); // no fault: execute() succeeds directly
      const store = new InMemoryStore();
      const contract = createRefundContract({ client, idempotencyReplaySafeWindowMs: 30 });
      const identity = { id: "refund-14", operationType: contract.operationType };
      const intent = { chargeId: "ch_14", amountCents: 5000 };

      const first = await runEffect(store, contract, { identity, intent });
      expect(first.evidenceState).toBe("PENDING");
      expect(client.createdRefundCount).toBe(1);

      // Well past the replay-safety window — if re-observation used replay, this would refuse
      // and report UNKNOWN. Because execute() returned a stable id, observation uses direct
      // retrieve instead, which has no expiry, and correctly resolves once convergence finishes.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const second = await runEffect(store, contract, { identity, intent });
      expect(second.evidenceState).toBe("APPLIED");
      expect(second.disposition).toBe("COMPLETE");
      expect(client.createdRefundCount).toBe(1);
    });
  });
});
