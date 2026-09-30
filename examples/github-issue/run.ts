/**
 * Runs corrobo's conformance harness against the GitHub issue creation contract (where search
 * cannot prove absence, so "not found" maps to UNKNOWN), then against the broken variant that
 * maps "not found -> NOT_APPLIED" and retries while search lags behind writes.
 *
 *   npx tsx examples/github-issue/run.ts
 */
import { formatConformanceReport, verifyEffectContract } from "corrobo/testing";
import {
  brokenRetryOnEmptySearchContract,
  createGitHubIssueContract,
  fakeGitHubIssues
} from "./contract";

const intent = {
  repo: "acme/widgets",
  title: "Production checkout timeout",
  body: "Investigate 504 gateway timeouts on POST /checkout."
};

const otherIntent = {
  repo: "acme/widgets",
  title: "Different issue title",
  body: "Different issue body."
};

async function main() {
  const good = fakeGitHubIssues({ lateLandingMs: 2_000 });
  const passing = await verifyEffectContract({
    contract: createGitHubIssueContract(good.client),
    target: good.target,
    intent,
    otherIntent
  });
  console.log(formatConformanceReport(passing));

  console.log("\n--- broken variant: maps 'not found -> NOT_APPLIED' and retries while search lags behind writes ---\n");
  const lagging = fakeGitHubIssues({ lateLandingMs: 2_000, searchLagReads: 2 });
  const failing = await verifyEffectContract({
    contract: brokenRetryOnEmptySearchContract(lagging.client, 500),
    target: lagging.target,
    intent,
    otherIntent
  });
  console.log(formatConformanceReport(failing));

  if (!passing.passed || failing.passed) {
    process.exitCode = 1;
  }
}

main();
