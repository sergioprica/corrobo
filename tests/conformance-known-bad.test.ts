import { describe, expect, it } from "vitest";
import { ALL_SCENARIOS, formatConformanceReport, verifyEffectContract } from "../src/testing";
import type { ConformanceReport, ConformanceTarget, ScenarioName, ScenarioResult } from "../src/testing";
import type { EffectContract, EvidenceState, ObservationResult, ReconciliationResult, RecoveryDisposition } from "../src/core/types";

interface CreditIntent {
  accountId: string;
  amountCents: number;
}

interface Credit {
  id: string;
  operationId: string;
  accountId: string;
  amountCents: number;
}

interface CreditObservation {
  operationId: string;
  credits: Credit[];
  pending: boolean;
  global: boolean;
}

interface CreditEvidence {
  operationId: string;
  creditId?: string;
  acceptedAsPending?: boolean;
}

type WriteFault =
  | { kind: "lose-response-after-commit" }
  | { kind: "lose-request-before-commit" }
  | { kind: "hold-commit"; operationId: string | null; intent: CreditIntent | null; landed: boolean }
  | { kind: "accept-as-pending"; operationId: string | null; intent: CreditIntent | null };

class FakeCreditLedger implements ConformanceTarget {
  /** How late a dropped write can land here (the harness checks maxInFlightMs against it). */
  readonly lateLandingMs = 500;
  private creditsByOperationId = new Map<string, Credit[]>();
  private pendingByOperationId = new Map<string, CreditIntent>();
  private nextWriteFault: WriteFault | null = null;
  private failRead = false;
  private sequence = 0;

  readonly faults = {
    loseResponseAfterCommit: () => {
      this.nextWriteFault = { kind: "lose-response-after-commit" };
    },
    loseRequestBeforeCommit: () => {
      this.nextWriteFault = { kind: "lose-request-before-commit" };
    },
    holdCommit: () => {
      const fault: Extract<WriteFault, { kind: "hold-commit" }> = {
        kind: "hold-commit",
        operationId: null,
        intent: null,
        landed: false
      };
      this.nextWriteFault = fault;
      return async () => {
        fault.landed = true;
        if (fault.operationId && fault.intent) {
          this.commit(fault.operationId, fault.intent);
          fault.operationId = null;
          fault.intent = null;
        }
      };
    },
    failNextRead: () => {
      this.failRead = true;
    },
    acceptAsPending: () => {
      const fault: Extract<WriteFault, { kind: "accept-as-pending" }> = {
        kind: "accept-as-pending",
        operationId: null,
        intent: null
      };
      this.nextWriteFault = fault;
      return {
        settle: async () => {
          if (!fault.operationId || !fault.intent) return;
          this.pendingByOperationId.delete(fault.operationId);
          this.commit(fault.operationId, fault.intent);
          fault.operationId = null;
          fault.intent = null;
        },
        reject: async () => {
          if (!fault.operationId) return;
          this.pendingByOperationId.delete(fault.operationId);
          fault.operationId = null;
          fault.intent = null;
        }
      };
    }
  };

  reset(): void {
    this.creditsByOperationId.clear();
    this.pendingByOperationId.clear();
    this.nextWriteFault = null;
    this.failRead = false;
    this.sequence = 0;
  }

  effectCount(operationId: string): number {
    return this.creditsByOperationId.get(operationId)?.length ?? 0;
  }

  async apply(operationId: string, intent: CreditIntent): Promise<CreditEvidence> {
    const fault = this.nextWriteFault;
    this.nextWriteFault = null;

    if (fault?.kind === "lose-response-after-commit") {
      this.commit(operationId, intent);
      throw new Error("lost response after commit");
    }

    if (fault?.kind === "lose-request-before-commit") {
      throw new Error("request failed before commit");
    }

    if (fault?.kind === "hold-commit") {
      fault.operationId = operationId;
      fault.intent = intent;
      if (fault.landed) this.commit(operationId, intent);
      throw new Error("request failed while commit was still in flight");
    }

    if (fault?.kind === "accept-as-pending") {
      fault.operationId = operationId;
      fault.intent = intent;
      this.pendingByOperationId.set(operationId, intent);
      return { operationId, acceptedAsPending: true };
    }

    return this.commit(operationId, intent);
  }

  async readByOperationId(operationId: string): Promise<CreditObservation> {
    if (this.failRead) {
      this.failRead = false;
      throw new Error("credit ledger read failed");
    }
    return {
      operationId,
      credits: [...(this.creditsByOperationId.get(operationId) ?? [])],
      pending: this.pendingByOperationId.has(operationId),
      global: false
    };
  }

