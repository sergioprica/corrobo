import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { OperationBusyError, reviewEffect, runEffect } from "../src/core/runtime";
import { fingerprintIntent } from "../src/core/fingerprint";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { EffectContract, RecordedReview, RevalidateInput, RevalidationResult, ReviewDecision } from "../src/core/types";

/**
 * Attributed review decisions (issue #28): who decided, when, until when, and for exactly which
 * intent, recorded on the operation and checked before every attempt. Effects are counted on
 * the fake ledger, never from corrobo's own record.
 */

class ClockStore extends InMemoryStore {
  time = Date.parse("2026-10-01T12:00:00.000Z");
  async now(): Promise<Date> {
    return new Date(this.time);
  }
  iso(offsetMs = 0): string {
    return new Date(this.time + offsetMs).toISOString();
  }
}

type Intent = { orderId: string; amountCents: number; memo?: string };
type Context = { actor: string };

function makeLedger() {
  const credits: string[] = [];
  let respondNotApplied = false;
  return {
    credits,
    respondNotAppliedOnce() {
      respondNotApplied = true;
    },
    async credit(ref: string) {
      if (respondNotApplied) {
        respondNotApplied = false;
        return { applied: false };
      }
      credits.push(ref);
      return { applied: true };
    },
    count: (ref: string) => credits.filter((c) => c === ref).length
  };
}

function makeContract(
  ledger: ReturnType<typeof makeLedger>,
  options: {
    revalidate?: (input: RevalidateInput<Intent, Context>) => RevalidationResult;
    fingerprintIntent?: (intent: Intent) => string;
  } = {}
) {
  return defineContract<Intent, Context>()({
    operationType: "payments/refund",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    authorize: () => ({ requiresReview: true }),
    execute: ({ identity }) => ledger.credit(identity.id),
    observe: async ({ identity }) => observed(ledger.count(identity.id), { source: "ledger", authoritative: true }),
    reconcile: ({ observation }) =>
      observation.status === "observed" && observation.data > 0
        ? reconciled("APPLIED", "REFUNDED", "refunded")
        : reconciled("NOT_APPLIED", "NONE", "none"),
    ...(options.revalidate ? { revalidate: options.revalidate } : {}),
    ...(options.fingerprintIntent ? { fingerprintIntent: options.fingerprintIntent } : {})
  });
}

const intent: Intent = { orderId: "1001", amountCents: 5_000 };

/** The two-step flow: the review screen records the decision, then a worker acts on it. */
async function decideThenRun(
  store: ClockStore,
  contract: EffectContract<Intent, any, any, Context>,
  id: string,
  decision: ReviewDecision,
  options: { context?: Context } = {}
) {
  await reviewEffect(store, contract, { identity: id, decision });
  return runEffect(store, contract, { identity: id, intent, ...(options.context ? { context: options.context } : {}) });
}

async function awaitingReview(store: ClockStore, contract: EffectContract<Intent, any, any, Context>, id: string) {
  const waiting = await runEffect(store, contract, { identity: id, intent });
  expect(waiting.status).toBe("AWAITING_REVIEW");
  return waiting;
}

