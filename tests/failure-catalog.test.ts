import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEffect } from "../src/core/runtime";
import type { EffectContract, ResolvedAttempt } from "../src/core/types";
import { InMemoryStore } from "../src/stores/memory";
import { createIssueCreditContract, naiveIssueCredit } from "../examples/timeout-after-write/contract";
import { startLedgerServer } from "../examples/timeout-after-write/ledger-server";
import type { LedgerServer } from "../examples/timeout-after-write/ledger-server";

/**
 * Failure-catalog rows (docs/failure-matrix.md) that no other test file covered. External
 * effects are always counted by the fake target, never read from corrobo's record.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

type Status = "accepted" | "settled" | "failed" | "absent";

/** An async provider: accepts a request, then later settles it or fails it. */
function asyncTarget() {
  return { status: "absent" as Status, executeCalls: 0 };
}

function asyncContract(
  target: ReturnType<typeof asyncTarget>,
  retryOnNotApplied = true
): EffectContract<Record<string, never>, { status: Status }, { accepted: true }> {
  return {
    operationType: "test/async",
    capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: true },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied },
    async execute() {
      target.executeCalls += 1;
      target.status = "accepted";
      return { accepted: true };
    },
    async observe() {
      const observedAt = new Date().toISOString();
      return target.status === "accepted"
        ? { status: "pending", authoritative: true, source: "t", observedAt }
        : { status: "observed", data: { status: target.status }, authoritative: true, source: "t", observedAt };
    },
    reconcile({ observation }) {
      if (observation.status === "pending") return { evidenceState: "PENDING", reason: { code: "ACCEPTED", summary: "accepted" } };
      if (observation.status === "observation_failed") return { evidenceState: "UNKNOWN", reason: { code: "X", summary: "x" } };
      return observation.data?.status === "settled"
        ? { evidenceState: "APPLIED", reason: { code: "SETTLED", summary: "settled" } }
        : { evidenceState: "NOT_APPLIED", reason: { code: "FAILED", summary: "provider rejected it asynchronously" } };
    }
  };
}

describe("convergence: PENDING that ends in NOT_APPLIED", () => {
  const identity = { id: "async-1", operationType: "test/async" };

  it("provider accepted, then failed it: RETRY per policy (the request is no longer in flight), one new attempt", async () => {
    const store = new InMemoryStore();
    const target = asyncTarget();
    const contract = asyncContract(target);

    expect((await runEffect(store, contract, { identity, intent: {} })).evidenceState).toBe("PENDING");
    target.status = "failed";
    const failed = await runEffect(store, contract, { identity, intent: {} });
    expect(failed.evidenceState).toBe("NOT_APPLIED");
    expect(failed.disposition).toBe("RETRY");
    expect(failed.retryNotBefore).toBeNull();
    expect(target.executeCalls).toBe(1);

    const retried = await runEffect(store, contract, { identity, intent: {} });
    expect(retried.evidenceState).toBe("PENDING");
    expect(retried.attempts).toHaveLength(2);
    expect(target.executeCalls).toBe(2);
  });

  it("same, but the operation type is not safe to retry: INVESTIGATE, never re-executed", async () => {
    const store = new InMemoryStore();
    const target = asyncTarget();
    const contract = asyncContract(target, false);
    await runEffect(store, contract, { identity, intent: {} });
    target.status = "failed";
    const failed = await runEffect(store, contract, { identity, intent: {} });
    expect(failed.disposition).toBe("INVESTIGATE");
    await runEffect(store, contract, { identity, intent: {} });
    expect(target.executeCalls).toBe(1);
  });
});

