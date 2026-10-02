# Guarantees, in questions and answers

Short answers, each pointing at the [failure matrix](failure-matrix.md) rows (and through them, the tests) that back it. Where an answer depends on your contract rather than on corrobo, it says so.

**What problem does corrobo solve?**
You made a consequential call to another system (a refund, a message, a ticket, a merge) and the outcome is unclear: a timeout, a reset connection, a crash. corrobo records the operation before the call, asks the external system what actually happened, and tells you what's safe to do next, so an unclear outcome is never guessed into a duplicate or a silent drop.

**Why isn't retry enough?**
A timeout means you didn't get an answer, not that nothing happened. If the provider committed and only the response was lost, retrying does it twice. `npm run demo` shows exactly this: 2 credits from a catch-and-retry loop, 1 with corrobo. → rows 1.2, 1.6

**Why isn't an idempotency key always enough?**
Often it is, and you should use one when your provider supports it (row 1.7). The gaps: many APIs don't support them; keys are retained for a limited time (Stripe: at least 24 hours), so a later retry is a new request; they deduplicate *requests*, not your business operation, if the key isn't derived from a stable operation id; and they don't tell you what happened for asynchronous outcomes. → rows 1.7, 11.1, 11.2, 4.x; [why-not-just](why-not-just.md)

**Why isn't a workflow engine by itself the whole answer?**
Temporal, Restate, Trigger.dev, Inngest, Vercel Workflow and DBOS make your *process* durable: a crashed step runs again. A step that crashes after its external write but before its result is recorded therefore runs its write again, which is why each of them tells you to make steps idempotent. corrobo goes inside that step. → [why-not-just](why-not-just.md)

**What happens after a timeout?**
corrobo does not assume failure. It observes the external system. Found → `APPLIED` / `COMPLETE`. Not found → `NOT_APPLIED`, but the timed-out request may still land, so while it could, the `RETRY` carries a `retryNotBefore` time: nothing is executed before it, and after it corrobo checks once more before executing. Without a declared `maxInFlightMs` the answer is `INVESTIGATE`. → rows 1.2–1.5

**What happens when observation fails?**
`UNKNOWN` → `INVESTIGATE`. corrobo never turns "couldn't check" into "didn't happen". → rows 3.1–3.3

**What happens when the state is still converging?**
`PENDING`, with no next step yet. While it stays `PENDING`, calling again re-checks instead of re-executing. If the provider later rejects the request, it becomes `NOT_APPLIED` and follows your retry policy, which may allow one new attempt. → rows 4.1–4.4

**What happens when corrobo genuinely cannot know?**
It says so: `UNKNOWN` → `INVESTIGATE`, closed, for a person or another process to decide. That's a correct answer, not a failure mode to work around. → rows 2.6, 3.1, 6.4

**What happens when two workers race?**
With `PostgresStore`, one of them executes; the other gets the current record (or an honest "in progress") without waiting or executing. Different operations don't block each other. If the winner's database connection dies mid-call, version-checked writes stop it from overwriting anything, and the late-landing rule stops anyone from executing again before the declared in-flight window has passed and a re-check still finds nothing. → rows 8.1–8.11

**What happens after a crash?**
The attempt was recorded before `execute()` ran, so the restart knows it was attempted. It observes first: `APPLIED` finishes it; `NOT_APPLIED` follows the late-landing rule; `UNKNOWN` goes to a person. With `InMemoryStore`, a restart loses everything, so use `PostgresStore` wherever that matters. → rows 2.1–2.9

**What does corrobo guarantee?**
With `PostgresStore` and an `observe()` that tells the truth, corrobo will not itself cause a blind duplicate in any case in the failure matrix; every recovery step after execution is derived from what `observe()` found, never invented (`REVIEW` and `revalidate()`'s `REPLAN` are the exceptions by design: policy gates that run before anything is executed); an operation identity can't silently be reused for a different intent (with the default fingerprint; a custom `fingerprintIntent()` defines its own notion of "same"); raw thrown error objects are never persisted; nothing is sent to the maintainer.

**Can corrobo check that an action is still allowed right before it runs?**
Yes: a contract's `revalidate()` runs under the lock before every attempt, with the current caller's `context`, and can let it proceed, send it to review, or reject it. It only gates new attempts; it never stops corrobo from recognizing an effect that already landed. It narrows the gap between checking and acting but can't close it, so use the provider's conditional writes too where it has them. → rows 7.5–7.13

**Who approved this, and can an approval be reused for something else?**
A `ReviewDecision` records the reviewer, when they decided, an optional expiry and note, and the fingerprint of the intent it applies to, on the operation and on every attempt it allowed. A decision made for a different intent than the recorded one is refused, an approval that has expired sends the operation back to review before any further attempt, and `revalidate()` can apply your approver policy. corrobo doesn't authenticate the reviewer: only pass decisions from your own review flow, never from anything a model can call. → rows 7.14–7.22

**What does it explicitly not guarantee?**
Exactly-once execution in general. Anything about writes made outside corrobo. A correct `observe()`: if your lookup can't prove absence (a search, an eventually consistent read) and your contract calls that `NOT_APPLIED`, corrobo will believe it (row 3.4). A correct `maxInFlightMs`: it's your bound, corrobo can't verify it. It is also not a scheduler: it doesn't decide when you call it again.

**How do I wrap one mutation?**
Write an effect contract: `execute` (make the call, sending the operation id if the API lets you), `observe` (ask the system what's true), `reconcile` (turn that into an evidence state). Then call `runEffect(store, contract, { identity, intent })`. See the [quickstart](../README.md#quickstart).

**How do I test my contract?**
Run it through `verifyEffectContract()` from `corrobo/testing`, with a fake of your provider that implements a few fault hooks. It drives lost responses, lost requests, late landings, failed reads, crashes, concurrent callers, identity reuse and pending outcomes, and counts effects on your fake rather than trusting corrobo's record. A pass means the configured scenarios passed against your fake — not that the real provider is covered. See [testing your contract](testing-your-contract.md).

**What data gets persisted?**
With `PostgresStore`: the operation identity, the intent (as JSON), each attempt's transport outcome, observations, evidence state, next step, reason metadata, and error messages, with no automatic expiry. Never raw thrown error objects. With `InMemoryStore`: nothing beyond the process. → rows 10.1–10.9; [README privacy](../README.md#privacy-and-data-handling)

**How do I use it with the workflow stack I already have?**
Call `runEffect` inside the step or activity that makes the external call, with an operation identity derived from something stable in the workflow (for example the workflow id plus the step name). The engine retries the step; corrobo decides whether the call inside it needs to happen again. [`examples/dbos-workflow`](../examples/dbos-workflow) does this with DBOS across a real process crash.
