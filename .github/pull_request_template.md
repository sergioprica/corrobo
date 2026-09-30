## What and why

<!-- The failure case or problem this addresses. -->

## How it's proven

<!-- Tests added or changed. For behavior after a timeout/crash/race/failed read: effects counted on a fake of the external system, not from corrobo's record. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass (with `CORROBO_TEST_DATABASE_URL` set if you touched stores or recovery)
- [ ] docs/failure-matrix.md updated (row + test citation) if behavior changed
- [ ] CHANGELOG.md updated if the public API or behavior changed
- [ ] No new runtime dependency, telemetry, logging or network call in `src/`
- [ ] Docs don't claim anything a test doesn't show
