import { describe, expect, expectTypeOf, it } from "vitest";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import { runEffect } from "../src/core/runtime";
import type { EffectContract, ObservationResult, ReconciliationResult } from "../src/core/types";
import { InMemoryStore } from "../src/stores/memory";

/** Builders and shorthands that cut quickstart boilerplate without changing behavior. */

describe("defineContract", () => {
  it("infers observation and evidence types from observe()/execute(); only the intent is named", () => {
    const contract = defineContract<{ orderId: string }>()({
      operationType: "t",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      execute: async ({ intent }) => ({ refundId: `re_${intent.orderId}` }),
      observe: async () => observed({ count: 1 }, { source: "api", authoritative: true }),
      reconcile: ({ observation, transport }) => {
        // Compile-time checks: these are the narrow types, not unknown.
        if (observation.status === "observed") expectTypeOf(observation.data).toEqualTypeOf<{ count: number }>();
        if (transport.ok) expectTypeOf(transport.evidence).toEqualTypeOf<{ refundId: string }>();
        return reconciled("APPLIED", "OK", "ok");
      }
    });
    expectTypeOf(contract).toEqualTypeOf<EffectContract<{ orderId: string }, { count: number }, { refundId: string }>>();
    expect(contract.operationType).toBe("t"); // returned unchanged
  });
});

describe("observed / reconciled", () => {
  it("observed() builds the observed variant, keeping authoritative explicit", () => {
    const o = observed([1, 2], { source: "search", authoritative: false, observedAt: "2026-01-01T00:00:00.000Z" });
    expect(o).toEqual({ status: "observed", data: [1, 2], authoritative: false, source: "search", observedAt: "2026-01-01T00:00:00.000Z" });
    expectTypeOf(o).toMatchTypeOf<ObservationResult<number[]>>();
  });

  it("observed() stamps observedAt when not given", () => {
    expect(Date.parse(observed(null, { source: "s", authoritative: true }).observedAt)).not.toBeNaN();
  });

  it("reconciled() builds a ReconciliationResult, with metadata only when given", () => {
    expect(reconciled("NOT_APPLIED", "ABSENT", "none")).toEqual({ evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "none" } });
    const withMeta: ReconciliationResult = reconciled("CONFLICTED", "DUP", "two", { ids: ["a", "b"] });
    expect(withMeta.reason.metadata).toEqual({ ids: ["a", "b"] });
  });
});

describe("less ceremony, same behavior", () => {
  const minimal = () => {
    const target = { applied: 0 };
    const contract = defineContract<{ amount: number }>()({
      operationType: "test/minimal",
      retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
      execute: async () => {
        target.applied += 1;
        return {};
      },
      observe: async () => observed(target.applied, { source: "t", authoritative: true }),
      reconcile: ({ observation }) =>
        observation.status === "observed" && observation.data === 1
          ? reconciled("APPLIED", "FOUND", "found")
          : reconciled("UNKNOWN", "UNCLEAR", "unclear")
    });
    return { target, contract };
  };

  it("a contract without capabilities runs (the runtime never read them)", async () => {
    const { target, contract } = minimal();
    expect(contract.capabilities).toBeUndefined();
    const result = await runEffect(new InMemoryStore(), contract, { identity: "op-1", intent: { amount: 5 } });
    expect(result.disposition).toBe("COMPLETE");
    expect(target.applied).toBe(1);
  });

  it("identity as a string is shorthand for { id, operationType: contract.operationType }", async () => {
    const { target, contract } = minimal();
    const store = new InMemoryStore();
    const first = await runEffect(store, contract, { identity: "op-2", intent: { amount: 5 } });
    expect(first.identity).toEqual({ id: "op-2", operationType: "test/minimal" });
    // The object form reaches the very same operation.
    const again = await runEffect(store, contract, { identity: { id: "op-2", operationType: "test/minimal" }, intent: { amount: 5 } });
    expect(again.disposition).toBe("COMPLETE");
    expect(target.applied).toBe(1);
  });

  it("an explicit identity whose operationType disagrees with the contract is rejected before anything happens", async () => {
    const { target, contract } = minimal();
    const store = new InMemoryStore();
    await expect(
      runEffect(store, contract, { identity: { id: "op-3", operationType: "something/else" }, intent: { amount: 5 } })
    ).rejects.toThrow(/operationType "something\/else", but the contract is "test\/minimal"/);
    expect(target.applied).toBe(0);
    expect(await store.getOperation("op-3")).toBeNull();
  });
});
