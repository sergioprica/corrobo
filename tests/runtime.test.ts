import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { reviewEffect, runEffect } from "../src/core/runtime";
import type { EffectContract, ObservationResult, ReconciliationResult, RetryPolicy } from "../src/core/types";

interface TestIntent {
  [key: string]: unknown;
}

function makeContract(opts: {
  retryPolicy?: RetryPolicy;
  authorize?: EffectContract<TestIntent, unknown, unknown>["authorize"];
  executeImpl?: () => Promise<unknown>;
  observeQueue: ObservationResult<unknown>[];
  reconcileImpl: (input: {
    intent: TestIntent;
    transport: { ok: boolean };
    observation: ObservationResult<unknown>;
  }) => ReconciliationResult;
}) {
  let executeCalls = 0;
  const observeQueue = [...opts.observeQueue];

  const contract: EffectContract<TestIntent, unknown, unknown> = {
    operationType: "test/op",
    capabilities: {
      nativeIdempotency: false,
      callerGeneratedIdentity: true,
      optimisticConcurrency: false,
      convergence: false
    },
    retryPolicy: opts.retryPolicy ?? { maxAttempts: 3, retryOnNotApplied: true },
    authorize: opts.authorize,
    async execute() {
      executeCalls += 1;
      if (opts.executeImpl) return opts.executeImpl();
      return { call: executeCalls };
    },
    async observe() {
      const next = observeQueue.shift();
      if (!next) throw new Error("test observe queue exhausted — unexpected extra observe() call");
      return next;
    },
    reconcile: opts.reconcileImpl as EffectContract<TestIntent, unknown, unknown>["reconcile"]
  };

  return { contract, getExecuteCalls: () => executeCalls };
}

const nowIso = () => new Date().toISOString();

