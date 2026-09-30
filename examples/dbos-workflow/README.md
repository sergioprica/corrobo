# Example: corrobo with DBOS

[DBOS](https://docs.dbos.dev) makes your *process* durable: if a worker dies mid-workflow, a restart picks the workflow up and re-runs the step that hadn't finished. That's the right behavior — and it's also why a step whose external write already landed runs that write again. DBOS's own guidance is to make such steps idempotent.

This example puts corrobo *inside* the step and shows the difference across a real crash:

```
npm install && npm run build          # in the repo root: this example uses the built corrobo package
cd examples/dbos-workflow
npm install
DATABASE_URL=postgres://localhost:5432/corrobo_dev npm run demo
```

For each variant, a worker process runs a DBOS workflow whose single step issues a $10 credit at a local HTTP ledger. The moment the ledger commits the credit, the demo `SIGKILL`s the worker and waits until it has exited before the ledger answers, so the step can never see a response and DBOS can't checkpoint it. A fresh worker starts, DBOS recovers the workflow and re-runs the step:

```
NAIVE    credit committed; worker SIGKILLed and gone before the ledger answered (ledger: 1)
         DBOS recovered the workflow and re-ran the step: ledger saw [committed, responded] -> {…"result":{"credit":"cr_2"}}
         ledger: 2 credits ✗ credited twice

CORROBO  credit committed; worker SIGKILLed and gone before the ledger answered (ledger: 1)
         DBOS recovered the workflow and re-ran the step: ledger saw [read] -> {…"result":{"evidence":"APPLIED","next":"COMPLETE"}}
         ledger: 1 credit ✓ credited once
```

The demo also checks the mechanism, not just the totals: after the crash, corrobo's record for the step must hold a reserved, unresolved attempt, and during recovery the ledger must see a read and no new write.

The corrobo step is just [`runEffect`](../../README.md#quickstart) with a [`PostgresStore`](../../README.md#in-production-postgresstore) in the same database: its attempt was reserved before the POST, so the re-run finds it, asks the ledger, sees the credit, and returns `APPLIED` without posting again. DBOS still owns the workflow; corrobo only decides whether the write inside the step needs to happen again.

```ts
const issueCredit = DBOS.registerWorkflow(async (id: string) =>
  DBOS.runStep(() => runEffect(store, creditContract, { identity: id, intent }), { name: "issue-credit" })
);
```

Give each logical external write one identity that's stable across re-runs: here `<workflowId>:issue-credit`. If a step runs once per item in a loop, include the item's stable key too (`<workflowId>:issue-credit:<orderId>`); the workflow id alone would make every iteration look like the same write. Counts are read from the ledger itself; the demo exits non-zero if they aren't 2 and 1. DBOS keeps its own checkpoints in a sibling database it creates (`corrobo_dbos_example_sys`, or set `DBOS_SYSTEM_DATABASE_URL`; the database user needs permission to create it), in a fresh schema per run that's dropped afterwards.

This is an example of using the two together, not an official DBOS integration. It lives in its own package so corrobo itself doesn't depend on DBOS.
