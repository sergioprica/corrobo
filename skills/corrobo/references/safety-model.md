# Safety model reference

Read this before reasoning about any specific operation, in either mode.

## The problem corrobo addresses

A side-effecting operation can produce an uncertain transport result — a timeout, a dropped connection, a 5xx. **The transport result does not tell you whether the business effect happened.** Treating "the call threw" as "it didn't happen," or "the call returned 200" as "it's finally done," is the exact mistake that causes duplicate side effects on retry or premature completion.

## Evidence states vs. recovery dispositions

Evidence state is a claim about the world, established only by authoritative observation — never inferred from a transport error/success alone. Disposition is a policy decision about what's safe to do next, computed *from* the evidence state (plus attempt history and the operation's own retry policy). Never let a disposition-shaped conclusion ("it failed, retry") stand in for actually observing.

| Evidence state | Meaning | Disposition mapping |
|---|---|---|
| `APPLIED` | Observation confirms the intended effect exists. | `COMPLETE` |
| `NOT_APPLIED` | Observation confirms the intended effect does not exist. | `RETRY` if this operation type is actually safe to retry (native idempotency, or naturally idempotent like a declarative PUT/apply) **and** attempts remain; otherwise `INVESTIGATE`. |
| `CONFLICTED` | Authoritative state diverged from what the plan assumed (someone/something else changed it). | `REPLAN` — a new intent and a new operation identity, never a retry of this one. |
| `PENDING` | The system acknowledged the request but the effect hasn't converged yet. Normal for async/declarative operations (an async refund, a Kubernetes deployment converging). | **No disposition.** Re-observe on the next call. Never re-execute because of this alone. |
| `UNKNOWN` | Evidence is insufficient — observation failed, or is genuinely ambiguous. | `INVESTIGATE`. Never a silent automatic retry. |

`APPLIED` is evaluated against the intended effect defined by the Effect Contract, not necessarily the downstream terminal lifecycle of the created resource — that boundary must be chosen explicitly when proposing a contract. For example, if the intended effect is "create/submit a message," a successfully created message is `APPLIED` even while delivery to the recipient remains `PENDING`; the message's further progress toward delivered/failed doesn't make the original submission `NOT_APPLIED`, it's just a separate downstream fact the integration may or may not also care about. Never broaden `APPLIED` beyond what authoritative evidence actually establishes for the chosen intended effect — if the contract's intended effect really is final delivery, then only delivery confirms `APPLIED`, and everything short of that is `PENDING`.

`REVIEW` sits outside this table entirely: it is a **pre-execution** policy gate ("this is a known, well-formed action, but policy requires a human to authorize it before we attempt it") — it never comes from evidence, and it is not the same thing as `INVESTIGATE` (which is about not knowing what happened, not about needing permission).

## Concurrency model (technical reference — do not restate this in every response; only mention what's relevant when asked about concurrency, custom stores, or crash safety)

corrobo's `PostgresStore` coordinates concurrent callers that share the same operation identity: only one active execution path is allowed for that identity at a time. This uses a session-scoped Postgres advisory lock held on one dedicated pooled connection for the duration of one `runEffect()` pass, and that same connection is reused for every store operation the pass performs (so one in-flight identity never needs a second connection); if the holder's process crashes, its connection dies and Postgres releases the lock automatically — no lease timers, no permanent locks. Different operation identities never serialize against each other.

Crash safety is a separate, stronger property, not just a side effect of the lock: corrobo durably reserves an attempt *before* `execute()` is ever called. If a worker dies with an unresolved attempt, the next run for that identity does not blindly execute again — it observes and reconciles first, exactly as it would for any other attempt, and can itself land on `UNKNOWN`/`INVESTIGATE` if observation still can't establish the truth. This is **not** a distributed exactly-once guarantee for the external system — corrobo has no coordination role over anything that calls the external API directly, outside corrobo — but within corrobo's own execution path, a crash cannot cause `execute()` to be silently called a second time for the same attempt.

