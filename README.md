# corrobo

[![npm version](https://img.shields.io/npm/v/corrobo.svg)](https://www.npmjs.com/package/corrobo)
[![CI](https://github.com/vidithsalla/corrobo/actions/workflows/ci.yml/badge.svg)](https://github.com/vidithsalla/corrobo/actions/workflows/ci.yml)

**Your API call timed out. Did the write happen?**

Your code issued a refund, sent a message, opened a ticket, or merged a PR, and the connection dropped before the answer came back. Maybe it failed. Maybe the provider did it and only the response got lost. Retry blindly and you might do it twice.

corrobo is a small TypeScript library for that moment. It records the operation before making the call, then asks the external system what actually happened, and decides from that evidence whether doing it again is safe.

```
execute  →  observe  →  reconcile  →  recover
```

![npm run demo: after a lost response, the naive retry credits the account twice; corrobo checks the ledger and credits once](docs/assets/timeout-after-write.svg)

That's `npm run demo` in this repo: a real local HTTP ledger commits a credit, then drops the connection. Both counts come from the ledger's own API, not from corrobo.

```
npm install corrobo
```

> **Heads-up:** this README describes corrobo **0.3.0**, the next release. npm currently serves 0.2.1, which doesn't have `maxInFlightMs` or version-checked stores, so the quickstart below won't compile against it yet. Until 0.3.0 is published, try it from this repo (`npm run quickstart`). Upgrading from 0.2.x: see the [changelog](CHANGELOG.md).

## Quickstart

Wrap one consequential call in an *effect contract*: how to do it, how to check it, and how to judge what you see. Here `payments` is your API client (in the runnable version, [`examples/quickstart`](examples/quickstart), it's a stand-in that loses the response after refunding).

```ts
import { runEffect, InMemoryStore, defineContract, observed, reconciled } from "corrobo";

const refundOrder = defineContract<{ orderId: string; amountCents: number }>()({
  operationType: "payments/refund",
  retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
  maxInFlightMs: 10_000, // your request timeout + how long the API may take to apply a request

  // 1. Make the write. Send the operation id so the API can be asked about it afterwards.
  execute: ({ intent, identity }) => payments.createRefund({ ...intent, reference: identity.id }),

  // 2. Ask the API what is actually true. Never infer it from execute()'s outcome.
  observe: async ({ identity }) =>
    observed((await payments.findRefunds(identity.id)).length, { source: "payments.findRefunds", authoritative: true }),

  // 3. Compare what you intended with what you observed.
  reconcile: ({ observation }) => {
    if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "Could not read refunds.");
    const found = observation.data;
    if (found === 0) return reconciled("NOT_APPLIED", "NO_REFUND", "No refund exists.");
    if (found === 1) return reconciled("APPLIED", "REFUNDED", "Exactly one refund exists.");
    return reconciled("CONFLICTED", "DUPLICATES", `${found} refunds exist.`);
  }
});

async function main() {
  payments.loseNextResponse(); // the refund goes through, but the response is lost

  const result = await runEffect(new InMemoryStore(), refundOrder, {
    identity: "refund-order-1001",
    intent: { orderId: "1001", amountCents: 5_000 }
  });

  console.log(result.evidenceState, result.disposition); // APPLIED COMPLETE
  console.log("refunds made:", payments.refundCount()); // refunds made: 1
}
```

`execute()` threw, but corrobo didn't treat that as "not refunded": it asked, found the refund, and finished. Call `runEffect` again with the same store and `identity` (say, from a retry loop) and it returns the recorded result instead of refunding again. A new refund needs a new identity.

`InMemoryStore` is for trying things out: it forgets everything when the process exits, so a restarted worker would see the refund as new. For anything where a restart or a second worker matters, use [`PostgresStore`](#in-production-postgresstore).

## What corrobo tells you

Two answers, kept separate on purpose: what the evidence shows, and what's safe to do next.

| Evidence | Meaning | Next step |
|---|---|---|
| `APPLIED` | The external system shows the intended effect | `COMPLETE` |
| `NOT_APPLIED` | It shows the effect didn't happen | `RETRY` if your policy allows and a late landing is ruled out, otherwise `INVESTIGATE` |
| `CONFLICTED` | The world changed under the plan (already refunded, stale version) | `REPLAN` with a new identity |
| `PENDING` | Accepted, not final yet | none yet: call again later; while it stays `PENDING`, corrobo re-checks instead of re-executing |
| `UNKNOWN` | It couldn't find out | `INVESTIGATE`, never a blind retry |

Plus `REVIEW`: an optional `authorize()` hook can require human sign-off *before* anything is executed; a reviewer can approve or reject.

**Requests can land late.** A timed-out request isn't undone, it's just unanswered, and it can still be applied after corrobo first looks. So when a failed call is followed by `NOT_APPLIED` while that request could still land, the `RETRY` comes with a `retryNotBefore` time (your declared `maxInFlightMs` after the attempt started): calling earlier does nothing, and calling after it makes corrobo check once more before it executes again. If you don't declare `maxInFlightMs`, the answer is `INVESTIGATE`. Details: [spec §O](docs/v0.1-spec.md#o-fencing-and-settlement-when-the-lock-is-not-enough).

## Test your contract

The runtime handles timing; whether the answers are right depends on your `observe()` and `reconcile()`. `verifyEffectContract()` (from `corrobo/testing`) runs your contract against a fake of your provider through a lost response, a lost request, a late landing, a failed read, a crash on either side of the write, concurrent callers, a reused identity and pending outcomes, and counts effects on the fake. It fails a blind retry, a failed read treated as "not applied", a `maxInFlightMs` shorter than your provider's real delay, and more. See [docs/testing-your-contract.md](docs/testing-your-contract.md) and `npm run conformance`.

## Idempotency keys and durable workflows

corrobo doesn't replace either one.

- **Idempotency keys:** if your provider supports them, use them, with the same key on every attempt of one operation. corrobo covers what they don't: APIs without keys, retries past the key's retention window, outcomes that settle asynchronously, and a recorded answer to "what happened?". The [Stripe example](examples/stripe-refund) does both.
- **Durable workflows** (Temporal, Trigger.dev, Inngest, Restate, Vercel Workflow, DBOS): they make *your process* resume and retry its steps. A step that crashes after its external write but before its result is recorded still runs again, which is why they all tell you to make steps idempotent. corrobo sits inside that step and establishes what the external system actually did.

> Durable execution restores your process. corrobo establishes what the external system actually did.

Longer answers to "why not just retry / use a key / use Temporal / use a queue / check first": **[docs/why-not-just.md](docs/why-not-just.md)**.

## In production: PostgresStore

```
npm install corrobo pg
```

```ts
import { Pool } from "pg";
import { PostgresStore } from "corrobo/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await PostgresStore.migrate(pool); // creates (or upgrades) the one table it needs; idempotent

const store = new PostgresStore(pool, { acknowledgePersistence: true });
```

- **Crash safety:** the attempt is recorded before `execute()` runs, so a restart never mistakes "attempted, outcome unknown" for "never attempted". It checks the external system first.
- **Concurrency:** callers racing on the same identity are coordinated with a Postgres advisory lock; different identities run in parallel. Each operation in flight holds one pool connection for its whole pass, so size `max` on your `Pool` for the operations you run at once, plus whatever else uses that pool.
- **Lost locks:** if the lock's connection dies while `execute()` is still running, version-checked writes keep the stale caller from overwriting anything, and the late-landing rule keeps the next caller from re-executing too early. Time windows use the database's clock, so skew between hosts doesn't matter.
- `acknowledgePersistence: true` is required on purpose: this store keeps what your contracts produce, with no automatic expiry (see [privacy](#privacy-and-data-handling)).
- **Upgrading from 0.2.x:** drain 0.2.x workers first, then run `migrate()` once. See [upgrade notes](docs/v0.1-spec.md#o-fencing-and-settlement-when-the-lock-is-not-enough).

## Guarantees

- **[Failure matrix](docs/failure-matrix.md):** every failure point corrobo handles — lost responses, late landings, crashes at each boundary, failed read-backs, races, lost locks, review, identity misuse, persistence — with what's actually true, what corrobo records, whether `execute()` runs again, and the test that proves each row. The build fails if a cited test disappears.
- **[Guarantees, in questions and answers](docs/guarantees.md):** what happens after a timeout, a crash, a race; what's persisted; what corrobo does not promise.

In short: with `PostgresStore` and a contract whose `observe()` tells the truth, corrobo will not *itself* cause a blind duplicate in any case in the matrix. It does **not** give you exactly-once execution in general, can't see writes made outside it, and is only as honest as your `observe()`: a lookup that can't prove absence must return `UNKNOWN`, not `NOT_APPLIED`.

corrobo is not a workflow engine, queue, scheduler, or agent framework. It doesn't schedule when you call it again.

## Privacy and data handling

corrobo has no telemetry and no hosted service, and sends no application data to its maintainer. Your effects go to the systems your code already calls; `PostgresStore` writes only to the database you give it (local or remote — your choice).

- **`InMemoryStore`** stays inside the process: no persistence, no network I/O of its own.
- **`PostgresStore`** persists what your contracts produce: intent, transport evidence, observations, reason metadata and error *messages*, with no automatic expiry. Retention and deletion are yours.
- **Raw thrown error objects are never persisted** by `PostgresStore` (they often carry request headers and response bodies). Only the message string is kept, so don't put secrets in error messages.
- corrobo doesn't inspect or filter the data you put in these fields; what goes in is up to you.

Two things it would be wrong to claim: that corrobo never handles personal data (it holds whatever you pass it), and that data never leaves your machine (it does whenever your database or your own `execute()`/`observe()` are remote). More detail: [spec §J](docs/v0.1-spec.md#j-privacy-and-data-persistence).

## Examples

- **[`examples/timeout-after-write`](examples/timeout-after-write)** — `npm run demo`, shown above. Its tests also cover a request lost *before* commit and one that lands *late*.
- **[`examples/quickstart`](examples/quickstart)** — `npm run quickstart`, the code above.
- **[`examples/conformance`](examples/conformance)** — `npm run conformance`: the conformance harness against a reference fake, passing and then failing on a too-short `maxInFlightMs`.
- **[`examples/stripe-refund`](examples/stripe-refund)** — Stripe refunds with idempotency keys and corrobo together, including the key's retention window. `npm run example:stripe` runs against a fake Stripe (no network); an optional test-mode smoke script needs `sk_test_` credentials.
- **[`examples/rest`](examples/rest)** — a plain HTTP order cancellation: conflict, `PENDING`, `UNKNOWN`. `npm run example:rest`.
- **[`examples/jev-refund`](examples/jev-refund)** — a model-based risk judgment feeding `authorize()` before execution, while corrobo alone decides what happened after. [Write-up](docs/jev-integration.md). `npm run example:jev` (no API key needed).

## Agent Skill

[`skills/corrobo`](skills/corrobo) is an optional skill for coding agents (Claude Code, Codex): it helps find consequential side effects and unsafe retries in a codebase and draft contracts for them. It's an adoption aid, not the safety layer; the library works the same with or without it.

## Contributing

```
npm install
npm run typecheck
npm test            # Postgres suites run when CORROBO_TEST_DATABASE_URL is set
npm run demo
```

```
createdb corrobo_dev_test
CORROBO_TEST_DATABASE_URL=postgres://localhost:5432/corrobo_dev_test npm test
```

Issues and PRs are welcome, especially real-world failure cases and provider behavior you've seen. The full technical contract is in [docs/v0.1-spec.md](docs/v0.1-spec.md). Security reports: [SECURITY.md](SECURITY.md).

MIT licensed.
