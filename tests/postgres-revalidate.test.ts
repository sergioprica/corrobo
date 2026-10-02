import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import { StoreConflictError } from "../src/core/store";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { RevalidationResult } from "../src/core/types";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

/** revalidate() results and updateOperation() against a real Postgres (see tests/revalidate.test.ts). */
describe.skipIf(!connectionString)("PostgresStore: revalidate() and updateOperation()", () => {
  let pool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    store = new PostgresStore(pool, { acknowledgePersistence: true });
  });

  beforeEach(async () => {
    await PostgresStore.migrate(pool);
    await pool.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await pool.end();
  });

  function contract(credits: string[], revalidate: () => RevalidationResult) {
    return defineContract<{ amount: number }>()({
      operationType: "pg/credit",
      retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
      execute: async ({ identity }) => {
        credits.push(identity.id);
        return { ok: true };
      },
      observe: async ({ identity }) =>
        observed(credits.filter((c) => c === identity.id).length, { source: "ledger", authoritative: true }),
      reconcile: ({ observation }) =>
        observation.status === "observed" && observation.data > 0
          ? reconciled("APPLIED", "CREDITED", "credited")
          : reconciled("NOT_APPLIED", "NONE", "none"),
      revalidate
    });
  }

  it("migrate() upgrades a 0.3.x table in place (adds blocked_by) and keeps its rows", async () => {
    await pool.query("ALTER TABLE corrobo_operations DROP COLUMN IF EXISTS blocked_by");
    await pool.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, attempts, version)
       VALUES ('old-1', 'pg/credit', '{"amount":1}', 'OPEN', '[]', 3)`
    );
    await PostgresStore.migrate(pool);
    const old = await store.getOperation("old-1");
    expect(old).toMatchObject({ status: "OPEN", version: 3 });
    expect(old?.blockedBy).toBeUndefined();
  });

  it("a reject is persisted on the operation and reported from a fresh read", async () => {
    const credits: string[] = [];
    await runEffect(store, contract(credits, () => ({ decision: "reject", reason: { code: "CANCELLED", summary: "cancelled" } })), {
      identity: "pg-r1",
      intent: { amount: 1 }
    });
    const record = await new PostgresStore(pool, { acknowledgePersistence: true }).getOperation("pg-r1");
    expect(record).toMatchObject({
      status: "CLOSED",
      attempts: [],
      blockedBy: { outcome: "reject", reason: { code: "CANCELLED" }, attemptNumber: 1, recordVersion: record?.version }
    });
    expect(credits).toEqual([]);
  });

  it("requiresReview sets status, review reason and blockedBy in one write; a failure keeps the operation OPEN", async () => {
    const credits: string[] = [];
    const waiting = await runEffect(store, contract(credits, () => ({ decision: "requiresReview" })), {
      identity: "pg-r2",
      intent: { amount: 1 }
    });
    expect(waiting).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "REVALIDATION_REQUIRES_REVIEW" } });
    const record = await store.getOperation("pg-r2");
    expect(record).toMatchObject({ version: 1, reviewReason: { code: "REVALIDATION_REQUIRES_REVIEW" } });

    const failed = await runEffect(
      store,
      contract(credits, () => {
        throw new Error("down");
      }),
      { identity: "pg-r3", intent: { amount: 1 } }
    );
    expect(failed).toMatchObject({ status: "OPEN", disposition: null, dispositionReason: { code: "REVALIDATION_FAILED" } });
    expect((await store.getOperation("pg-r3"))?.blockedBy?.outcome).toBe("failed");
    expect(credits).toEqual([]);
  });

  it("a proceed is recorded on the attempt, with the database clock", async () => {
    const credits: string[] = [];
    const before = Date.now();
    const result = await runEffect(store, contract(credits, () => ({ decision: "proceed" })), {
      identity: "pg-r4",
      intent: { amount: 1 }
    });
    const attempt = (await store.getOperation("pg-r4"))?.attempts[0];
    expect(attempt?.check).toMatchObject({ outcome: "proceed", attemptNumber: 1 });
    expect(Math.abs(Date.parse(attempt!.check!.checkedAt) - before)).toBeLessThan(60_000);
    expect(result.disposition).toBe("COMPLETE");
    expect(credits).toEqual(["pg-r4"]);
  });

  it("updateOperation changes only the fields given, null clears, and a stale version changes nothing", async () => {
    await store.createOperation({
      identity: { id: "pg-u1", operationType: "t" },
      intent: {},
      status: "AWAITING_REVIEW",
      reviewReason: { code: "R", summary: "r" }
    });
    const opened = await store.updateOperation("pg-u1", { status: "OPEN" }, 0);
    expect(opened).toMatchObject({ status: "OPEN", reviewReason: { code: "R" }, version: 1 });

    const cleared = await store.updateOperation("pg-u1", { reviewReason: null }, 1);
    expect(cleared.reviewReason).toBeUndefined();
    expect(cleared.status).toBe("OPEN");

    const stale = store.updateOperation("pg-u1", { status: "CLOSED" }, 1);
    await expect(stale).rejects.toBeInstanceOf(StoreConflictError);
    expect(await store.getOperation("pg-u1")).toMatchObject({ status: "OPEN", version: 2 });
  });
});
