# Failure matrix

What corrobo does at every failure point it knows about, and the test that proves it. The rules:

- Every row that claims corrobo behavior cites at least one automated test (`T…`, listed at the bottom with its exact file and title). `tests/failure-matrix-doc.test.ts` fails the build if a cited test is renamed or deleted, or if a row cites nothing.
- Rows whose outcome depends on your contract, not on corrobo, say **Assumes:** and name what you must get right. corrobo can't verify those for you.
- "Duplicate?" means: can this situation, handled by corrobo as described, cause the external effect to happen twice? It is about corrobo's own execution path; writes made outside corrobo are out of scope everywhere.

Vocabulary: evidence states `APPLIED` · `NOT_APPLIED` · `CONFLICTED` · `PENDING` · `UNKNOWN`; dispositions `COMPLETE` · `RETRY` · `REPLAN` · `REVIEW` · `INVESTIGATE`. `maxInFlightMs` is the contract's declared bound on how long a failed request could still land ([spec §O](v0.1-spec.md#o-fencing-and-settlement-when-the-lock-is-not-enough)).

## 1. Transport ambiguity

| # | Failure | What's actually true | corrobo records | `execute()` again? | Duplicate? | You do | Proof |
|---|---|---|---|---|---|---|---|
| 1.1 | None — normal success | Effect applied | `APPLIED` → `COMPLETE` | No | No | Nothing | T1 |
| 1.2 | Response lost **after** the provider committed (timeout, reset) | Effect applied | `APPLIED` → `COMPLETE` (read back, not assumed failed) | No | No | Nothing | T2, T3, T4 |
| 1.3 | Request lost **before** the provider saw it | Nothing applied | `NOT_APPLIED` → `RETRY` with `retryNotBefore`; after the window, re-observed, then one new attempt | Once, after the window | No | Call again after `retryNotBefore` | T5, T6, T11, T12 |
| 1.4 | Request lands **late**, after corrobo first looked | Applied, but later | First `NOT_APPLIED` → `RETRY` (deferred); the re-check before retrying finds `APPLIED` → `COMPLETE` | No | No | Call again after `retryNotBefore` | T7, T8 |
| 1.5 | Transport failure, contract declares no `maxInFlightMs` | Unknown whether it will land | `NOT_APPLIED` → `INVESTIGATE` (`IN_FLIGHT_NOT_RULED_OUT`) | No | No | Decide manually, or declare `maxInFlightMs` | T9, T10 |
| 1.6 | `execute()` returned a response, but the effect isn't there | Not applied, request finished | `NOT_APPLIED` → `RETRY` immediately (per retry policy) | Yes, once | No | Nothing | T13, T42 |
| 1.7 | Transport failure with provider-side idempotency | Either; the provider deduplicates | The contract sends one key on every attempt and in its read-back, so a replay returns the original result instead of a second effect; with `maxInFlightMs: 0` the retry decision is immediate | Possibly, deduplicated by the provider | No, within the provider's key retention | Keep the key stable per operation. **Assumes:** the provider really deduplicates on it | T14, T15, T92 |

## 2. Crash boundaries

| # | Failure | What's actually true | corrobo records | `execute()` again? | Duplicate? | You do | Proof |
|---|---|---|---|---|---|---|---|
| 2.1 | Crash at any point after the attempt starts | Depends on when | The attempt is reserved before `execute()` runs, so a restart finds a reservation, never an empty record. What the restart then does is rows 2.2–2.6 | See 2.2–2.6 | No | Run again | T16, T17 |
| 2.2 | Crash after the effect, before the outcome is saved | Effect applied | Restart observes first: `APPLIED` → `COMPLETE`, resolved in place | No | No | Run again | T18 |
| 2.3 | Crash; restart observes nothing, no `maxInFlightMs` | Unknown whether it will land | `NOT_APPLIED` → `INVESTIGATE` | No | No | Decide manually | T19 |
| 2.4 | Crash; restart observes nothing, window already passed | Not applied | `NOT_APPLIED` → `RETRY`; the retry executes once | Once | No | Run again | T20 |
| 2.5 | Crash; restart observes nothing inside the window; dead request lands later | Applied, late | `RETRY` deferred; the re-check finds `APPLIED` → `COMPLETE` | No | No | Run again after `retryNotBefore` | T21 |
| 2.6 | Crash; restart can't observe | Unknown | `UNKNOWN` → `INVESTIGATE` | No | No | Investigate | T22 |
| 2.7 | `execute()` succeeds but returns data the store can't serialize (e.g. circular SDK object in Postgres) | Effect applied | That pass throws; the reservation survives; the next run observes: `APPLIED` → `COMPLETE` | No | No | Run again; return plain data from `execute()` | T23 |
| 2.8 | Process restart with `PostgresStore` | — | Operation, intent and evidence reload from Postgres | — | — | Nothing | T24, T34 |
| 2.9 | Process restart with `InMemoryStore` | — | Every record is gone; corrobo no longer knows the operation was attempted | Yes — it looks new | **Yes** | Use `PostgresStore` wherever a restart matters | T101 |

## 3. Observation failures

