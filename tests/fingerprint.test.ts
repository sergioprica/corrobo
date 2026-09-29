import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import { canonicalStringify, fingerprintIntent } from "../src/core/fingerprint";
import type { EffectContract } from "../src/core/types";

describe("canonicalStringify / fingerprintIntent", () => {
  it("object key ordering does not change the fingerprint", () => {
    const a = { amountCents: 500, chargeId: "ch_1", reason: "requested_by_customer" };
    const b = { reason: "requested_by_customer", chargeId: "ch_1", amountCents: 500 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("nested key ordering does not change the fingerprint either", () => {
    const a = { chargeId: "ch_1", meta: { a: 1, b: 2 } };
    const b = { meta: { b: 2, a: 1 }, chargeId: "ch_1" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("array order DOES change the fingerprint — arrays are meaningful sequences, not sorted", () => {
    expect(canonicalStringify({ items: [1, 2, 3] })).not.toBe(canonicalStringify({ items: [3, 2, 1] }));
  });

  it("a genuinely different intent fingerprints differently", () => {
    expect(canonicalStringify({ chargeId: "ch_1", amountCents: 50 })).not.toBe(
      canonicalStringify({ chargeId: "ch_1", amountCents: 500 })
    );
  });

  it("fingerprintIntent uses the contract's own override when provided", () => {
    const contract = {
      fingerprintIntent: (intent: { chargeId: string; requestNonce: string }) => intent.chargeId
    };
    // Two intents that differ only in a field the override deliberately ignores still match.
    const fp1 = fingerprintIntent(contract, { chargeId: "ch_1", requestNonce: "a" });
    const fp2 = fingerprintIntent(contract, { chargeId: "ch_1", requestNonce: "b" });
    expect(fp1).toBe(fp2);

    // But a genuinely different chargeId still differs.
    const fp3 = fingerprintIntent(contract, { chargeId: "ch_2", requestNonce: "a" });
    expect(fp1).not.toBe(fp3);
  });

  it("fingerprintIntent falls back to canonicalStringify when no override is provided", () => {
    const contract = {};
    expect(fingerprintIntent(contract, { a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });
});

describe("runEffect honors a contract-provided fingerprintIntent override", () => {
  it("treats two intents differing only in an ignored field as the same logical operation", async () => {
    const store = new InMemoryStore();
    const contract: EffectContract<{ chargeId: string; requestNonce: string }, unknown, unknown> = {
      operationType: "test/fingerprint-override",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      fingerprintIntent: (intent) => intent.chargeId,
      async execute() {
        return { done: true };
      },
      async observe() {
        return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    };

    const identity = { id: "override-1", operationType: contract.operationType };
    const first = await runEffect(store, contract, { identity, intent: { chargeId: "ch_1", requestNonce: "a" } });
    expect(first.disposition).toBe("COMPLETE");

    // A different nonce alone must NOT be treated as a conflicting logical operation, because
    // the override deliberately fingerprints only chargeId.
    const second = await runEffect(store, contract, { identity, intent: { chargeId: "ch_1", requestNonce: "b" } });
    expect(second.disposition).toBe("COMPLETE");
  });
});

describe("canonicalStringify is faithful to what JSON persistence keeps", () => {
  it("different Dates fingerprint differently (they are different intents)", () => {
    expect(canonicalStringify({ at: new Date("2026-01-01") })).not.toBe(canonicalStringify({ at: new Date("2027-01-01") }));
  });

  it("an intent fingerprints the same before and after a JSON round trip (Date vs its persisted ISO string)", () => {
    const intent = { at: new Date("2026-01-01T00:00:00.000Z"), amount: 5, note: undefined, tags: ["a", undefined] };
    expect(canonicalStringify(JSON.parse(JSON.stringify(intent)))).toBe(canonicalStringify(intent));
  });

  it("plain JSON intents fingerprint exactly as before (existing records keep matching)", () => {
    const intent = { b: [1, { d: true, c: null }], a: "x" };
    expect(canonicalStringify(intent)).toBe('{"a":"x","b":[1,{"c":null,"d":true}]}');
  });

  it("the same object referenced twice (not a cycle) is fine", () => {
    const shared = { id: 1 };
    expect(canonicalStringify({ a: shared, b: shared })).toBe('{"a":{"id":1},"b":{"id":1}}');
  });

  it.each([
    ["a circular reference", () => {
      const o: Record<string, unknown> = { a: 1 };
      o.self = o;
      return o;
    }],
    ["a function", () => ({ amount: 5, onDone: () => 1 })],
    ["a symbol", () => ({ tag: Symbol("x") })],
    ["a bigint", () => ({ amount: 10n })],
    ["a Map", () => ({ m: new Map([["x", 1]]) })],
    ["a Set", () => ({ s: new Set([1]) })]
  ])("rejects %s with a clear TypeError naming the path", (what, make) => {
    expect(() => canonicalStringify(make())).toThrow(TypeError);
    expect(() => canonicalStringify(make())).toThrow(new RegExp(`intent\\.\\w+ is ${what}`));
  });
});

describe("runEffect rejects an unpersistable intent before anything happens", () => {
  it("circular intent: throws before execute(), and leaves no record behind", async () => {
    const store = new InMemoryStore();
    let executed = 0;
    const contract: EffectContract<Record<string, unknown>, unknown, unknown> = {
      operationType: "t",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        executed += 1;
        return {};
      },
      async observe() {
        return { status: "observed", data: {}, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "A", summary: "a" } })
    };
    const intent: Record<string, unknown> = { a: 1 };
    intent.self = intent;
    await expect(runEffect(store, contract, { identity: { id: "circ", operationType: "t" }, intent })).rejects.toThrow(
      /intent\.self is a circular reference/
    );
    expect(executed).toBe(0);
    expect(await store.getOperation("circ")).toBeNull();
  });
});

describe("canonicalStringify matches the JSON round trip by construction (review cases)", () => {
  const roundTrip = (v: unknown) => JSON.parse(JSON.stringify(v));

  it.each([
    ["toJSON receives its real key", () => ({ a: { toJSON: (key: string) => `key:${key}` }, list: [{ toJSON: (key: string) => key }] })],
    ["a __proto__ key parsed from JSON", () => JSON.parse('{"__proto__":{"x":1},"b":2}')],
    ["nested Dates, -0, sparse arrays, NaN", () => ({ d: [new Date("2026-01-01")], z: -0, sparse: [1, , 3], n: NaN })],
    ["a Buffer (judged by its own toJSON)", () => ({ b: Buffer.from("hi") })],
    ["numeric-string keys", () => ({ "10": "a", "9": "b", x: 1 })]
  ])("%s: fingerprint before == after persistence", (_label, make) => {
    const intent = make();
    expect(canonicalStringify(roundTrip(intent))).toBe(canonicalStringify(intent));
  });

  it("an own getter property is rejected: it could return something different when the intent is stored", () => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "a", { enumerable: true, get: () => Math.random() });
    expect(() => canonicalStringify(o)).toThrow(/intent\.a is a getter/);
  });

  it("a __proto__ key is kept, not dropped: it differs from an empty object", () => {
    expect(canonicalStringify(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(canonicalStringify({}));
  });

  it("intents JSON stores identically are the same intent (documented equivalences)", () => {
    expect(canonicalStringify({ a: undefined })).toBe(canonicalStringify({}));
    expect(canonicalStringify({ n: NaN })).toBe(canonicalStringify({ n: null }));
    expect(canonicalStringify({ at: new Date("2026-01-01T00:00:00.000Z") })).toBe(canonicalStringify({ at: "2026-01-01T00:00:00.000Z" }));
  });

  it.each([
    ["undefined", () => undefined],
    ["a function", () => () => 1]
  ])("a root intent that is %s is rejected", (_label, make) => {
    expect(() => canonicalStringify(make())).toThrow(TypeError);
  });

  it.each([
    ["a Uint8Array", () => ({ bytes: new Uint8Array([1, 2]) })],
    ["an ArrayBuffer", () => ({ buf: new ArrayBuffer(2) })]
  ])("rejects %s (it would come back from storage as a plain object)", (_label, make) => {
    expect(() => canonicalStringify(make())).toThrow(TypeError);
  });
});

describe("runEffect intent validation, per kind", () => {
  const counting = () => {
    const calls = { execute: 0 };
    const contract: EffectContract<unknown, unknown, unknown> = {
      operationType: "t",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        calls.execute += 1;
        return {};
      },
      async observe() {
        return { status: "observed", data: {}, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "A", summary: "a" } })
    };
    return { calls, contract };
  };

  it.each([
    ["a function", { cb: () => 1 }],
    ["a Map", { m: new Map() }],
    ["a Set", { s: new Set() }],
    ["a bigint", { n: 1n }],
    ["a symbol", { s: Symbol("x") }],
    ["a Uint8Array", { b: new Uint8Array(1) }]
  ])("an intent containing %s is rejected before any record or execute()", async (_label, intent) => {
    const { calls, contract } = counting();
    const store = new InMemoryStore();
    await expect(runEffect(store, contract, { identity: { id: "k", operationType: "t" }, intent })).rejects.toThrow(TypeError);
    expect(calls.execute).toBe(0);
    expect(await store.getOperation("k")).toBeNull();
  });

  it("a custom fingerprintIntent takes responsibility: corrobo does not apply the default rules to that intent", async () => {
    const { calls, contract } = counting();
    const withOverride = { ...contract, fingerprintIntent: (intent: unknown) => String((intent as { orderId: string }).orderId) };
    const store = new InMemoryStore();
    const intent = { orderId: "o1", cache: new Map([["k", 1]]) }; // the default rules reject a Map; this override ignores it
    const first = await runEffect(store, withOverride, { identity: { id: "c", operationType: "t" }, intent });
    const again = await runEffect(store, withOverride, { identity: { id: "c", operationType: "t" }, intent });
    expect(first.disposition).toBe("COMPLETE");
    expect(again.disposition).toBe("COMPLETE");
    expect(calls.execute).toBe(1);
  });
});
