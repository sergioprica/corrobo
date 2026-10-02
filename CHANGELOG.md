# Changelog

## Unreleased

### Added

- Docs: [where the identity comes from](README.md#where-the-identity-comes-from). Mint it server-side when the action is confirmed and store it with the action, because the same intent with a new identity is a new effect.
- Example: [`examples/action-table`](examples/action-table) links corrobo's record to an app's own table of actions (`npm run example:action-table`). It's tested against Postgres, including the restart sweep and an operator join.

Thanks to Ömer Faruk Koç ([@negativexq](https://github.com/negativexq)) for the review that prompted both.

## 0.3.0 — 2026-09-30

### Upgrading from 0.2.x

1. **Install `pg` yourself if you use `PostgresStore`** (`npm install pg`). corrobo no longer depends on it: it never loaded `pg` at runtime anyway (you pass in your own `Pool`), so it's now an optional peer dependency. If your code imports `pg` and only worked because corrobo pulled it in, you'll see `Cannot find module 'pg'` until you add it.
2. **Drain 0.2.x workers, then run `PostgresStore.migrate(pool)` once** before 0.3.0 serves traffic. It adds a `version` column in place (existing rows start at 0). 0.2.x writes don't check or bump versions, so don't run both versions against the same table. On PostgreSQL 11+ this doesn't rewrite the table but takes a brief `ACCESS EXCLUSIVE` lock; run it with a `lock_timeout`.
3. **Declare `maxInFlightMs` on contracts that should retry after a timeout.** A `NOT_APPLIED` after a failed or unknown transport used to become `RETRY` immediately. A timed-out request can still land after that check, so it's now `INVESTIGATE` unless the contract declares `maxInFlightMs`. With it, a `RETRY` decided while that window is still open carries `retryNotBefore` (nothing executes before it); once the window has passed, corrobo re-checks before executing again. Use `0` only when every attempt sends the same provider idempotency key. `RETRY`s recorded by 0.2.x are re-checked under the new rule.
4. **Custom `EffectStore` implementations** must add `version` to records and take `expectedVersion` on every write, throwing `StoreConflictError` on mismatch (see spec §O). Add `now()` if the store is shared across hosts.
5. **Intents must be plain JSON.** An intent containing a function, `Map`, `Set`, `BigInt`, symbol, typed array, own getter or a circular reference now throws a `TypeError` naming the field, before anything runs. Previously some of these were silently mangled, and a `Date` never matched itself after a Postgres round trip, so every retry threw "different intent". Stored intents are now their JSON form (a `Date` is stored as its ISO string in both stores). Contracts with their own `fingerprintIntent()` are unaffected.
6. **`decideDisposition()` input** now requires `settlement` (only relevant if you call it directly).
7. **An explicit `identity` whose `operationType` differs from the contract's now throws** before anything runs. Previously it created a record that conflicted on the next call.
8. **New required fields on exported types:** `EffectResult.retryNotBefore` (`string | null`) and `OperationRecord.version` (`number`). Code that builds these objects by hand, such as test fixtures, needs `retryNotBefore: null` and a `version`.

### Fixed

- **Duplicate effect when a Postgres lock is lost mid-call.** If the lock's database session died while `execute()` was still running, another caller could observe "not applied" before the first request landed, record `RETRY`, and execute again. Fixed by version-checked writes (a stale caller can't overwrite anything) plus the settlement rule above.
- **Process crash on connection loss.** A terminated database session emitted an unhandled `error` event on the lock's client, which crashes a Node process. Now handled.
- A lock connection whose unlock failed was returned to the pool still holding the lock; it's now destroyed.
- Intent fingerprints: `Date`, `Map` and function fields all fingerprinted as `{}`, so different intents bound as the same operation (see upgrade note 5).
- `InMemoryStore` no longer breaks permanently when `execute()` throws a value that can't be cloned.
- A thrown `{ message }` object records its message instead of `"[object Object]"`; a thrown value whose `message` can't be read no longer aborts a pass.

### Added

- `maxInFlightMs` on contracts; `retryNotBefore` on results.
- `defineContract<Intent>()({...})`, `observed(data, { source, authoritative })` and `reconciled(state, code, summary)` helpers.
- `identity` may be a plain string id (the `operationType` comes from the contract).
- `capabilities` is optional (the runtime never read it).
- `StoreConflictError`; `OperationRecord.version`; `CoordinatedStore.now()`; `PostgresStore.now()` (the database clock).
- Structural `PgPool` / `PgPoolClient` / `PgQueryable` types: `corrobo/postgres` no longer needs `@types/pg` to type-check.
- Conformance harness: `verifyEffectContract()` and `formatConformanceReport()` in `corrobo/testing` run your contract against a fake of your provider through 12 failure scenarios and count effects on the fake ([guide](docs/testing-your-contract.md)); `npm run conformance`.
- `npm run demo` (timeout-after-write against a real HTTP ledger, CI-gated), `npm run quickstart`.
- Example: corrobo inside a DBOS workflow step across a real `SIGKILL` between the write and DBOS's checkpoint (naive: 2 credits; corrobo: 1), CI-gated.
- Docs: [failure matrix](docs/failure-matrix.md) (every row test-backed, CI-checked), [guarantees](docs/guarantees.md), [why not just…](docs/why-not-just.md).

## 0.2.1

See the [v0.2.1 release](https://github.com/vidithsalla/corrobo/releases/tag/v0.2.1).