  async readAnyCredit(operationId: string): Promise<CreditObservation> {
    if (this.failRead) {
      this.failRead = false;
      throw new Error("credit ledger read failed");
    }
    const credits = [...this.creditsByOperationId.values()].flat();
    return {
      operationId,
      credits: credits.length > 0 ? [credits[0]] : [],
      pending: this.pendingByOperationId.size > 0,
      global: true
    };
  }

  private commit(operationId: string, intent: CreditIntent): CreditEvidence {
    const credit: Credit = {
      id: `cr_${++this.sequence}`,
      operationId,
      accountId: intent.accountId,
      amountCents: intent.amountCents
    };
    const existing = this.creditsByOperationId.get(operationId) ?? [];
    existing.push(credit);
    this.creditsByOperationId.set(operationId, existing);
    return { operationId, creditId: credit.id };
  }
}

type ContractVariant =
  | "correct"
  | "blind-transport"
  | "failed-read-as-absence"
  | "zero-window"
  | "pending-as-not-applied"
  | "failed-read-as-applied"
  | "global-observe";

const intent: CreditIntent = { accountId: "acct_conformance", amountCents: 500 };
const otherIntent: CreditIntent = { accountId: "acct_conformance", amountCents: 501 };

const allScenarios: readonly ScenarioName[] = ALL_SCENARIOS;

function observed(data: CreditObservation): ObservationResult<CreditObservation> {
  return {
    status: "observed",
    data,
    authoritative: true,
    source: data.global ? "fake-ledger global read" : "fake-ledger by operation id",
    observedAt: "2026-01-01T00:00:00.000Z"
  };
}

function pending(data: CreditObservation): ObservationResult<CreditObservation> {
  return {
    status: "pending",
    data,
    authoritative: true,
    source: "fake-ledger by operation id",
    observedAt: "2026-01-01T00:00:00.000Z"
  };
}

function reconciled(evidenceState: EvidenceState, code: string, summary: string): ReconciliationResult {
  return { evidenceState, reason: { code, summary } };
}

function creditContract(target: FakeCreditLedger, variant: ContractVariant): EffectContract<CreditIntent, CreditObservation, CreditEvidence> {
  return {
    operationType: "conformance/credit-ledger",
    capabilities: {
      nativeIdempotency: false,
      callerGeneratedIdentity: true,
      optimisticConcurrency: false,
      convergence: true
    },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs: variant === "blind-transport" || variant === "zero-window" ? 0 : 1000,
    execute: async ({ identity, intent }) => target.apply(identity.id, intent),
    observe: async ({ identity }) => {
      const snapshot = variant === "global-observe" ? await target.readAnyCredit(identity.id) : await target.readByOperationId(identity.id);
      return snapshot.pending ? pending(snapshot) : observed(snapshot);
    },
    reconcile: ({ observation, transport }) => {
      if (variant === "blind-transport") {
        return transport.ok
          ? reconciled("APPLIED", "TRUSTED_TRANSPORT_OK", "The contract trusted the execute response.")
          : reconciled("NOT_APPLIED", "TRUSTED_TRANSPORT_FAILURE", "The contract trusted the failed transport.");
      }

      if (observation.status === "observation_failed") {
        if (variant === "failed-read-as-absence") {
          return reconciled("NOT_APPLIED", "READ_FAILED_AS_ABSENT", "The contract treated a failed read as absence.");
        }
        if (variant === "failed-read-as-applied") {
          return reconciled("APPLIED", "READ_FAILED_AS_APPLIED", "The contract claimed success without a successful read.");
        }
        return reconciled("UNKNOWN", "READ_FAILED", "A failed read proves nothing about the external effect.");
      }

      if (observation.status === "pending") {
        return variant === "pending-as-not-applied"
          ? reconciled("NOT_APPLIED", "PENDING_AS_ABSENT", "The contract treated pending as absence.")
          : reconciled("PENDING", "PENDING", "The ledger accepted the write but has not converged.");
      }

      const credits = observation.data.credits;
      if (credits.length === 0) {
        return reconciled("NOT_APPLIED", "NO_CREDIT", "The ledger has no credit for this operation id.");
      }
      if (credits.length > 1) {
        return reconciled("CONFLICTED", "MULTIPLE_CREDITS", "The ledger has more than one credit for this operation id.");
      }
      const [credit] = credits;
      if (credit.accountId !== intent.accountId || credit.amountCents !== intent.amountCents) {
        return reconciled("CONFLICTED", "CREDIT_MISMATCH", "The ledger credit does not match the intended credit.");
      }
      return {
        evidenceState: "APPLIED",
        reason: { code: "CREDIT_FOUND", summary: "The ledger has exactly the intended credit for this operation id." },
        observedEffect: credit
      };
    }
  };
}

