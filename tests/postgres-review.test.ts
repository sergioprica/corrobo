import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "../src/stores/postgres";
import { OperationBusyError, reviewEffect, runEffect } from "../src/core/runtime";
import { fingerprintIntent } from "../src/core/fingerprint";
import { defineContract, observed, reconciled } from "../src/core/helpers";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

/** Recorded review decisions against a real Postgres (see tests/review-approval.test.ts). */
describe.skipIf(!connectionString)("PostgresStore: recorded review decisions", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
  });

  beforeEach(async () => {
    await PostgresStore.migrate(pool);
    await pool.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await pool.end();
  });

  const credits: string[] = [];
  const contract = defineContract<{ orderId: string }>()({
    operationType: "pg/refund",
    retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
    authorize: () => ({ requiresReview: true }),
    execute: async ({ identity }) => {
      credits.push(identity.id);
      return {};
    },
    observe: async ({ identity }) =>
      observed(credits.filter((c) => c === identity.id).length, { source: "ledger", authoritative: true }),
    reconcile: ({ observation }) =>
      observation.status === "observed" && observation.data > 0
        ? reconciled("APPLIED", "REFUNDED", "refunded")
        : reconciled("NOT_APPLIED", "NONE", "none")
  });

  it("migrate() adds the review column to an older table and keeps its rows", async () => {
    await pool.query("ALTER TABLE corrobo_operations DROP COLUMN IF EXISTS review");
    await pool.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, attempts, version)
       VALUES ('old-r', 'pg/refund', '{"orderId":"1"}', 'CLOSED', '[]', 2)`
    );
    await PostgresStore.migrate(pool);
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const old = await store.getOperation("old-r");
    expect(old).toMatchObject({ status: "CLOSED", version: 2 });
    expect(old?.review).toBeUndefined();
    // A 0.3.x rejection (CLOSED, no attempts, no review record) still reads as rejected.
    const result = await runEffect(store, contract, { identity: "old-r", intent: { orderId: "1" } });
    expect(result.dispositionReason.code).toBe("POLICY_REVIEW_REJECTED");
  });

  it("a row approved under 0.3.x (OPEN, a review reason, no recorded decision) needs a new review before any attempt", async () => {
    await pool.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, review_reason, attempts, version)
       VALUES ('old-approved', 'pg/refund', '{"orderId":"9"}', 'OPEN',
               '{"code":"POLICY_REVIEW_REQUIRED","summary":"needs review"}', '[]', 2)`
    );
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const result = await runEffect(store, contract, { identity: "old-approved", intent: { orderId: "9" } });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_NOT_RECORDED" } });
    expect(credits).not.toContain("old-approved");
  });

  it("an approval survives a restart: the review, and the approval on the attempt it allowed, read back exactly", async () => {
    const intent = { orderId: "7" };
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    await runEffect(store, contract, { identity: "pg-a1", intent });
    // The review screen and the worker are different processes.
    const reviewPool = new Pool({ connectionString });
    try {
      await reviewEffect(new PostgresStore(reviewPool, { acknowledgePersistence: true }), contract, {
        identity: "pg-a1",
        decision: {
          decision: "approved",
          reviewer: "alice@example.com",
          decidedAt: "2026-10-01T11:59:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          note: "ok"
        }
      });
    } finally {
      await reviewPool.end();
    }
    expect(credits.filter((c) => c === "pg-a1")).toHaveLength(0);
    const result = await runEffect(store, contract, { identity: "pg-a1", intent });
    expect(result.disposition).toBe("COMPLETE");

    const restarted = new Pool({ connectionString });
    try {
      const record = await new PostgresStore(restarted, { acknowledgePersistence: true }).getOperation("pg-a1");
      expect(record?.review).toEqual(result.review);
      expect(record?.review).toMatchObject({
        reviewer: "alice@example.com",
        decidedAt: "2026-10-01T11:59:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        intentFingerprint: fingerprintIntent(contract, intent)
      });
      expect(record?.attempts[0].check?.approval).toEqual(result.review);
    } finally {
      await restarted.end();
    }
    expect(credits.filter((c) => c === "pg-a1")).toHaveLength(1);
  });

  it("a rejection is recorded with the reviewer and reported from a fresh read", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    await runEffect(store, contract, { identity: "pg-r1", intent: { orderId: "8" } });
    await reviewEffect(store, contract, { identity: "pg-r1", decision: { decision: "rejected", reviewer: "carol" } });
    const reread = await runEffect(new PostgresStore(pool, { acknowledgePersistence: true }), contract, {
      identity: "pg-r1",
      intent: { orderId: "8" }
    });
    expect(reread).toMatchObject({
      status: "CLOSED",
      dispositionReason: { code: "POLICY_REVIEW_REJECTED" },
      review: { decision: "rejected", reviewer: "carol" }
    });
    expect(credits).not.toContain("pg-r1");
  });

  it("reviewEffect() throws OperationBusyError while another process holds the operation's advisory lock", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    await runEffect(store, contract, { identity: "pg-busy", intent: { orderId: "10" } });
    const otherPool = new Pool({ connectionString });
    const lock = await new PostgresStore(otherPool, { acknowledgePersistence: true }).tryAcquireLock("pg-busy");
    try {
      await expect(
        reviewEffect(store, contract, { identity: "pg-busy", decision: { decision: "approved", reviewer: "alice" } })
      ).rejects.toBeInstanceOf(OperationBusyError);
    } finally {
      await lock?.release();
      await otherPool.end();
    }
    expect((await store.getOperation("pg-busy"))?.review).toBeUndefined();
  });
});
