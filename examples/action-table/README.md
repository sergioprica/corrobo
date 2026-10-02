# Linking corrobo to your own action table

Most apps already have a row for each thing someone asked to happen: a refund request, an agent's tool call, an order cancellation. corrobo keeps its own record of each operation too. This example shows how the two fit together without becoming two competing sources of truth.

```
npm run example:action-table
```

## The pattern

1. **Mint the identity when the action is confirmed, and store it as the row's key.** `confirmRefund()` creates the `refund_requests` row with a fresh UUID, server-side, at the moment someone decides to act. That id is the corrobo identity, so `refund_requests.id = corrobo_operations.id`. Nothing downstream ever creates an identity.
2. **Run the effect from the row.** `processRefund()` reads the identity *and* the intent from the row, calls `runEffect()`, then writes corrobo's answer back onto the row (`refunded` with a receipt id, `waiting`, or `needs_attention`).
3. **Sweep.** If a worker dies after the refund is made but before the row is updated, the row still says `confirmed`. `sweep()` runs unfinished rows through `processRefund()` again; corrobo returns the recorded outcome without refunding again, and the row catches up.

## Which record is the truth

| Question | Answered by |
|---|---|
| What was asked for, by whom, when? | Your row |
| Did the external effect happen? How many attempts, what evidence? | corrobo's record |
| What should the UI show? | Your row's `status`: a projection of corrobo's result, rewritten after every pass |

The projection can be stale (after a crash), but it is never decided independently: it's always copied from a `runEffect()` result, and re-running `runEffect()` for the same identity is how it's refreshed.

## For operators

`ACTIONS_WITH_EVIDENCE_SQL` in [`pg-table.ts`](pg-table.ts) joins the two tables on the identity, so you can see each action next to its evidence and spot rows a crash left behind (`app_status = 'confirmed'` while `corrobo_status = 'CLOSED'`). Treat `corrobo_operations` as read-only: only `runEffect()` writes to it.

## Files

- [`refunds.ts`](refunds.ts): the contract, `confirmRefund()`, `processRefund()`, `sweep()` and an in-memory action table.
- [`pg-table.ts`](pg-table.ts): the same table in Postgres, and the operator join.
- [`demo.ts`](demo.ts): a lost response, then a crash before the row is updated, then the sweep. One refund.
- Tests: [`tests/action-table-example.test.ts`](../../tests/action-table-example.test.ts), including a Postgres run across a simulated restart.

Thanks to Ömer Faruk Koç for pointing out that this needed an example.
