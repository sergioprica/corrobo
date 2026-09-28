import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { runEffect } from "../src/core/runtime";
import { StoreConflictError } from "../src/core/store";
import type { EffectContract, ResolvedAttempt } from "../src/core/types";
import { PostgresStore } from "../src/stores/postgres";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe.skipIf(!connectionString)("PostgresStore fencing", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await PostgresStore.migrate(admin);
  });

  beforeEach(async () => {
    await admin.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await admin.end();
  });

  it("a write based on a stale version is rejected and changes nothing", async () => {
    const store = new PostgresStore(admin, { acknowledgePersistence: true });
    await store.createOperation({ identity: { id: "pf1", operationType: "t" }, intent: {}, status: "OPEN" });
    const reserved = await store.reserveAttempt("pf1", { attemptNumber: 1, startedAt: new Date().toISOString() }, 0);
    expect(reserved.version).toBe(1);

    const stale = store.updateLatestAttempt(
      "pf1",
      { status: "RESERVED", attemptNumber: 1, startedAt: "x", updatedAt: "x" },
      "CLOSED",
      0
    );
    await expect(stale).rejects.toBeInstanceOf(StoreConflictError);
    await expect(stale).rejects.toMatchObject({ expectedVersion: 0, actualVersion: 1 });
    const row = await store.getOperation("pf1");
    expect(row?.status).toBe("OPEN");
    expect(row?.version).toBe(1);
  });

  it("updateLatestAttempt on an operation with no attempts throws instead of writing", async () => {
    const store = new PostgresStore(admin, { acknowledgePersistence: true });
    await store.createOperation({ identity: { id: "pf2", operationType: "t" }, intent: {}, status: "OPEN" });
    await expect(
      store.updateLatestAttempt("pf2", { status: "RESERVED", attemptNumber: 1, startedAt: "x", updatedAt: "x" }, "OPEN", 0)
    ).rejects.toThrow(/no attempt to update/);
    expect((await store.getOperation("pf2"))?.version).toBe(0);
  });

  it("a duplicate create is a StoreConflictError (message still says 'already exists')", async () => {
    const store = new PostgresStore(admin, { acknowledgePersistence: true });
    await store.createOperation({ identity: { id: "pf3", operationType: "t" }, intent: {}, status: "OPEN" });
    const dup = store.createOperation({ identity: { id: "pf3", operationType: "t" }, intent: {}, status: "OPEN" });
    await expect(dup).rejects.toBeInstanceOf(StoreConflictError);
    await expect(dup).rejects.toThrow(/already exists/);
  });

  it("the lock session is killed mid-execute: no duplicate external effect, and the stale pass never overwrites", async () => {
    const target = { applied: 0, executeCalls: 0 };
    const inExecute = deferred();
    const land = deferred();
    let hold = true;
    const contract: EffectContract<Record<string, never>, { applied: number }, unknown> = {
      operationType: "test/pg-lock-loss",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      async execute() {
        target.executeCalls += 1;
        if (hold) {
          hold = false;
          inExecute.resolve();
          await land.promise;
        }
        target.applied += 1;
        return { ok: true };
      },
      async observe() {
        return { status: "observed", data: { applied: target.applied }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: ({ observation }) =>
        observation.status === "observed" && observation.data.applied > 0
          ? { evidenceState: "APPLIED", reason: { code: "FOUND", summary: "found" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "absent" } }
    };
    const identity = { id: "pg-lock-loss-1", operationType: contract.operationType };

    const poolA = new Pool({ connectionString });
    const poolB = new Pool({ connectionString });
    const storeA = new PostgresStore(poolA, { acknowledgePersistence: true });
    const storeB = new PostgresStore(poolB, { acknowledgePersistence: true });

    const a = runEffect(storeA, contract, { identity, intent: {} });
    await inExecute.promise;

    // Kill the session holding A's advisory lock, as a network blip or DB failover would.
    const locks = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()"
    );
    expect(locks.rows).toHaveLength(1);
    await admin.query("SELECT pg_terminate_backend($1)", [locks.rows[0].pid]);

    // B now gets the lock, finds attempt 1 RESERVED, and recovers without executing.
    const b = await runEffect(storeB, contract, { identity, intent: {} });
    expect(b.evidenceState).toBe("NOT_APPLIED");
    expect(b.disposition).toBe("INVESTIGATE");
    expect(target.executeCalls).toBe(1);

    // A's request lands; A's final write fails on its dead connection — never overwrites B.
    land.resolve();
    await expect(a).rejects.toThrow();
    expect(target.applied).toBe(1);

    const c = await runEffect(storeB, contract, { identity, intent: {} });
    expect(c.disposition).toBe("INVESTIGATE"); // closed; an operator decides, nobody re-executes
    expect(target.executeCalls).toBe(1);
    const stored = await storeB.getOperation(identity.id);
    expect((stored?.attempts[0] as ResolvedAttempt).dispositionReason.code).toBe("IN_FLIGHT_NOT_RULED_OUT");

    await poolA.end();
    await poolB.end();
  });

  it("migrate() upgrades a corrobo 0.2.x table in place, and an old RESERVED row still recovers", async () => {
    await admin.query("DROP TABLE corrobo_operations");
    await admin.query(`
      CREATE TABLE corrobo_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        intent JSONB NOT NULL,
        status TEXT NOT NULL,
        review_reason JSONB,
        attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const reserved = { status: "RESERVED", attemptNumber: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await admin.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, attempts) VALUES ('old-1', 'test/old', '{}', 'OPEN', $1::jsonb)`,
      [JSON.stringify([reserved])]
    );

    await PostgresStore.migrate(admin);
    await PostgresStore.migrate(admin); // idempotent

    const store = new PostgresStore(admin, { acknowledgePersistence: true });
    const record = await store.getOperation("old-1");
    expect(record?.version).toBe(0);

    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/old",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      async execute() {
        throw new Error("must not be called during recovery");
      },
      async observe() {
        return { status: "observed", data: {}, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "FOUND", summary: "found" } })
    };
    const result = await runEffect(store, contract, { identity: { id: "old-1", operationType: "test/old" }, intent: {} });
    expect(result.evidenceState).toBe("APPLIED");
    expect((await store.getOperation("old-1"))?.version).toBe(1);
  });
});

describe("PostgresStore lock release", () => {
  it("if unlocking fails, the connection is destroyed (ending its session) and release() does not throw", async () => {
    const releaseArgs: unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
        if (sql.includes("pg_advisory_unlock")) throw new Error("connection terminated");
        return { rows: [] };
      }),
      release: (arg?: unknown) => {
        releaseArgs.push(arg);
      },
      on: () => client,
      off: () => client
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const store = new PostgresStore(pool, { acknowledgePersistence: true });

    const lock = await store.tryAcquireLock("x");
    expect(lock).not.toBeNull();
    await expect(lock!.release()).resolves.toBeUndefined();
    expect(releaseArgs).toHaveLength(1);
    expect(releaseArgs[0]).toBeInstanceOf(Error); // release(err) => pg destroys the client
  });
});

describe.skipIf(!connectionString)("PostgresStore clock", () => {
  it("now() reads the database server's clock", async () => {
    const pool = new Pool({ connectionString });
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const dbNow = await store.now();
    const serverNow = (await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0].t;
    expect(Math.abs(serverNow.getTime() - dbNow.getTime())).toBeLessThan(1_000);
    await pool.end();
  });
});