Lock loss and late landings (0.3+): the advisory lock is also released if only the connection dies while `execute()` is still running, and a timed-out request can land after corrobo observed "not applied". So every store write is version-checked (a pass that lost its lock gets `StoreConflictError` internally and cannot overwrite another pass's record), and a `NOT_APPLIED` after a failed or unknown transport only permits a retry once the contract's `maxInFlightMs` has passed — without `maxInFlightMs` it is `INVESTIGATE`. When auditing or writing a contract, always ask: what is the longest time after this call starts that it could still take effect (client timeout + provider processing)? Declare that as `maxInFlightMs`; use `0` only when re-execution is deduplicated by the provider with a key that is stable across attempts.

Any custom `EffectStore` implementation must satisfy the same same-identity coordination contract (`tryAcquireLock`) to be safe for concurrent use. `InMemoryStore` provides only an in-process mutex — correct for concurrent calls within one Node process, no cross-process or distributed guarantee whatsoever. Never describe `InMemoryStore` as safe for multi-process/production use.

## Non-guarantees — never claim these

- **No universal exactly-once execution** against an arbitrary third-party system. corrobo guarantees its own recorded decision is derived from real evidence, not that no external system can ever be double-invoked by something outside corrobo's control.
- **No certainty from an idempotency key alone.** A native idempotency key (Stripe's `Idempotency-Key`, a client-generated resource id) makes a *retry* safe; it does not by itself prove the FIRST attempt's outcome without an actual observation.
- **No authoritative read-back where only a search/index exists.** A paginated channel-history scan (Slack), a search index (GitHub Issues search, Elasticsearch-backed lookups), or any eventually-consistent index is best-effort evidence, not authoritative. Say so explicitly; don't call it confirmed.
- **No final success from HTTP 200 alone.** A 200/202 proves the request was accepted, not that the business effect is final — some operations report `pending`/`requires_action`/an async status after a synchronous-looking response.
- **`UNKNOWN` and `PENDING` are legitimate, final-for-now answers**, not signs the audit/integration is incomplete. If the target system genuinely can't provide better evidence, say so.

## Probabilistic decision systems feeding `authorize()`

An application may use a classifier, scoring model, or system like TypeSafe AI's Jev to help
decide whether an action should proceed automatically or need human sign-off. When proposing or
reviewing such an integration:

- A model's output (a score, a probability, a classification) may inform pre-execution routing,
  risk assessment, or the `requiresReview` decision passed to `authorize()`. It is INPUT to
  policy, never the policy itself — deterministic application code (a threshold, a rule) must
  interpret it, exactly as `examples/jev-refund/contract.ts` does.
- Model output is never authoritative evidence that a side effect actually happened. After
  `execute()` has been attempted, only real `observe()`/`reconcile()` against the system of
  record can establish evidence state — never re-consult the judgment model to resolve an
  ambiguous transport outcome. See `examples/jev-refund` for a concrete demonstration of this
  boundary (its "timeout after write" scenario).
- `UNKNOWN`/`PENDING` stay `UNKNOWN`/`PENDING` even when a model is confident about something —
  never convert unresolved evidence into false certainty based only on an AI/model judgment.
- If the integration calls an external judgment provider (e.g. a hosted model API), only send the
  minimum state needed for that specific judgment, and note that provider's own privacy/data
  policy is separate from corrobo's (which has none — see the main README's Privacy section).
  Never claim corrobo controls a third-party provider's data handling.

This is a generic rule, not Jev-specific guidance — see `docs/jev-integration.md` in this repo for
one worked example, not a template to force onto every operation.

## Where corrobo's actual API sits (for integration mode)

- Core lifecycle: `intent → authorize()? → execute() → observe() → reconcile() → evidence state → disposition`.
- Public entry point: `runEffect(store, contract, request)` from `corrobo` (or a relative path to `src/core` inside this monorepo, since corrobo is not yet published to npm).
- Stores: `InMemoryStore` (from `corrobo`) for tests/local dev only; `PostgresStore` (from `corrobo/postgres`) for anything production-shaped.
- Fault-testing helpers (`FaultSchedule`, `withFaultInjection`, `withObservationFault`) live in `corrobo/testing` and are architecturally separate from the production path — use them (or a small hand-rolled fake client, as in `examples/stripe-refund`, when the target API's shape doesn't fit the generic decorator pattern) to write fault tests, never to alter runtime behavior.