describe("review decisions are recorded and bound", () => {
  it("an approval is recorded with who, when and the intent it applies to, and the attempt it allowed carries it", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a1");

    const decidedAt = store.iso(-60_000);
    const result = await decideThenRun(store, contract, "a1", { decision: "approved", reviewer: "alice@example.com", decidedAt, note: "customer called" });

    const expected: RecordedReview = {
      decision: "approved",
      reviewer: "alice@example.com",
      decidedAt,
      note: "customer called",
      intentFingerprint: fingerprintIntent(contract, intent),
      recordedAt: store.iso(),
      attemptCount: 0
    };
    expect(result.disposition).toBe("COMPLETE");
    expect(result.review).toEqual(expected);
    expect((await store.getOperation("a1"))?.review).toEqual(expected);
    expect(result.attempts[0].check).toEqual({
      outcome: "proceed",
      reason: { code: "REVIEW_APPROVED", summary: "Approved in review by alice@example.com." },
      approval: expected,
      attemptNumber: 1,
      checkedAt: store.iso()
    });
    expect(ledger.count("a1")).toBe(1);
  });

  it("decidedAt defaults to when corrobo records it, from the store's clock", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "a2");
    const result = await decideThenRun(store, contract, "a2", { decision: "approved", reviewer: "bob" });
    expect(result.review).toMatchObject({ decidedAt: store.iso(), recordedAt: store.iso() });
  });

  it("a rejection records who rejected it, says so in the result, and nothing is executed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a3");
    const result = await decideThenRun(store, contract, "a3", { decision: "rejected", reviewer: "carol", note: "duplicate request" });
    expect(result).toMatchObject({
      status: "CLOSED",
      disposition: "REVIEW",
      dispositionReason: { code: "POLICY_REVIEW_REJECTED" },
      review: { decision: "rejected", reviewer: "carol", note: "duplicate request" }
    });
    expect(result.dispositionReason.summary).toContain("by carol");
    const later = await decideThenRun(store, contract, "a3", { decision: "approved", reviewer: "mallory" });
    expect(later.review?.reviewer).toBe("carol"); // a closed operation's decision can't be replaced
    expect(ledger.credits).toEqual([]);
  });

  it("an approval made for a different intent than the recorded one is refused, and nothing changes", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a4");
    const before = await store.getOperation("a4");

    const shown = { ...intent, amountCents: 500 }; // the reviewer was shown $5, not $50
    await expect(
      decideThenRun(store, contract, "a4", { decision: "approved", reviewer: "alice", intentFingerprint: fingerprintIntent(contract, shown) })
    ).rejects.toThrow(/different intent/);
    expect(await store.getOperation("a4")).toEqual(before);
    expect(ledger.credits).toEqual([]);

    const ok = await decideThenRun(store, contract, "a4", { decision: "approved", reviewer: "alice", intentFingerprint: fingerprintIntent(contract, intent) });
    expect(ok.disposition).toBe("COMPLETE");
    expect(ledger.count("a4")).toBe(1);
  });

  it("an approval that has already expired when it arrives is refused, and nothing changes", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a5");
    const before = await store.getOperation("a5");
    await expect(
      decideThenRun(store, contract, "a5", { decision: "approved", reviewer: "alice", decidedAt: store.iso(-10_000), expiresAt: store.iso() })
    ).rejects.toThrow(/expired/);
    expect(await store.getOperation("a5")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["no reviewer", { decision: "approved" }],
    ["an empty reviewer", { decision: "approved", reviewer: "  " }],
    ["an unknown decision", { decision: "maybe", reviewer: "alice" }],
    ["a decidedAt that isn't a date", { decision: "approved", reviewer: "alice", decidedAt: "yesterday" }],
    ["an expiresAt on a rejection", { decision: "rejected", reviewer: "alice", expiresAt: "2030-01-01T00:00:00Z" }],
    [
      "an expiresAt before decidedAt",
      { decision: "approved", reviewer: "alice", decidedAt: "2030-01-02T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z" }
    ],
    ["a non-string note", { decision: "approved", reviewer: "alice", note: 42 }],
    ["a non-ISO date", { decision: "approved", reviewer: "alice", expiresAt: "12/31/2099" }],
    ["a date that doesn't exist", { decision: "approved", reviewer: "alice", expiresAt: "2099-02-30T00:00:00Z" }],
    ["a time with no offset (host-timezone dependent)", { decision: "approved", reviewer: "alice", expiresAt: "2099-01-01T00:00:00" }],
    ["a date with no time", { decision: "approved", reviewer: "alice", decidedAt: "2026-10-01" }],
    ["a time an offset carries past year 9999", { decision: "approved", reviewer: "alice", expiresAt: "9999-12-31T23:59:59-23:59" }],
    ["a leap second (a JavaScript Date can't hold it)", { decision: "approved", reviewer: "alice", expiresAt: "2099-12-31T23:59:60Z" }],
    ["a number", 1],
    ["null", null]
  ])("a malformed reviewDecision (%s) throws before anything is recorded or executed", async (_label, decision) => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a6");
    const before = await store.getOperation("a6");
    await expect(
      reviewEffect(store, contract, { identity: "a6", decision: decision as ReviewDecision })
    ).rejects.toThrow(TypeError);
    expect(await store.getOperation("a6")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it("each field of a decision is read once: a getter that changes its answer can't slip past validation", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a8");
    let reads = 0;
    const shifty = {
      get decision() {
        reads += 1;
        return reads === 1 ? "approved" : "maybe";
      },
      reviewer: "alice"
    };
    const result = await reviewEffect(store, contract, { identity: "a8", decision: shifty as ReviewDecision });
    expect(reads).toBe(1);
    expect(result.review?.decision).toBe("approved");
  });

  it("times with an offset are recorded in one canonical UTC form", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "a9");
    const result = await decideThenRun(store, contract, "a9", {
        decision: "approved",
        reviewer: "alice",
        decidedAt: "2026-10-01T16:30:00+05:00",
        expiresAt: "2099-01-01T05:00:00.5+05:00"
      });
    expect(result.review).toMatchObject({ decidedAt: "2026-10-01T11:30:00.000Z", expiresAt: "2099-01-01T00:00:00.500Z" });
  });

  it("runEffect() refuses the reviewDecision field corrobo 0.3 took, and nothing is recorded or executed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a7");
    const before = await store.getOperation("a7");
    for (const reviewDecision of ["approved", "rejected"]) {
      await expect(
        runEffect(store, contract, { identity: "a7", intent, reviewDecision } as unknown as Parameters<typeof runEffect>[2])
      ).rejects.toThrow(/reviewEffect/);
    }
    expect(await store.getOperation("a7")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });
});