describe("lock losers see honest in-progress results and never execute", () => {
  it("record exists with a reserved attempt: ATTEMPT_IN_PROGRESS, no disposition", async () => {
    const store = new InMemoryStore();
    const target = asyncTarget();
    const hold = deferred();
    const inExecute = deferred();
    const base = asyncContract(target);
    const contract: typeof base = {
      ...base,
      async execute(input) {
        inExecute.resolve();
        await hold.promise;
        return base.execute(input);
      }
    };
    const identity = { id: "busy-1", operationType: contract.operationType };
    const winner = runEffect(store, contract, { identity, intent: {} });
    await inExecute.promise;

    const loser = await runEffect(store, contract, { identity, intent: {} });
    expect(loser.status).toBe("OPEN");
    expect(loser.disposition).toBeNull();
    expect(loser.dispositionReason.code).toBe("ATTEMPT_IN_PROGRESS");

    hold.resolve();
    await winner;
    expect(target.executeCalls).toBe(1);
  });

  it("no record yet (the winner is still authorizing): OPERATION_IN_PROGRESS, no disposition", async () => {
    const store = new InMemoryStore();
    const target = asyncTarget();
    const authorizing = deferred();
    const release = deferred();
    const contract: EffectContract<Record<string, never>, { status: Status }, { accepted: true }> = {
      ...asyncContract(target),
      async authorize() {
        authorizing.resolve();
        await release.promise;
        return { requiresReview: false };
      }
    };
    const identity = { id: "busy-2", operationType: contract.operationType };
    const winner = runEffect(store, contract, { identity, intent: {} });
    await authorizing.promise;

    const loser = await runEffect(store, contract, { identity, intent: {} });
    expect(loser.dispositionReason.code).toBe("OPERATION_IN_PROGRESS");
    expect(loser.disposition).toBeNull();

    release.resolve();
    await winner;
    expect(target.executeCalls).toBe(1);
  });
});

describe("thrown values that are not Errors", () => {
  it.each([["a string", "boom"], ["undefined", undefined], ["null", null], ["a number", 42]])(
    "execute() throwing %s is recorded as a transport failure, never crashes the pass",
    async (_label, thrown) => {
      const store = new InMemoryStore();
      const contract: EffectContract<Record<string, never>, { status: Status }, { accepted: true }> = {
        ...asyncContract(asyncTarget()),
        async execute() {
          throw thrown;
        }
      };
      const result = await runEffect(store, contract, { identity: { id: "t", operationType: contract.operationType }, intent: {} });
      const transport = (result.attempts[0] as ResolvedAttempt).transport;
      expect(transport.ok).toBe(false);
      expect(!transport.ok && transport.error.message).toBe(String(thrown));
    }
  );
});

describe("external records that already existed before corrobo started", () => {
  let ledger: LedgerServer;
  beforeEach(async () => {
    ledger = await startLedgerServer();
  });
  afterEach(async () => {
    await ledger.close();
  });

  it("corrobo has no record, so it executes once, then sees more than it intended: CONFLICTED / REPLAN, no further writes", async () => {
    const intent = { accountId: "acct_1", amountCents: 1_000 };
    await naiveIssueCredit(ledger.url, intent, "op-dup"); // written by something other than corrobo
    const contract = createIssueCreditContract(ledger.url);
    const store = new InMemoryStore();
    const request = { identity: { id: "op-dup", operationType: contract.operationType }, intent };

    const result = await runEffect(store, contract, request);
    expect(result.evidenceState).toBe("CONFLICTED");
    expect(result.disposition).toBe("REPLAN");
    await runEffect(store, contract, request);
    expect(ledger.credits()).toHaveLength(2); // one outside write + corrobo's single attempt
  });
});

describe("static guarantees of the shipped source", () => {
  const root = join(__dirname, "..");
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? srcFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
  const files = srcFiles(join(root, "src")).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("no logging of any kind in src/ (application payloads are never printed by corrobo)", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/\bconsole\.\w+\(/);
      expect(text, path).not.toMatch(/process\.(stdout|stderr)/);
    }
  });

  it("no network-capable code in src/ except PostgresStore's use of the pool you pass in", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
      expect(text, path).not.toMatch(/from ["'](node:)?(http|https|http2|net|tls|dgram|dns|child_process)["']/);
      if (!path.endsWith(join("stores", "postgres.ts"))) {
        expect(text, path).not.toMatch(/from ["']pg["']/);
      }
    }
  });

  it("no automatic expiry or deletion of persisted records", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
    }
  });

  it("package.json declares no install-time scripts and no runtime dependencies (pg is an optional peer)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const hook of ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare"]) {
      expect(pkg.scripts?.[hook], hook).toBeUndefined();
    }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.peerDependencies).toEqual({ pg: ">=8" });
    expect(pkg.peerDependenciesMeta).toEqual({ pg: { optional: true } });
  });
});

