import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatConformanceReport, verifyEffectContract } from "../src/testing";
import { correctContract, fakeLedger } from "../examples/conformance/fake-ledger";
import { observed, reconciled } from "../src/core/helpers";
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

describe("harness artifacts must not fail a correct contract (review fixes)", () => {
  it("a class-based contract with private fields, and a frozen contract, both pass", async () => {
    const { client, target } = fakeLedger();
    class CreditContract {
      readonly operationType = "fake/credit-class";
      readonly retryPolicy = { maxAttempts: 3, retryOnNotApplied: true };
      readonly maxInFlightMs = 1_000;
      #client = client;
      execute({ identity }: { identity: { id: string } }) {
        return this.#client.write(identity.id);
      }
      async observe({ identity }: { identity: { id: string } }) {
        return observed(await this.#client.read(identity.id), { source: "fake", authoritative: true });
      }
      reconcile({ observation }: { observation: { status: string; data?: { applied: number; pending: boolean } } }) {
        return correctContract(client).reconcile({ observation } as never);
      }
    }
    const asClass = new CreditContract() as never;
    const report1 = await verifyEffectContract({ contract: asClass, target, intent: { amount: 5 } });
    expect(report1.passed, formatConformanceReport(report1)).toBe(true);

    const frozen = Object.freeze({ ...correctContract(client) });
    const report2 = await verifyEffectContract({ contract: frozen, target, intent: { amount: 5 } });
    expect(report2.passed, formatConformanceReport(report2)).toBe(true);
  });

  it("a contract that judges a replay window with its own clock (like the Stripe example) is not failed by the virtual clock", async () => {
    const { client, target } = fakeLedger();
    const base = correctContract(client);
    const windowed = {
      ...base,
      observe: async (input: Parameters<typeof base.observe>[0]) => {
        // Refuse to trust anything older than 22h, measured with the real clock.
        if (Date.now() - Date.parse(input.attemptStartedAt) > 22 * 3_600_000) throw new Error("outside replay window");
        return base.observe(input);
      }
    };
    const report = await verifyEffectContract({ contract: windowed, target, intent: { amount: 5 } });
    expect(report.passed, formatConformanceReport(report)).toBe(true);
  });

  it("more than one effect fails every scenario, even ones that don't check effects themselves", async () => {
    const { client, target } = fakeLedger();
    const base = correctContract(client);
    const doubleWrite = {
      ...base,
      execute: async (input: Parameters<typeof base.execute>[0]) => {
        await base.execute(input);
        return base.execute(input); // a bug: writes twice
      }
    };
    const report = await verifyEffectContract({
      contract: doubleWrite,
      target,
      intent: { amount: 5 },
      otherIntent: { amount: 6 },
      scenarios: ["identity-reuse-different-intent"]
    });
    expect(report.passed).toBe(false);
    expect(report.results[0].notes.join(" ")).toMatch(/the target has 2 effects for one operation/);
  });

  it("when every scenario is skipped, the report says nothing was verified and doesn't pass", async () => {
    const { client, target } = fakeLedger();
    const report = await verifyEffectContract({
      contract: correctContract(client),
      target: { ...target, lateLandingMs: undefined },
      intent: { amount: 5 },
      scenarios: ["late-landing", "identity-reuse-different-intent"]
    });
    expect(report.passed).toBe(false);
    expect(report.summary).toBe("corrobo conformance: no scenarios ran (2 skipped), so nothing was verified.");
    expect(formatConformanceReport(report)).not.toMatch(/passed/);
  });
});

describe("a contract must recover when it declares it can", () => {
  const neverRecovers = (client: ReturnType<typeof fakeLedger>["client"], retryOnNotApplied: boolean) => {
    const base = correctContract(client);
    return {
      ...base,
      retryPolicy: { maxAttempts: 3, retryOnNotApplied },
      // After any failed write, even a provably absent effect is reported as unknown.
      reconcile: (input: Parameters<typeof base.reconcile>[0]) =>
        !input.transport.ok && input.observation.status === "observed" && input.observation.data.applied === 0
          ? reconciled("UNKNOWN", "OVERLY_CAUTIOUS", "never retries")
          : base.reconcile(input)
    };
  };

  it("fails request-lost-before-commit when it declares maxInFlightMs and a retry policy but never retries", async () => {
    const { client, target } = fakeLedger();
    const report = await verifyEffectContract({
      contract: neverRecovers(client, true),
      target,
      intent: { amount: 5 },
      scenarios: ["request-lost-before-commit"]
    });
    expect(report.passed).toBe(false);
    expect(report.results[0].notes[0]).toMatch(/should be retried/);
  });

  it("passes the same contract when its retry policy says it doesn't retry (conservative by declaration)", async () => {
    const { client, target } = fakeLedger();
    const report = await verifyEffectContract({
      contract: neverRecovers(client, false),
      target,
      intent: { amount: 5 },
      scenarios: ["request-lost-before-commit"]
    });
    expect(report.passed, formatConformanceReport(report)).toBe(true);
  });
});
