import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect, StoreConflictError } from "../src/core";
import type { CoordinatedStore, EffectStore, NewOperationInput, OperationUpdate } from "../src/core/store";
import type {
  AttemptRecord,
  EffectContract,
  ObservationResult,
  OperationRecord,
  OperationStatus,
  ReservedAttemptInput,
  RetryPolicy
} from "../src/core/types";

const BASE_TIME = "2026-01-01T00:00:00.000Z";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeExternalTarget {
  effectCount = 0;
  executeCalls = 0;
  observeCalls = 0;

  land(): void {
    this.effectCount += 1;
  }

  observe(source = "fake-target"): ObservationResult<{ applied: boolean; effects: number }> {
    this.observeCalls += 1;
    return {
      status: "observed",
      data: { applied: this.effectCount > 0, effects: this.effectCount },
      authoritative: true,
      source,
      observedAt: new Date().toISOString()
    };
  }
}

function makeContract(opts: {
  operationType: string;
  target: FakeExternalTarget;
  maxInFlightMs?: number;
  retryPolicy?: RetryPolicy;
  execute: EffectContract<Record<string, never>, { applied: boolean; effects: number }, unknown>["execute"];
  observe?: EffectContract<Record<string, never>, { applied: boolean; effects: number }, unknown>["observe"];
}): EffectContract<Record<string, never>, { applied: boolean; effects: number }, unknown> {
  return {
    operationType: opts.operationType,
    maxInFlightMs: opts.maxInFlightMs,
    capabilities: {
      nativeIdempotency: false,
      callerGeneratedIdentity: true,
      optimisticConcurrency: false,
      convergence: false
    },
    retryPolicy: opts.retryPolicy ?? { maxAttempts: 3, retryOnNotApplied: true },
    execute: opts.execute,
    observe: opts.observe ?? (async () => opts.target.observe()),
    reconcile: ({ observation }) => {
      if (observation.status === "observation_failed") {
        return { evidenceState: "UNKNOWN", reason: { code: "OBSERVATION_FAILED", summary: "readback failed" } };
      }
      const applied = observation.status === "observed" && observation.data.applied;
      return applied
        ? { evidenceState: "APPLIED", reason: { code: "TARGET_APPLIED", summary: "target reports applied" } }
        : { evidenceState: "NOT_APPLIED", reason: { code: "TARGET_ABSENT", summary: "target reports absent" } };
    }
  };
}

class EarlyReleaseAfterReserveStore {
  readonly releasedAfterReserve = deferred<void>();
  private releasedEarly = false;

  constructor(private readonly inner: any = new InMemoryStore()) {}

  async tryAcquireLock(identityId: string) {
    const lock = await this.inner.tryAcquireLock(identityId);
    if (!lock) return null;

    const wrapped = {
      getOperation: (id: string) => lock.store.getOperation(id),
      createOperation: (input: NewOperationInput) => lock.store.createOperation(input),
      reserveAttempt: async (id: string, reserved: ReservedAttemptInput, expectedVersion: number) => {
        const record = await lock.store.reserveAttempt(id, reserved, expectedVersion);
        if (!this.releasedEarly) {
          this.releasedEarly = true;
          await lock.release();
          this.releasedAfterReserve.resolve();
        }
        return record;
      },
      appendAttempt: (id: string, attempt: AttemptRecord, status: OperationStatus, expectedVersion: number) =>
        lock.store.appendAttempt(id, attempt, status, expectedVersion),
      updateLatestAttempt: (id: string, attempt: AttemptRecord, status: OperationStatus, expectedVersion: number) =>
        lock.store.updateLatestAttempt(id, attempt, status, expectedVersion),
      updateOperation: (id: string, update: OperationUpdate, expectedVersion: number) =>
        lock.store.updateOperation(id, update, expectedVersion),
      setStatus: (id: string, status: OperationStatus, expectedVersion: number) =>
        lock.store.setStatus(id, status, expectedVersion)
    } as unknown as CoordinatedStore;

    return {
      store: wrapped,
      release: async () => {
        await lock.release();
      }
    };
  }

