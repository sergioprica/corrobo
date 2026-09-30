import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatConformanceReport, verifyEffectContract } from "../src/testing";
import { correctContract, fakeLedger } from "../examples/conformance/fake-ledger";
import type { ConformanceTarget } from "../src/testing";
import { createIssueCreditContract } from "../examples/timeout-after-write/contract";
import { startLedgerServer } from "../examples/timeout-after-write/ledger-server";
import type { LedgerServer } from "../examples/timeout-after-write/ledger-server";

describe("verifyEffectContract with a correct contract", () => {
  it("passes every scenario", async () => {
    const { client, target } = fakeLedger();
    const report = await verifyEffectContract({
      contract: correctContract(client),
      target,
      intent: { amount: 5 },
      otherIntent: { amount: 500 }
    });
    expect(report.results.filter((r) => r.status !== "pass"), formatConformanceReport(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(12);
    expect(report.summary).toBe("corrobo conformance: passed the configured scenarios (12 run).");
  });

  it("without maxInFlightMs it still passes, ending ambiguous cases in INVESTIGATE (noted), never duplicating", async () => {
    const { client, target } = fakeLedger();
    const report = await verifyEffectContract({ contract: correctContract(client, null), target, intent: { amount: 5 } });
    expect(report.passed, formatConformanceReport(report)).toBe(true);
    const lost = report.results.find((r) => r.scenario === "request-lost-before-commit")!;
    expect(lost.effects).toBe(0);
    expect(lost.disposition).toBe("INVESTIGATE");
    expect(lost.notes.join(" ")).toMatch(/no maxInFlightMs declared/);
  });

  it("skips (and says why) scenarios the target or options can't drive", async () => {
    const { client, target } = fakeLedger();
    const { lateLandingMs: _unused, ...withoutLate } = target;
    const noPending = { ...withoutLate, faults: { ...target.faults, acceptAsPending: undefined } };
    const report = await verifyEffectContract({ contract: correctContract(client), target: noPending, intent: { amount: 5 } });
    const skipped = report.results.filter((r) => r.status === "skipped").map((r) => r.scenario);
    expect(skipped.sort()).toEqual(["identity-reuse-different-intent", "late-landing", "pending-then-rejected", "pending-then-settled"]);
    expect(report.passed).toBe(true);
    expect(report.summary).toBe("corrobo conformance: passed the configured scenarios (8 run, 4 skipped).");
  });

  it("the report never calls anything 'safe'", async () => {
    const { client, target } = fakeLedger();
    const text = formatConformanceReport(await verifyEffectContract({ contract: correctContract(client), target, intent: { amount: 5 } }));
    expect(text).not.toMatch(/\bsafe\b/i);
    expect(text).toMatch(/scenario\s+result\s+effects\s+execute\s+observe\s+evidence\s+next step/);
  });

  it("a window shorter than how late the target lands a dropped request fails late-landing with a clear reason", async () => {
    const { client, target } = fakeLedger(2_000);
    const report = await verifyEffectContract({
      contract: correctContract(client, 1_000),
      target,
      intent: { amount: 5 },
      scenarios: ["late-landing"]
    });
    const late = report.results[0];
    expect(late.status).toBe("fail");
    expect(late.effects).toBe(2);
    expect(late.notes[0]).toMatch(/maxInFlightMs \(1000\) is shorter than how late this target lands a dropped request \(2000\)/);
  });
});

describe("the demo's real HTTP ledger contract passes the harness", () => {
  let ledger: LedgerServer;
  beforeAll(async () => {
    ledger = await startLedgerServer();
  });
  afterAll(async () => {
    await ledger.close();
  });

  it("every scenario the ledger supports", async () => {
    const target: ConformanceTarget = {
      lateLandingMs: 1_050, // the demo contract's request timeout + apply bound
      reset: () => ledger.reset(),
      effectCount: (opId) => ledger.credits().filter((c) => c.reference === opId).length,
      faults: {
        loseResponseAfterCommit: () => ledger.loseNextResponse(),
        loseRequestBeforeCommit: () => ledger.loseNextRequest(),
        holdCommit: () => ledger.holdNextCommit(),
        failNextRead: () => ledger.failNextRead()
      }
    };
    const report = await verifyEffectContract({
      contract: createIssueCreditContract(ledger.url),
      target,
      intent: { accountId: "acct_1", amountCents: 1_000 },
      otherIntent: { accountId: "acct_1", amountCents: 9_000 }
    });
    expect(report.passed, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.status === "skipped").map((r) => r.scenario).sort()).toEqual([
      "pending-then-rejected",
      "pending-then-settled"
    ]);
  });
});
