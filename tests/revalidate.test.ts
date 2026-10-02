import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { RevalidateInput, RevalidationResult } from "../src/core/types";

/**
 * revalidate() (issue #27): runs under the lock immediately before every attempt, before the
 * attempt is reserved; only ever gates a new execute(), never finding out what happened.
 * Effects are counted on the fake target, never from corrobo's own record.
 */

/** A store with a clock the test moves (like a database clock). */
class ClockStore extends InMemoryStore {
  time = Date.parse("2026-10-01T12:00:00.000Z");
  async now(): Promise<Date> {
    return new Date(this.time);
  }
}

/**
 * A ledger that applies credits. `dropNext` makes the next request fail without applying it;
 * `holdNext` makes it fail while the request stays in flight until `land()` is called.
 */
function makeLedger() {
  const credits: string[] = [];
  const held: string[] = [];
  let mode: "normal" | "dropNext" | "holdNext" | "rejectNext" = "normal";
  return {
    credits,
    set next(m: typeof mode) {
      mode = m;
    },
    async credit(ref: string): Promise<{ ok: true } | { ok: false }> {
      const current = mode;
      mode = "normal";
      if (current === "dropNext") throw new Error("connection reset before the request was sent");
      if (current === "holdNext") {
        held.push(ref);
        throw new Error("timed out");
      }
      if (current === "rejectNext") return { ok: false }; // a response: the request is finished
      credits.push(ref);
      return { ok: true };
    },
    land() {
      credits.push(...held.splice(0));
    },
    count: (ref: string) => credits.filter((c) => c === ref).length
  };
}

type Context = { actor: string };

function makeContract(
  ledger: ReturnType<typeof makeLedger>,
  revalidate?: (input: RevalidateInput<{ amount: number }, Context>) => RevalidationResult | Promise<RevalidationResult>,
  log: string[] = [],
  options: { maxInFlightMs?: number } = {}
) {
  return defineContract<{ amount: number }, Context>()({
    operationType: "ledger/credit",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs: options.maxInFlightMs ?? 1_000,
    execute: async ({ identity }) => {
      log.push("execute");
      const res = await ledger.credit(identity.id);
      return res;
    },
    observe: async ({ identity }) => {
      log.push("observe");
      return observed(ledger.count(identity.id), { source: "ledger", authoritative: true });
    },
    reconcile: ({ observation }) => {
      if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "no read");
      return observation.data === 0
        ? reconciled("NOT_APPLIED", "NONE", "no credit")
        : reconciled("APPLIED", "CREDITED", "credited");
    },
    ...(revalidate
      ? {
          revalidate: (input: RevalidateInput<{ amount: number }, Context>) => {
            log.push(`revalidate#${input.attemptNumber}`);
            return revalidate(input);
          }
        }
      : {})
  });
}

const intent = { amount: 100 };

