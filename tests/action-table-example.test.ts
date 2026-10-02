import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/core/index";
import { PostgresStore } from "../src/stores/postgres";
import { createPaymentsApi } from "../examples/quickstart/payments-api";
import { confirmRefund, memoryRefundRequests, processRefund, sweep } from "../examples/action-table/refunds";
import { ACTIONS_WITH_EVIDENCE_SQL, PostgresRefundRequests, REFUND_REQUESTS_SQL } from "../examples/action-table/pg-table";

const root = join(__dirname, "..");

describe("examples/action-table", () => {
  it("demo: a crash between the effect and the app-row update is finished by the sweeper, with one refund", async () => {
    const { stdout } = await promisify(execFile)("npx", ["tsx", "examples/action-table/demo.ts"], { cwd: root });
    expect(stdout).toBe(
      "worker: process died before updating refund_requests\n" +
        "refund_requests says: confirmed\n" +
        "refund_requests says: refunded re_1\n" +
        "refunds made: 1\n"
    );
  }, 30_000);

  it("the app row's id is the corrobo identity, and processing it again never refunds again", async () => {
    const payments = createPaymentsApi();
    const store = new InMemoryStore();
    const table = memoryRefundRequests();
    const id = await confirmRefund(table, { orderId: "1", amountCents: 100, requestedBy: "u" });

    await processRefund(store, table, payments, id);
    await processRefund(store, table, payments, id);
    await table.setOutcome(id, "confirmed", null); // even a stale projection doesn't cause a second refund
    await sweep(store, table, payments);

    expect(payments.refundCount()).toBe(1);
    expect((await store.getOperation(id))?.identity.id).toBe(id);
    expect((await table.get(id))?.status).toBe("refunded");
  });

  it("the same intent confirmed twice is two decisions, two identities and two refunds", async () => {
    const payments = createPaymentsApi();
    const store = new InMemoryStore();
    const table = memoryRefundRequests();
    const first = await confirmRefund(table, { orderId: "1", amountCents: 100, requestedBy: "u" });
    const second = await confirmRefund(table, { orderId: "1", amountCents: 100, requestedBy: "u" });

    expect(first).not.toBe(second);
    await sweep(store, table, payments);
    expect(payments.refundCount()).toBe(2);
  });
});

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("examples/action-table with Postgres", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await PostgresStore.migrate(pool);
    await pool.query(REFUND_REQUESTS_SQL);
    await pool.query("TRUNCATE corrobo_operations");
    await pool.query("TRUNCATE refund_requests");
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS refund_requests");
    await pool.end();
  });

  it("a restarted worker finishes the row from corrobo's record, and the join shows both records agreeing", async () => {
    const payments = createPaymentsApi();
    const table = new PostgresRefundRequests(pool);
    const id = await confirmRefund(table, { orderId: "1001", amountCents: 5_000, requestedBy: "user:42" });

    payments.loseNextResponse();
    const first = new PostgresStore(pool, { acknowledgePersistence: true });
    await expect(processRefund(first, table, payments, id, { crashBeforeProjection: true })).rejects.toThrow(
      "process died"
    );

    const before = await pool.query(ACTIONS_WITH_EVIDENCE_SQL);
    expect(before.rows).toEqual([
      expect.objectContaining({ id, app_status: "confirmed", corrobo_status: "CLOSED", evidence_state: "APPLIED" })
    ]);

    const restartedPool = new Pool({ connectionString });
    try {
      await sweep(new PostgresStore(restartedPool, { acknowledgePersistence: true }), new PostgresRefundRequests(restartedPool), payments);
    } finally {
      await restartedPool.end();
    }

    const after = await pool.query(ACTIONS_WITH_EVIDENCE_SQL);
    expect(after.rows).toEqual([
      {
        id,
        app_status: "refunded",
        receipt_id: "re_1",
        corrobo_status: "CLOSED",
        evidence_state: "APPLIED",
        disposition: "COMPLETE",
        attempts: 1
      }
    ]);
    expect(payments.refundCount()).toBe(1);
  });
});
