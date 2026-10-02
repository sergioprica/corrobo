import { afterEach, describe, expect, it, vi } from "vitest";
import { runEffect } from "../src/core/runtime";
import { StoreConflictError } from "../src/core/store";
import type { CoordinatedStore, EffectStore, OperationLock } from "../src/core/store";
import type { EffectContract, ResolvedAttempt } from "../src/core/types";
import { InMemoryStore } from "../src/stores/memory";

/**
 * Fencing + settlement at the runtime level, with no database: a store whose lock the test can
 * take away mid-pass stands in for "the Postgres session holding the advisory lock died while
 * execute() was still running". External effects are counted by the fake target itself, never
 * read back from corrobo's own record.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** InMemoryStore data, with a lock the test can revoke while its holder is still mid-pass. */
class LosableLockStore implements EffectStore {
  readonly inner = new InMemoryStore();
  private readonly held = new Set<string>();

  loseLock(identityId: string) {
    this.held.delete(identityId);
  }

  async tryAcquireLock(identityId: string): Promise<OperationLock | null> {
    if (this.held.has(identityId)) return null;
    this.held.add(identityId);
    return {
      store: this.inner,
      release: async () => {
        this.held.delete(identityId);
      }
    };
  }

  getOperation: CoordinatedStore["getOperation"] = (id) => this.inner.getOperation(id);
  createOperation: CoordinatedStore["createOperation"] = (input) => this.inner.createOperation(input);
  reserveAttempt: CoordinatedStore["reserveAttempt"] = (id, r, v) => this.inner.reserveAttempt(id, r, v);
  appendAttempt: CoordinatedStore["appendAttempt"] = (id, a, s, v) => this.inner.appendAttempt(id, a, s, v);
  updateLatestAttempt: CoordinatedStore["updateLatestAttempt"] = (id, a, s, v) => this.inner.updateLatestAttempt(id, a, s, v);
  updateOperation: CoordinatedStore["updateOperation"] = (id, u, v) => this.inner.updateOperation(id, u, v);
  setStatus: CoordinatedStore["setStatus"] = (id, s, v) => this.inner.setStatus(id, s, v);
}

/**
 * A target with its own authoritative state. `execute()` sends a request; the target applies it
 * only when the test calls `land()` (or immediately, if `holdNextRequest` is false). A held
 * request can land after the caller has already given up on it — exactly a late landing.
 */
function makeTarget() {
  const target = {
    applied: 0,
    executeCalls: 0,
    observeCalls: 0,
    holdNextRequest: false,
    failNextTransport: false,
    held: null as ReturnType<typeof deferred> | null,
    land() {
      target.held?.resolve();
    }
  };
  return target;
}

type Target = ReturnType<typeof makeTarget>;

function contractFor(target: Target, maxInFlightMs?: number): EffectContract<{ amount: number }, { applied: number }, { ok: true }> {
  return {
    operationType: "test/credit",
    capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs,
    async execute() {
      target.executeCalls += 1;
      if (target.holdNextRequest) {
        target.holdNextRequest = false;
        const held = deferred();
        target.held = held;
        await held.promise;
      }
      target.applied += 1;
      if (target.failNextTransport) {
        target.failNextTransport = false;
        throw new Error("socket hang up"); // applied, but the response is lost
      }
      return { ok: true };
    },
    async observe() {
      target.observeCalls += 1;
      return { status: "observed", data: { applied: target.applied }, authoritative: true, source: "target", observedAt: new Date().toISOString() };
    },
    reconcile({ observation }) {
      if (observation.status !== "observed") {
        return { evidenceState: "UNKNOWN", reason: { code: "NO_READBACK", summary: "read-back failed" } };
      }
      return observation.data.applied > 0
        ? { evidenceState: "APPLIED", reason: { code: "FOUND", summary: "credit exists" } }
        : { evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "no credit" } };
    }
  };
}

/** Lets pending microtasks/IO callbacks run so a started runEffect() reaches its await on execute(). */
const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.useRealTimers();
});