describe("revalidate(): before the first attempt", () => {
  it("runs once, before the attempt is reserved, with the attempt number, this call's context and the record", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const seen: RevalidateInput<{ amount: number }, Context>[] = [];
    const contract = makeContract(ledger, (input) => {
      seen.push(structuredClone(input));
      return { decision: "proceed" };
    });

    const result = await runEffect(store, contract, { identity: "c1", intent, context: { actor: "user:7" } });

    expect(result.disposition).toBe("COMPLETE");
    expect(ledger.count("c1")).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      intent,
      identity: { id: "c1", operationType: "ledger/credit" },
      attemptNumber: 1,
      context: { actor: "user:7" }
    });
    expect(seen[0].record.attempts).toEqual([]); // nothing reserved yet
    const attempt = result.attempts[0];
    expect(attempt.check).toEqual({
      outcome: "proceed",
      reason: { code: "REVALIDATION_PASSED", summary: "revalidate() allowed this attempt." },
      attemptNumber: 1,
      checkedAt: new Date(store.time).toISOString()
    });
  });

  it("reject: nothing is executed or reserved; CLOSED with REPLAN, and later calls never execute", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const log: string[] = [];
    const contract = makeContract(
      ledger,
      () => ({ decision: "reject", reason: { code: "ORDER_CANCELLED", summary: "The order was cancelled." } }),
      log
    );

    const result = await runEffect(store, contract, { identity: "c2", intent });
    expect(result).toMatchObject({
      status: "CLOSED",
      disposition: "REPLAN",
      evidenceState: null,
      dispositionReason: { code: "ORDER_CANCELLED" },
      attempts: []
    });

    const again = await runEffect(store, contract, { identity: "c2", intent, reviewDecision: "approved" });
    expect(again.disposition).toBe("REPLAN");
    expect(ledger.credits).toEqual([]);
    expect(log).toEqual(["revalidate#1"]); // checked once; a CLOSED operation is never checked again

    const record = await store.getOperation("c2");
    expect(record?.blockedBy).toMatchObject({ outcome: "reject", attemptNumber: 1, recordVersion: record?.version });
  });

  it("reject without a reason gets a default one that says to replan with a new identity", async () => {
    const result = await runEffect(new ClockStore(), makeContract(makeLedger(), () => ({ decision: "reject" })), {
      identity: "c2b",
      intent
    });
    expect(result.dispositionReason.code).toBe("REVALIDATION_REJECTED");
    expect(result.dispositionReason.summary).toMatch(/new identity/);
  });

  it("requiresReview: AWAITING_REVIEW with the hook's reason; on approval it runs again, with the approving call's context", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contexts: (Context | undefined)[] = [];
    let approvals = 0;
    const contract = makeContract(ledger, ({ context }) => {
      contexts.push(context);
      return approvals === 0
        ? { decision: "requiresReview", reason: { code: "OVER_LIMIT", summary: "Over the agent's limit." } }
        : { decision: "proceed" };
    });

    const waiting = await runEffect(store, contract, { identity: "c3", intent, context: { actor: "agent" } });
    expect(waiting).toMatchObject({
      status: "AWAITING_REVIEW",
      disposition: "REVIEW",
      dispositionReason: { code: "OVER_LIMIT" },
      attempts: []
    });
    expect(ledger.credits).toEqual([]);

    // Without a decision nothing changes and nothing is checked again.
    await runEffect(store, contract, { identity: "c3", intent, context: { actor: "agent" } });
    expect(contexts).toHaveLength(1);

    approvals = 1;
    const done = await runEffect(store, contract, {
      identity: "c3",
      intent,
      reviewDecision: "approved",
      context: { actor: "reviewer:alice" }
    });
    expect(done.disposition).toBe("COMPLETE");
    expect(ledger.count("c3")).toBe(1);
    expect(contexts).toEqual([{ actor: "agent" }, { actor: "reviewer:alice" }]);
    expect(done.attempts[0].check?.outcome).toBe("proceed");
  });

  it("requiresReview, then rejected in review: CLOSED, nothing executed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger, () => ({ decision: "requiresReview" }));

    const waiting = await runEffect(store, contract, { identity: "c3r", intent });
    expect(waiting.dispositionReason.code).toBe("REVALIDATION_REQUIRES_REVIEW");
    const rejected = await runEffect(store, contract, { identity: "c3r", intent, reviewDecision: "rejected" });
    expect(rejected).toMatchObject({ status: "CLOSED", disposition: "REVIEW" });
    expect(rejected.dispositionReason.code).toBe("POLICY_REVIEW_REJECTED");
    expect(ledger.credits).toEqual([]);
  });

  it("an approval that revalidate() still won't accept goes back to review instead of executing", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger, ({ context }) =>
      context?.actor === "reviewer:senior"
        ? { decision: "proceed" }
        : { decision: "requiresReview", reason: { code: "NEEDS_SENIOR", summary: "Needs a senior reviewer." } }
    );

    await runEffect(store, contract, { identity: "c3s", intent });
    const junior = await runEffect(store, contract, {
      identity: "c3s",
      intent,
      reviewDecision: "approved",
      context: { actor: "reviewer:junior" }
    });
    expect(junior).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "NEEDS_SENIOR" } });
    expect(ledger.credits).toEqual([]);

    const senior = await runEffect(store, contract, {
      identity: "c3s",
      intent,
      reviewDecision: "approved",
      context: { actor: "reviewer:senior" }
    });
    expect(senior.disposition).toBe("COMPLETE");
    expect(ledger.count("c3s")).toBe(1);
  });

  it("authorize() still routes at creation, and receives the identity and context", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const authorizeCalls: unknown[] = [];
    const contract = {
      ...makeContract(ledger, () => ({ decision: "proceed" })),
      authorize: (i: { amount: number }, input: unknown) => {
        authorizeCalls.push([i, input]);
        return { requiresReview: true };
      }
    };
    await runEffect(store, contract, { identity: "c4", intent, context: { actor: "agent" } });
    await runEffect(store, contract, { identity: "c4", intent, reviewDecision: "approved" });
    expect(authorizeCalls).toEqual([
      [intent, { identity: { id: "c4", operationType: "ledger/credit" }, context: { actor: "agent" } }]
    ]);
    expect(ledger.count("c4")).toBe(1);
  });
});

