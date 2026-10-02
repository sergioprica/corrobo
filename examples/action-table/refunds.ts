import { randomUUID } from "node:crypto";
import { defineContract, observed, reconciled, runEffect } from "corrobo";
import type { EffectResult, EffectStore } from "corrobo";
import type { Refund, createPaymentsApi } from "../quickstart/payments-api";

type Payments = ReturnType<typeof createPaymentsApi>;

export interface RefundIntent {
  orderId: string;
  amountCents: number;
}

/**
 * Your app's own row for one refund someone decided to make: a user clicking "Confirm", or an
 * agent's proposal being approved. Its `id` is minted once, at that moment, and is also the
 * corrobo identity, so the two records always share a key.
 */
export interface RefundRequest {
  id: string;
  orderId: string;
  amountCents: number;
  requestedBy: string;
  /** A projection of corrobo's result, rewritten after every pass. Never the source of truth. */
  status: RefundRequestStatus;
  receiptId: string | null;
}

export type RefundRequestStatus = "confirmed" | "refunded" | "waiting" | "needs_attention";

/** The app's action table. `memoryRefundRequests()` below, or `PostgresRefundRequests` in pg-table.ts. */
export interface RefundRequests {
  insert(row: RefundRequest): Promise<void>;
  get(id: string): Promise<RefundRequest | null>;
  setOutcome(id: string, status: RefundRequestStatus, receiptId: string | null): Promise<void>;
  /** Rows whose status isn't final yet: a sweeper runs these through processRefund() again. */
  unfinished(): Promise<RefundRequest[]>;
}

export function refundContract(payments: Payments) {
  return defineContract<RefundIntent>()({
    operationType: "payments/refund",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs: 10_000,
    execute: ({ intent, identity }) => payments.createRefund({ ...intent, reference: identity.id }),
    observe: async ({ identity }) =>
      observed(await payments.findRefunds(identity.id), { source: "payments.findRefunds", authoritative: true }),
    reconcile: ({ observation }) => {
      if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "Could not read refunds.");
      const found = observation.data.length;
      if (found === 0) return reconciled("NOT_APPLIED", "NO_REFUND", "No refund exists.");
      if (found === 1) return reconciled("APPLIED", "REFUNDED", "Exactly one refund exists.");
      return reconciled("CONFLICTED", "DUPLICATES", `${found} refunds exist.`);
    }
  });
}

/**
 * Step 1, when the action is confirmed: mint the identity here, server-side, once, and store it
 * with the action. Everything after this (retries, other workers, restarts) reads it from the row.
 */
export async function confirmRefund(
  table: RefundRequests,
  input: RefundIntent & { requestedBy: string }
): Promise<string> {
  const id = randomUUID();
  await table.insert({ id, ...input, status: "confirmed", receiptId: null });
  return id;
}

/**
 * Step 2, any number of times: run the effect for a row, then project corrobo's answer onto it.
 * Both the identity and the intent come from the row, so they always travel together.
 * Safe to call again for the same row (from a retry, a sweeper, another worker): corrobo
 * returns the recorded outcome instead of refunding again.
 */
export async function processRefund(
  store: EffectStore,
  table: RefundRequests,
  payments: Payments,
  id: string,
  options: { crashBeforeProjection?: boolean } = {}
): Promise<RefundRequest> {
  const row = await table.get(id);
  if (!row) throw new Error(`no refund request ${id}`);
  if (row.status === "refunded") return row;

  const result = await runEffect(store, refundContract(payments), {
    identity: row.id,
    intent: { orderId: row.orderId, amountCents: row.amountCents }
  });

  if (options.crashBeforeProjection) {
    // The refund is made and corrobo has recorded it, but the app row isn't updated yet.
    throw new Error("process died before updating refund_requests");
  }

  const projected = project(result);
  await table.setOutcome(row.id, projected.status, projected.receiptId);
  return { ...row, ...projected };
}

/** Step 3, on a timer: finish whatever a crash or an open outcome left behind. */
export async function sweep(store: EffectStore, table: RefundRequests, payments: Payments): Promise<void> {
  for (const row of await table.unfinished()) {
    await processRefund(store, table, payments, row.id);
  }
}

function project(result: EffectResult<Refund[]>): { status: RefundRequestStatus; receiptId: string | null } {
  switch (result.disposition) {
    case "COMPLETE":
      return {
        status: "refunded",
        receiptId: result.observation?.status === "observed" ? (result.observation.data[0]?.id ?? null) : null
      };
    case "RETRY":
    case null: // PENDING, or another worker is mid-attempt
      return { status: "waiting", receiptId: null };
    default: // INVESTIGATE, REPLAN, REVIEW: a person should look
      return { status: "needs_attention", receiptId: null };
  }
}

export function memoryRefundRequests(): RefundRequests & { rows: Map<string, RefundRequest> } {
  const rows = new Map<string, RefundRequest>();
  return {
    rows,
    async insert(row) {
      rows.set(row.id, { ...row });
    },
    async get(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async setOutcome(id, status, receiptId) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, status, receiptId });
    },
    async unfinished() {
      return [...rows.values()].filter((r) => r.status !== "refunded" && r.status !== "needs_attention");
    }
  };
}
