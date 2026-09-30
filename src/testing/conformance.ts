import { runEffect } from "../core/runtime";
import type { EffectContract, EffectResult, EvidenceState, RecoveryDisposition } from "../core/types";
import { InMemoryStore } from "../stores/memory";

/**
 * Conformance harness: runs YOUR effect contract through the failure timings corrobo exists
 * for — a response lost after commit, a request lost before it, a request that lands late, a
 * failed read-back, a crash on either side of the effect, concurrent callers, a reused identity,
 * pending outcomes — and checks, by counting effects on your fake of the external system, that
 * none of them produces a duplicate or a claim the evidence doesn't support.
 *
 * It does not talk to real providers and cannot know how they behave: your fake (the
 * ConformanceTarget) encodes that, so the result is only as true as the fake. A passing report
 * means "passed the configured scenarios", not "safe".
 */

export interface ConformanceTarget {
  /**
   * How late a dropped request can still land at this target, in ms — mirror your real
   * provider. The late-landing scenario lands the held request exactly this long after the
   * attempt started and checks the contract's maxInFlightMs against it. Omit to skip that scenario.
   */
  lateLandingMs?: number;
  /** Clear all state between scenarios. */
  reset(): void | Promise<void>;
  /** How many times the effect for this operation id has actually been applied at the target. */
  effectCount(operationId: string): number | Promise<number>;
  faults: {
    /** Apply the next write, then make the call fail as if the response were lost. */
    loseResponseAfterCommit(): void;
    /** Make the next write fail before anything is applied. */
    loseRequestBeforeCommit(): void;
    /** Make the next write fail now; apply it only when the returned function is called. */
    holdCommit(): () => void | Promise<void>;
    /** Make the next read (observe) fail. */
    failNextRead(): void;
    /** Optional: accept the next write as pending; settle() applies it, reject() records it as not applied. */
    acceptAsPending?(): { settle(): void | Promise<void>; reject(): void | Promise<void> };
  };
}

export type ScenarioName =
  | "normal"
  | "response-lost-after-commit"
  | "request-lost-before-commit"
  | "late-landing"
  | "read-fails-after-lost-response"
  | "crash-after-effect-before-save"
  | "crash-before-execute"
  | "concurrent-same-identity"
  | "identity-reuse-different-intent"
  | "pending-then-settled"
  | "pending-then-rejected"
  | "neighbor-effect-isolation";

export const ALL_SCENARIOS: readonly ScenarioName[] = [
  "normal",
  "response-lost-after-commit",
  "request-lost-before-commit",
  "late-landing",
  "read-fails-after-lost-response",
  "crash-after-effect-before-save",
  "crash-before-execute",
  "concurrent-same-identity",
  "identity-reuse-different-intent",
  "pending-then-settled",
  "pending-then-rejected",
  "neighbor-effect-isolation"
];

export interface VerifyOptions<Intent> {
  /** Your contract, wired to the fake target. */
  contract: EffectContract<Intent, any, any>;
  target: ConformanceTarget;
  intent: Intent;
  /** A different intent, to check that reusing an identity for it is rejected. Scenario skipped if absent. */
  otherIntent?: Intent;
  /** Run only these scenarios (default: all). */
  scenarios?: readonly ScenarioName[];
}

export interface ScenarioResult {
  scenario: ScenarioName;
  status: "pass" | "fail" | "skipped";
  /** From target.effectCount() after the scenario — the proof, independent of corrobo's record. */
  effects: number;
  executeCalls: number;
  observeCalls: number;
  evidenceState: EvidenceState | null;
  disposition: RecoveryDisposition | null;
  notes: string[];
}

export interface ConformanceReport {
  passed: boolean;
  results: ScenarioResult[];
  summary: string;
}

/** Thrown by the harness store to model the process dying at a chosen point. */
class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "SimulatedCrash";
  }
}

/**
 * The harness's store: InMemoryStore (records survive a simulated crash, like a durable store
 * after a restart) with a virtual clock, so in-flight windows pass without sleeping, and a hook
 * that "crashes" at a chosen write.
 */
class HarnessStore extends InMemoryStore {
  // Starts at the real current time, so a contract that reads the clock itself (e.g. to judge a
  // provider's key-retention window from attemptStartedAt) sees a consistent start; the harness
  // then only moves this clock forward, so the contract's own clock never runs ahead of it.
  time = Date.now();
  crashOn: "afterReserve" | "onResolve" | null = null;

  async now(): Promise<Date> {
    return new Date(this.time);
  }

  advance(ms: number): void {
    this.time += ms;
  }