describe("lock lost while execute() is still in flight", () => {
  const identity = { id: "credit-1", operationType: "test/credit" };
  const intent = { amount: 5 };

  it("no maxInFlightMs: recovery says INVESTIGATE, nobody re-executes, and the stale pass cannot overwrite", async () => {
    const store = new LosableLockStore();
    const target = makeTarget();
    const contract = contractFor(target);

    target.holdNextRequest = true;
    const a = runEffect(store, contract, { identity, intent });
    await tick();
    expect(target.executeCalls).toBe(1); // A is inside execute(), request in flight

    store.loseLock(identity.id); // A's session died; A itself keeps running
    const b = await runEffect(store, contract, { identity, intent });
    expect(b.evidenceState).toBe("NOT_APPLIED"); // nothing has landed yet...
    expect(b.disposition).toBe("INVESTIGATE"); // ...but that does not prove it never will
    expect(b.dispositionReason.code).toBe("IN_FLIGHT_NOT_RULED_OUT");

    const c = await runEffect(store, contract, { identity, intent });
    expect(c.disposition).toBe("INVESTIGATE");
    expect(target.executeCalls).toBe(1);

    target.land(); // A's request lands late
    const aResult = await a; // A's final write is fenced out: it resolves with the current record instead
    expect(aResult.disposition).toBe("INVESTIGATE");
    const stored = await store.getOperation(identity.id);
    expect(stored?.attempts).toHaveLength(1);
    expect((stored?.attempts[0] as ResolvedAttempt).evidenceState).toBe("NOT_APPLIED"); // B's record, not A's
    expect(target.applied).toBe(1); // exactly one external effect
  });

  it("with maxInFlightMs: recovery defers the retry; the settlement check catches the late landing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new LosableLockStore();
    const target = makeTarget();
    const contract = contractFor(target, 30_000);

    target.holdNextRequest = true;
    const a = runEffect(store, contract, { identity, intent });
    await tick();

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    store.loseLock(identity.id);
    const b = await runEffect(store, contract, { identity, intent });
    expect(b.disposition).toBe("RETRY");
    expect(b.retryNotBefore).toBe("2026-01-01T00:00:30.000Z");

    const early = await runEffect(store, contract, { identity, intent });
    expect(early.retryNotBefore).toBe(b.retryNotBefore);
    expect(target.executeCalls).toBe(1);

    target.land();
    await a;
    expect(target.applied).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
    const settled = await runEffect(store, contract, { identity, intent });
    expect(settled.evidenceState).toBe("APPLIED");
    expect(settled.disposition).toBe("COMPLETE");
    expect(settled.attempts).toHaveLength(1);
    expect(target.executeCalls).toBe(1);
    expect(target.applied).toBe(1);
  });

  it("the stale pass's reservation is fenced too: it never reaches execute()", async () => {
    const store = new LosableLockStore();
    const target = makeTarget();
    const contract = contractFor(target, 0);

    // A reads the record, then (before reserving) another pass reserves and resolves attempt 1.
    const originalReserve = store.inner.reserveAttempt.bind(store.inner);
    let raced = false;
    store.inner.reserveAttempt = async (id, reserved, version) => {
      if (!raced) {
        raced = true;
        await originalReserve(id, reserved, version); // "another pass" wins the version
      }
      return originalReserve(id, reserved, version); // A's own reservation, now stale
    };

    const result = await runEffect(store, contract, { identity, intent });
    expect(target.executeCalls).toBe(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe("RESERVED");
  });
});

describe("settlement after a failed transport (no lock loss)", () => {
  const identity = { id: "credit-2", operationType: "test/credit" };
  const intent = { amount: 5 };

  it("response lost after the target applied: APPLIED / COMPLETE immediately, regardless of window", async () => {
    const store = new InMemoryStore();
    const target = makeTarget();
    target.failNextTransport = true;
    const result = await runEffect(store, contractFor(target), { identity, intent });
    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
    expect(target.applied).toBe(1);
  });

  it("a request that times out without landing, then lands inside the window: no second execute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new InMemoryStore();
    const target = makeTarget();
    const contract: EffectContract<{ amount: number }, { applied: number }, { ok: true }> = {
      ...contractFor(target, 10_000),
      async execute() {
        target.executeCalls += 1;
        throw new Error("timeout"); // client gave up; the provider still has the request
      }
    };

    const first = await runEffect(store, contract, { identity, intent });
    expect(first.disposition).toBe("RETRY");
    expect(first.retryNotBefore).toBe("2026-01-01T00:00:10.000Z");

    target.applied = 1; // lands late
    vi.setSystemTime(new Date("2026-01-01T00:00:12.000Z"));
    const second = await runEffect(store, contract, { identity, intent });
    expect(second.evidenceState).toBe("APPLIED");
    expect(second.disposition).toBe("COMPLETE");
    expect(target.executeCalls).toBe(1);
  });

  it("after the window, a settled NOT_APPLIED retries in the same call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new InMemoryStore();
    const target = makeTarget();
    let calls = 0;
    const contract: EffectContract<{ amount: number }, { applied: number }, { ok: true }> = {
      ...contractFor(target, 10_000),
      async execute() {
        calls += 1;
        if (calls === 1) throw new Error("connect ETIMEDOUT");
        target.applied += 1;
        return { ok: true };
      }
    };

    const first = await runEffect(store, contract, { identity, intent });
    expect(first.disposition).toBe("RETRY");

    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    const second = await runEffect(store, contract, { identity, intent });
    expect(second.evidenceState).toBe("APPLIED");
    expect(second.attempts).toHaveLength(2);
    expect(target.applied).toBe(1);
    const firstAttempt = second.attempts[0] as ResolvedAttempt;
    expect(firstAttempt.observations).toHaveLength(2); // the original read-back + the settlement check
    expect(firstAttempt.retryNotBefore).toBeUndefined();
  });

  it("if the settlement check itself cannot read the target, nothing is executed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = new InMemoryStore();
    const target = makeTarget();
    let observeFails = false;
    const base = contractFor(target, 10_000);
    const contract: typeof base = {
      ...base,
      async execute() {
        target.executeCalls += 1;
        throw new Error("timeout");
      },
      async observe(input) {
        if (observeFails) throw new Error("read-back unavailable");
        return base.observe(input);
      }
    };

    await runEffect(store, contract, { identity, intent });
    observeFails = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:11.000Z"));
    const result = await runEffect(store, contract, { identity, intent });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(target.executeCalls).toBe(1);
  });
});

