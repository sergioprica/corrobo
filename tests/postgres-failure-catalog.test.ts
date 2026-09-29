import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";
import { PostgresStore } from "../src/stores/postgres";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

/** Failure-catalog rows (docs/failure-matrix.md) that need a real Postgres round trip. */
describe.skipIf(!connectionString)("PostgresStore: persistence-path failure catalog", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await PostgresStore.migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await pool.end();
  });

  function contractFor<Intent>(target: { effects: number }, execute?: () => Promise<unknown>): EffectContract<Intent, { effects: number }, unknown> {
    return {
      operationType: "test/pg-catalog",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      execute:
        execute ??
        (async () => {
          target.effects += 1;
          return { ok: true };
        }),
      async observe() {
        return { status: "observed", data: { effects: target.effects }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: ({ observation }) =>
        observation.status === "observed" && observation.data.effects > 0
          ? { evidenceState: "APPLIED", reason: { code: "FOUND", summary: "found" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "absent" } }
    };
  }

  it("an intent containing a Date matches itself after the Postgres round trip, and a different Date is a loud conflict", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const target = { effects: 0 };
    const contract = contractFor<{ refundBy: Date }>(target);
    const identity = { id: "date-1", operationType: contract.operationType };

    await runEffect(store, contract, { identity, intent: { refundBy: new Date("2026-10-01T00:00:00.000Z") } });
    const again = await runEffect(store, contract, { identity, intent: { refundBy: new Date("2026-10-01T00:00:00.000Z") } });
    expect(again.disposition).toBe("COMPLETE");

    await expect(
      runEffect(store, contract, { identity, intent: { refundBy: new Date("2027-10-01T00:00:00.000Z") } })
    ).rejects.toThrow(/different intent/);
    expect(target.effects).toBe(1);
  });

  it("a circular intent is rejected before any effect or row", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const target = { effects: 0 };
    const intent: Record<string, unknown> = { a: 1 };
    intent.self = intent;
    await expect(
      runEffect(store, contractFor<Record<string, unknown>>(target), { identity: { id: "circ-pg", operationType: "test/pg-catalog" }, intent })
    ).rejects.toThrow(/circular reference/);
    expect(target.effects).toBe(0);
    expect(await store.getOperation("circ-pg")).toBeNull();
  });

  it("execute() succeeds but returns data Postgres can't store: the pass throws, the reservation survives, the next run observes — one effect", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const target = { effects: 0 };
    const contract = contractFor<Record<string, never>>(target, async () => {
      target.effects += 1;
      const evidence: Record<string, unknown> = { id: "x" };
      evidence.self = evidence; // e.g. an SDK response object with back-references
      return evidence;
    });
    const identity = { id: "circ-evidence", operationType: contract.operationType };

    await expect(runEffect(store, contract, { identity, intent: {} })).rejects.toThrow(/circular/i);
    expect((await store.getOperation(identity.id))?.attempts[0].status).toBe("RESERVED");

    const recovered = await runEffect(store, contract, { identity, intent: {} });
    expect(recovered.evidenceState).toBe("APPLIED");
    expect(recovered.disposition).toBe("COMPLETE");
    expect(target.effects).toBe(1);
  });
});

describe.skipIf(!connectionString)("PostgresStore: exact round trip and connection failures", () => {
  it("nested evidence, observations and reason metadata come back from a fresh pool exactly as written", async () => {
    const poolA = new Pool({ connectionString });
    await PostgresStore.migrate(poolA);
    await poolA.query("TRUNCATE corrobo_operations");
    const evidence = { refund: { id: "re_1", lines: [{ sku: "a", qty: 2 }, { sku: "b", qty: 1 }] }, http: 201 };
    const contract: EffectContract<{ order: { id: string; items: string[] } }, { refunds: { id: string }[] }, typeof evidence> = {
      operationType: "test/roundtrip",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      execute: async () => evidence,
      observe: async () => ({ status: "observed", data: { refunds: [{ id: "re_1" }] }, authoritative: true, source: "t", observedAt: "2026-01-01T00:00:00.000Z" }),
      reconcile: () => ({
        evidenceState: "APPLIED",
        reason: { code: "FOUND", summary: "found", metadata: { outer: { inner: ["x", { deep: true }] }, n: 1.5 } }
      })
    };
    const intent = { order: { id: "o1", items: ["a", "b"] } };
    const result = await runEffect(new PostgresStore(poolA, { acknowledgePersistence: true }), contract, {
      identity: { id: "rt-1", operationType: contract.operationType },
      intent
    });
    await poolA.end();

    const poolB = new Pool({ connectionString });
    const reloaded = await new PostgresStore(poolB, { acknowledgePersistence: true }).getOperation("rt-1");
    await poolB.end();
    expect(reloaded?.intent).toEqual(intent);
    expect(reloaded?.attempts).toEqual(result.attempts);
  });

  it("the pool can't hand out a connection: the error surfaces, nothing is executed or written", async () => {
    let executed = 0;
    const brokenPool = { connect: async () => { throw new Error("connection refused"); }, query: async () => { throw new Error("connection refused"); } } as unknown as Pool;
    const store = new PostgresStore(brokenPool, { acknowledgePersistence: true });
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/no-db",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        executed += 1;
        return {};
      },
      observe: async () => ({ status: "observed", data: {}, authoritative: true, source: "t", observedAt: new Date().toISOString() }),
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "A", summary: "a" } })
    };
    await expect(runEffect(store, contract, { identity: { id: "x", operationType: "test/no-db" }, intent: {} })).rejects.toThrow(
      /connection refused/
    );
    expect(executed).toBe(0);
  });
});
