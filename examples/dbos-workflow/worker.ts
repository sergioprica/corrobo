/**
 * One DBOS worker process. The workflow has a single step that issues a $10 credit at the
 * ledger — either with a plain POST (naive) or through corrobo (runEffect + PostgresStore).
 *
 *   node --import tsx worker.ts <naive|corrobo> <start|recover> <workflowId>
 *
 * "start" begins the workflow (the orchestrator kills this process mid-step). "recover" is the
 * restart: DBOS.launch() recovers the pending workflow and re-runs the unfinished step.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { runEffect } from "corrobo";
import { PostgresStore } from "corrobo/postgres";
import { createIssueCreditContract } from "../timeout-after-write/contract";

const [mode, phase, workflowId] = process.argv.slice(2);
const ledgerUrl = required("LEDGER_URL");
const appDatabaseUrl = required("DATABASE_URL"); // corrobo's operation records live here
const systemDatabaseUrl = required("DBOS_SYSTEM_DATABASE_URL"); // DBOS's own checkpoints live here

const intent = { accountId: "acct_7", amountCents: 1_000 };
const pool = new Pool({ connectionString: appDatabaseUrl });

async function naiveCredit(id: string) {
  const res = await fetch(`${ledgerUrl}/credits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...intent, reference: id })
  });
  if (res.status !== 201) throw new Error(`ledger answered ${res.status}`);
  return { credit: ((await res.json()) as { id: string }).id };
}

async function corroboCredit(id: string) {
  const store = new PostgresStore(pool, { acknowledgePersistence: true });
  const result = await runEffect(store, createIssueCreditContract(ledgerUrl), { identity: id, intent });
  return { evidence: result.evidenceState, next: result.disposition };
}

const issueCredit = DBOS.registerWorkflow(
  async (id: string) =>
    DBOS.runStep<object>(() => (mode === "corrobo" ? corroboCredit(id) : naiveCredit(id)), { name: "issue-credit" }),
  { name: `issue-credit-${mode}` }
);

async function main() {
  await PostgresStore.migrate(pool);
  DBOS.setConfig({ name: "corrobo-dbos-example", systemDatabaseUrl, logLevel: "error" });
  await DBOS.launch(); // on "recover", this is where DBOS picks the pending workflow back up

  const handle =
    phase === "start"
      ? await DBOS.startWorkflow(issueCredit, { workflowID: workflowId })(workflowId)
      : DBOS.retrieveWorkflow(workflowId);
  const result = await handle.getResult();
  console.log(JSON.stringify({ workflowId, result }));

  await DBOS.shutdown();
  await pool.end();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