describe("store-level fencing", () => {
  it("InMemoryStore rejects a write based on a stale version and leaves the record unchanged", async () => {
    const store = new InMemoryStore();
    const created = await store.createOperation({ identity: { id: "f1", operationType: "t" }, intent: {}, status: "OPEN" });
    expect(created.version).toBe(0);
    const reserved = await store.reserveAttempt("f1", { attemptNumber: 1, startedAt: new Date().toISOString() }, 0);
    expect(reserved.version).toBe(1);

    const stale = store.setStatus("f1", "CLOSED", 0);
    await expect(stale).rejects.toBeInstanceOf(StoreConflictError);
    await expect(stale).rejects.toMatchObject({ identityId: "f1", expectedVersion: 0, actualVersion: 1 });
    const after = await store.getOperation("f1");
    expect(after?.status).toBe("OPEN");
    expect(after?.version).toBe(1);
  });

  it("InMemoryStore: a stale updateOperation is rejected and changes nothing", async () => {
    const store = new InMemoryStore();
    await store.createOperation({ identity: { id: "f1u", operationType: "t" }, intent: {}, status: "OPEN" });
    await store.reserveAttempt("f1u", { attemptNumber: 1, startedAt: new Date().toISOString() }, 0);

    const stale = store.updateOperation("f1u", { status: "CLOSED", reviewReason: { code: "X", summary: "x" } }, 0);
    await expect(stale).rejects.toBeInstanceOf(StoreConflictError);
    const after = await store.getOperation("f1u");
    expect(after?.status).toBe("OPEN");
    expect(after?.reviewReason).toBeUndefined();
    expect(after?.version).toBe(1);
  });

  it("InMemoryStore: a duplicate create is a StoreConflictError with expectedVersion null", async () => {
    const store = new InMemoryStore();
    await store.createOperation({ identity: { id: "f2", operationType: "t" }, intent: {}, status: "OPEN" });
    await expect(
      store.createOperation({ identity: { id: "f2", operationType: "t" }, intent: {}, status: "OPEN" })
    ).rejects.toMatchObject({ name: "StoreConflictError", expectedVersion: null });
  });

  it("InMemoryStore: updateLatestAttempt with no attempts throws and does not bump the version", async () => {
    const store = new InMemoryStore();
    await store.createOperation({ identity: { id: "f3", operationType: "t" }, intent: {}, status: "OPEN" });
    await expect(
      store.updateLatestAttempt("f3", { status: "RESERVED", attemptNumber: 1, startedAt: "x", updatedAt: "x" }, "OPEN", 0)
    ).rejects.toThrow(/no attempt to update/);
    expect((await store.getOperation("f3"))?.version).toBe(0);
  });
});