| # | Failure | What's actually true | corrobo records | `execute()` again? | Duplicate? | You do | Proof |
|---|---|---|---|---|---|---|---|
| 3.1 | `observe()` throws or times out | Unknown | `observation_failed` → (contract) `UNKNOWN` → `INVESTIGATE`, never `NOT_APPLIED` | No | No | Investigate | T25, T26, T27 |
| 3.2 | Create succeeded but its read-back failed | Applied | `UNKNOWN` → `INVESTIGATE` (not assumed applied) | No | No | Investigate | T28 |
| 3.3 | The re-check before a deferred retry can't read the target | Unknown | `UNKNOWN` → `INVESTIGATE` | No | No | Investigate | T29 |
| 3.4 | Read is stale, from a replica, or a search that can't prove absence | Unknown | corrobo passes `authoritative` and `source` to `reconcile()` unchanged; the evidence state is whatever your `reconcile()` says. **Assumes:** a read that can't prove absence returns `UNKNOWN`, never `NOT_APPLIED` | Only if your contract says `NOT_APPLIED` | **Yes, if the contract is wrong** | Map weak reads to `UNKNOWN`; size `maxInFlightMs` to cover replication lag | T30, T31 |

## 4. Convergence (`PENDING`)

| # | Failure | What's actually true | corrobo records | `execute()` again? | Duplicate? | You do | Proof |
|---|---|---|---|---|---|---|---|
| 4.1 | Provider accepted, effect not final yet | In progress | `PENDING`, no disposition; the next run re-observes | No | No | Call again later | T32, T33 |
| 4.2 | `PENDING` → `APPLIED` | Applied | `APPLIED` → `COMPLETE`, same attempt | No | No | Nothing | T33, T34 |
| 4.3 | `PENDING` → provider rejected it | Not applied, request finished | `NOT_APPLIED` → `RETRY` per policy (one new attempt), or `INVESTIGATE` if not retryable | Once, if policy allows | No | Nothing / investigate | T35, T36 |
| 4.4 | Concurrent callers while `PENDING` | In progress | One execution; convergence needs no second one | No | No | Nothing | T37 |

## 5. Conflict

| # | Failure | What's actually true | corrobo records | `execute()` again? | Duplicate? | You do | Proof |
|---|---|---|---|---|---|---|---|
| 5.1 | The world changed under the plan (stale version, already refunded) | Diverged from intent | `CONFLICTED` → `REPLAN`, closed | No | No | Make a new plan with a new identity | T38, T39, T40 |
| 5.2 | Records for this operation already existed before corrobo ran (written by something else) | More than intended | corrobo has no record of them, so it executes once, then observes `CONFLICTED` → `REPLAN`. It does not pre-check before the first attempt | Once (the first attempt) | Only what already existed | Investigate the outside writer | T41 |

## 6. Retries and disposition rules

| # | Failure | corrobo records | `execute()` again? | Proof |
|---|---|---|---|---|
| 6.1 | Settled `NOT_APPLIED`, retry allowed, attempts left | `RETRY`; the next run makes a genuinely new attempt | Once per call | T42 |
| 6.2 | Retry budget exhausted | `INVESTIGATE` | No | T43 |
| 6.3 | Operation type not declared retryable | `INVESTIGATE` | No | T44 |
| 6.4 | `UNKNOWN`, `PENDING`, `CONFLICTED`, `APPLIED` | Never `RETRY`, whatever the retry policy | No | T45, T102, T103, T104 |
| 6.5 | Called again after the operation closed | Recorded result returned | No | T46, T100 |

## 7. Review

