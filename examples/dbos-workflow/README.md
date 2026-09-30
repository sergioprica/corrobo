# Example: corrobo with DBOS

[DBOS](https://docs.dbos.dev) makes your *process* durable: if a worker dies mid-workflow, a restart picks the workflow up and re-runs the step that hadn't finished. That's the right behavior — and it's also why a step whose external write already landed runs that write again. DBOS's own guidance is to make such steps idempotent.

This example puts corrobo *inside* the step and shows the difference across a real crash:

```
npm install
DATABASE_URL=postgres://localhost:5432/corrobo_dev npm run demo
```

For each variant, a worker process runs a DBOS workflow whose single step issues a $10 credit at a local HTTP ledger. The moment the ledger commits the credit, and before it answers, the demo `SIGKILL`s the worker, so DBOS never checkpoints the step. A fresh worker starts, DBOS recovers the workflow and re-runs the step:

```
NAIVE    credit committed, worker SIGKILLed before the step was checkpointed (ledger: 1)
         DBOS recovered the workflow and re-ran the step -> {"workflowId":"naive-credit-…","result":{"credit":"cr_2"}}
         ledger: 2 credits ✗ credited twice

CORROBO  credit committed, worker SIGKILLed before the step was checkpointed (ledger: 1)
         DBOS recovered the workflow and re-ran the step -> {"workflowId":"corrobo-credit-…","result":{"evidence":"APPLIED","next":"COMPLETE"}}
         ledger: 1 credit ✓ credited once
```

The corrobo step is just [`runEffect`](../../README.md#quickstart) with a [`PostgresStore`](../../README.md#in-production-postgresstore) in the same database: its attempt was reserved before the POST, so the re-run finds it, asks the ledger, sees the credit, and returns `APPLIED` without posting again. DBOS still owns the workflow; corrobo only decides whether the write inside the step needs to happen again.

```ts
const issueCredit = DBOS.registerWorkflow(async (id: string) =>
  DBOS.runStep(() => runEffect(store, creditContract, { identity: id, intent }), { name: "issue-credit" })
);
```

Use an identity that's stable across re-runs of the step (here, the workflow id). Counts are read from the ledger itself; the demo exits non-zero if they aren't 2 and 1. DBOS keeps its own checkpoints in a sibling database it creates (`corrobo_dbos_example_sys`, or set `DBOS_SYSTEM_DATABASE_URL`).

This is an example of using the two together, not an official DBOS integration. It lives in its own package so corrobo itself doesn't depend on DBOS.
