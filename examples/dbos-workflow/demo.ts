/**
 * corrobo inside a DBOS workflow step, across a real process crash.
 *
 *   npm install && npm run demo      (in this directory; needs DATABASE_URL to a Postgres 13+)
 *
 * For each variant, a worker process runs a DBOS workflow whose one step issues a credit at a
 * local HTTP ledger. The moment the ledger commits the credit — before it answers — this
 * orchestrator SIGKILLs the worker, so DBOS never checkpoints the step. A fresh worker then
 * starts; DBOS recovers the pending workflow and re-runs the step, as durable execution should.
 *
 *   naive step:   the re-run posts again            -> the ledger holds 2 credits
 *   corrobo step: the re-run finds the attempt it had reserved, asks the ledger, finds the
 *                 credit, and doesn't post again     -> the ledger holds 1 credit
 *
 * Credit counts are read from the ledger itself. Exits non-zero if the proof doesn't hold.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { startLedgerServer } from "../timeout-after-write/ledger-server";

type Mode = "naive" | "corrobo";

const appDatabaseUrl = process.env.DATABASE_URL ?? process.env.CORROBO_TEST_DATABASE_URL;
if (!appDatabaseUrl) {
  console.error("Set DATABASE_URL to a Postgres database (DBOS keeps its checkpoints in a sibling database it creates).");
  process.exit(1);
}
const systemDatabaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL ?? withDatabase(appDatabaseUrl, "corrobo_dbos_example_sys");

let worker: ChildProcess | null = null;
let killOnNextCommit = false;

async function main() {
  const ledger = await startLedgerServer({
    onCommit() {
      if (killOnNextCommit && worker) {
        killOnNextCommit = false;
        worker.kill("SIGKILL"); // the credit is committed; the worker dies before hearing back
      }
    }
  });
  const env = { ...process.env, LEDGER_URL: ledger.url, DATABASE_URL: appDatabaseUrl, DBOS_SYSTEM_DATABASE_URL: systemDatabaseUrl };
  const credits = (reference: string) => ledger.credits().filter((c) => c.reference === reference).length;
  const failures: string[] = [];
  const counts: Record<Mode, number> = { naive: 0, corrobo: 0 };

  try {
    for (const mode of ["naive", "corrobo"] as const) {
      const workflowId = `${mode}-credit-${Date.now()}`;

      killOnNextCommit = true;
      const first = await run(mode, "start", workflowId, env);
      if (first.signal !== "SIGKILL") failures.push(`${mode}: the first worker wasn't killed mid-step (${first.signal ?? first.code})`);
      const afterCrash = credits(workflowId);

      const second = await run(mode, "recover", workflowId, env);
      if (second.code !== 0) failures.push(`${mode}: the recovering worker failed: ${second.stderr.trim()}`);
      counts[mode] = credits(workflowId);

      console.log(`${mode.toUpperCase().padEnd(8)} credit committed, worker SIGKILLed before the step was checkpointed (ledger: ${afterCrash})`);
      console.log(`         DBOS recovered the workflow and re-ran the step -> ${second.stdout.trim()}`);
      console.log(`         ledger: ${counts[mode]} credit${counts[mode] === 1 ? "" : "s"} ${counts[mode] === 1 ? "✓ credited once" : "✗ credited twice"}\n`);
    }
  } finally {
    await ledger.close();
  }

  if (counts.naive !== 2) failures.push(`naive: expected 2 credits, found ${counts.naive}`);
  if (counts.corrobo !== 1) failures.push(`corrobo: expected 1 credit, found ${counts.corrobo}`);
  console.log("Credit counts are read from the ledger's own state, not from DBOS or corrobo.");
  if (failures.length) {
    console.error("\nPROOF FAILED:\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
}

function run(mode: Mode, phase: "start" | "recover", workflowId: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    // Spawn node itself (not npx), so SIGKILL hits the process that is actually in the step.
    const child = spawn(process.execPath, ["--import", "tsx", join(__dirname, "worker.ts"), mode, phase, workflowId], {
      env,
      cwd: __dirname
    });
    worker = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code, signal) => {
      worker = null;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
