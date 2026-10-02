# Integration mode reference

Only enter this mode when the user explicitly asks to wrap, fix, or integrate a *specific* operation — not as a follow-on from an audit without being asked.

## Step 1 — inspect the exact code

Read the real call site(s) for the target operation: the mutation call, whatever error handling/retry already exists, and any existing read/lookup call that could serve as `observe()`. Do not generalize from the audit report alone — re-check the actual current code, since it may have changed.

## Step 2 — propose the Effect Contract (before writing code, unless the user asked you to just do it)

Using corrobo's real public shape (`EffectContract<Intent, Observation, Evidence>` — see `src/core/types.ts` in this repo, or the published package's types), propose, specific to this one operation:

- **Identity**: what string uniquely identifies this logical operation, and where it's generated/stored (e.g. a UUID persisted alongside the domain record before the call).
- **Intent type**: the minimal typed shape of what's being requested.
- **`execute()`**: wraps the real mutation call. Must capture transport evidence without interpreting it — let it throw for a genuine transport failure (timeout/network/5xx); catch and return a normal resolved value for anything the API itself reports definitively and synchronously (e.g. a validation rejection), since the runtime distinguishes "threw" (`transport.ok === false`) from "responded" for you.
- **`observe()`**: the strongest real evidence available — a direct fetch-by-id/id-based lookup where one exists; a native-idempotency replay (re-issuing the same request with the same idempotency key, when the API supports it) when no id was captured; explicitly best-effort/search-based only if nothing better exists, labeled `authoritative: false`.
- **`reconcile()`**: a pure function mapping `(intent, transport, observation)` to one evidence state — reuse the honest mapping worked out in the audit (or redo steps 3-4 of `audit-guide.md` for this operation if it wasn't already audited).
- **`capabilities`**: `nativeIdempotency`, `callerGeneratedIdentity`, `optimisticConcurrency`, `convergence` — set each based on what step 3-5 of the audit actually found for this operation, not what would be convenient.
- **`authorize()`** — only if there's a real policy reason (a dollar threshold, a destructive-action gate); it produces `REVIEW`, never an evidence-derived outcome. It runs once, when the operation is first recorded.
- **`revalidate()`** — if whether the action is still allowed can change between proposal, approval and a later retry (an order cancelled, an agent's scope revoked, an approver policy). It runs before every attempt with the current caller's `context` and the recorded approval; it can `proceed`, `requiresReview` or `reject`. Keep the provider's own conditional writes (version/ETag) as well: it narrows the gap, it doesn't close it.
- **Approvals** — record them with `reviewEffect(store, contract, { identity, decision: { decision, reviewer, expiresAt? } })` from the app's own review flow, then let the worker's `runEffect()` act. Never expose `reviewEffect()` to a tool the model can call; flag any code that does, and any remaining `reviewDecision: "approved"` on `runEffect()` (deprecated).
- **Retry policy**: `retryOnNotApplied` (whether a confirmed-absent result is safe to retry for this operation type) and a sane `maxAttempts`. NOT_APPLIED is the only evidence state that can ever become a retry — there is no way to make APPLIED, CONFLICTED, PENDING, or UNKNOWN retryable, and none should be.
- **In-flight window** (`maxInFlightMs`): the longest time after `execute()` starts that its effect could still land (the client timeout you set in `execute()` plus the provider's processing time). Without it, a NOT_APPLIED after a timeout becomes INVESTIGATE rather than RETRY. Make sure `execute()` actually bounds its request (e.g. `AbortSignal.timeout`) — an unbounded request has no honest window. Use `0` only if every attempt sends the same provider idempotency key.
- **Storage**: `PostgresStore` for anything production-shaped, unless the user explicitly chooses otherwise. `InMemoryStore` only for tests/local demos — say this plainly if the target context is production and no store choice was specified.

Keep the proposal to what this ONE operation needs. Do not design a generic adapter/framework layer on top of corrobo's own API — prefer it directly, the way `examples/rest/contract.ts` and `examples/stripe-refund/contract.ts` do in this repo.

## Step 3 — implement

- Import corrobo's `runEffect` (and `InMemoryStore`/`PostgresStore` as appropriate) — from the `corrobo` package once published, or a relative path into this repo's `src/core` if integrating within/against this monorepo before publication.
- Generate/persist the operation identity **before** calling `execute()` — this is `runEffect`'s own responsibility once you call it correctly; do not build a separate identity-generation step outside the contract unless the identity must be derived from pre-existing domain state (e.g. `` `cancel-order-${orderId}-v${planVersion}` ``).
- Wire the real mutation into `execute()`, the real read-back into `observe()`, and the mapping into `reconcile()` — preserve whatever domain logic/validation the application already had; corrobo wraps the call, it doesn't replace application logic.
- Use `PostgresStore` unless told otherwise, and call `PostgresStore.migrate(pool)` once at startup (one table, no ORM).
- Do not modify unrelated code paths, unrelated tests, or other operations "while you're in there."

## Step 4 — generate fault tests

Only generate the scenarios that actually make sense for this operation (skip PENDING/convergence tests for something that's always synchronous; skip conflict tests for an operation with no precondition/versioning):

- Timeout before the effect (transport fails, authoritative state shows absence) → `NOT_APPLIED` → `RETRY` if safe.
- Timeout after the effect committed (transport fails, but observation shows it happened) → `APPLIED` → `COMPLETE`, and assert **no second mutation occurred** — this is the scenario corrobo exists for.
- Observation/read-back failure → `UNKNOWN` → `INVESTIGATE`, never silently treated as `NOT_APPLIED`.
- PENDING/convergence, if the operation can report an async status → assert re-observation happens without a second `execute()` call.
- Stale-version/precondition conflict, if the operation has one → `CONFLICTED` → `REPLAN`.
- Duplicate logical delivery (the same identity invoked twice, e.g. a replayed webhook/event) → assert exactly one real mutation.
- Concurrent same-identity callers, if `PostgresStore` is used and concurrency is plausible for this operation → use a real barrier/deferred-promise to force genuine overlap (see `tests/postgres-concurrency.test.ts` in this repo for the pattern), not sequential awaits.

Use `corrobo/testing`'s `FaultSchedule`/`withFaultInjection`/`withObservationFault` when the target API's call shape fits the generic before/after-effect decorator pattern (see `examples/rest`). When it doesn't (e.g. an SDK with its own idempotency-replay semantics like Stripe), write a small deterministic fake client instead (see `examples/stripe-refund/fake-stripe-client.ts`) rather than forcing the generic helpers to fit.

## Step 5 — verify

Run the project's actual typecheck/test/build commands (don't assume corrobo's own `npm run verify` applies to a host application) and confirm the new fault tests pass and the existing test suite is unaffected.
