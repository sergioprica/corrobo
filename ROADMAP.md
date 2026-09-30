# Roadmap

corrobo does one job: resolving external writes whose outcome is unclear after a timeout or crash. The roadmap is deliberately driven by evidence from people using it, not by features that seem nice. Nothing below is promised; each item says what would make it worth doing.

## How decisions are made

Evidence, strongest first:

1. Someone using corrobo in a codebase the maintainer didn't write.
2. External pull requests, issues with real reproductions, and integrations built by others.
3. References from other projects or maintainers.
4. Repeat installs and packages that depend on corrobo.
5. Technical discussion (reviews, threads, questions).
6. Stars, likes and impressions — noted, not decisive.

`scripts/adoption-snapshot.sh` records the public signals (no telemetry; corrobo never reports anything about its users).

## Now (0.3.x)

- Get technical critique of the failure matrix and the conformance harness from people who work on retries, idempotency and durable execution, and fix what they find.
- Provider examples that exercise the hard cases — [#14](https://github.com/vidithsalla/corrobo/issues/14) (Linear, a lookup that can prove absence), [#15](https://github.com/vidithsalla/corrobo/issues/15) (GitHub issues, a search that can't), [#16](https://github.com/vidithsalla/corrobo/issues/16) (Stripe through the harness). Good first contributions.
- Bug fixes and doc corrections, especially anything that overstates a guarantee.

## Next, if evidence supports it (0.4 candidates)

| Candidate | Worth doing when |
|---|---|
| Conformance harness for custom stores ([#17](https://github.com/vidithsalla/corrobo/issues/17)) | Someone is building or maintaining a non-Postgres store. |
| Hide store write methods from the public surface | Evidence of misuse, or a store author asks for a cleaner interface; it's a breaking change for custom stores, so batch it with other breaking changes. |
| A second workflow-engine example (Temporal activity, Vercel Workflow step, Restate `ctx.run`, Inngest `step.run`) | Users of that engine ask, or its maintainers want one. Each must run in CI without a cloud account. |
| Richer diagnostics on results (why an operation is `INVESTIGATE`, what to check) | Operators report that `UNKNOWN`/`INVESTIGATE` outcomes are hard to act on. |

## Later, only with more evidence (0.5+)

| Candidate | Worth doing when |
|---|---|
| A CLI that runs the conformance harness or audits a codebase for unsafe retries | The programmatic harness is in real use and people ask for a CLI. |
| Another durable store (e.g. SQLite, DynamoDB) | Real users need it and can help test it. |
| Shared contract recipes for common providers | Several independent users write contracts for the same provider. |

## Not planned

These would make corrobo bigger without making its one job better: a workflow engine, scheduler or queue; an agent framework; a hosted service, dashboard or control plane; telemetry of any kind; a connector marketplace; a Python port without clear demand. If you think one of these belongs here, open an issue with the use case.