  override async reserveAttempt(...args: Parameters<InMemoryStore["reserveAttempt"]>) {
    const record = await super.reserveAttempt(...args);
    if (this.crashOn === "afterReserve") {
      this.crashOn = null;
      throw new SimulatedCrash("after the attempt was reserved, before execute()");
    }
    return record;
  }

  override async updateLatestAttempt(...args: Parameters<InMemoryStore["updateLatestAttempt"]>) {
    if (this.crashOn === "onResolve") {
      this.crashOn = null;
      throw new SimulatedCrash("after execute(), before its outcome was saved");
    }
    return super.updateLatestAttempt(...args);
  }
}

interface Run {
  store: HarnessStore;
  calls: { execute: number; observe: number };
  contract: EffectContract<unknown, unknown, unknown>;
  opId: string;
  last: EffectResult<unknown> | null;
  notes: string[];
  /** Runs the operation once; a SimulatedCrash is expected and recorded, anything else is rethrown. */
  once(intent?: unknown, operationId?: string): Promise<EffectResult<unknown> | null>;
}

export async function verifyEffectContract<Intent>(options: VerifyOptions<Intent>): Promise<ConformanceReport> {
  const selected = options.scenarios ?? ALL_SCENARIOS;
  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    results.push(await runScenario(scenario, options));
  }
  const ran = results.filter((r) => r.status !== "skipped");
  const failed = ran.filter((r) => r.status === "fail");
  const skipped = results.length - ran.length;
  const summary =
    ran.length === 0
      ? `corrobo conformance: no scenarios ran (${skipped} skipped), so nothing was verified.`
      : failed.length === 0
        ? `corrobo conformance: passed the configured scenarios (${ran.length} run${skipped ? `, ${skipped} skipped` : ""}).`
        : `corrobo conformance: FAILED ${failed.length} of ${ran.length} scenarios run (${failed.map((f) => f.scenario).join(", ")}).`;
  return { passed: failed.length === 0 && ran.length > 0, results, summary };
}

