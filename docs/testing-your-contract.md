# Testing your contract

corrobo's runtime handles the timing — reserve before the call, observe after, don't retry while a request could still land. Whether the result is right still depends on *your* contract: does `observe()` really look up this operation, does `reconcile()` treat a failed read as unknown, is `maxInFlightMs` long enough for your provider? `verifyEffectContract()` checks that, in your own test suite.

```ts
import { verifyEffectContract, formatConformanceReport } from "corrobo/testing";

const report = await verifyEffectContract({
  contract: refundContract(fakePayments.client), // your real contract, wired to a fake
  target: fakePayments.target,                   // the fake, with fault hooks (below)
  intent: { orderId: "1001", amountCents: 5_000 },
  otherIntent: { orderId: "1001", amountCents: 9_000 } // optional: checks identity reuse is rejected
});

console.log(formatConformanceReport(report));
expect(report.passed).toBe(true);
```

A runnable version, with a reference fake: [`examples/conformance`](../examples/conformance) (`npm run conformance`).

## What it checks

Each scenario starts from a reset target and counts effects **on your fake** — never from corrobo's own record. Every scenario also fails if more than one effect happens, or if the final answer is `APPLIED` while your fake has no effect for that operation.

| Scenario | What happens | Passes when |
|---|---|---|
| `normal` | Nothing goes wrong | 1 effect, `APPLIED`, one `execute()` |
| `response-lost-after-commit` | The write lands, the response is lost | 1 effect, `APPLIED`, no second `execute()` |
| `request-lost-before-commit` | The write never reaches the target | 1 effect and `APPLIED` after the window, or 0 and `INVESTIGATE` if no `maxInFlightMs` |
| `late-landing` | The write is dropped, then lands `target.lateLandingMs` later | 1 effect; fails if `maxInFlightMs` is shorter than how late your target can land a request |
| `read-fails-after-lost-response` | The write lands, the response is lost, and the read fails | First answer is `UNKNOWN` (a failed read proves nothing); 1 effect |
| `crash-after-effect-before-save` | The process dies after the write, before saving the outcome | After restart: `APPLIED`, no second `execute()` |
| `crash-before-execute` | The process dies after reserving the attempt | After restart: 1 effect and `APPLIED`, or 0 and `INVESTIGATE` |
| `concurrent-same-identity` | Two callers run the same operation at once | 1 effect, one `execute()` |
| `identity-reuse-different-intent` | The same id is reused for a different intent | It throws; nothing changes at the target |
| `pending-then-settled` / `-rejected` | The target accepts the write as pending | No second `execute()` while pending; settles to 1 effect, or a rejection retries at most once |
| `neighbor-effect-isolation` | Another operation's effect already exists | `observe()` doesn't mistake it for this operation's |

Time windows pass on a virtual clock — nothing sleeps — and crashes are simulated at store writes, with records surviving the way they would in `PostgresStore`.

## Writing the fake

The fake is the part only you can write, and the report is only as true as it is. It needs to behave like your real provider where it matters: does it deduplicate? can a read fail or lag? how late can a dropped request still be applied? Implement `ConformanceTarget`:

```ts
interface ConformanceTarget {
  lateLandingMs?: number; // how late a dropped request can land at your provider; omit to skip late-landing
  reset(): void | Promise<void>;
  effectCount(operationId: string): number | Promise<number>;
  faults: {
    loseResponseAfterCommit(): void;
    loseRequestBeforeCommit(): void;
    holdCommit(): () => void | Promise<void>; // returns "land it now"
    failNextRead(): void;
    acceptAsPending?(): { settle(): void | Promise<void>; reject(): void | Promise<void> };
  };
}
```

[`examples/conformance/fake-ledger.ts`](../examples/conformance/fake-ledger.ts) is a complete reference: the fake is about 75 lines, plus a correct contract for it. Scenarios your target or options can't drive are reported as `skipped`, with the reason.

## What a pass does and doesn't mean

A pass means: **your contract passed the configured corrobo conformance scenarios against the fake you supplied.** It doesn't prove anything about the real provider, about scenarios not listed above, or about a fake that doesn't match reality. It is a way to catch the common mistakes before they reach production:

- deciding from `execute()`'s error instead of reading the target (a blind retry);
- treating a failed or weak read as "not applied";
- a `maxInFlightMs` shorter than the provider's real delay, or `0` without provider deduplication;
- mapping "pending" to "not applied";
- claiming `APPLIED` without a successful read;
- an `observe()` that isn't scoped to its own operation.

corrobo's own test suite runs each of those broken contracts through the harness and requires it to fail them ([`tests/conformance-known-bad.test.ts`](../tests/conformance-known-bad.test.ts)).
