# Jev + corrobo integration

Example integration with [TypeSafe AI](https://typesafe.ai)'s **Jev**, a "System One" model that
answers bounded, typed questions (`Choice`, `Score`, `Noul`) with probabilities instead of
prose. See [`examples/jev-refund`](../examples/jev-refund). This is not an official TypeSafe
integration, and corrobo has no partnership or affiliation with TypeSafe AI.

corrobo is model/framework-independent — nothing here is a first-class corrobo feature. Jev is
used as a concrete, current example of a more general pattern: a probabilistic decision system
feeding deterministic application policy, which feeds corrobo's execution/reconciliation
lifecycle.

## 1. What Jev contributes

A fast, cheap, pre-execution judgment: given some state and a typed question, Jev returns a
probability (`Noul`), a scored position on a rubric (`Score`), or a selection among labeled
options (`Choice`) — never a decision, and never a claim about whether a side effect happened.

## 2. What corrobo contributes

Everything after a decision to attempt (or not attempt) an action: durable operation identity,
`execute()`/`observe()`/`reconcile()`, evidence states, and a conservative recovery disposition.
Corrobo has no knowledge of Jev, TypeSafe, or any other judgment system — see
[`src/core/types.ts`](../src/core/types.ts).

## 3. Architecture

```
application state
  |
  v
Jev bounded judgment            (Choice / Score / Noul — probabilities only)
  |
  v
deterministic policy            (ordinary application code; thresholds live here)
  |
  v
corrobo authorize()             (requiresReview: true | false)
  |
  v
execute()                       (the real side effect — only if not requiring review)
  |
  v
authoritative observe()         (queries the system of record, NOT Jev)
  |
  v
reconcile()
  |
  v
evidence state + recovery disposition   (APPLIED/NOT_APPLIED/CONFLICTED/PENDING/UNKNOWN
                                          -> COMPLETE/RETRY/REPLAN/REVIEW/INVESTIGATE)
```

## 4. Why the responsibilities stay separate

Jev is fast and cheap specifically because it is not a general reasoning system — it returns a
calibrated probability over a bounded question, evaluated once, before anything has happened in
the world. It has no privileged access to the outcome of an action it hasn't seen executed, and
no mechanism to observe a third-party system's authoritative state after the fact. Asking it "did
this probably succeed?" after an ambiguous transport failure would be asking a pre-execution
judgment model to do post-execution reconciliation — exactly the class of mistake corrobo exists
to prevent (see the [safety model](../skills/corrobo/references/safety-model.md)). Keeping the
two separate means each does only what it has actual evidence for.

## 5. `authorize()` example

See [`examples/jev-refund/contract.ts`](../examples/jev-refund/contract.ts) for the full contract.
The relevant shape:

```ts
async authorize(intent) {
  const judgment = await judgmentProvider.assess({
    requestText: intent.requestText,
    amountCents: intent.amountCents
  });

  if (judgment.risk.confidence < CONFIDENCE_THRESHOLD) {
    return { requiresReview: true, reason: { code: "JEV_LOW_CONFIDENCE", summary: "...", metadata: auditRecord } };
  }
  if (judgment.risk.score > RISK_THRESHOLD) {
    return { requiresReview: true, reason: { code: "JEV_HIGH_RISK", summary: "...", metadata: auditRecord } };
  }
  return { requiresReview: false };
}
```

`authorize()` is corrobo's existing, general-purpose pre-execution policy gate (see
`EffectContract.authorize` in [`src/core/types.ts`](../src/core/types.ts)) — this example does
not add a new hook or a Jev-specific adapter to corrobo's public API.

## 6. Deterministic thresholds

`CONFIDENCE_THRESHOLD` and `RISK_THRESHOLD` are ordinary constants in application code (see
`contract.ts`), not something Jev configures or returns. Jev's score/confidence are **input** to
this policy; the policy authority is the deterministic code that reads them. This is what makes
the outcome auditable and reproducible independent of anything the model does.

## 7. `REVIEW` behavior