async function runScenario<Intent>(scenario: ScenarioName, options: VerifyOptions<Intent>): Promise<ScenarioResult> {
  const { target } = options;
  const window = options.contract.maxInFlightMs;
  const skip = (why: string): ScenarioResult => ({
    scenario,
    status: "skipped",
    effects: 0,
    executeCalls: 0,
    observeCalls: 0,
    evidenceState: null,
    disposition: null,
    notes: [why]
  });
  if (scenario === "late-landing" && target.lateLandingMs === undefined) {
    return skip("target.lateLandingMs is not set, so the harness can't know when a dropped request would land");
  }
  if ((scenario === "pending-then-settled" || scenario === "pending-then-rejected") && !target.faults.acceptAsPending) {
    return skip("target.faults.acceptAsPending is not provided");
  }
  if (scenario === "identity-reuse-different-intent" && options.otherIntent === undefined) {
    return skip("options.otherIntent is not provided");
  }

  await target.reset();
  const run = makeRun(scenario, options);
  const failures: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };
  const effects = () => Promise.resolve(target.effectCount(run.opId));
  /** Enough time for any declared window to pass. */
  const settleStep = (window ?? 0) + (target.lateLandingMs ?? 0) + 1;
  const followUp = async (times = 3) => {
    for (let i = 0; i < times; i++) {
      run.store.advance(settleStep);
      await run.once();
    }
  };
  const noWindowNote = () =>
    run.last?.disposition === "INVESTIGATE" && window === undefined
      ? run.notes.push("no maxInFlightMs declared: ends in INVESTIGATE for a person to decide (conservative, allowed)")
      : undefined;

  try {
    switch (scenario) {
      case "normal": {
        await run.once();
        await followUp();
        expect((await effects()) === 1, `expected 1 effect, found ${await effects()}`);
        expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times, expected 1`);
        expect(run.last?.evidenceState === "APPLIED", `final evidence ${run.last?.evidenceState}, expected APPLIED`);
        break;
      }
      case "response-lost-after-commit": {
        target.faults.loseResponseAfterCommit();
        await run.once();
        await followUp();
        expect((await effects()) === 1, `expected 1 effect, found ${await effects()}`);
        expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times: a lost response was treated as a failure`);
        expect(run.last?.evidenceState === "APPLIED", `final evidence ${run.last?.evidenceState}, expected APPLIED`);
        break;
      }
      case "request-lost-before-commit": {
        target.faults.loseRequestBeforeCommit();
        await run.once();
        await followUp();
        const n = await effects();
        expect(n <= 1, `expected at most 1 effect, found ${n}`);
        noWindowNote();
        expect(
          (n === 1 && run.last?.evidenceState === "APPLIED") || (n === 0 && run.last?.disposition === "INVESTIGATE"),
          `expected either 1 effect and APPLIED, or 0 effects and INVESTIGATE; got ${n} and ${run.last?.evidenceState}/${run.last?.disposition}`
        );
        break;
      }
      case "late-landing": {
        const lateMs = target.lateLandingMs!;
        const land = target.faults.holdCommit();
        await run.once(); // the write is dropped now and lands at +lateMs
        const runAt = window ?? lateMs + 1;
        if (runAt < lateMs) {
          run.store.advance(runAt);
          await run.once(); // the contract says it's safe to retry already
          run.store.advance(lateMs - runAt);
          await land(); // ...but the dropped request lands afterwards
        } else {
          run.store.advance(lateMs);
          await land();
          run.store.advance(runAt - lateMs);
          await run.once();
        }
        await followUp();
        const n = await effects();
        expect(
          n === 1,
          window !== undefined && window < lateMs
            ? `expected 1 effect, found ${n}: maxInFlightMs (${window}) is shorter than how late this target lands a dropped request (${lateMs})`
            : `expected 1 effect, found ${n}`
        );
        noWindowNote();
        if (window !== undefined && window >= lateMs) {
          expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times; the late landing should have been found by the re-check`);
          expect(run.last?.evidenceState === "APPLIED", `final evidence ${run.last?.evidenceState}, expected APPLIED`);
        }
        break;
      }
      case "read-fails-after-lost-response": {
        target.faults.loseResponseAfterCommit();
        target.faults.failNextRead();
        const first = await run.once();
        expect(
          first?.evidenceState === "UNKNOWN",
          `after a failed read the evidence was ${first?.evidenceState}; a failed read proves nothing, so it must be UNKNOWN`
        );
        await followUp();
        expect((await effects()) === 1, `expected 1 effect, found ${await effects()}`);
        break;
      }
      case "crash-after-effect-before-save": {
        run.store.crashOn = "onResolve";
        await run.once(); // crashes after the effect, before saving
        await followUp(); // "restart"
        expect((await effects()) === 1, `expected 1 effect, found ${await effects()}`);
        expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times after a restart; recovery must observe, not re-execute`);
        expect(run.last?.evidenceState === "APPLIED", `final evidence ${run.last?.evidenceState}, expected APPLIED`);
        break;
      }
      case "crash-before-execute": {
        run.store.crashOn = "afterReserve";
        await run.once();
        await followUp();
        const n = await effects();
        expect(n <= 1, `expected at most 1 effect, found ${n}`);
        noWindowNote();
        expect(
          (n === 1 && run.last?.evidenceState === "APPLIED") || (n === 0 && run.last?.disposition === "INVESTIGATE"),
          `expected either 1 effect and APPLIED, or 0 effects and INVESTIGATE; got ${n} and ${run.last?.evidenceState}/${run.last?.disposition}`
        );
        break;
      }
      case "concurrent-same-identity": {
        await Promise.all([run.once(), run.once()]);
        await followUp();
        expect((await effects()) === 1, `expected 1 effect from two concurrent callers, found ${await effects()}`);
        expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times for one identity`);
        break;
      }
      case "identity-reuse-different-intent": {
        await run.once();
        const before = await effects();
        let rejected = false;
        try {
          await run.once(options.otherIntent);
        } catch {
          rejected = true;
        }
        expect(rejected, "reusing the identity for a different intent was accepted; it must throw");
        expect((await effects()) === before, "reusing the identity for a different intent changed the target");
        break;
      }
      case "neighbor-effect-isolation": {
        // Another operation's effect already exists at the target. A contract whose observe()
        // isn't scoped to its own operation would mistake it for this one's.
        await run.once(undefined, `${run.opId}-neighbor`);
        const neighbor = await Promise.resolve(target.effectCount(`${run.opId}-neighbor`));
        expect(neighbor === 1, `setup: the neighboring operation should have 1 effect, found ${neighbor}`);
        target.faults.loseRequestBeforeCommit();
        await run.once();
        await followUp();
        const n = await effects();
        noWindowNote();
        expect(
          (n === 1 && run.last?.evidenceState === "APPLIED") || (n === 0 && run.last?.disposition === "INVESTIGATE"),
          `with another operation's effect present, expected 1 effect and APPLIED, or 0 and INVESTIGATE; got ${n} and ${run.last?.evidenceState}/${run.last?.disposition}` +
            (n === 0 && run.last?.evidenceState === "APPLIED" ? " — observe() seems to see other operations' effects as this one's" : "")
        );
        break;
      }
      case "pending-then-settled":
      case "pending-then-rejected": {
        const pending = target.faults.acceptAsPending!();
        const first = await run.once();
        expect(first?.evidenceState === "PENDING", `accepted-but-unsettled was ${first?.evidenceState}, expected PENDING`);
        await run.once();
        expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times while the write was pending`);
        expect((await effects()) === 0, "the effect was applied before the target settled it");
        if (scenario === "pending-then-settled") {
          await pending.settle();
          await followUp();
          expect((await effects()) === 1, `expected 1 effect, found ${await effects()}`);
          expect(run.calls.execute === 1, `execute() ran ${run.calls.execute} times; settling needs no new attempt`);
          expect(run.last?.evidenceState === "APPLIED", `final evidence ${run.last?.evidenceState}, expected APPLIED`);
        } else {
          await pending.reject();
          await followUp();
          const n = await effects();
          expect(n <= 1, `expected at most 1 effect after a rejection and retry, found ${n}`);
          expect(
            (n === 1 && run.last?.evidenceState === "APPLIED") || (n === 0 && run.last?.disposition === "INVESTIGATE"),
            `expected either a successful retry (1 effect, APPLIED) or INVESTIGATE; got ${n} and ${run.last?.evidenceState}/${run.last?.disposition}`
          );
        }
        break;
      }
    }
  } catch (err) {
    failures.push(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Universal rules, whatever the scenario: never more than one effect, and APPLIED is a claim
  // that the effect exists, so the target must agree.
  const finalEffects = await effects();
  if (finalEffects > 1 && !failures.some((f) => f.includes(`found ${finalEffects}`))) {
    failures.push(`the target has ${finalEffects} effects for one operation`);
  }
  if (run.last?.evidenceState === "APPLIED" && finalEffects === 0) {
    failures.push("final evidence is APPLIED but the target has no effect for this operation");
  }

  return {
    scenario,
    status: failures.length === 0 ? "pass" : "fail",
    effects: await effects(),
    executeCalls: run.calls.execute,
    observeCalls: run.calls.observe,
    evidenceState: run.last?.evidenceState ?? null,
    disposition: run.last?.disposition ?? null,
    notes: [...failures, ...run.notes]
  };
}

function makeRun<Intent>(scenario: ScenarioName, options: VerifyOptions<Intent>): Run {
  const calls = { execute: 0, observe: 0 };
  const original = options.contract as EffectContract<unknown, unknown, unknown>;
  // Forward everything to the contract untouched (methods keep the contract as `this`, so class
  // contracts with private fields work, and frozen contracts are never written to); only count
  // execute() and observe() calls. The proxy's own target is a blank object so no proxy
  // invariant ties it to the contract's (possibly frozen) properties.
  const contract = new Proxy({} as EffectContract<unknown, unknown, unknown>, {
    get(_blank, prop) {
      const value = Reflect.get(original, prop, original);
      if (prop === "execute" || prop === "observe") {
        return (input: never) => {
          calls[prop] += 1;
          return (value as (input: never) => unknown).call(original, input);
        };
      }
      return typeof value === "function" ? value.bind(original) : value;
    },
    has: (_blank, prop) => Reflect.has(original, prop)
  });
  const run: Run = {
    store: new HarnessStore(),
    calls,
    contract,
    opId: `conformance-${scenario}`,
    last: null,
    notes: [],
    async once(intent?: unknown, operationId?: string) {
      try {
        const result = await runEffect(run.store, contract, {
          identity: operationId ?? run.opId,
          intent: intent === undefined ? options.intent : intent
        });
        if (!operationId) run.last = result;
        return result;
      } catch (err) {
        if (err instanceof SimulatedCrash) {
          run.notes.push(err.message);
          return null;
        }
        throw err;
      }
    }
  };
  return run;
}

/** A plain-text table of the report, for test output or CI logs. */
export function formatConformanceReport(report: ConformanceReport): string {
  const header = ["scenario", "result", "effects", "execute", "observe", "evidence", "next step"];
  const rows = report.results.map((r) => [
    r.scenario,
    r.status,
    String(r.effects),
    String(r.executeCalls),
    String(r.observeCalls),
    r.evidenceState ?? "-",
    r.disposition ?? "-"
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const notes = report.results.flatMap((r) => r.notes.map((n) => `  ${r.scenario}: ${n}`));
  return [report.summary, "", line(header), ...rows.map(line), ...(notes.length ? ["", "notes:", ...notes] : [])].join("\n");
}