describe("InMemoryStore and uncloneable thrown values", () => {
  it("execute() throwing an object holding a function still yields a result, and the operation stays usable", async () => {
    const store = new InMemoryStore();
    const target = makeTarget();
    const thrown = { code: "E_WEIRD", retry: () => 1 };
    const contract: EffectContract<{ amount: number }, { applied: number }, { ok: true }> = {
      ...contractFor(target, 0),
      async execute() {
        target.executeCalls += 1;
        throw thrown;
      }
    };
    const identity = { id: "weird-1", operationType: "test/credit" };

    const first = await runEffect(store, contract, { identity, intent: { amount: 1 } });
    expect(first.evidenceState).toBe("NOT_APPLIED");
    const transport = (first.attempts[0] as ResolvedAttempt).transport;
    expect(transport.ok).toBe(false);
    expect(!transport.ok && transport.error.raw).toBe(thrown); // kept by reference in memory

    const second = await runEffect(store, contract, { identity, intent: { amount: 1 } });
    expect(second.attempts).toHaveLength(2);
  });
});

describe("review fixes: legacy RETRY, one clock domain, identity binding on conflict", () => {
  const identity = { id: "credit-3", operationType: "test/credit" };
  const intent = { amount: 5 };

  /** Writes the record corrobo 0.2.x left behind: a transport failure resolved straight to RETRY, no window. */
  async function seedLegacyRetry(store: InMemoryStore, startedAt: string) {
    await store.createOperation({ identity, intent, status: "OPEN" });
    await store.reserveAttempt(identity.id, { attemptNumber: 1, startedAt }, 0);
    const legacy: ResolvedAttempt = {
      status: "RESOLVED",
      attemptNumber: 1,
      startedAt,
      updatedAt: startedAt,
      transport: { ok: false, error: { message: "timeout" } },
      observations: [{ status: "observed", data: { applied: 0 }, authoritative: true, source: "target", observedAt: startedAt }],
      evidenceState: "NOT_APPLIED",
      evidenceReason: { code: "ABSENT", summary: "no credit" },
      disposition: "RETRY",
      dispositionReason: { code: "SAFE_RETRY", summary: "0.2.x" }
    };
    await store.updateLatestAttempt(identity.id, legacy, "OPEN", 1);
  }

  it("a 0.2.x RETRY after a transport failure, contract without maxInFlightMs: INVESTIGATE, never executed", async () => {
    const store = new InMemoryStore();
    const target = makeTarget();
    await seedLegacyRetry(store, new Date().toISOString());

    const result = await runEffect(store, contractFor(target), { identity, intent });
    expect(result.disposition).toBe("INVESTIGATE");
    expect(result.dispositionReason.code).toBe("IN_FLIGHT_NOT_RULED_OUT");
    expect(target.executeCalls).toBe(0);
  });

  it("a 0.2.x RETRY whose request landed late: the settlement check finds APPLIED, no second effect", async () => {
    const store = new InMemoryStore();
    const target = makeTarget();
    await seedLegacyRetry(store, new Date(Date.now() - 60_000).toISOString());
    target.applied = 1;

    const result = await runEffect(store, contractFor(target, 1_000), { identity, intent });
    expect(result.evidenceState).toBe("APPLIED");
    expect(target.executeCalls).toBe(0);
    expect(target.applied).toBe(1);
  });

  it("attempt start and window checks use the store's clock, not the local one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let dbTime = new Date("2026-01-01T12:00:00.000Z");
    class ClockedStore extends InMemoryStore {
      async now() {
        return dbTime;
      }
    }
    const store = new ClockedStore();
    const target = makeTarget();
    const base = contractFor(target, 30_000);
    const contract: typeof base = {
      ...base,
      async execute() {
        target.executeCalls += 1;
        throw new Error("timeout");
      }
    };

    const first = await runEffect(store, contract, { identity, intent });
    expect(first.attempts[0].startedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(first.retryNotBefore).toBe("2026-01-01T12:00:30.000Z");

    // This host's clock jumps far ahead; the shared clock has only moved 5s. Still too early.
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    dbTime = new Date("2026-01-01T12:00:05.000Z");
    const early = await runEffect(store, contract, { identity, intent });
    expect(early.retryNotBefore).toBe(first.retryNotBefore);
    expect(target.observeCalls).toBe(1);
    expect(target.executeCalls).toBe(1);
  });

  it("a conflict on create never hands back another intent's result", async () => {
    const store = new LosableLockStore();
    const target = makeTarget();
    const originalCreate = store.inner.createOperation.bind(store.inner);
    store.inner.createOperation = async (input) => {
      // Between this pass's read and its create, a pass whose lock was lost created the same id
      // for a different intent.
      await originalCreate({ ...input, intent: { amount: 500 } });
      return originalCreate(input);
    };

    await expect(runEffect(store, contractFor(target, 0), { identity, intent: { amount: 5 } })).rejects.toThrow(
      /different intent/
    );
    expect(target.executeCalls).toBe(0);
  });
});