| # | Failure | corrobo records | `execute()` again? | Proof |
|---|---|---|---|---|
| 7.1 | `authorize()` requires review | `REVIEW`, `AWAITING_REVIEW`; nothing executed | Not until approved | T47 |
| 7.2 | Approved | Executes exactly once | Once | T48 |
| 7.3 | Rejected | Closed with `POLICY_REVIEW_REJECTED` | Never | T49 |
| 7.4 | Called again after rejection | Stays closed | Never | T50 |
| 7.5 | `revalidate()` runs before an attempt | Before every attempt, including the first, and before the attempt is reserved, with this call's `context`; a `proceed` is recorded on the attempt | Only on `proceed` | T116, T124 |
| 7.6 | `revalidate()` says `reject` | `CLOSED`, `REPLAN` (new decision, new identity); the check is recorded on the operation; nothing reserved | Never | T117, T128 |
| 7.7 | `revalidate()` says `requiresReview` | `AWAITING_REVIEW`, `REVIEW`; after approval it runs again (with the acting call's `context` and the approval) before anything executes, and can send it back to review | Not until approved *and* revalidated | T118, T119 |
| 7.8 | `revalidate()` throws, or returns something that isn't a valid result (including one whose fields throw when read) | `REVALIDATION_FAILED`, operation stays `OPEN`, nothing reserved; a later call checks again | Not until a check passes | T120, T121, T133 |
| 7.9 | Things changed between attempt 1 and attempt 2 (scope revoked, order cancelled) | Attempt 2 is stopped; attempt 1's evidence is still reported | No | T122 |
| 7.10 | A late landing while `revalidate()` would now say no | The settlement re-check finds `APPLIED` → `COMPLETE`; `revalidate()` is never asked (it gates new effects, not finding out what happened) | No | T123 |
| 7.11 | Approved after earlier attempts (revalidation sent attempt 2 to review) | The latest attempt is re-observed before executing, whether its transport failed or got a response; an effect found then is `COMPLETE`. Rejected instead: `CLOSED` with `POLICY_REVIEW_REJECTED`, attempt 1's evidence kept | Only if approved and still a settled `NOT_APPLIED` | T125, T130, T131, T132 |
| 7.12 | Restart finds a reserved, unresolved attempt | Observes only; `revalidate()` isn't called because nothing executes | No | T126 |
| 7.13 | Another pass writes while `revalidate()` runs (lost lock) | The reservation is version-checked and fails; nothing executes | No | T127 |
| 7.14 | Approved with a `ReviewDecision` | Recorded on the operation with reviewer, times and the recorded intent's fingerprint, and copied onto the attempt it allowed; survives a restart | Once | T134, T140 |
| 7.15 | Rejected with a `ReviewDecision` | `CLOSED`, `POLICY_REVIEW_REJECTED` naming the reviewer; a later decision can't replace it | Never | T135, T141 |
| 7.16 | The reviewer was shown a different intent (`intentFingerprint` doesn't match) | Refused (throws); nothing recorded | Not on that approval | T136 |
| 7.17 | Malformed `reviewDecision` (no reviewer, `expiresAt` on a rejection, a time that isn't strict RFC 3339 with `Z` or an offset, a date that doesn't exist…) | `TypeError` before anything is recorded; valid times are stored in one canonical UTC form | No | T137, T148 |
| 7.18 | Approval already expired when it arrives | Refused (throws); nothing recorded | No | T138 |
| 7.19 | Approval expires before a later attempt, or while `revalidate()` is running | `AWAITING_REVIEW` with `APPROVAL_EXPIRED`; checked again after `revalidate()` returns, at the time the attempt would start; a new approval allows the attempt | Not until re-approved | T139, T144, T147 |
| 7.20 | Approval no longer matches the recorded intent under the contract's current fingerprint rules | `AWAITING_REVIEW` with `APPROVAL_INTENT_MISMATCH` | Not until re-approved | T142 |
| 7.21 | Approver policy (e.g. no self-approval) | Up to `revalidate()`, which receives the approval and this call's `context` | Only when it says `proceed` | T143 |
| 7.22 | `runEffect()` called with 0.3's `reviewDecision: "approved"` / `"rejected"` | `TypeError` pointing to `reviewEffect()`; nothing recorded. `runEffect()` has no way to approve | No | T145 |
| 7.23 | An operation approved by 0.3.x, which recorded no decision, after upgrading | `AWAITING_REVIEW` with `APPROVAL_NOT_RECORDED` before any further attempt | Not until re-approved | T149, T150 |
| 7.24 | `reviewEffect()` records a decision | Records it and nothing else: no `execute()`, no `observe()`; the result says approved, not attempted since (also after earlier attempts); the next `runEffect()` attempts | Not by `reviewEffect()` | T151, T155 |
| 7.25 | `runEffect()` is handed a decision object (e.g. by an agent's tool) | `TypeError`, nothing recorded: decisions only go through `reviewEffect()` | No | T152 |
| 7.26 | `reviewEffect()` while another call holds the operation (or writes to it mid-review), or on one that isn't awaiting review | Busy: `OperationBusyError`, nothing recorded. Not awaiting review: current state returned, nothing recorded | No | T153, T154, T156, T157 |
| 7.27 | Approved (separately) after an attempt that got a not-applied response | The next `runEffect()` re-observes that attempt first (also if the review record lacks its attempt count); an effect that appeared during the wait is `COMPLETE` | No | T155, T158 |

## 8. Concurrency and lock loss

| # | Failure | corrobo records | `execute()` again? | Duplicate? | Proof |
|---|---|---|---|---|---|
| 8.1 | Two callers, same identity, same time | One executes; the other gets the recorded state | Once total | No | T51, T52 |
| 8.2 | Different identities concurrently | Run in parallel, no global lock | Independent | No | T53 |
| 8.3 | Loser arrives while an attempt is reserved | `ATTEMPT_IN_PROGRESS`, no disposition | No | No | T54 |
| 8.4 | Loser arrives before the record exists | `OPERATION_IN_PROGRESS`, no disposition | No | No | T55 |
| 8.5 | Race that ends `UNKNOWN` | Still one execution | No | No | T64 |
| 8.6 | Pool at or above `pool.max` concurrent identities | No self-deadlock; one connection per in-flight identity | — | No | T56 |
| 8.7 | Lock's DB session dies while `execute()` is still running | Another caller recovers without executing; the stale pass can't overwrite (version check) | Only per settlement rules (1.3–1.5) | No | T57, T58, T59 |
| 8.8 | A stale pass tries to reserve on top of another's attempt | Rejected by version check before `execute()` | No | No | T60 |
| 8.9 | Unlocking fails | Connection destroyed (its session lock ends); `release()` doesn't throw | — | No | T61 |
| 8.10 | Host clocks disagree | Window checks use the store's clock (Postgres: `clock_timestamp()`) | — | No | T62 |
| 8.11 | Database unavailable | Error surfaces before anything executes | No | No | T63 |

## 9. Identity and intent

| # | Failure | corrobo records | `execute()` again? | Proof |
|---|---|---|---|---|
| 9.1 | Same identity, different `operationType` | Throws; never executes | No | T65 |
| 9.2 | Same identity, different intent | Throws; never returns the other operation's result | No | T66, T67, T68 |
| 9.3 | Same intent, different key order | Same operation | No | T69 |
| 9.4 | Intent with irrelevant fields (nonces) | Use `fingerprintIntent()` to ignore them | No | T70 |
| 9.5 | Intent containing a `Date` | Stored as ISO string; matches itself after a Postgres round trip; a different date is a conflict | No | T71 |
| 9.6 | Intent JSON can't store faithfully: circular, function, symbol, BigInt, Map, Set, typed array, getter, or `undefined` itself | `TypeError` naming the path, before anything is written or executed | No | T72, T73, T74, T105, T106, T107 |
| 9.8 | Intents that JSON stores identically: `{ a: undefined }` / `{}`, `NaN` / `null`, a `Date` / its ISO string | The same operation — identity follows what is stored | No | T108, T109, T110 |
| 9.10 | Intent reads differently each time (a stateful `toJSON()`) | Read exactly once per call; that reading is what's stored and fingerprinted; a later, different reading is a loud conflict | No | T113 |
| 9.11 | Request's explicit `identity.operationType` differs from the contract's (or pass the id as a plain string) | Throws before anything is written or executed; a string id always uses the contract's `operationType` | No | T114, T115 |
| 9.9 | Contract supplies its own `fingerprintIntent()` | corrobo uses it and does not apply the default JSON rules to that intent; the store must still be able to persist the intent | No | T70, T111 |
| 9.7 | A new identity | A genuinely new operation | Yes (it's new) | T75 |

## 10. Persistence and privacy

| # | Situation | Behavior | Proof |
|---|---|---|---|
| 10.1 | `execute()`/`observe()` throws an error carrying secrets or PII in `error.raw` | `PostgresStore` never persists `error.raw` (transport and observation) | T76, T77 |
| 10.2 | Your own data has a field named `raw` | Not stripped | T78 |
| 10.3 | Thrown value is Error-like (`{ message, headers }`) | The recorded message is its own string `message` and nothing else of it; the thrown object itself stays in memory only (`error.raw`), never persisted by `PostgresStore` (10.1) | T79 |
| 10.4 | Thrown value isn't an Error (string, `undefined`, `null`, number, object with functions), or even its message can't be read | Recorded as a transport failure; the pass never crashes | T87, T88, T112 |
| 10.5 | `PostgresStore` constructed without `{ acknowledgePersistence: true }` | Throws | T80, T81, T82 |
| 10.6 | `InMemoryStore` | No acknowledgement, no persistence beyond the process | T83, T101 |
| 10.7 | Nested evidence, observations, reason metadata | Round-trip through Postgres exactly | T84, T85 |
| 10.8 | Retention | No automatic expiry or deletion; retention is yours | T86 |
| 10.9 | Upgrading from 0.2.x | `migrate()` adds `version` in place; old reserved rows recover; old transport-failure `RETRY`s are re-checked under current rules | T89, T90, T91 |
| 10.10 | Upgrading from 0.3.x | `migrate()` adds `blocked_by` and `review` in place; existing rows keep their state and version, and a 0.3.x rejection still reads as rejected | T129, T146 |

Error **messages** are still persisted: if your code puts secrets into an error message, intent, observation or reason metadata, they are stored as you wrote them.

## 11. Provider idempotency and correlation

| # | Situation | Behavior | Proof |
|---|---|---|---|
| 11.1 | Provider idempotency key | Same key on every attempt of one operation; a new operation never reuses it | T92, T93 |
| 11.2 | Idempotency replay window expired (e.g. Stripe's ~24h) | Replay refused: `UNKNOWN` → `INVESTIGATE`, never a new refund | T94 |
| 11.3 | Stable provider id known from `execute()` | Later checks look it up directly | T95 |
| 11.4 | Lookup only by search/listing | **Assumes:** your contract returns `UNKNOWN` when absence can't be proven — see 3.4 | T30 |

## 12. What corrobo itself does on your machine

| # | Guarantee | Proof |
|---|---|---|
| 12.1 | No logging of any kind in the library source | T96 |
| 12.2 | No network code except `PostgresStore` talking to the pool you pass in | T97, T98 |
| 12.3 | No install-time scripts and no runtime dependencies (`pg` is an optional peer, used only through the pool you pass in) | T99 |

## Not covered by this matrix

- Writes to the external system made outside corrobo.
- A `maxInFlightMs` smaller than the provider's real processing time.
- A custom `EffectStore` without version-checked writes or same-identity locking.
- Exactly-once delivery in general: corrobo guarantees it will not *itself* cause a blind duplicate, within the rows above.

## Tests cited

- **T1** [`tests/rest-example.test.ts`](../tests/rest-example.test.ts) — "normal success -> APPLIED / COMPLETE"
- **T2** [`tests/timeout-demo.test.ts`](../tests/timeout-demo.test.ts) — "corrobo: same lost response, one credit, APPLIED / COMPLETE"
- **T3** [`tests/rest-example.test.ts`](../tests/rest-example.test.ts) — "timeout AFTER the write commits does not duplicate the mutation (headline scenario)"
- **T4** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "HEADLINE: timeout after Stripe commits the refund does not create a duplicate"
- **T5** [`tests/timeout-demo.test.ts`](../tests/timeout-demo.test.ts) — "request lost BEFORE commit: no immediate retry; after the in-flight window, re-check, then exactly one credit"
- **T6** [`tests/rest-example.test.ts`](../tests/rest-example.test.ts) — "timeout BEFORE the write reaches the server allows retry only after absence is established"
- **T7** [`tests/timeout-demo.test.ts`](../tests/timeout-demo.test.ts) — "request lands LATE, after corrobo first looked: the re-check finds it, and no second POST is sent"
- **T8** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "a request that times out without landing, then lands inside the window: no second execute"
- **T9** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "no maxInFlightMs declared -> INVESTIGATE (a late landing cannot be ruled out), never RETRY"
- **T10** [`tests/fencing-adversarial.test.ts`](../tests/fencing-adversarial.test.ts) — "investigates NOT_APPLIED after an unknown transport when no maxInFlightMs is declared"
- **T11** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "after the window, a settled NOT_APPLIED retries in the same call"
- **T12** [`tests/fencing-adversarial.test.ts`](../tests/fencing-adversarial.test.ts) — "returns cached RETRY before retryNotBefore without executing or observing"
- **T13** [`tests/fencing-adversarial.test.ts`](../tests/fencing-adversarial.test.ts) — "retries immediately when transport ok:true proves the request is no longer in flight"
- **T14** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "timeout BEFORE Stripe ever processes the request self-heals in one call via the idempotency replay"
- **T15** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "maxInFlightMs: 0 (re-execution provider-deduplicated) -> ordinary RETRY immediately"
- **T16** [`tests/postgres-crash-recovery.test.ts`](../tests/postgres-crash-recovery.test.ts) — "a reserved attempt exists before execute() is ever called"
- **T17** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "persists operation identity and intent before execute() runs, even if execute() throws"
- **T18** [`tests/postgres-crash-recovery.test.ts`](../tests/postgres-crash-recovery.test.ts) — "crash after the effect occurred but before resolution: restart observes first, finds APPLIED, does not re-execute"
- **T19** [`tests/postgres-crash-recovery.test.ts`](../tests/postgres-crash-recovery.test.ts) — "crash, then NOT_APPLIED, no maxInFlightMs: INVESTIGATE — the dead attempt could still land, so no automatic retry"
- **T20** [`tests/postgres-crash-recovery.test.ts`](../tests/postgres-crash-recovery.test.ts) — "crash, then NOT_APPLIED after the in-flight window has passed: RETRY per policy, and the retry executes once"
- **T21** [`tests/postgres-crash-recovery.test.ts`](../tests/postgres-crash-recovery.test.ts) — "crash, then NOT_APPLIED inside the window, then the dead attempt lands late: caught by the settlement check, never re-executed"
- **T22** [`tests/postgres-crash-recovery.test.ts`](../tests/postgres-crash-recovery.test.ts) — "crash + observation cannot resolve either way: honestly UNKNOWN / INVESTIGATE, no blind re-execution"
- **T23** [`tests/postgres-failure-catalog.test.ts`](../tests/postgres-failure-catalog.test.ts) — "execute() succeeds but returns data Postgres can't store: the pass throws, the reservation survives, the next run observes — one effect"
- **T24** [`tests/postgres-store.test.ts`](../tests/postgres-store.test.ts) — "persists an operation and reloads it via a fresh pool, simulating a process restart"
- **T25** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "a failed observation is UNKNOWN, never conflated with NOT_APPLIED, and does not silently retry"
- **T26** [`tests/timeout-demo.test.ts`](../tests/timeout-demo.test.ts) — "if the ledger can't be read after a lost response: UNKNOWN / INVESTIGATE, and nothing is re-executed"
- **T27** [`tests/rest-example.test.ts`](../tests/rest-example.test.ts) — "execute AND observe both failing is honestly UNKNOWN / INVESTIGATE, never a blind retry"
- **T28** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "a failed read-back on an otherwise-successful create is honestly UNKNOWN, not assumed APPLIED"
- **T29** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "if the settlement check itself cannot read the target, nothing is executed"
- **T30** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "corrobo does not judge authority itself: reconcile() receives authoritative:false untouched"
- **T31** [`tests/timeout-demo-adversarial.test.ts`](../tests/timeout-demo-adversarial.test.ts) — "verifyProof rejects a contract that turns ledger read failure into false absence"
- **T32** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "PENDING triggers re-observation on the next call, never a second execute()"
- **T33** [`tests/rest-example.test.ts`](../tests/rest-example.test.ts) — "an asynchronously converging effect is PENDING and later resolves without a second mutation"
- **T34** [`tests/postgres-store.test.ts`](../tests/postgres-store.test.ts) — "supports the PENDING -> re-observe -> APPLIED lifecycle durably, across separate calls"
- **T35** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "provider accepted, then failed it: RETRY per policy (the request is no longer in flight), one new attempt"
- **T36** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "same, but the operation type is not safe to retry: INVESTIGATE, never re-executed"
- **T37** [`tests/postgres-concurrency.test.ts`](../tests/postgres-concurrency.test.ts) — "CASE 3: a race resolving to PENDING does not cause a second execute(), and convergence still requires only one"
- **T38** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "CONFLICTED leads to REPLAN and closes the operation (a new identity is needed, not a retry of this one)"
- **T39** [`tests/rest-example.test.ts`](../tests/rest-example.test.ts) — "a stale expected version produces CONFLICTED / REPLAN"
- **T40** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "a charge already refunded by something else -> CONFLICTED / REPLAN"
- **T41** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "corrobo has no record, so it executes once, then sees more than it intended: CONFLICTED / REPLAN, no further writes"
- **T42** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "NOT_APPLIED with a safe-retry policy allows a genuine second attempt"
- **T43** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "retry exhaustion is represented conservatively (INVESTIGATE, not a silent stop or a forced retry)"
- **T44** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "NOT_APPLIED not declared retryable for this operation type -> INVESTIGATE, not RETRY"
- **T45** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "UNKNOWN cannot be configured into RETRY — retryOnNotApplied only affects NOT_APPLIED"
- **T46** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "does not re-execute once the same operation identity is closed"
- **T47** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "REVIEW is a pre-execution policy gate, not a reconciliation outcome"
- **T48** [`tests/review-rejection.test.ts`](../tests/review-rejection.test.ts) — "approval still executes exactly once"
- **T49** [`tests/review-rejection.test.ts`](../tests/review-rejection.test.ts) — "rejection calls execute() zero times"
- **T50** [`tests/review-rejection.test.ts`](../tests/review-rejection.test.ts) — "repeated calls after rejection remain closed and never execute"
- **T51** [`tests/postgres-concurrency.test.ts`](../tests/postgres-concurrency.test.ts) — "CASE 1: two concurrent callers racing the SAME identity cause exactly one external mutation"
- **T52** [`tests/memory-concurrency.test.ts`](../tests/memory-concurrency.test.ts) — "two overlapping runEffect() calls for the SAME identity cause exactly one execute()"
- **T53** [`tests/postgres-concurrency.test.ts`](../tests/postgres-concurrency.test.ts) — "CASE 2: different identities execute concurrently without serializing behind a global lock"
- **T54** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "record exists with a reserved attempt: ATTEMPT_IN_PROGRESS, no disposition"
- **T55** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "no record yet (the winner is still authorizing): OPERATION_IN_PROGRESS, no disposition"
- **T56** [`tests/postgres-pool.test.ts`](../tests/postgres-pool.test.ts) — "N >= pool.max concurrent distinct identities complete without deadlocking, and genuinely overlap"
- **T57** [`tests/postgres-fencing.test.ts`](../tests/postgres-fencing.test.ts) — "the lock session is killed mid-execute: no duplicate external effect, and the stale pass never overwrites"
- **T58** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "no maxInFlightMs: recovery says INVESTIGATE, nobody re-executes, and the stale pass cannot overwrite"
- **T59** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "with maxInFlightMs: recovery defers the retry; the settlement check catches the late landing"
- **T60** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "the stale pass's reservation is fenced too: it never reaches execute()"
- **T61** [`tests/postgres-fencing.test.ts`](../tests/postgres-fencing.test.ts) — "if unlocking fails, the connection is destroyed (ending its session) and release() does not throw"
- **T62** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "attempt start and window checks use the store's clock, not the local one"
- **T63** [`tests/postgres-failure-catalog.test.ts`](../tests/postgres-failure-catalog.test.ts) — "the pool can't hand out a connection: the error surfaces, nothing is executed or written"
- **T64** [`tests/postgres-concurrency.test.ts`](../tests/postgres-concurrency.test.ts) — "CASE 5: a race resolving to UNKNOWN does not turn coordination into an unsafe second execution"
- **T65** [`tests/identity-binding.test.ts`](../tests/identity-binding.test.ts) — "same identity + different operationType -> loud conflict error, no execute"
- **T66** [`tests/identity-binding.test.ts`](../tests/identity-binding.test.ts) — "same identity + same operationType + different intent -> loud conflict error, never a silent stale result"
- **T67** [`tests/identity-binding.test.ts`](../tests/identity-binding.test.ts) — "the conflict check also applies to a caller who lost the coordination race"
- **T68** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "a conflict on create never hands back another intent's result"
- **T69** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "reusing an identity with the same intent in a different key order is the same operation, not a conflict"
- **T70** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "treats two intents differing only in an ignored field as the same logical operation"
- **T71** [`tests/postgres-failure-catalog.test.ts`](../tests/postgres-failure-catalog.test.ts) — "an intent containing a Date matches itself after the Postgres round trip, and a different Date is a loud conflict"
- **T72** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "circular intent: throws before execute(), and leaves no record behind"
- **T73** [`tests/postgres-failure-catalog.test.ts`](../tests/postgres-failure-catalog.test.ts) — "a circular intent is rejected before any effect or row"
- **T74** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "rejects %s with a clear TypeError naming the path"
- **T75** [`tests/timeout-demo.test.ts`](../tests/timeout-demo.test.ts) — "a different operation identity is a genuinely new credit"
- **T76** [`tests/postgres-error-sanitization.test.ts`](../tests/postgres-error-sanitization.test.ts) — "a transport error's raw object never reaches persisted Postgres JSON"
- **T77** [`tests/postgres-error-sanitization.test.ts`](../tests/postgres-error-sanitization.test.ts) — "an observation error's raw object never reaches persisted Postgres JSON"
- **T78** [`tests/postgres-error-sanitization.test.ts`](../tests/postgres-error-sanitization.test.ts) — "a legitimately-named unrelated field is not accidentally stripped"
- **T79** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "a thrown Error-like object keeps its message (and nothing else of it) as the recorded message"
- **T80** [`tests/postgres-acknowledgement.test.ts`](../tests/postgres-acknowledgement.test.ts) — "throws a clear error when the options object is missing entirely"
- **T81** [`tests/postgres-acknowledgement.test.ts`](../tests/postgres-acknowledgement.test.ts) — "throws a clear error when acknowledgePersistence is false"
- **T82** [`tests/postgres-acknowledgement.test.ts`](../tests/postgres-acknowledgement.test.ts) — "throws a clear error when the options object is malformed (missing the key)"
- **T83** [`tests/postgres-acknowledgement.test.ts`](../tests/postgres-acknowledgement.test.ts) — "constructs with zero arguments and zero permission gates"
- **T84** [`tests/postgres-failure-catalog.test.ts`](../tests/postgres-failure-catalog.test.ts) — "nested evidence, observations and reason metadata come back from a fresh pool exactly as written"
- **T85** [`tests/runtime.test.ts`](../tests/runtime.test.ts) — "reason-code metadata survives persistence through the store"
- **T86** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "no automatic expiry or deletion of persisted records"
- **T87** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "execute() throwing %s is recorded as a transport failure, never crashes the pass"
- **T88** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "execute() throwing an object holding a function still yields a result, and the operation stays usable"
- **T89** [`tests/postgres-fencing.test.ts`](../tests/postgres-fencing.test.ts) — "migrate() upgrades a corrobo 0.2.x table in place, and an old RESERVED row still recovers"
- **T90** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "a 0.2.x RETRY after a transport failure, contract without maxInFlightMs: INVESTIGATE, never executed"
- **T91** [`tests/fencing.test.ts`](../tests/fencing.test.ts) — "a 0.2.x RETRY whose request landed late: the settlement check finds APPLIED, no second effect"
- **T92** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "reuses the same Stripe idempotency key across attempts of the same logical operation"
- **T93** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "a NEW logical operation (new identity) never reuses an old idempotency key"
- **T94** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "replay beyond the safe window is refused — UNKNOWN/INVESTIGATE, no second refund ever created"
- **T95** [`tests/stripe-refund.test.ts`](../tests/stripe-refund.test.ts) — "once execute() itself returns a stable refund id, later re-observations use direct retrieve, never replay"
- **T96** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "no logging of any kind in src/ (application payloads are never printed by corrobo)"
- **T97** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "no network-capable code in src/ except PostgresStore's use of the pool you pass in"
- **T98** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "the core and InMemoryStore make no network calls of their own"
- **T99** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "package.json declares no install-time scripts and no runtime dependencies (pg is an optional peer)"
- **T100** [`tests/timeout-demo.test.ts`](../tests/timeout-demo.test.ts) — "running the same operation repeatedly never adds a credit"
- **T101** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "InMemoryStore is process-local: a new instance (a restarted process) has none of the old records"
- **T102** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "APPLIED -> COMPLETE"
- **T103** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "CONFLICTED -> REPLAN"
- **T104** [`tests/disposition.test.ts`](../tests/disposition.test.ts) — "PENDING cannot be configured into RETRY — it never carries a disposition"
- **T105** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "an intent containing %s is rejected before any record or execute()"
- **T106** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "an own getter property is rejected: it could return something different when the intent is stored"
- **T107** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "a root intent that is %s is rejected"
- **T108** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "intents JSON stores identically are the same intent (documented equivalences)"
- **T109** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "%s: fingerprint before == after persistence"
- **T110** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "an intent fingerprints the same before and after a JSON round trip (Date vs its persisted ISO string)"
- **T111** [`tests/fingerprint.test.ts`](../tests/fingerprint.test.ts) — "a custom fingerprintIntent takes responsibility: corrobo does not apply the default rules to that intent"
- **T112** [`tests/failure-catalog.test.ts`](../tests/failure-catalog.test.ts) — "a thrown value whose message can't even be read is still recorded as a transport failure"
- **T113** [`tests/postgres-failure-catalog.test.ts`](../tests/postgres-failure-catalog.test.ts) — "%s: stored intent == the single reading; a later, different reading is a conflict"
- **T114** [`tests/helpers.test.ts`](../tests/helpers.test.ts) — "an explicit identity whose operationType disagrees with the contract is rejected before anything happens"
- **T115** [`tests/helpers.test.ts`](../tests/helpers.test.ts) — "identity as a string is shorthand for { id, operationType: contract.operationType }"
- **T116** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "runs once, before the attempt is reserved, with the attempt number, this call's context and the record"
- **T117** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "reject: nothing is executed or reserved; CLOSED with REPLAN, and later calls never execute"
- **T118** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "requiresReview: AWAITING_REVIEW with the hook's reason; after approval it runs again, with the acting call's context and the approval"
- **T119** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "an approval that revalidate() still won't accept goes back to review instead of executing"
- **T120** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "a throw: nothing executed or reserved, the operation stays OPEN with REVALIDATION_FAILED, and a later call checks again"
- **T121** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "returning %s fails closed"
- **T122** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "runs before attempt 2 with that call's context (a background worker), and can stop it; attempt 1's evidence is still reported"
- **T123** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "a late landing found by the settlement check is APPLIED, and revalidate() is never asked about it"
- **T124** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "order: settlement check first, then revalidate(), then reserve and execute"
- **T125** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "requiresReview before attempt 2, then approved: the settlement check runs again before executing"
- **T126** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "recovering a reserved attempt after a crash never calls revalidate() (it never executes)"
- **T127** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "if another pass writes while revalidate() runs (lost lock), this pass executes nothing"
- **T128** [`tests/postgres-revalidate.test.ts`](../tests/postgres-revalidate.test.ts) — "a reject is persisted on the operation and reported from a fresh read"
- **T129** [`tests/postgres-revalidate.test.ts`](../tests/postgres-revalidate.test.ts) — "migrate() upgrades a 0.3.x table in place (adds blocked_by) and keeps its rows"
- **T130** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "requiresReview before attempt 2, then rejected in review: CLOSED as rejected, not as a pending RETRY"
- **T131** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "requiresReview after a definitive not-applied response, then approved: re-observed first, so an effect that appeared meanwhile isn't repeated"
- **T132** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "requiresReview after a definitive not-applied response, then approved and still not applied: one new attempt"
- **T133** [`tests/revalidate.test.ts`](../tests/revalidate.test.ts) — "a result whose fields throw when read fails closed like a throw, and only code, summary and metadata of a reason are kept"
- **T134** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an approval is recorded with who, when and the intent it applies to, and the attempt it allowed carries it"
- **T135** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "a rejection records who rejected it, says so in the result, and nothing is executed"
- **T136** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an approval made for a different intent than the recorded one is refused, and nothing changes"
- **T137** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "a malformed reviewDecision (%s) throws before anything is recorded or executed"
- **T138** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an approval that has already expired when it arrives is refused, and nothing changes"
- **T139** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an approval that expires before a later attempt sends it back to review instead of executing"
- **T140** [`tests/postgres-review.test.ts`](../tests/postgres-review.test.ts) — "an approval survives a restart: the review, and the approval on the attempt it allowed, read back exactly"
- **T141** [`tests/postgres-review.test.ts`](../tests/postgres-review.test.ts) — "a rejection is recorded with the reviewer and reported from a fresh read"
- **T142** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an approval whose intent no longer matches the recorded one (the fingerprint rules changed) goes back to review"
- **T143** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "revalidate() receives the approval and can enforce approver policy (no self-approval)"
- **T144** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "a crash after the approval is recorded but before the attempt: the next call checks the approval again"
- **T145** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "runEffect() refuses the reviewDecision field corrobo 0.3 took, and nothing is recorded or executed"
- **T146** [`tests/postgres-review.test.ts`](../tests/postgres-review.test.ts) — "migrate() adds the review column to an older table and keeps its rows"
- **T147** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an approval that expires while revalidate() runs doesn't allow the attempt, and the attempt starts at the time it was checked"
- **T148** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "times with an offset are recorded in one canonical UTC form"
- **T149** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an operation approved by corrobo 0.3.x (no recorded decision) needs a new review %s"
- **T150** [`tests/postgres-review.test.ts`](../tests/postgres-review.test.ts) — "a row approved under 0.3.x (OPEN, a review reason, no recorded decision) needs a new review before any attempt"
- **T151** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "records the decision and does nothing else: no execute, no observe; runEffect() then makes the attempt"
- **T152** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "runEffect() refuses a decision object: decisions go through reviewEffect()"
- **T153** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "while another call holds the operation it throws OperationBusyError and records nothing"
- **T154** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "an operation that isn't awaiting review is returned unchanged, and the decision isn't recorded"
- **T155** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "approved after an attempt that got a not-applied response: the next runEffect() re-observes first, so an effect that appeared meanwhile isn't repeated"
- **T156** [`tests/postgres-review.test.ts`](../tests/postgres-review.test.ts) — "reviewEffect() throws OperationBusyError while another process holds the operation's advisory lock"
- **T157** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "a concurrent write while the decision is being recorded is OperationBusyError, and the decision isn't recorded"
- **T158** [`tests/review-approval.test.ts`](../tests/review-approval.test.ts) — "a review record without attemptCount is treated as recent: the next runEffect() re-observes first"