async function verify(variant: ContractVariant): Promise<ConformanceReport> {
  const target = new FakeCreditLedger();
  return verifyEffectContract({
    contract: creditContract(target, variant),
    target,
    intent,
    otherIntent
  });
}

function resultFor(report: ConformanceReport, scenario: ScenarioName): ScenarioResult {
  const result = report.results.find((candidate) => candidate.scenario === scenario);
  expect(result, `missing scenario result for ${scenario}`).toBeTruthy();
  return result!;
}

function expectFailedScenario(report: ConformanceReport, scenario: ScenarioName): ScenarioResult {
  const result = resultFor(report, scenario);
  expect(result.status, `${scenario} should fail`).toBe("fail");
  return result;
}

function expectDuplicateFailure(report: ConformanceReport, scenario: ScenarioName): void {
  const result = expectFailedScenario(report, scenario);
  expect(result.effects, `${scenario} should prove the duplicate at the target`).toBeGreaterThan(1);
}

function expectSpecificRuleFailure(report: ConformanceReport, scenario: ScenarioName, rule: RegExp): void {
  const result = expectFailedScenario(report, scenario);
  expect(result.effects, `${scenario} should not need a duplicate to fail`).toBeLessThanOrEqual(1);
  expect([result.evidenceState, result.disposition, ...result.notes].join("\n")).toMatch(rule);
}

describe("verifyEffectContract known-bad conformance proofs", () => {
  it("passes every configured scenario for a contract that observes by operation id", async () => {
    const report = await verify("correct");

    expect(report.passed).toBe(true);
    expect(new Set(report.results.map((result) => result.scenario))).toEqual(new Set(allScenarios));
    for (const result of report.results) {
      expect(result.status, result.scenario).toBe("pass");
      expect(result.effects, result.scenario).toBeLessThanOrEqual(1);
    }
  });

  it("fails a blind retry contract that reconciles from transport.ok", async () => {
    const report = await verify("blind-transport");

    expect(report.passed).toBe(false);
    expectDuplicateFailure(report, "response-lost-after-commit");
  });

  it("fails when a failed read is treated as absence", async () => {
    const report = await verify("failed-read-as-absence");

    expect(report.passed).toBe(false);
    expectSpecificRuleFailure(report, "read-fails-after-lost-response", /UNKNOWN|failed read|observation.*failed/i);
  });

  it("fails maxInFlightMs: 0 on a target without provider dedupe when a request lands late", async () => {
    const report = await verify("zero-window");

    expect(report.passed).toBe(false);
    expectDuplicateFailure(report, "late-landing");
  });

  it("fails when pending is mapped to NOT_APPLIED", async () => {
    const report = await verify("pending-as-not-applied");

    expect(report.passed).toBe(false);
    expectDuplicateFailure(report, "pending-then-settled");
  });

  it("fails when the contract claims APPLIED after the read failed", async () => {
    const report = await verify("failed-read-as-applied");

    expect(report.passed).toBe(false);
    expectSpecificRuleFailure(report, "read-fails-after-lost-response", /UNKNOWN|successful read|failed read|observation.*failed/i);
  });

  it("catches an observe() implementation that ignores the operation id and reads a global counter", async () => {
    const report = await verify("global-observe");

    expect(report.passed).toBe(false);
    const isolation = resultFor(report, "neighbor-effect-isolation");
    expect(isolation.status).toBe("fail");
    expect(isolation.effects).toBe(0);
    expect(isolation.evidenceState).toBe("APPLIED");
    expect(isolation.notes.join(" ")).toMatch(/other operations' effects|target has no effect/);
  });

  it("formats passing and failing reports with scenario names, the configured-pass phrase, and no forbidden wording", async () => {
    const passingReport = await verify("correct");
    const failingReport = await verify("zero-window");

    const passingText = formatConformanceReport(passingReport);
    const failingText = formatConformanceReport(failingReport);

    expect(passingText).toContain("passed the configured");
    expect(failingText).toMatch(/failed/i);
    for (const scenario of allScenarios) {
      expect(passingText).toContain(scenario);
      expect(failingText).toContain(scenario);
    }
    expect(passingText).not.toMatch(/\bsafe\b/i);
    expect(failingText).not.toMatch(/\bsafe\b/i);
  });
});
