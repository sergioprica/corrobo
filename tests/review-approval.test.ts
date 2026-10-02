import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
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
    const result = await runEffect(store, contract, {
      identity: "a1",
      intent,
      reviewDecision: { decision: "approved", reviewer: "alice@example.com", decidedAt, note: "customer called" }
    });

    const expected: RecordedReview = {
      decision: "approved",
      reviewer: "alice@example.com",
      decidedAt,
      note: "customer called",
      intentFingerprint: fingerprintIntent(contract, intent),
      recordedAt: store.iso()
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
    const result = await runEffect(store, contract, {
      identity: "a2",
      intent,
      reviewDecision: { decision: "approved", reviewer: "bob" }
    });
    expect(result.review).toMatchObject({ decidedAt: store.iso(), recordedAt: store.iso() });
  });

  it("a rejection records who rejected it, says so in the result, and nothing is executed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a3");
    const result = await runEffect(store, contract, {
      identity: "a3",
      intent,
      reviewDecision: { decision: "rejected", reviewer: "carol", note: "duplicate request" }
    });
    expect(result).toMatchObject({
      status: "CLOSED",
      disposition: "REVIEW",
      dispositionReason: { code: "POLICY_REVIEW_REJECTED" },
      review: { decision: "rejected", reviewer: "carol", note: "duplicate request" }
    });
    expect(result.dispositionReason.summary).toContain("by carol");
    const later = await runEffect(store, contract, {
      identity: "a3",
      intent,
      reviewDecision: { decision: "approved", reviewer: "mallory" }
    });
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
      runEffect(store, contract, {
        identity: "a4",
        intent,
        reviewDecision: { decision: "approved", reviewer: "alice", intentFingerprint: fingerprintIntent(contract, shown) }
      })
    ).rejects.toThrow(/different intent/);
    expect(await store.getOperation("a4")).toEqual(before);
    expect(ledger.credits).toEqual([]);

    const ok = await runEffect(store, contract, {
      identity: "a4",
      intent,
      reviewDecision: { decision: "approved", reviewer: "alice", intentFingerprint: fingerprintIntent(contract, intent) }
    });
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
      runEffect(store, contract, {
        identity: "a5",
        intent,
        reviewDecision: { decision: "approved", reviewer: "alice", decidedAt: store.iso(-10_000), expiresAt: store.iso() }
      })
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
    ["a number", 1],
    ["null", null]
  ])("a malformed reviewDecision (%s) throws before anything is recorded or executed", async (_label, decision) => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a6");
    const before = await store.getOperation("a6");
    await expect(
      runEffect(store, contract, { identity: "a6", intent, reviewDecision: decision as ReviewDecision })
    ).rejects.toThrow(TypeError);
    expect(await store.getOperation("a6")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it("the deprecated string form still works, and is recorded with reviewer null", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a7");
    const result = await runEffect(store, contract, { identity: "a7", intent, reviewDecision: "approved" });
    expect(result.disposition).toBe("COMPLETE");
    expect(result.review).toMatchObject({ decision: "approved", reviewer: null });
    expect(result.attempts[0].check?.reason.summary).toBe("Approved in review.");
    expect(ledger.count("a7")).toBe(1);
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
    const first = await runEffect(store, contract, {
      identity: "e1",
      intent,
      reviewDecision: { decision: "approved", reviewer: "alice", expiresAt: store.iso(60_000) }
    });
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

    const renewed = await runEffect(store, contract, {
      identity: "e1",
      intent,
      reviewDecision: { decision: "approved", reviewer: "bob", expiresAt: store.iso(60_000) }
    });
    expect(renewed.disposition).toBe("COMPLETE");
    expect(renewed.attempts[1].check?.approval?.reviewer).toBe("bob");
    expect(ledger.count("e1")).toBe(1);
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

    const self = await runEffect(store, contract, {
      identity: "p1",
      intent,
      context: { actor: "dave" },
      reviewDecision: { decision: "approved", reviewer: "dave" }
    });
    expect(self).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "SELF_APPROVAL" } });
    expect(ledger.credits).toEqual([]);

    const other = await runEffect(store, contract, {
      identity: "p1",
      intent,
      context: { actor: "dave" },
      reviewDecision: { decision: "approved", reviewer: "erin" }
    });
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
    await runEffect(store, v1, { identity: "m1", intent, reviewDecision: { decision: "approved", reviewer: "alice" } });

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
          recordedAt: store.iso()
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
