# Contributing to corrobo

Thanks for considering it. corrobo is small on purpose: one job (resolving external writes whose outcome is unclear), done carefully. The most useful contributions make that job more correct, easier to adopt, or better documented — real failure cases from providers you use are especially welcome.

Before changing runtime code, read [docs/architecture.md](docs/architecture.md): it lists the safety invariants, where each is enforced, and which tests prove it.

## Setup

```
npm install
npm run typecheck
npm test
```

The Postgres suites run when `CORROBO_TEST_DATABASE_URL` points at a scratch database (they're skipped otherwise, and CI always runs them):

```
createdb corrobo_dev_test
CORROBO_TEST_DATABASE_URL=postgres://localhost:5432/corrobo_dev_test npm test
```

Also useful: `npm run demo`, `npm run quickstart`, `npm run conformance`, and the examples (`npm run example:rest`, `example:stripe`, `example:jev`; the DBOS example has its own package in [`examples/dbos-workflow`](examples/dbos-workflow)).

## What a good PR looks like

- **Tests first for behavior.** A change to what corrobo does after a timeout, crash, race or failed read needs a test that fails without it. Count external effects on a fake of the external system, never from corrobo's own record.
- **Keep the failure matrix true.** If behavior in [docs/failure-matrix.md](docs/failure-matrix.md) changes, update the row and its test citation. `tests/failure-matrix-doc.test.ts` fails if a cited test is renamed or removed; `tests/docs-links.test.ts` fails on broken links or anchors in the README, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and `docs/`.
- **Claims match code.** Don't describe behavior in docs that no test shows, and never claim exactly-once, "safe", or that corrobo never handles personal data.
- **No new runtime dependencies** without discussing it in an issue first. corrobo has zero; `pg` is an optional peer used only through the pool the caller passes in.
- **No telemetry, logging or network calls** in `src/` — there's a test for that too.
- **Public API changes** go in [CHANGELOG.md](CHANGELOG.md) under the next version, with upgrade steps if anything breaks.
- `npm run typecheck` must pass (it uses the project's TypeScript). If your editor runs TypeScript 6 (VS Code bundles it), it should show no errors either.

## Common contributions

**An example for a real provider.** Put it in `examples/<name>/` with a contract, a deterministic fake of the provider (no network or credentials in CI), a runnable script, and tests. Say honestly what the provider guarantees: if its lookup can't prove absence (a search, an eventually consistent list), the contract must return `UNKNOWN`, not `NOT_APPLIED`. Run it through the [conformance harness](docs/testing-your-contract.md). Live-credential scripts are fine as opt-in extras, never in CI.

**A store.** Implement `EffectStore` (see `src/core/store.ts`): same-identity locking, and version-checked writes that throw `StoreConflictError` and change nothing on a mismatch; add `now()` if the store is shared across hosts. Run the existing store and fencing tests against it.

**A conformance scenario.** Add it to `src/testing/conformance.ts`, prove a correct contract passes it, and add a known-bad contract to `tests/conformance-known-bad.test.ts` that only the new scenario catches.

**Docs.** Corrections are always welcome, especially where the docs overstate something.

## Reporting bugs and security issues

Bugs: open an issue with the template. The most useful reports include the sequence of events (what the external system did, what corrobo recorded, whether `execute()` ran again), the corrobo version, and which store.

Security issues — including anything that could cause a duplicate effect, bypass same-identity coordination, or persist data corrobo shouldn't — please report privately: [Report a vulnerability](https://github.com/vidithsalla/corrobo/security/advisories/new). See [SECURITY.md](SECURITY.md).

## Review and merging

`main` is protected: changes go through a pull request with passing CI and resolved review threads. Expect questions about failure cases and how a claim is proven; that's the core of the project, not nitpicking.

By contributing you agree your contribution is licensed under the [MIT License](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
