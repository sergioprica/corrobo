import type { PgQueryable } from "corrobo/postgres";
import type { RefundRequest, RefundRequests, RefundRequestStatus } from "./refunds";

/** The app's own table. Its primary key is the corrobo identity (corrobo_operations.id). */
export const REFUND_REQUESTS_SQL = `
CREATE TABLE IF NOT EXISTS refund_requests (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * For operators: the app's view and corrobo's record side by side. Read-only; corrobo's table is
 * written only by runEffect(). A row whose status disagrees with corrobo's record (e.g.
 * 'confirmed' while corrobo says CLOSED) is one a crash interrupted; sweep() fixes it.
 */
export const ACTIONS_WITH_EVIDENCE_SQL = `
SELECT r.id,
       r.status                                AS app_status,
       r.receipt_id,
       o.status                                AS corrobo_status,
       o.attempts -> -1 ->> 'evidenceState'    AS evidence_state,
       o.attempts -> -1 ->> 'disposition'      AS disposition,
       jsonb_array_length(o.attempts)          AS attempts
FROM refund_requests r
LEFT JOIN corrobo_operations o ON o.id = r.id
ORDER BY r.created_at
`;

interface Row {
  id: string;
  order_id: string;
  amount_cents: number;
  requested_by: string;
  status: RefundRequestStatus;
  receipt_id: string | null;
}

const toRequest = (r: Row): RefundRequest => ({
  id: r.id,
  orderId: r.order_id,
  amountCents: r.amount_cents,
  requestedBy: r.requested_by,
  status: r.status,
  receiptId: r.receipt_id
});

export class PostgresRefundRequests implements RefundRequests {
  constructor(private readonly db: PgQueryable) {}

  async insert(row: RefundRequest): Promise<void> {
    await this.db.query(
      `INSERT INTO refund_requests (id, order_id, amount_cents, requested_by, status, receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.orderId, row.amountCents, row.requestedBy, row.status, row.receiptId]
    );
  }

  async get(id: string): Promise<RefundRequest | null> {
    const { rows } = await this.db.query(`SELECT * FROM refund_requests WHERE id = $1`, [id]);
    return rows[0] ? toRequest(rows[0] as Row) : null;
  }

  async setOutcome(id: string, status: RefundRequestStatus, receiptId: string | null): Promise<void> {
    await this.db.query(`UPDATE refund_requests SET status = $2, receipt_id = $3 WHERE id = $1`, [id, status, receiptId]);
  }

  async unfinished(): Promise<RefundRequest[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM refund_requests WHERE status IN ('confirmed', 'waiting') ORDER BY created_at`
    );
    return (rows as Row[]).map(toRequest);
  }
}
