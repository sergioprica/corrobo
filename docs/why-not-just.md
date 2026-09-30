# Why not just…

corrobo is for the gap between "the caller failed" and "the external system did or did not change." Most mature systems already give you useful durability, retries, idempotency, queues, transactions, or compensation; use them where they fit. The remaining problem is the evidence problem after an ambiguous side effect: what does the authoritative system say happened, and what is safe next?

Durable execution restores your process. corrobo establishes what the external system actually did.

Checked against current official docs on 2026-09-29.

## 1. Why not just retry?

**When it is enough:** Retrying is enough when the operation is naturally idempotent, or when repeating it cannot cause a second business effect: a cache refresh, a read, a PUT-style declarative update, or a provider-deduplicated request.

**Where ambiguity remains:** POST charge -> provider commits -> TCP timeout before response -> catch block retries -> second charge. The exception only says the response was lost; it does not say the write failed.

**How corrobo composes with it:** corrobo still permits RETRY, but only after evidence says NOT_APPLIED and the operation's contract says retrying is safe. If the failed request might still land, the RETRY carries a `retryNotBefore` time: nothing executes before it, and corrobo re-checks after it before executing. UNKNOWN becomes INVESTIGATE, not another attempt.

## 2. Why not just use an idempotency key?

**When it is enough:** Stripe-style idempotency is often sufficient. Stripe saves the first result for a key, returns the same result on replay, accepts keys on all POSTs, and says keys may be pruned after at least 24 hours: https://docs.stripe.com/api/idempotent_requests.

**Where ambiguity remains:** Some APIs have no keys. Some keys expire. Some keys are scoped to one HTTP request, not a business operation. Async outcomes can remain PENDING. Audit still asks "what happened?" not merely "what did replay return?" Stripe also does not save a result before endpoint execution starts, such as validation failure or concurrent conflict.

**How corrobo composes with it:** Use the provider key, derived from corrobo's stable operation identity so every attempt of one operation sends the same key. corrobo then observes the authoritative state after execution and records APPLIED / NOT_APPLIED / CONFLICTED / PENDING / UNKNOWN. The [Stripe example](../examples/stripe-refund) does exactly this, and its contract also refuses to replay a key past a conservative margin inside Stripe's retention window, reporting UNKNOWN instead of risking a second refund.

## 3. Why not just use Temporal?

**When it is enough:** Temporal is a strong answer for durable workflow state, timers, backoff, worker crashes, and replay. Its docs are explicit that completed activities are not re-executed during workflow replay: https://docs.temporal.io/activity-definition.

**Where ambiguity remains:** Temporal also says activities may be executed more than once; if a worker completes an activity but crashes before reporting it, the activity is retried. The docs recommend idempotent activities and downstream idempotency keys enforced by the called service.

**How corrobo composes with it:** Put corrobo inside the Temporal activity around the consequential call. Temporal resumes the workflow; corrobo decides whether that external effect is APPLIED, still PENDING, safely NOT_APPLIED, CONFLICTED, or UNKNOWN.

## 4. Why not Trigger.dev / Inngest / Restate / Vercel Workflow / DBOS?

**When it is enough:** These are good durable-execution systems. Trigger.dev documents task idempotency windows and failed-run key clearing: https://trigger.dev/docs/idempotency. Inngest documents retried steps and 24-hour event/function idempotency: https://www.inngest.com/docs/guides/error-handling and https://www.inngest.com/docs/guides/handling-idempotency. Restate documents durable services/workflows and `ctx.run` side-effect examples: https://docs.restate.dev/concepts/services/. Vercel Workflow documents retrying steps and stable step IDs for idempotency keys: https://workflow-sdk.dev/docs/foundations/errors-and-retries and https://workflow-sdk.dev/cookbook/common-patterns/idempotency. DBOS documents workflow IDs as idempotency keys and steps tried at least once: https://docs.dbos.dev/typescript/tutorials/workflow-tutorial.

**Where ambiguity remains:** A step calls a payment API, the provider commits, the process dies before the step result is durably recorded, and the engine retries the step. Restate docs issue #410 is a public example of this concern for `ctx.run`: https://github.com/restatedev/docs-restate/issues/410. Cloudflare's Workflow docs show the same gap as code guidance: check if already charged because a request can fail/retry while still committing in the payment processor: https://developers.cloudflare.com/workflows/build/rules-of-workflows/.