describe("approvals are checked before every attempt", () => {
  it("an approval that expires before a later attempt sends it back to review instead of executing", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const revalidated: number[] = [];
    const contract = makeContract(ledger, {
      revalidate: ({ attemptNumber }) => {
        revalidated.push(attemptNumber);
        return { decision: "proceed" };
      }
    });
    await awaitingReview(store, contract, "e1");

    ledger.respondNotAppliedOnce(); // attempt 1 gets a response: not applied, RETRY
    const first = await decideThenRun(store, contract, "e1", { decision: "approved", reviewer: "alice", expiresAt: store.iso(60_000) });
    expect(first.disposition).toBe("RETRY");

    store.time += 60_000;
    const second = await runEffect(store, contract, { identity: "e1", intent });
    expect(second).toMatchObject({
      status: "AWAITING_REVIEW",
      disposition: "REVIEW",
      evidenceState: "NOT_APPLIED",
      dispositionReason: { code: "APPROVAL_EXPIRED" }
    });
    expect(second.attempts).toHaveLength(1);
    expect(revalidated).toEqual([1]); // corrobo's own check stopped it; revalidate() never saw an expired approval
    expect(ledger.credits).toEqual([]);

    const renewed = await decideThenRun(store, contract, "e1", { decision: "approved", reviewer: "bob", expiresAt: store.iso(60_000) });
    expect(renewed.disposition).toBe("COMPLETE");
    expect(renewed.attempts[1].check?.approval?.reviewer).toBe("bob");
    expect(ledger.count("e1")).toBe(1);
  });

  it("an approval that expires while revalidate() runs doesn't allow the attempt, and the attempt starts at the time it was checked", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let slow = true;
    const contract = makeContract(ledger, {
      revalidate: () => {
        if (slow) store.time += 2_000; // the policy service takes two seconds
        return { decision: "proceed" };
      }
    });
    await awaitingReview(store, contract, "e2");
    const result = await decideThenRun(store, contract, "e2", { decision: "approved", reviewer: "alice", expiresAt: store.iso(1_000) });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_EXPIRED" } });
    expect(result.attempts).toEqual([]);
    expect(ledger.credits).toEqual([]);

    slow = false;
    const renewed = await decideThenRun(store, contract, "e2", { decision: "approved", reviewer: "alice", expiresAt: store.iso(1_000) });
    expect(renewed.disposition).toBe("COMPLETE");
    expect(renewed.attempts[0].startedAt).toBe(renewed.attempts[0].check?.checkedAt);
    expect(ledger.count("e2")).toBe(1);
  });

  it.each([
    ["before its first attempt", false],
    ["after an attempt that asked for a retry", true]
  ])("an operation approved by corrobo 0.3.x (no recorded decision) needs a new review %s", async (_label, withRetry) => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    // What a 0.3.x approval left behind: OPEN, the review reason, and no record of the decision.
    await store.createOperation({
      identity: { id: "legacy", operationType: "payments/refund" },
      intent,
      status: "OPEN",
      reviewReason: { code: "POLICY_REVIEW_REQUIRED", summary: "needs review" }
    });
    if (withRetry) {
      ledger.respondNotAppliedOnce();
      const record = await store.getOperation("legacy");
      await store.reserveAttempt("legacy", { attemptNumber: 1, startedAt: store.iso() }, record!.version);
      const reserved = await store.getOperation("legacy");
      await ledger.credit("legacy"); // the not-applied response
      await store.updateLatestAttempt(
        "legacy",
        {
          status: "RESOLVED",
          attemptNumber: 1,
          startedAt: store.iso(),
          updatedAt: store.iso(),
          transport: { ok: true, evidence: { applied: false } },
          observations: [{ status: "observed", data: 0, authoritative: true, source: "ledger", observedAt: store.iso() }],
          evidenceState: "NOT_APPLIED",
          evidenceReason: { code: "NONE", summary: "none" },
          disposition: "RETRY",
          dispositionReason: { code: "SAFE_RETRY", summary: "retry" }
        },
        "OPEN",
        reserved!.version
      );
    }

    const result = await runEffect(store, contract, { identity: "legacy", intent });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_NOT_RECORDED" } });
    expect(ledger.credits).toEqual([]);

    const approved = await decideThenRun(store, contract, "legacy", { decision: "approved", reviewer: "alice" });
    expect(approved.disposition).toBe("COMPLETE");
    expect(ledger.count("legacy")).toBe(1);
  });

  it("revalidate() receives the approval and can enforce approver policy (no self-approval)", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const approvals: (RecordedReview | null)[] = [];
    const contract = makeContract(ledger, {
      revalidate: ({ approval, context }) => {
        approvals.push(approval);
        return approval?.reviewer === context?.actor
          ? { decision: "requiresReview", reason: { code: "SELF_APPROVAL", summary: "The requester can't approve their own refund." } }
          : { decision: "proceed" };
      }
    });
    await awaitingReview(store, contract, "p1");

    const self = await decideThenRun(store, contract, "p1", { decision: "approved", reviewer: "dave" }, { context: { actor: "dave" } });
    expect(self).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "SELF_APPROVAL" } });
    expect(ledger.credits).toEqual([]);

    const other = await decideThenRun(store, contract, "p1", { decision: "approved", reviewer: "erin" }, { context: { actor: "dave" } });
    expect(other.disposition).toBe("COMPLETE");
    expect(approvals.map((a) => a?.reviewer)).toEqual(["dave", "erin"]);
    expect(ledger.count("p1")).toBe(1);
  });

  it("revalidate() gets approval null when the operation never went through review", async () => {
    const seen: unknown[] = [];
    const contract = {
      ...makeContract(makeLedger(), {
        revalidate: ({ approval }) => {
          seen.push(approval);
          return { decision: "proceed" };
        }
      }),
      authorize: undefined
    };
    const result = await runEffect(new ClockStore(), contract, { identity: "p2", intent });
    expect(result.disposition).toBe("COMPLETE");
    expect(result.review).toBeNull();
    expect(seen).toEqual([null]);
    expect(result.attempts[0].check?.approval).toBeUndefined();
  });

  it("an approval whose intent no longer matches the recorded one (the fingerprint rules changed) goes back to review", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const v1 = makeContract(ledger);
    await awaitingReview(store, v1, "m1");
    ledger.respondNotAppliedOnce();
    await decideThenRun(store, v1, "m1", { decision: "approved", reviewer: "alice" });

    // A new deploy fingerprints intents differently (ignoring memo); the old approval's
    // fingerprint no longer names the recorded intent under the current rules.
    const v2 = makeContract(ledger, {
      fingerprintIntent: (i) => JSON.stringify({ orderId: i.orderId, amountCents: i.amountCents })
    });
    const second = await runEffect(store, v2, { identity: "m1", intent });
    expect(second).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_INTENT_MISMATCH" } });
    expect(ledger.credits).toEqual([]);
  });

  it("a crash after the approval is recorded but before the attempt: the next call checks the approval again", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "c1");
    // Simulate: the approval was recorded (status OPEN, review set), then the process died.
    const record = await store.getOperation("c1");
    await store.updateOperation(
      "c1",
      {
        status: "OPEN",
        review: {
          decision: "approved",
          reviewer: "alice",
          decidedAt: store.iso(),
          expiresAt: store.iso(1_000),
          intentFingerprint: fingerprintIntent(contract, intent),
          recordedAt: store.iso(),
          attemptCount: 0
        }
      },
      record!.version
    );
    store.time += 1_000;
    const result = await runEffect(store, contract, { identity: "c1", intent });
    expect(result.dispositionReason.code).toBe("APPROVAL_EXPIRED");
    expect(ledger.credits).toEqual([]);
  });
});

