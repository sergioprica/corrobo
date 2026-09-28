import { InMemoryStore, runEffect } from "../../src/core";
import { FaultSchedule } from "../../src/testing/faults";
import { createCancelOrderContract } from "./contract";
import { startOrdersServer } from "./server";

function log(label: string, result: unknown): void {
  console.log(`\n-- ${label} --`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const server = await startOrdersServer();
  const store = new InMemoryStore();
  console.log(`orders server listening at ${server.url}`);

  // 1. Normal success.
  server.seed("order-1", { status: "open", version: 1 });
  const happy = createCancelOrderContract({ baseUrl: server.url, faultSchedule: new FaultSchedule([]) });
  const r1 = await runEffect(store, happy, {
    identity: { id: "op-happy", operationType: happy.operationType },
    intent: { orderId: "order-1", expectedVersion: 1 }
  });
  log("normal success -> APPLIED / COMPLETE", { evidenceState: r1.evidenceState, disposition: r1.disposition });

  // 2. Timeout BEFORE the write reaches the server -> NOT_APPLIED -> RETRY, but not before the
  //    failed request's in-flight window (maxInFlightMs) has passed: until then "not cancelled
  //    yet" can't rule out a late landing. After it, corrobo re-observes, then retries.
  server.seed("order-2", { status: "open", version: 1 });
  const timeoutBefore = createCancelOrderContract({
    baseUrl: server.url,
    faultSchedule: new FaultSchedule([{ phase: "BEFORE_EFFECT", attempt: 1, fault: "TIMEOUT" }])
  });
  const identity2 = { id: "op-timeout-before", operationType: timeoutBefore.operationType };
  const intent2 = { orderId: "order-2", expectedVersion: 1 };
  const r2a = await runEffect(store, timeoutBefore, { identity: identity2, intent: intent2 });
  log("timeout before write, attempt 1 -> NOT_APPLIED / RETRY after the in-flight window", {
    evidenceState: r2a.evidenceState,
    disposition: r2a.disposition,
    retryNotBefore: r2a.retryNotBefore
  });
  await waitUntil(r2a.retryNotBefore);
  const r2b = await runEffect(store, timeoutBefore, { identity: identity2, intent: intent2 });
  log("caller retries, attempt 2 -> APPLIED / COMPLETE", { evidenceState: r2b.evidenceState, disposition: r2b.disposition });
  console.log(
    `order-2: version ${server.getState("order-2")?.version} (cancelled exactly once); ` +
      `${server.requestCount("order-2")} HTTP requests in total, reads included`
  );

  // 3. Timeout AFTER the write committed -> the mutation still happened, but the response was lost.
  //    Headline proof: disposition is COMPLETE on attempt 1, no duplicate attempt occurs.
  server.seed("order-3", { status: "open", version: 1 });
  const timeoutAfter = createCancelOrderContract({
    baseUrl: server.url,
    faultSchedule: new FaultSchedule([{ phase: "AFTER_EFFECT", attempt: 1, fault: "TIMEOUT" }])
  });
  const identity3 = { id: "op-timeout-after", operationType: timeoutAfter.operationType };
  const intent3 = { orderId: "order-3", expectedVersion: 1 };
  const r3a = await runEffect(store, timeoutAfter, { identity: identity3, intent: intent3 });
  log("timeout after write -> APPLIED / COMPLETE despite the throw", { evidenceState: r3a.evidenceState, disposition: r3a.disposition });
  const r3b = await runEffect(store, timeoutAfter, { identity: identity3, intent: intent3 });
  log("calling run() again with the same identity -> cached, no re-execution", {
    evidenceState: r3b.evidenceState,
    disposition: r3b.disposition,
    attemptsRecorded: r3b.attempts.length
  });
  console.log(`order-3 server saw exactly one mutating attempt: version is now ${server.getState("order-3")?.version} (started at 1)`);

  // 4. Conflict: the plan assumed version 1, but the order was already changed by something else.
  server.seed("order-4", { status: "open", version: 5 });
  const conflict = createCancelOrderContract({ baseUrl: server.url, faultSchedule: new FaultSchedule([]) });
  const r4 = await runEffect(store, conflict, {
    identity: { id: "op-conflict", operationType: conflict.operationType },
    intent: { orderId: "order-4", expectedVersion: 1 }
  });
  log("stale expected version -> CONFLICTED / REPLAN", { evidenceState: r4.evidenceState, disposition: r4.disposition, reason: r4.evidenceReason });

  // 5. Eventual effect: the server acknowledges immediately but converges asynchronously.
  server.seed("order-5", { status: "open", version: 1 });
  const pending = createCancelOrderContract({ baseUrl: server.url, faultSchedule: new FaultSchedule([]) });
  const identity5 = { id: "op-pending", operationType: pending.operationType };
  const intent5 = { orderId: "order-5", expectedVersion: 1, convergeAsync: true };
  const r5a = await runEffect(store, pending, { identity: identity5, intent: intent5 });
  log("async convergence, first observe -> PENDING / no disposition", { evidenceState: r5a.evidenceState, disposition: r5a.disposition });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const r5b = await runEffect(store, pending, { identity: identity5, intent: intent5 });
  log("caller re-observes later -> APPLIED / COMPLETE, still only one mutation", {
    evidenceState: r5b.evidenceState,
    disposition: r5b.disposition,
    attemptsRecorded: r5b.attempts.length
  });

  // 6. Ambiguous: the mutation attempt AND the read-back both fail -> honestly UNKNOWN.
  server.seed("order-6", { status: "open", version: 1 });
  const ambiguous = createCancelOrderContract({
    baseUrl: server.url,
    faultSchedule: new FaultSchedule([
      { phase: "BEFORE_EFFECT", attempt: 1, fault: "NETWORK_ERROR" },
      { phase: "ON_OBSERVE", attempt: 1, fault: "NETWORK_ERROR" }
    ])
  });
  const r6 = await runEffect(store, ambiguous, {
    identity: { id: "op-ambiguous", operationType: ambiguous.operationType },
    intent: { orderId: "order-6", expectedVersion: 1 }
  });
  log("execute AND observe both fail -> UNKNOWN / INVESTIGATE (no blind retry)", { evidenceState: r6.evidenceState, disposition: r6.disposition });

  await server.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function waitUntil(iso: string | null): Promise<void> {
  if (iso) await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(iso) - Date.now()) + 10));
}