describe("more catalog rows", () => {
  it("a thrown Error-like object keeps its message (and nothing else of it) as the recorded message", async () => {
    const store = new InMemoryStore();
    const contract: EffectContract<Record<string, never>, { status: Status }, { accepted: true }> = {
      ...asyncContract(asyncTarget()),
      async execute() {
        throw { message: "rate limited", headers: { authorization: "Bearer sk_live_secret" } };
      }
    };
    const result = await runEffect(store, contract, { identity: { id: "t2", operationType: contract.operationType }, intent: {} });
    const transport = (result.attempts[0] as ResolvedAttempt).transport;
    expect(!transport.ok && transport.error.message).toBe("rate limited");
  });

  it("reusing an identity with the same intent in a different key order is the same operation, not a conflict", async () => {
    const store = new InMemoryStore();
    const target = asyncTarget();
    const contract = asyncContract(target) as unknown as EffectContract<Record<string, unknown>, { status: Status }, { accepted: true }>;
    const identity = { id: "order-1", operationType: contract.operationType };
    await runEffect(store, contract, { identity, intent: { a: 1, b: { c: 2, d: 3 } } });
    const again = await runEffect(store, contract, { identity, intent: { b: { d: 3, c: 2 }, a: 1 } });
    expect(again.evidenceState).toBe("PENDING");
    expect(target.executeCalls).toBe(1);
  });

  it("corrobo does not judge authority itself: reconcile() receives authoritative:false untouched", async () => {
    const store = new InMemoryStore();
    let seen: boolean | undefined;
    let seenSource: string | undefined;
    const contract: EffectContract<Record<string, never>, { found: boolean }, unknown> = {
      operationType: "test/non-authoritative",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
      async execute() {
        throw new Error("timeout");
      },
      async observe() {
        return { status: "observed", data: { found: false }, authoritative: false, source: "search index", observedAt: new Date().toISOString() };
      },
      reconcile({ observation }) {
        seen = observation.status === "observed" ? observation.authoritative : undefined;
        seenSource = observation.source;
        // What a correct contract does with a read that can't prove absence:
        return { evidenceState: "UNKNOWN", reason: { code: "WEAK_READ", summary: "search results can't prove absence" } };
      }
    };
    const result = await runEffect(store, contract, { identity: { id: "na-1", operationType: contract.operationType }, intent: {} });
    expect(seen).toBe(false);
    expect(seenSource).toBe("search index");
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("the core and InMemoryStore make no network calls of their own", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("network not allowed");
    }) as typeof fetch;
    try {
      const target = asyncTarget();
      const store = new InMemoryStore();
      const contract = asyncContract(target);
      await runEffect(store, contract, { identity: { id: "net-1", operationType: contract.operationType }, intent: {} });
      target.status = "settled";
      await runEffect(store, contract, { identity: { id: "net-1", operationType: contract.operationType }, intent: {} });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });

  it("a thrown value whose message can't even be read is still recorded as a transport failure", async () => {
    const store = new InMemoryStore();
    const contract: EffectContract<Record<string, never>, { status: Status }, { accepted: true }> = {
      ...asyncContract(asyncTarget()),
      async execute() {
        throw new Proxy(
          {},
          {
            get(target, prop, receiver) {
              if (prop === "message" || prop === Symbol.toPrimitive || prop === "toString") throw new Error("getter exploded");
              return Reflect.get(target, prop, receiver);
            }
          }
        );
      }
    };
    const result = await runEffect(store, contract, { identity: { id: "proxy", operationType: contract.operationType }, intent: {} });
    const transport = (result.attempts[0] as ResolvedAttempt).transport;
    expect(!transport.ok && transport.error.message).toBe("(the thrown value could not be converted to a message)");
  });

  it("InMemoryStore is process-local: a new instance (a restarted process) has none of the old records", async () => {
    const target = asyncTarget();
    const contract = asyncContract(target);
    const before = new InMemoryStore();
    await runEffect(before, contract, { identity: { id: "mem-1", operationType: contract.operationType }, intent: {} });
    expect(await before.getOperation("mem-1")).not.toBeNull();
    const afterRestart = new InMemoryStore();
    expect(await afterRestart.getOperation("mem-1")).toBeNull();
  });
});