  getOperation(identityId: string): Promise<OperationRecord | null> {
    return this.inner.getOperation(identityId);
  }

  createOperation(input: NewOperationInput): Promise<OperationRecord> {
    return this.inner.createOperation(input);
  }

  reserveAttempt(identityId: string, reserved: ReservedAttemptInput, expectedVersion: number): Promise<OperationRecord> {
    return this.inner.reserveAttempt(identityId, reserved, expectedVersion);
  }

  appendAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.inner.appendAttempt(identityId, attempt, status, expectedVersion);
  }

  updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.inner.updateLatestAttempt(identityId, attempt, status, expectedVersion);
  }

  updateOperation(identityId: string, update: OperationUpdate, expectedVersion: number): Promise<OperationRecord> {
    return this.inner.updateOperation(identityId, update, expectedVersion);
  }

  setStatus(identityId: string, status: OperationStatus, expectedVersion: number): Promise<OperationRecord> {
    return this.inner.setStatus(identityId, status, expectedVersion);
  }
}

class ConcurrentReservationStore {
  private readonly inner: any = new InMemoryStore();
  private readonly readGate = deferred<void>();
  private coordinatedEmptyReads = 0;

  constructor(private readonly raceIdentityId: string) {}

  async tryAcquireLock() {
    const lockStore = {
      getOperation: async (id: string) => {
        const record = await this.inner.getOperation(id);
        if (id === this.raceIdentityId && record?.attempts.length === 0) {
          this.coordinatedEmptyReads += 1;
          if (this.coordinatedEmptyReads === 2) {
            this.readGate.resolve();
          }
          await this.readGate.promise;
        }
        return record;
      },
      createOperation: (input: NewOperationInput) => this.inner.createOperation(input),
      reserveAttempt: (id: string, reserved: ReservedAttemptInput, expectedVersion: number) =>
        this.inner.reserveAttempt(id, reserved, expectedVersion),
      appendAttempt: (id: string, attempt: AttemptRecord, status: OperationStatus, expectedVersion: number) =>
        this.inner.appendAttempt(id, attempt, status, expectedVersion),
      updateLatestAttempt: (id: string, attempt: AttemptRecord, status: OperationStatus, expectedVersion: number) =>
        this.inner.updateLatestAttempt(id, attempt, status, expectedVersion),
      updateOperation: (id: string, update: OperationUpdate, expectedVersion: number) =>
        this.inner.updateOperation(id, update, expectedVersion),
      setStatus: (id: string, status: OperationStatus, expectedVersion: number) =>
        this.inner.setStatus(id, status, expectedVersion)
    } as unknown as CoordinatedStore;

    return { store: lockStore, release: async () => undefined };
  }

  getOperation(identityId: string): Promise<OperationRecord | null> {
    return this.inner.getOperation(identityId);
  }

  createOperation(input: NewOperationInput): Promise<OperationRecord> {
    return this.inner.createOperation(input);
  }

  reserveAttempt(identityId: string, reserved: ReservedAttemptInput, expectedVersion: number): Promise<OperationRecord> {
    return this.inner.reserveAttempt(identityId, reserved, expectedVersion);
  }

  appendAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.inner.appendAttempt(identityId, attempt, status, expectedVersion);
  }

  updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.inner.updateLatestAttempt(identityId, attempt, status, expectedVersion);
  }

  updateOperation(identityId: string, update: OperationUpdate, expectedVersion: number): Promise<OperationRecord> {
    return this.inner.updateOperation(identityId, update, expectedVersion);
  }

  setStatus(identityId: string, status: OperationStatus, expectedVersion: number): Promise<OperationRecord> {
    return this.inner.setStatus(identityId, status, expectedVersion);
  }
}

