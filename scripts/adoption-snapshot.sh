#!/usr/bin/env bash
# Prints a dated snapshot of corrobo's public adoption signals, strongest evidence first.
# Uses public GitHub/npm/deps.dev data plus the repo's own aggregate GitHub traffic totals
# (which need repo access via `gh auth`). corrobo itself never reports anything about its users;
# this only reads counts GitHub and the package registries already publish to the maintainer.
#   scripts/adoption-snapshot.sh >> ~/corrobo-adoption-log.md
set -euo pipefail
REPO=vidithsalla/corrobo
PKG=corrobo
ME=$(gh api user --jq .login 2>/dev/null || echo "")
echo "## $(date -u +%Y-%m-%d)"
echo "- external issues (not by maintainer): $(gh issue list -R $REPO --state all --limit 500 --json author --jq "[.[] | select(.author.login != \"$ME\" and (.author.login | test(\"dependabot\") | not))] | length")"
echo "- external PRs (not by maintainer or bots): $(gh pr list -R $REPO --state all --limit 500 --json author --jq "[.[] | select(.author.login != \"$ME\" and (.author.login | test(\"dependabot|github-actions\") | not))] | length")"
echo "- contributors: $(gh api repos/$REPO/contributors --jq 'length')"
# npm has no public dependents API; deps.dev (Google's open-source dependency index) does, per version.
LATEST=$(npm view $PKG version 2>/dev/null || echo "")
echo "- dependents of $PKG@$LATEST (deps.dev, direct / all): $(curl -s "https://api.deps.dev/v3alpha/systems/npm/packages/$PKG/versions/$LATEST:dependents" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('directDependentCount','?'), '/', d.get('dependentCount','?'))" 2>/dev/null || echo n/a)"
echo "- npm downloads last week / month: $(curl -s https://api.npmjs.org/downloads/point/last-week/$PKG | python3 -c 'import json,sys; print(json.load(sys.stdin).get("downloads","?"))') / $(curl -s https://api.npmjs.org/downloads/point/last-month/$PKG | python3 -c 'import json,sys; print(json.load(sys.stdin).get("downloads","?"))') (includes mirrors, CI and the maintainer's own installs)"
echo "- repo views / unique (14d): $(gh api repos/$REPO/traffic/views --jq '"\(.count) / \(.uniques)"' 2>/dev/null || echo n/a)"
echo "- clones / unique (14d): $(gh api repos/$REPO/traffic/clones --jq '"\(.count) / \(.uniques)"' 2>/dev/null || echo n/a)"
echo "- top referrers (14d): $(gh api repos/$REPO/traffic/popular/referrers --jq '[.[] | "\(.referrer) \(.uniques)"] | join(", ")' 2>/dev/null || echo n/a)"
echo "- stars / forks / watchers: $(gh api repos/$REPO --jq '"\(.stargazers_count) / \(.forks_count) / \(.subscribers_count)"')"
echo "- latest npm version: $(npm view $PKG version 2>/dev/null || echo n/a)"
