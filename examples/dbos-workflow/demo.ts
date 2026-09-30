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
import { Pool } from "pg";
import { startLedgerServer } from "../timeout-after-write/ledger-server";

type Mode = "naive" | "corrobo";

const appDatabaseUrl = process.env.DATABASE_URL ?? process.env.CORROBO_TEST_DATABASE_URL;
if (!appDatabaseUrl) {
  console.error("Set DATABASE_URL to a Postgres database (DBOS keeps its checkpoints in a sibling database it creates).");
  process.exit(1);
}
const systemDatabaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL ?? withDatabase(appDatabaseUrl, "corrobo_dbos_example_sys");
// A fresh DBOS schema per run: DBOS recovers every pending workflow it finds on launch, so a
// leftover from an interrupted earlier run must never be in reach.
const runId = `r${Date.now()}`;
const systemSchema = `dbos_${runId}`;

let worker: { child: ChildProcess; exited: Promise<void> } | null = null;
let killOnNextCommit = false;

async function main() {
  const ledger = await startLedgerServer({
    async onCommit() {
      if (!killOnNextCommit || !worker) return;
      killOnNextCommit = false;
      // The credit is committed. Kill the worker and wait until it has actually exited before
      // the ledger answers: the step can never see a response, so DBOS can't checkpoint it.
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  });
  const app = new Pool({ connectionString: appDatabaseUrl });
  const env = {
    ...process.env,
    LEDGER_URL: ledger.url,
    DATABASE_URL: appDatabaseUrl,
    DBOS_SYSTEM_DATABASE_URL: systemDatabaseUrl,
    DBOS_SYSTEM_SCHEMA: systemSchema
  };
  const events = (reference: string) => ledger.events().filter((e) => e.reference === reference);
  const commits = (reference: string) => events(reference).filter((e) => e.kind === "committed").length;
  const failures: string[] = [];
  const counts: Record<Mode, number> = { naive: 0, corrobo: 0 };

  try {
    for (const mode of ["naive", "corrobo"] as const) {
      const workflowId = `${runId}-${mode}`;
      const reference = mode === "corrobo" ? `${workflowId}:issue-credit` : workflowId;

      killOnNextCommit = true;
      const first = await run(mode, "start", workflowId, env);
      if (first.signal !== "SIGKILL") failures.push(`${mode}: the first worker wasn't killed mid-step (${first.signal ?? first.code})`);
      // The ledger records the undeliverable answer to the dead worker; let it, before counting recovery.
      for (let i = 0; i < 100 && !events(reference).some((e) => e.kind === "response_lost"); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (commits(reference) !== 1) failures.push(`${mode}: expected the credit committed before the crash, found ${commits(reference)}`);
      if (mode === "corrobo") {
        // Proof that corrobo's crash recovery is what runs next: the attempt was reserved, never resolved.
        const row = await app.query("SELECT attempts FROM corrobo_operations WHERE id = $1", [reference]);
        const status = row.rows[0]?.attempts?.[0]?.status;
        if (status !== "RESERVED") failures.push(`corrobo: after the crash the attempt should be RESERVED, found ${status}`);
      }
      const eventsBeforeRecovery = events(reference).length;

      const second = await run(mode, "recover", workflowId, env);
      if (second.code !== 0) failures.push(`${mode}: the recovering worker failed: ${second.stderr.trim()}`);
      counts[mode] = ledger.credits().filter((c) => c.reference === reference).length;
      const recovery = events(reference).slice(eventsBeforeRecovery).map((e) => e.kind);
      if (mode === "naive" && !recovery.includes("committed")) failures.push("naive: DBOS's re-run of the step didn't post again");
      if (mode === "corrobo" && (!recovery.includes("read") || recovery.includes("committed"))) {
        failures.push(`corrobo: recovery should read the ledger and not post again; the ledger saw ${recovery.join(", ") || "nothing"}`);
      }

      console.log(`${mode.toUpperCase().padEnd(8)} credit committed; worker SIGKILLed and gone before the ledger answered (ledger: 1)`);
      console.log(`         DBOS recovered the workflow and re-ran the step: ledger saw [${recovery.join(", ")}] -> ${second.stdout.trim()}`);
      console.log(`         ledger: ${counts[mode]} credit${counts[mode] === 1 ? "" : "s"} ${counts[mode] === 1 ? "✓ credited once" : "✗ credited twice"}\n`);
    }
  } finally {
    await ledger.close();
    await cleanup(app, [`${runId}-corrobo:issue-credit`]);
  }

  if (counts.naive !== 2) failures.push(`naive: expected 2 credits, found ${counts.naive}`);
  if (counts.corrobo !== 1) failures.push(`corrobo: expected 1 credit, found ${counts.corrobo}`);
  console.log("Credit counts and requests are read from the ledger's own state, not from DBOS or corrobo.");
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
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<void>((done) =>
      child.on("exit", (code, signal) => {
        worker = null;
        resolve({ code, signal, stdout, stderr });
        done();
      })
    );
    worker = { child, exited };
  });
}

/** Best-effort: drop this run's DBOS schema and corrobo rows, so runs don't accumulate state. */
async function cleanup(app: Pool, corroboIds: string[]) {
  try {
    await app.query("DELETE FROM corrobo_operations WHERE id = ANY($1)", [corroboIds]);
    const sys = new Pool({ connectionString: systemDatabaseUrl });
    await sys.query(`DROP SCHEMA IF EXISTS ${systemSchema} CASCADE`);
    await sys.end();
  } catch {
    // leaving state behind is harmless: every run uses fresh ids and a fresh schema
  } finally {
    await app.end();
  }
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
