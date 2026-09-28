/**
 * Timeout after write: the whole problem in one run.
 *
 *   npm run demo
 *
 * A ledger commits a $50 credit, then the response is lost. The naive catch-and-retry client
 * credits the account twice. corrobo asks the ledger what actually happened and stops at one.
 * Every number printed as proof is read back from the ledger over HTTP — never from corrobo's
 * own records. Exits non-zero if any proof condition fails.
 */
import { runEffect } from "../../src/core/runtime";
import type { EffectContract, EffectResult } from "../../src/core/types";
import { InMemoryStore } from "../../src/stores/memory";
import { createIssueCreditContract, describeFetchError, naiveIssueCredit } from "./contract";
import type { CreditIntent, CreditObservation } from "./contract";
import { startLedgerServer } from "./ledger-server";
import type { Credit, LedgerEvent } from "./ledger-server";

const INTENT: CreditIntent = { accountId: "acct_42", amountCents: 5_000 };
const NAIVE_REFERENCE = "credit-acct_42-refund-7781-naive";
const CORROBO_OPERATION_ID = "credit-acct_42-refund-7781";

export interface DemoResult {
  naive: { creditsInLedger: number; attempts: number; errors: string[]; events: LedgerEvent[] };
  corrobo: {
    creditsInLedger: number;
    first: EffectResult<CreditObservation>;
    again: EffectResult<CreditObservation>;
    events: LedgerEvent[];
  };
}

type ContractFactory = (baseUrl: string) => EffectContract<CreditIntent, CreditObservation, Credit>;

/**
 * Runs both paths against a fresh ledger. `makeContract` exists so tests can prove the proof
 * check catches a broken contract; the demo itself always uses createIssueCreditContract.
 */
export async function runDemo(options: { makeContract?: ContractFactory } = {}): Promise<DemoResult> {
  const ledger = await startLedgerServer();
  try {
    // NAIVE: catch → retry.
    ledger.loseNextResponse();
    const naive = await naiveIssueCredit(ledger.url, INTENT, NAIVE_REFERENCE);
    const naiveEvents = ledger.events().filter((e) => e.reference === NAIVE_REFERENCE);

    // CORROBO: execute → observe → reconcile → recover. The caller then runs it again, the way
    // a retry loop or a restarted worker would.
    const contract = (options.makeContract ?? ((url) => createIssueCreditContract(url)))(ledger.url);
    const store = new InMemoryStore();
    const request = { identity: { id: CORROBO_OPERATION_ID, operationType: contract.operationType }, intent: INTENT };
    ledger.loseNextResponse();
    const first = await runEffect(store, contract, request);
    const again = await runEffect(store, contract, request);
    const corroboEvents = ledger.events().filter((e) => e.reference === CORROBO_OPERATION_ID);

    return {
      naive: {
        creditsInLedger: await countCreditsInLedger(ledger.url, NAIVE_REFERENCE),
        attempts: naive.attempts,
        errors: naive.errors,
        events: naiveEvents
      },
      corrobo: {
        creditsInLedger: await countCreditsInLedger(ledger.url, CORROBO_OPERATION_ID),
        first,
        again,
        events: corroboEvents
      }
    };
  } finally {
    await ledger.close();
  }
}

/** The proof source: the ledger's own HTTP API, independent of anything corrobo recorded. */
export async function countCreditsInLedger(baseUrl: string, reference: string): Promise<number> {
  const res = await fetch(`${baseUrl}/credits?reference=${encodeURIComponent(reference)}`);
  const body = (await res.json()) as { credits: Credit[] };
  return body.credits.length;
}