**How corrobo composes with it:** Keep the durable workflow. Wrap only the side-effecting boundary with corrobo ([DBOS example](../examples/dbos-workflow), across a real crash) when you need post-write observation, settlement, and an auditable conservative disposition. If the platform step plus provider idempotency fully covers the operation, corrobo may add little beyond evidence and audit.

## 5. Why not transactions?

**When it is enough:** Transactions are enough when all relevant state is in the same transactional system. PostgreSQL serializable isolation is defined to behave like transactions ran one at a time: https://www.postgresql.org/docs/current/transaction-iso.html.

**Where ambiguity remains:** DB commit -> external API call -> timeout. Or external API call -> DB commit fails. Your database can roll back your row; it cannot roll back Stripe, Slack, GitHub, or a human-visible email.

**How corrobo composes with it:** corrobo uses durable local state for operation identity and attempts, but treats the external system as the authority for the effect. It is not a distributed transaction protocol.

## 6. Why not exactly-once delivery?

**When it is enough:** Exactly-once can be meaningful inside one coordinated substrate. Kafka documents exactly-once support for Kafka Streams / Kafka-to-Kafka transactions: https://kafka.apache.org/40/design/design/.

**Where ambiguity remains:** Kafka's own design docs say external systems require coordination between consumer position and external output, often via cooperation from that system. Delivery exactly once to a worker is not the same as charging exactly once at a payment processor.

**How corrobo composes with it:** corrobo does not claim exactly-once. It narrows the post-effect decision: observe authoritative state, then COMPLETE, RETRY, REPLAN, REVIEW, or INVESTIGATE.

## 7. Why not query before every write?

**When it is enough:** A pre-check helps reject obvious duplicates or stale plans. It is useful with optimistic concurrency, unique constraints, and human review.

**Where ambiguity remains:** GET says not charged -> POST charge starts -> timeout -> immediate GET still says not charged because the first request is in flight -> retry -> first request lands too. That is a TOCTOU race plus a late landing.

**How corrobo composes with it:** corrobo observes after execute, under same-identity coordination, and applies settlement rules before retrying a NOT_APPLIED after failed transport.

## 8. Why not rely on HTTP status codes?

**When it is enough:** A received 2xx/4xx/5xx response is useful evidence. HTTP status codes describe the result and response semantics: https://www.rfc-editor.org/rfc/rfc9110.html#name-status-codes.

**Where ambiguity remains:** A timeout has no status code. A 500 may be saved by an idempotency layer. A 409/405 after a lost success may mean "already applied," not "failed."

**How corrobo composes with it:** `execute()` captures transport evidence without treating it as business truth. `observe()` and `reconcile()` decide the evidence state.

## 9. Why not a queue?

**When it is enough:** Queues decouple producers and consumers, smooth bursts, and make retry/backoff operationally sane. Some queues are explicitly at-least-once; SQS tells consumers to be idempotent because a message copy can be received again: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html.

**Where ambiguity remains:** Consumer receives message -> calls external API -> API commits -> consumer dies before ack/delete -> message redelivered -> API called again.

**How corrobo composes with it:** Put corrobo in the consumer around the external mutation. The queue owns delivery; corrobo owns evidence-based recovery for the effect.

## 10. Why not a saga / compensation?

**When it is enough:** Sagas are appropriate when the business process has meaningful undo or forward-repair steps: cancel shipment, issue refund, reopen ticket, notify human.

**Where ambiguity remains:** Compensation assumes you know which step happened. If the refund call timed out, compensating as if it applied can be wrong, and retrying as if it did not apply can also be wrong.

**How corrobo composes with it:** corrobo can feed the saga with APPLIED, NOT_APPLIED, CONFLICTED, PENDING, or UNKNOWN. It does not invent compensation; UNKNOWN still means investigate.

## When corrobo is not worth it

Skip it for pure internal database writes, read-only operations, and operations whose duplicate cost is trivial. It is also often unnecessary when a provider has strong native idempotency, the replay window is short and comfortably within retention, the operation has no async/convergence ambiguity, and you do not need an audit record of post-write evidence. In those cases, stable idempotency keys plus your workflow engine or transaction boundary are probably enough.