describe("fencing and settlement adversarial behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_TIME));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fences every store write with version and reports StoreConflictError metadata", async () => {
    // Intent: stale callers must fail writes with StoreConflictError instead of overwriting newer truth.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const created = await store.createOperation({
      identity: { id: "cas-direct-1", operationType: "test/cas-direct" },
      intent: {},
      status: "OPEN"
    });

    expect(created.version).toBe(0);
    const reserved = await store.reserveAttempt(
      created.identity.id,
      { attemptNumber: 1, startedAt: BASE_TIME },
      created.version
    );
    expect(reserved.version).toBe(1);

    try {
      await store.setStatus(created.identity.id, "CLOSED", created.version);
      throw new Error("expected stale setStatus to conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreConflictError);
      expect(err).toMatchObject({ identityId: created.identity.id, expectedVersion: 0, actualVersion: 1 });
    }
    expect(target.effectCount).toBe(0);
  });

  it("holds retry until settlement after lock loss while the original execute is still in flight", async () => {
    // Intent: if A loses its lock mid-execute, B and C must not duplicate the side effect before settlement.
    const target = new FakeExternalTarget();
    const store = new EarlyReleaseAfterReserveStore();
    const enteredExecute = deferred<void>();
    const allowLanding = deferred<void>();
    const identity = { id: "lock-loss-1", operationType: "test/lock-loss" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 1000,
      execute: async () => {
        target.executeCalls += 1;
        if (target.executeCalls > 1) {
          target.land();
          return { duplicate: true };
        }
        enteredExecute.resolve();
        await allowLanding.promise;
        target.land();
        return { ok: true };
      }
    });

    const callA = runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    await enteredExecute.promise;
    await store.releasedAfterReserve.promise;

    vi.setSystemTime(new Date("2026-01-01T00:00:00.100Z"));
    const resultB = await runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    expect(resultB.disposition).toBe("RETRY");
    expect(resultB.dispositionReason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
    expect(resultB.retryNotBefore).toBe("2026-01-01T00:00:01.000Z");
    expect(target.effectCount).toBe(0);
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(1);

    const resultC = await runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    expect(resultC.dispositionReason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(1);

    allowLanding.resolve();
    const resultA = await callA;
    expect(resultA.dispositionReason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
    expect(target.effectCount).toBe(1);
    expect(target.executeCalls).toBe(1);
  });

  it("returns fresh truth when A's stale final write races after B has resolved the attempt", async () => {
    // Intent: a stale A must resolve without throwing and must not replace B's resolved attempt.
    const target = new FakeExternalTarget();
    const store = new EarlyReleaseAfterReserveStore();
    const enteredExecute = deferred<void>();
    const allowExecuteReturn = deferred<void>();
    const identity = { id: "stale-final-write-1", operationType: "test/stale-final-write" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 1000,
      execute: async () => {
        target.executeCalls += 1;
        target.land();
        enteredExecute.resolve();
        await allowExecuteReturn.promise;
        return { ok: true };
      },
      observe: async () => target.observe(`observe-${target.observeCalls + 1}`)
    });

    const callA = runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    await enteredExecute.promise;
    await store.releasedAfterReserve.promise;

    const resultB = await runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    expect(resultB.disposition).toBe("COMPLETE");
    expect(resultB.observation?.source).toBe("observe-1");

    allowExecuteReturn.resolve();
    const resultA = await callA;
    const record = await store.getOperation(identity.id);
    const latest = record?.attempts[0];

    expect(resultA.disposition).toBe("COMPLETE");
    expect(resultA.observation?.source).toBe("observe-1");
    expect(latest?.status).toBe("RESOLVED");
    expect(latest?.status === "RESOLVED" ? latest.observations.map((o) => o.source) : []).toEqual(["observe-1"]);
    expect(target.effectCount).toBe(1);
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(2);
  });

  it("catches a late landing with the settlement observation before starting a retry", async () => {
    // Intent: after retryNotBefore, APPLIED from the settlement observation must close without a second execute.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "late-landing-1", operationType: "test/late-landing" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 1000,
      execute: async () => {
        target.executeCalls += 1;
        throw new Error("client timed out");
      }
    });

    const first = await runEffect(store, contract, { identity, intent: {} });
    expect(first.dispositionReason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
    expect(first.retryNotBefore).toBe("2026-01-01T00:00:01.000Z");
    expect(target.effectCount).toBe(0);

    target.land();
    vi.setSystemTime(new Date(first.retryNotBefore!));
    const second = await runEffect(store, contract, { identity, intent: {} });

    expect(second.evidenceState).toBe("APPLIED");
    expect(second.disposition).toBe("COMPLETE");
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(2);
    expect(target.effectCount).toBe(1);
  });

  it("returns cached RETRY before retryNotBefore without executing or observing", async () => {
    // Intent: the settlement delay must be a hard gate; early callers get the current record only.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "before-retry-not-before-1", operationType: "test/before-retry-not-before" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 5000,
      execute: async () => {
        target.executeCalls += 1;
        throw new Error("timeout");
      }
    });

    const first = await runEffect(store, contract, { identity, intent: {} });
    vi.setSystemTime(new Date("2026-01-01T00:00:04.999Z"));
    const second = await runEffect(store, contract, { identity, intent: {} });

    expect(first.retryNotBefore).toBe("2026-01-01T00:00:05.000Z");
    expect(second.retryNotBefore).toBe(first.retryNotBefore);
    expect(second.dispositionReason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(1);
    expect(target.effectCount).toBe(0);
  });

  it("investigates NOT_APPLIED after an unknown transport when no maxInFlightMs is declared", async () => {
    // Intent: without a settlement bound, NOT_APPLIED after transport failure is not safe to retry.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "no-max-inflight-1", operationType: "test/no-max-inflight" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      execute: async () => {
        target.executeCalls += 1;
        throw new Error("timeout");
      }
    });

    const result = await runEffect(store, contract, { identity, intent: {} });

    expect(result.evidenceState).toBe("NOT_APPLIED");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(result.dispositionReason.code).toBe("IN_FLIGHT_NOT_RULED_OUT");
    expect(result.retryNotBefore).toBeNull();
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(1);
    expect(target.effectCount).toBe(0);
  });

  it("retries immediately when transport ok:true proves the request is no longer in flight", async () => {
    // Intent: maxInFlightMs must not delay ok:true + NOT_APPLIED, which remains SAFE_RETRY.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "transport-ok-retry-1", operationType: "test/transport-ok-retry" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 60_000,
      execute: async () => {
        target.executeCalls += 1;
        if (target.executeCalls === 2) {
          target.land();
        }
        return { accepted: target.executeCalls === 2 };
      }
    });

    const first = await runEffect(store, contract, { identity, intent: {} });
    const second = await runEffect(store, contract, { identity, intent: {} });

    expect(first.disposition).toBe("RETRY");
    expect(first.dispositionReason.code).toBe("SAFE_RETRY");
    expect(first.retryNotBefore).toBeNull();
    expect(second.disposition).toBe("COMPLETE");
    expect(target.executeCalls).toBe(2);
    expect(target.effectCount).toBe(1);
  });

  it("allows only one execution when two callers race to reserve the same attempt number", async () => {
    // Intent: version fencing on reserveAttempt must turn a double-reserve race into one execute.
    const target = new FakeExternalTarget();
    const identity = { id: "double-reserve-1", operationType: "test/double-reserve" };
    const store = new ConcurrentReservationStore(identity.id);
    const enteredExecute = deferred<void>();
    const allowExecute = deferred<void>();
    await store.createOperation({ identity, intent: {}, status: "OPEN" });
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      execute: async () => {
        target.executeCalls += 1;
        enteredExecute.resolve();
        await allowExecute.promise;
        target.land();
        return { ok: true };
      }
    });

    const callA = runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    const callB = runEffect(store as unknown as EffectStore, contract, { identity, intent: {} });
    await enteredExecute.promise;
    expect(target.executeCalls).toBe(1);

    allowExecute.resolve();
    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect([resultA.disposition, resultB.disposition]).toContain("COMPLETE");
    expect(target.executeCalls).toBe(1);
    expect(target.effectCount).toBe(1);
  });

  it("treats maxInFlightMs: 0 as immediately settled and retries in the same timestamp", async () => {
    // Intent: a zero settlement window must produce SAFE_RETRY without retryNotBefore delay.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "zero-inflight-1", operationType: "test/zero-inflight" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 0,
      execute: async () => {
        target.executeCalls += 1;
        if (target.executeCalls === 2) {
          target.land();
          return { ok: true };
        }
        throw new Error("timeout before request left process");
      }
    });

    const first = await runEffect(store, contract, { identity, intent: {} });
    const second = await runEffect(store, contract, { identity, intent: {} });

    expect(first.disposition).toBe("RETRY");
    expect(first.dispositionReason.code).toBe("SAFE_RETRY");
    expect(first.retryNotBefore).toBeNull();
    expect(second.disposition).toBe("COMPLETE");
    expect(target.executeCalls).toBe(2);
    expect(target.effectCount).toBe(1);
  });

  it("does not execute when the settlement observation itself fails", async () => {
    // Intent: observation_failed during settlement must resolve UNKNOWN/INVESTIGATE without a retry attempt.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "settlement-observe-fails-1", operationType: "test/settlement-observe-fails" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 1000,
      execute: async () => {
        target.executeCalls += 1;
        throw new Error("timeout");
      },
      observe: async () => {
        if (target.observeCalls === 0) {
          return target.observe("initial-observe");
        }
        target.observeCalls += 1;
        throw new Error("readback unavailable during settlement");
      }
    });

    const first = await runEffect(store, contract, { identity, intent: {} });
    vi.setSystemTime(new Date(first.retryNotBefore!));
    const second = await runEffect(store, contract, { identity, intent: {} });

    expect(second.evidenceState).toBe("UNKNOWN");
    expect(second.disposition).toBe("INVESTIGATE");
    expect(second.observation?.status).toBe("observation_failed");
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(2);
    expect(target.effectCount).toBe(0);
  });

  it("survives a non-cloneable thrown value in InMemoryStore and remains readable on the second call", async () => {
    // Intent: InMemoryStore must preserve raw thrown values without letting structuredClone abort persistence.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "non-cloneable-error-1", operationType: "test/non-cloneable-error" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      execute: async () => {
        target.executeCalls += 1;
        throw { message: "function-bearing error", fn() {} };
      }
    });

    const first = await runEffect(store, contract, { identity, intent: {} });
    const second = await runEffect(store, contract, { identity, intent: {} });

    expect(first.disposition).toBe("INVESTIGATE");
    expect(first.dispositionReason.code).toBe("IN_FLIGHT_NOT_RULED_OUT");
    expect(second.disposition).toBe("INVESTIGATE");
    expect(target.executeCalls).toBe(1);
    expect(target.effectCount).toBe(0);
  });

  it("computes retryNotBefore from attemptStartedAt, not from the later observation time", async () => {
    // Intent: slow readback must not extend or shrink the settlement window by using observedAt as the start.
    const target = new FakeExternalTarget();
    const store = new InMemoryStore();
    const identity = { id: "retry-not-before-origin-1", operationType: "test/retry-not-before-origin" };
    const contract = makeContract({
      operationType: identity.operationType,
      target,
      maxInFlightMs: 60_000,
      execute: async () => {
        target.executeCalls += 1;
        vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
        throw new Error("timeout after a slow request");
      }
    });

    const result = await runEffect(store, contract, { identity, intent: {} });

    expect(result.disposition).toBe("RETRY");
    expect(result.dispositionReason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
    expect(result.retryNotBefore).toBe("2026-01-01T00:01:00.000Z");
    expect(result.observation?.observedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(target.executeCalls).toBe(1);
    expect(target.observeCalls).toBe(1);
    expect(target.effectCount).toBe(0);
  });
});