describe("revalidate(): failing closed", () => {
  it("a throw: nothing executed or reserved, the operation stays OPEN with REVALIDATION_FAILED, and a later call checks again", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let down = true;
    const contract = makeContract(ledger, () => {
      if (down) throw new Error("policy service unavailable");
      return { decision: "proceed" };
    });

    const failed = await runEffect(store, contract, { identity: "f1", intent });
    expect(failed).toMatchObject({ status: "OPEN", disposition: null, attempts: [] });
    expect(failed.dispositionReason.code).toBe("REVALIDATION_FAILED");
    expect(failed.dispositionReason.summary).toContain("policy service unavailable");
    expect(ledger.credits).toEqual([]);

    // A read of the record (e.g. by a caller that lost the lock race) reports the same.
    const recorded = await store.getOperation("f1");
    expect(recorded?.blockedBy?.outcome).toBe("failed");

    down = false;
    const done = await runEffect(store, contract, { identity: "f1", intent });
    expect(done.disposition).toBe("COMPLETE");
    expect(done.dispositionReason.code).toBe("EFFECT_CONFIRMED"); // the old failure no longer describes the record
    expect(ledger.count("f1")).toBe(1);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an unknown decision", { decision: "yes" }],
    ["a boolean", true],
    ["a reason without a summary", { decision: "proceed", reason: { code: "OK" } }]
  ])("returning %s fails closed", async (_label, value) => {
    const ledger = makeLedger();
    const contract = makeContract(ledger, () => value as unknown as RevalidationResult);
    const result = await runEffect(new ClockStore(), contract, { identity: "f2", intent });
    expect(result.dispositionReason.code).toBe("REVALIDATION_FAILED");
    expect(result.status).toBe("OPEN");
    expect(ledger.credits).toEqual([]);
  });

  it("changing the record it was given changes nothing", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger, ({ record }) => {
      record.version = 99;
      record.attempts.push({ status: "RESERVED", attemptNumber: 7, startedAt: "x", updatedAt: "x" });
      record.identity.id = "someone-else";
      return { decision: "proceed" };
    });
    const result = await runEffect(store, contract, { identity: "f3", intent });
    expect(result.disposition).toBe("COMPLETE");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].attemptNumber).toBe(1);
    expect(ledger.count("f3")).toBe(1);
  });

  it("if another pass writes while revalidate() runs (lost lock), this pass executes nothing", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger, async ({ identity, record }) => {
      await store.updateOperation(identity.id, { reviewReason: { code: "OTHER", summary: "another pass" } }, record.version);
      return { decision: "proceed" };
    });
    const result = await runEffect(store, contract, { identity: "f4", intent });
    expect(ledger.credits).toEqual([]);
    expect(result.attempts).toEqual([]);
    expect(result.status).toBe("OPEN");
  });
});