describe("runEffect", () => {
  it("persists operation identity and intent before execute() runs, even if execute() throws", async () => {
    const store = new InMemoryStore();
    const { contract } = makeContract({
      executeImpl: async () => {
        throw new Error("boom");
      },
      observeQueue: [{ status: "observation_failed", error: { message: "no readback" }, source: "test", observedAt: nowIso() }],
      reconcileImpl: () => ({ evidenceState: "UNKNOWN", reason: { code: "X", summary: "x" } })
    });
    const identity = { id: "id-1", operationType: contract.operationType };
    await runEffect(store, contract, { identity, intent: { foo: 1 } });
    const record = await store.getOperation("id-1");
    expect(record).not.toBeNull();
    expect(record?.intent).toEqual({ foo: 1 });
  });

  it("does not re-execute once the same operation identity is closed", async () => {
    const store = new InMemoryStore();
    const { contract, getExecuteCalls } = makeContract({
      observeQueue: [{ status: "observed", data: { ok: true }, authoritative: true, source: "t", observedAt: nowIso() }],
      reconcileImpl: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    });
    const identity = { id: "id-2", operationType: contract.operationType };
    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.disposition).toBe("COMPLETE");
    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.disposition).toBe("COMPLETE");
    expect(getExecuteCalls()).toBe(1);
  });

  it("REVIEW is a pre-execution policy gate, not a reconciliation outcome", async () => {
    const store = new InMemoryStore();
    const { contract, getExecuteCalls } = makeContract({
      authorize: () => ({ requiresReview: true, reason: { code: "HIGH_RISK", summary: "needs sign-off" } }),
      observeQueue: [{ status: "observed", data: {}, authoritative: true, source: "t", observedAt: nowIso() }],
      reconcileImpl: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    });
    const identity = { id: "id-3", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.disposition).toBe("REVIEW");
    expect(r1.evidenceState).toBeNull();
    expect(getExecuteCalls()).toBe(0);

    await reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewer: "reviewer@example.com" } });

    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.disposition).toBe("COMPLETE");
    expect(getExecuteCalls()).toBe(1);
  });

  it("PENDING triggers re-observation on the next call, never a second execute()", async () => {
    const store = new InMemoryStore();
    const { contract, getExecuteCalls } = makeContract({
      observeQueue: [
        { status: "pending", authoritative: true, source: "t", observedAt: nowIso() },
        { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: nowIso() }
      ],
      reconcileImpl: ({ observation }) =>
        observation.status === "pending"
          ? { evidenceState: "PENDING", reason: { code: "WAIT", summary: "wait" } }
          : { evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } }
    });
    const identity = { id: "id-4", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.evidenceState).toBe("PENDING");
    expect(r1.disposition).toBeNull();

    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(getExecuteCalls()).toBe(1);
  });

  it("NOT_APPLIED with a safe-retry policy allows a genuine second attempt", async () => {
    const store = new InMemoryStore();
    const { contract, getExecuteCalls } = makeContract({
      observeQueue: [
        { status: "observed", data: { done: false }, authoritative: true, source: "t", observedAt: nowIso() },
        { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: nowIso() }
      ],
      reconcileImpl: ({ observation }) => {
        const data = observation.status === "observed" ? (observation.data as { done: boolean }) : undefined;
        return data?.done
          ? { evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "absent" } };
      }
    });
    const identity = { id: "id-5", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.disposition).toBe("RETRY");
    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.disposition).toBe("COMPLETE");
    expect(getExecuteCalls()).toBe(2);
  });

  it("a failed observation is UNKNOWN, never conflated with NOT_APPLIED, and does not silently retry", async () => {
    const store = new InMemoryStore();
    const { contract } = makeContract({
      observeQueue: [{ status: "observation_failed", error: { message: "timeout" }, source: "t", observedAt: nowIso() }],
      reconcileImpl: ({ observation }) =>
        observation.status === "observation_failed"
          ? { evidenceState: "UNKNOWN", reason: { code: "READBACK_UNAVAILABLE", summary: "x" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "X", summary: "x" } }
    });
    const identity = { id: "id-6", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.evidenceState).toBe("UNKNOWN");
    expect(r1.disposition).toBe("INVESTIGATE");

    // Second call must NOT attempt to observe again (queue is exhausted) — it must return the cached result.
    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.evidenceState).toBe("UNKNOWN");
    expect(r2.attempts.length).toBe(1);
  });

  it("CONFLICTED leads to REPLAN and closes the operation (a new identity is needed, not a retry of this one)", async () => {
    const store = new InMemoryStore();
    const { contract, getExecuteCalls } = makeContract({
      observeQueue: [{ status: "observed", data: { version: 9 }, authoritative: true, source: "t", observedAt: nowIso() }],
      reconcileImpl: () => ({ evidenceState: "CONFLICTED", reason: { code: "VERSION_CONFLICT", summary: "x" } })
    });
    const identity = { id: "id-8", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.disposition).toBe("REPLAN");
    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.disposition).toBe("REPLAN");
    expect(getExecuteCalls()).toBe(1);
  });

  it("retry exhaustion is represented conservatively (INVESTIGATE, not a silent stop or a forced retry)", async () => {
    const store = new InMemoryStore();
    const { contract } = makeContract({
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: true },
      observeQueue: [{ status: "observed", data: { done: false }, authoritative: true, source: "t", observedAt: nowIso() }],
      reconcileImpl: () => ({ evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "x" } })
    });
    const identity = { id: "id-9", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.disposition).toBe("INVESTIGATE");
    expect(r1.dispositionReason.metadata).toMatchObject({ attemptNumber: 1, maxAttempts: 1 });
  });

  it("reason-code metadata survives persistence through the store", async () => {
    const store = new InMemoryStore();
    const { contract } = makeContract({
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: true },
      observeQueue: [{ status: "observed", data: { done: false }, authoritative: true, source: "t", observedAt: nowIso() }],
      reconcileImpl: () => ({ evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "x" } })
    });
    const identity = { id: "id-10", operationType: contract.operationType };

    await runEffect(store, contract, { identity, intent: {} });
    const record = await store.getOperation("id-10");
    const latest = record?.attempts[0];
    expect(latest?.status).toBe("RESOLVED");
    expect(latest && latest.status === "RESOLVED" ? latest.dispositionReason.metadata : undefined).toMatchObject({
      attemptNumber: 1,
      maxAttempts: 1,
      retryable: true
    });
  });
});
