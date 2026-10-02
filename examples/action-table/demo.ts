// Run it: npm run example:action-table
import { InMemoryStore } from "corrobo";
import { createPaymentsApi } from "../quickstart/payments-api";
import { confirmRefund, memoryRefundRequests, processRefund, sweep } from "./refunds";

async function main() {
  const payments = createPaymentsApi();
  const store = new InMemoryStore(); // use PostgresStore in production (see pg-table.ts)
  const refundRequests = memoryRefundRequests();

  // The user confirms. The identity is minted now and stored with the action.
  const id = await confirmRefund(refundRequests, { orderId: "1001", amountCents: 5_000, requestedBy: "user:42" });

  // The worker makes the refund (the response is lost on the way back, and corrobo finds it
  // anyway), then dies before writing the outcome to refund_requests.
  payments.loseNextResponse();
  await processRefund(store, refundRequests, payments, id, { crashBeforeProjection: true }).catch((err: Error) =>
    console.log("worker:", err.message)
  );
  console.log("refund_requests says:", (await refundRequests.get(id))?.status); // confirmed

  // The sweeper picks the row up again. corrobo returns the recorded outcome; nothing is re-sent.
  await sweep(store, refundRequests, payments);
  const row = await refundRequests.get(id);
  console.log("refund_requests says:", row?.status, row?.receiptId); // refunded re_1
  console.log("refunds made:", payments.refundCount()); // 1
}

main();
