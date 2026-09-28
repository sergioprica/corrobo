import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import { FaultSchedule } from "../src/testing/faults";
import { createCancelOrderContract } from "../examples/rest/contract";
import { startOrdersServer, type OrdersServerHandle } from "../examples/rest/server";

describe("generic REST example: cancel order", () => {
  let server: OrdersServerHandle;

  beforeEach(async () => {
    server = await startOrdersServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("normal success -> APPLIED / COMPLETE", async () => {
    server.seed("o1", { status: "open", version: 1 });
    const store = new InMemoryStore();
    const contract = createCancelOrderContract({ baseUrl: server.url, faultSchedule: new FaultSchedule([]) });
    const result = await runEffect(store, contract, {
      identity: { id: "op-1", operationType: contract.operationType },
      intent: { orderId: "o1", expectedVersion: 1 }
    });
    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
  });

  it("timeout AFTER the write commits does not duplicate the mutation (headline scenario)", async () => {
    server.seed("o2", { status: "open", version: 1 });
    const store = new InMemoryStore();
    const contract = createCancelOrderContract({
      baseUrl: server.url,
      faultSchedule: new FaultSchedule([{ phase: "AFTER_EFFECT", attempt: 1, fault: "TIMEOUT" }])
    });
    const identity = { id: "op-2", operationType: contract.operationType };
    const intent = { orderId: "o2", expectedVersion: 1 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("APPLIED");
    expect(r1.disposition).toBe("COMPLETE");

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);

    expect(server.getState("o2")?.version).toBe(2);
  });

  it("timeout BEFORE the write reaches the server allows retry only after absence is established", async () => {
    server.seed("o3", { status: "open", version: 1 });
    const store = new InMemoryStore();
    const contract = createCancelOrderContract({
      baseUrl: server.url,
      faultSchedule: new FaultSchedule([{ phase: "BEFORE_EFFECT", attempt: 1, fault: "TIMEOUT" }])
    });
    const identity = { id: "op-3", operationType: contract.operationType };
    const intent = { orderId: "o3", expectedVersion: 1 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("NOT_APPLIED");
    expect(r1.disposition).toBe("RETRY");
    expect(r1.retryNotBefore).not.toBeNull(); // the failed request could still land until then
    expect(server.getState("o3")?.status).toBe("open");

    // Too early: no new attempt is made while the failed request could still land.
    const early = await runEffect(store, contract, { identity, intent });
    expect(early.attempts).toHaveLength(1);
    expect(server.getState("o3")?.version).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, Date.parse(r1.retryNotBefore!) - Date.now() + 10));
    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(server.getState("o3")?.version).toBe(2);
  });

  it("a stale expected version produces CONFLICTED / REPLAN", async () => {
    server.seed("o4", { status: "open", version: 5 });
    const store = new InMemoryStore();
    const contract = createCancelOrderContract({ baseUrl: server.url, faultSchedule: new FaultSchedule([]) });
    const result = await runEffect(store, contract, {
      identity: { id: "op-4", operationType: contract.operationType },
      intent: { orderId: "o4", expectedVersion: 1 }
    });
    expect(result.evidenceState).toBe("CONFLICTED");
    expect(result.disposition).toBe("REPLAN");
    expect(server.getState("o4")?.status).toBe("open");
  });

  it("an asynchronously converging effect is PENDING and later resolves without a second mutation", async () => {
    server.seed("o5", { status: "open", version: 1 });
    const store = new InMemoryStore();
    const contract = createCancelOrderContract({ baseUrl: server.url, faultSchedule: new FaultSchedule([]) });
    const identity = { id: "op-5", operationType: contract.operationType };
    const intent = { orderId: "o5", expectedVersion: 1, convergeAsync: true };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("PENDING");
    expect(r1.disposition).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 250));

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);
  });

  it("execute AND observe both failing is honestly UNKNOWN / INVESTIGATE, never a blind retry", async () => {
    server.seed("o6", { status: "open", version: 1 });
    const store = new InMemoryStore();
    const contract = createCancelOrderContract({
      baseUrl: server.url,
      faultSchedule: new FaultSchedule([
        { phase: "BEFORE_EFFECT", attempt: 1, fault: "NETWORK_ERROR" },
        { phase: "ON_OBSERVE", attempt: 1, fault: "NETWORK_ERROR" }
      ])
    });
    const result = await runEffect(store, contract, {
      identity: { id: "op-6", operationType: contract.operationType },
      intent: { orderId: "o6", expectedVersion: 1 }
    });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
  });
});