describe("reviewEffect(): deciding is separate from acting", () => {
  it("records the decision and does nothing else: no execute, no observe; runEffect() then makes the attempt", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let observes = 0;
    const base = makeContract(ledger);
    const contract = { ...base, observe: async (input: Parameters<typeof base.observe>[0]) => (observes++, base.observe(input)) };
    await awaitingReview(store, contract, "s1");

    const decided = await reviewEffect(store, contract, { identity: "s1", decision: { decision: "approved", reviewer: "alice" } });
    expect(decided).toMatchObject({
      status: "OPEN",
      disposition: null,
      dispositionReason: { code: "REVIEW_APPROVED" },
      attempts: [],
      review: { reviewer: "alice", attemptCount: 0 }
    });
    expect(decided.dispositionReason.summary).toContain("not attempted yet");
    expect(ledger.credits).toEqual([]);
    expect(observes).toBe(0);

    const done = await runEffect(store, contract, { identity: "s1", intent });
    expect(done.disposition).toBe("COMPLETE");
    expect(ledger.count("s1")).toBe(1);
  });

  it("while another call holds the operation it throws OperationBusyError and records nothing", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "s2");
    const before = await store.getOperation("s2");
    const lock = await store.tryAcquireLock("s2");
    try {
      await expect(
        reviewEffect(store, contract, { identity: "s2", decision: { decision: "approved", reviewer: "alice" } })
      ).rejects.toBeInstanceOf(OperationBusyError);
    } finally {
      await lock?.release();
    }
    expect(await store.getOperation("s2")).toEqual(before);
  });

  it("an operation that isn't awaiting review is returned unchanged, and the decision isn't recorded", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = { ...makeContract(ledger), authorize: undefined };
    await runEffect(store, contract, { identity: "s3", intent });
    const before = await store.getOperation("s3");
    const result = await reviewEffect(store, contract, { identity: "s3", decision: { decision: "approved", reviewer: "alice" } });
    expect(result).toMatchObject({ status: "CLOSED", disposition: "COMPLETE", review: null });
    expect(await store.getOperation("s3")).toEqual(before);
    expect(ledger.count("s3")).toBe(1);
  });

  it("an unknown operation, or one of another operation type, is refused", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    const decision: ReviewDecision = { decision: "approved", reviewer: "alice" };
    await expect(reviewEffect(store, contract, { identity: "nope", decision })).rejects.toThrow(/no operation "nope"/);
    await expect(
      reviewEffect(store, contract, { identity: { id: "x", operationType: "other/type" }, decision })
    ).rejects.toThrow(/operationType/);
  });

  it("runEffect() refuses a decision object: decisions go through reviewEffect()", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "s4");
    const before = await store.getOperation("s4");
    await expect(
      runEffect(store, contract, {
        identity: "s4",
        intent,
        reviewDecision: { decision: "approved", reviewer: "agent" }
      } as unknown as Parameters<typeof runEffect>[2])
    ).rejects.toThrow(/reviewEffect/);
    expect(await store.getOperation("s4")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it("approved after an attempt that got a not-applied response: the next runEffect() re-observes first, so an effect that appeared meanwhile isn't repeated", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let observes = 0;
    let reviewed = false;
    const base = makeContract(ledger, {
      revalidate: ({ attemptNumber }) => (attemptNumber === 1 || reviewed ? { decision: "proceed" } : { decision: "requiresReview" })
    });
    const contract = { ...base, authorize: undefined, observe: async (input: Parameters<typeof base.observe>[0]) => (observes++, base.observe(input)) };

    ledger.respondNotAppliedOnce();
    expect((await runEffect(store, contract, { identity: "s5", intent })).disposition).toBe("RETRY");
    expect((await runEffect(store, contract, { identity: "s5", intent })).status).toBe("AWAITING_REVIEW");

    ledger.credits.push("s5"); // the effect appears while the operation waits for review
    reviewed = true;
    const decided = await reviewEffect(store, contract, { identity: "s5", decision: { decision: "approved", reviewer: "alice" } });
    expect(decided.review?.attemptCount).toBe(1);
    expect(decided).toMatchObject({ status: "OPEN", disposition: null, dispositionReason: { code: "REVIEW_APPROVED" } });
    expect(decided.retryNotBefore).toBeNull();

    observes = 0;
    const result = await runEffect(store, contract, { identity: "s5", intent });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(observes).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(ledger.count("s5")).toBe(1);
  });

  it("a concurrent write while the decision is being recorded is OperationBusyError, and the decision isn't recorded", async () => {
    class RacingStore extends ClockStore {
      raced = false;
      override async updateOperation(...args: Parameters<ClockStore["updateOperation"]>) {
        if (!this.raced && args[1].review) {
          this.raced = true; // another pass writes first (its lock was lost, say)
          const current = await this.getOperation(args[0]);
          await super.updateOperation(args[0], { reviewReason: { code: "OTHER", summary: "other" } }, current!.version);
        }
        return super.updateOperation(...args);
      }
    }
    const store = new RacingStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "s6");
    await expect(
      reviewEffect(store, contract, { identity: "s6", decision: { decision: "approved", reviewer: "alice" } })
    ).rejects.toBeInstanceOf(OperationBusyError);
    const record = await store.getOperation("s6");
    expect(record?.review).toBeUndefined();
    expect(record?.status).toBe("AWAITING_REVIEW");
  });

  it("a review record without attemptCount is treated as recent: the next runEffect() re-observes first", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let observes = 0;
    const base = makeContract(ledger);
    const contract = { ...base, authorize: undefined, observe: async (input: Parameters<typeof base.observe>[0]) => (observes++, base.observe(input)) };
    ledger.respondNotAppliedOnce();
    await runEffect(store, contract, { identity: "s7", intent }); // attempt 1: not applied, RETRY
    const record = await store.getOperation("s7");
    const { attemptCount: _dropped, ...withoutCount } = {
      decision: "approved" as const,
      reviewer: "alice",
      decidedAt: store.iso(),
      intentFingerprint: fingerprintIntent(contract, intent),
      recordedAt: store.iso(),
      attemptCount: 1
    };
    await store.updateOperation("s7", { review: withoutCount as RecordedReview }, record!.version);

    ledger.credits.push("s7"); // the effect appeared
    observes = 0;
    const result = await runEffect(store, contract, { identity: "s7", intent });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(observes).toBe(1);
    expect(ledger.count("s7")).toBe(1);
  });
});