describe("revalidate(): before later attempts", () => {
  it("runs before attempt 2 with that call's context (a background worker), and can stop it; attempt 1's evidence is still reported", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const seen: { attemptNumber: number; actor?: string; attempts: number }[] = [];
    const contract = makeContract(ledger, ({ attemptNumber, context, record }) => {
      seen.push({ attemptNumber, actor: context?.actor, attempts: record.attempts.length });
      return attemptNumber === 1
        ? { decision: "proceed" }
        : { decision: "reject", reason: { code: "SCOPE_REVOKED", summary: "The worker's scope no longer covers this." } };
    });

    ledger.next = "rejectNext"; // attempt 1 gets a response: not applied
    const first = await runEffect(store, contract, { identity: "r1", intent, context: { actor: "user:7" } });
    expect(first).toMatchObject({ evidenceState: "NOT_APPLIED", disposition: "RETRY" });

    const second = await runEffect(store, contract, { identity: "r1", intent, context: { actor: "worker" } });
    expect(second).toMatchObject({
      status: "CLOSED",
      disposition: "REPLAN",
      evidenceState: "NOT_APPLIED",
      dispositionReason: { code: "SCOPE_REVOKED" }
    });
    expect(second.attempts).toHaveLength(1);
    expect(seen).toEqual([
      { attemptNumber: 1, actor: "user:7", attempts: 0 },
      { attemptNumber: 2, actor: "worker", attempts: 1 }
    ]);
    expect(ledger.credits).toEqual([]);
  });

  it("a late landing found by the settlement check is APPLIED, and revalidate() is never asked about it", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const log: string[] = [];
    const contract = makeContract(
      ledger,
      ({ attemptNumber }) => (attemptNumber === 1 ? { decision: "proceed" } : { decision: "reject" }),
      log
    );

    ledger.next = "holdNext"; // times out while the request is still in flight
    const first = await runEffect(store, contract, { identity: "r2", intent });
    expect(first.disposition).toBe("RETRY");
    expect(first.retryNotBefore).not.toBeNull();

    ledger.land();
    store.time += 1_000;
    const second = await runEffect(store, contract, { identity: "r2", intent });
    expect(second).toMatchObject({ status: "CLOSED", evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(ledger.count("r2")).toBe(1);
    expect(log).toEqual(["revalidate#1", "execute", "observe", "observe"]);
  });

  it("order: settlement check first, then revalidate(), then reserve and execute", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const log: string[] = [];
    const contract = makeContract(
      ledger,
      async ({ record }) => {
        log.push(`attempts recorded: ${record.attempts.length}`);
        return { decision: "proceed" };
      },
      log
    );

    ledger.next = "dropNext";
    await runEffect(store, contract, { identity: "r3", intent });
    store.time += 1_000;
    log.length = 0;
    const second = await runEffect(store, contract, { identity: "r3", intent });

    expect(log).toEqual(["observe", "revalidate#2", "attempts recorded: 1", "execute", "observe"]);
    expect(second.disposition).toBe("COMPLETE");
    expect(second.attempts.map((a) => a.check?.attemptNumber)).toEqual([1, 2]);
    expect(ledger.count("r3")).toBe(1);
  });

  it("nothing happens before retryNotBefore: revalidate() isn't called early", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const log: string[] = [];
    const contract = makeContract(ledger, () => ({ decision: "proceed" }), log);
    ledger.next = "dropNext";
    await runEffect(store, contract, { identity: "r4", intent });
    log.length = 0;
    const early = await runEffect(store, contract, { identity: "r4", intent });
    expect(early.disposition).toBe("RETRY");
    expect(log).toEqual([]);
  });

  it("requiresReview before attempt 2, then approved: the settlement check runs again before executing", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const log: string[] = [];
    let reviewed = false;
    const contract = makeContract(
      ledger,
      ({ attemptNumber }) => (attemptNumber === 1 || reviewed ? { decision: "proceed" } : { decision: "requiresReview" }),
      log
    );

    ledger.next = "holdNext";
    await runEffect(store, contract, { identity: "r5", intent });
    store.time += 1_000;
    const waiting = await runEffect(store, contract, { identity: "r5", intent });
    expect(waiting).toMatchObject({ status: "AWAITING_REVIEW", disposition: "REVIEW", evidenceState: "NOT_APPLIED" });

    // While it waited for review, the first request landed after all (later than declared).
    ledger.land();
    reviewed = true;
    log.length = 0;
    const approved = await runEffect(store, contract, { identity: "r5", intent, reviewDecision: "approved" });
    expect(approved).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(log).toEqual(["observe"]);
    expect(ledger.count("r5")).toBe(1);
  });

  it("requiresReview before attempt 2, then rejected in review: CLOSED as rejected, not as a pending RETRY", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger, ({ attemptNumber }) =>
      attemptNumber === 1 ? { decision: "proceed" } : { decision: "requiresReview" }
    );
    ledger.next = "rejectNext";
    await runEffect(store, contract, { identity: "r5r", intent });
    await runEffect(store, contract, { identity: "r5r", intent });

    const rejected = await runEffect(store, contract, { identity: "r5r", intent, reviewDecision: "rejected" });
    expect(rejected).toMatchObject({
      status: "CLOSED",
      disposition: "REVIEW",
      evidenceState: "NOT_APPLIED",
      dispositionReason: { code: "POLICY_REVIEW_REJECTED" },
      retryNotBefore: null
    });
    const again = await runEffect(store, contract, { identity: "r5r", intent });
    expect(again.dispositionReason.code).toBe("POLICY_REVIEW_REJECTED");
    expect(ledger.credits).toEqual([]);
  });

  it("recovering a reserved attempt after a crash never calls revalidate() (it never executes)", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const log: string[] = [];
    const contract = makeContract(ledger, () => ({ decision: "reject" }), log);
    await store.createOperation({ identity: { id: "r6", operationType: "ledger/credit" }, intent, status: "OPEN" });
    await store.reserveAttempt("r6", { attemptNumber: 1, startedAt: new Date(store.time).toISOString() }, 0);
    ledger.credits.push("r6"); // the crashed attempt's request had landed

    const result = await runEffect(store, contract, { identity: "r6", intent });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(log).toEqual(["observe"]);
  });

  it("the check is carried from the reserved attempt to its resolution after a crash", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger, () => ({ decision: "proceed" }));
    const check = {
      outcome: "proceed" as const,
      reason: { code: "REVALIDATION_PASSED", summary: "ok" },
      attemptNumber: 1,
      checkedAt: new Date(store.time).toISOString()
    };
    await store.createOperation({ identity: { id: "r7", operationType: "ledger/credit" }, intent, status: "OPEN" });
    await store.reserveAttempt("r7", { attemptNumber: 1, startedAt: new Date(store.time).toISOString(), check }, 0);
    ledger.credits.push("r7");

    const result = await runEffect(store, contract, { identity: "r7", intent });
    expect(result.attempts[0]).toMatchObject({ status: "RESOLVED", evidenceState: "APPLIED", check });
  });
});