When `authorize()` returns `requiresReview: true`, corrobo's runtime sets the operation to
`AWAITING_REVIEW` and returns disposition `REVIEW` **without ever calling `execute()`**. The
[example demo](../examples/jev-refund/demo.ts) (scenario B) proves this directly: it asserts the
fake refund ledger's `createdRefundCount` is unchanged while an operation is awaiting review, and
only increments after an explicit approval (`reviewDecision: { decision: "approved", reviewer }`).

## 8. Authoritative observation after execution

Once `execute()` has been attempted (or attempted ambiguously — see scenario C in the example),
Jev is never consulted again for that operation. `observe()` in
[`contract.ts`](../examples/jev-refund/contract.ts) performs a keyed, idempotent read-back
against the refund ledger — the same authoritative-evidence principle corrobo's Stripe example
uses against Stripe's own API. corrobo's runtime itself only ever calls `authorize()` once per
operation, before the first attempt (see `runCoordinated` in
[`src/core/runtime.ts`](../src/core/runtime.ts)) — there is no code path that re-invokes it during
observation, re-observation, or crash recovery.

If authoritative state cannot establish the outcome (the read-back itself fails or is
inconclusive), corrobo reports `UNKNOWN` → `INVESTIGATE`, honestly, rather than asking Jev to
convert that ambiguity into false certainty.

## 9. Privacy and data boundary

**Corrobo itself** has no telemetry and no hosted backend, and does not send application data to
corrobo or its maintainer (see the [main README](../README.md#privacy-and-data-handling)).

**A live Jev integration is different**: it sends whatever state your application code chooses
to include to TypeSafe's API. This example sends only the minimum semantic state needed for the
judgment — the free-text request and the amount (see
[`live-judgment-provider.ts`](../examples/jev-refund/live-judgment-provider.ts)) — never customer
identifiers, payment instruments, or the ledger's own provider payloads. Corrobo does not control,
and makes no claims about, TypeSafe's retention or data-handling policy; see TypeSafe's own
current documentation at [docs.typesafe.ai](https://docs.typesafe.ai) for that.

## 10. Model version / auditability

TypeSafe's `jev-latest` alias resolves to a specific versioned model (e.g. `jev-1.13.0`) that
moves forward as new releases ship, which can shift calibrated thresholds out from under an
application that has tuned against a specific version's behavior. This example pins
`jev-1.13.0` by default (overridable via `TYPESAFE_JEV_MODEL`) rather than using the moving
alias, for reproducibility — see
[`live-judgment-provider.ts`](../examples/jev-refund/live-judgment-provider.ts). If you use
`jev-latest` instead, be aware answers can change between calls as TypeSafe ships new releases;
that tradeoff is TypeSafe's alias mechanism, not something corrobo introduces.

When a response resolves a model/version, this example retains a small audit record in
`authorize()`'s `reason.metadata`: the resolved model, the bounded probabilities, the
deterministic thresholds applied, and the resulting `requiresReview` decision. This is ordinary
`ReasonCode.metadata` — corrobo adds no new schema for it — and deliberately excludes the raw
provider response, headers, or API key.

## 11. Running the mock example

No account or API key required:

```
npm run example:jev
```

Runs entirely against `MockRefundJudgmentProvider` (a deterministic, in-process stand-in for
Jev) and `FakeRefundLedger` (a deterministic, in-process stand-in for a refund system). No
network calls. This is also what the automated test suite
([`tests/jev-refund.test.ts`](../tests/jev-refund.test.ts)) exercises.

## 12. Running the optional live example

Requires a real TypeSafe API key. Never commit it; it is read only from the environment and never
logged, persisted, or included in corrobo state:

```
TYPESAFE_API_KEY=sk_... npm run example:jev:live
```

With no key set, the script prints a message and exits cleanly — this is what CI and `npm test`
do, and is the expected/normal path. Only `authorize()`'s judgment is live; the refund side
effect itself still runs against the local fake ledger, so this never touches a real payment
provider.