/** Returns every proof condition that does NOT hold (empty = the demo proved its point). */
export function verifyProof(result: DemoResult): string[] {
  const failures: string[] = [];
  const lostAfterCommit = (events: LedgerEvent[]) =>
    events.some((e, i) => {
      const before = events[i - 1];
      return e.kind === "response_lost" && before?.kind === "committed" && before.creditId === e.creditId;
    });

  if (!lostAfterCommit(result.naive.events)) failures.push("naive: the response was not lost after a commit");
  if (result.naive.creditsInLedger !== 2) failures.push(`naive: expected 2 credits in the ledger, found ${result.naive.creditsInLedger}`);
  if (!lostAfterCommit(result.corrobo.events)) failures.push("corrobo: the response was not lost after a commit");
  if (result.corrobo.creditsInLedger !== 1) failures.push(`corrobo: expected 1 credit in the ledger, found ${result.corrobo.creditsInLedger}`);
  if (!result.corrobo.events.some((e) => e.kind === "read")) failures.push("corrobo: never read the ledger");
  if (result.corrobo.first.evidenceState !== "APPLIED") failures.push(`corrobo: evidence ${result.corrobo.first.evidenceState}, expected APPLIED`);
  if (result.corrobo.first.disposition !== "COMPLETE") failures.push(`corrobo: disposition ${result.corrobo.first.disposition}, expected COMPLETE`);
  if (result.corrobo.again.disposition !== "COMPLETE") failures.push("corrobo: running again did not stay COMPLETE");
  return failures;
}

// --- presentation -----------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");

export function renderDemo(result: DemoResult): string[] {
  const lines: string[] = [];
  const credit = `$${(INTENT.amountCents / 100).toFixed(2)} credit to ${INTENT.accountId}`;
  lines.push(bold(`Issue a ${credit}. The ledger commits it, then the response is lost.`));
  lines.push("");

  lines.push(bold("NAIVE") + dim("   try { post() } catch { retry() }"));
  let attempt = 0;
  for (const e of result.naive.events) {
    if (e.kind === "committed") {
      attempt += 1;
      lines.push(`  attempt ${attempt}   POST /credits   ledger committed ${e.creditId}`);
    } else if (e.kind === "response_lost") {
      lines.push(`              ${red("response lost")} ${dim(`(${result.naive.errors[0] ?? "no response"})`)}  → retry`);
    } else if (e.kind === "responded") {
      lines.push(`              ${e.status} Created`);
    }
  }
  lines.push(`  ledger: ${bold(String(result.naive.creditsInLedger))} credits  ${red("✗ customer credited twice")}`);
  lines.push("");

  lines.push(bold("CORROBO") + dim(" execute → observe → reconcile → recover"));
  for (const e of result.corrobo.events) {
    if (e.kind === "committed") {
      lines.push(`  execute   POST /credits   ledger committed ${e.creditId}`);
    } else if (e.kind === "response_lost") {
      const t = result.corrobo.first.attempts[0];
      const error = t?.status === "RESOLVED" && !t.transport.ok ? t.transport.error.message : "no response";
      lines.push(`            ${red("response lost")} ${dim(`(${error})`)}  → not assumed failed`);
    } else if (e.kind === "read") {
      lines.push(`  observe   GET /credits?reference=…   ${e.found} credit found`);
    }
  }
  lines.push(`  reconcile ${green(result.corrobo.first.evidenceState ?? "—")}`);
  lines.push(`  recover   ${green(result.corrobo.first.disposition ?? "—")}   no retry`);
  lines.push(`  run again ${green(result.corrobo.again.disposition ?? "—")}   execute() not called`);
  lines.push(`  ledger: ${bold(String(result.corrobo.creditsInLedger))} credit   ${green("✓ credited once")}`);
  lines.push("");
  lines.push(dim("Credit counts are read from the ledger's own API, not from corrobo's records."));
  return lines;
}

async function main(): Promise<void> {
  const result = await runDemo();
  for (const line of renderDemo(result)) console.log(line);
  const failures = verifyProof(result);
  if (failures.length > 0) {
    console.error(red("\nPROOF FAILED:"));
    for (const f of failures) console.error(red(`  - ${f}`));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(describeFetchError(err));
    process.exitCode = 1;
  });
}
