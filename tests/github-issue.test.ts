import { describe, expect, it } from "vitest";
import { formatConformanceReport, verifyEffectContract } from "../src/testing";
import {
  brokenRetryOnEmptySearchContract,
  createGitHubIssueContract,
  fakeGitHubIssues,
  markerFor
} from "../examples/github-issue/contract";

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

describe("GitHub issue creation example (search cannot prove absence -> UNKNOWN, not NOT_APPLIED)", () => {
  it("passes the conformance harness: embeds operation marker, marks search non-authoritative, and never duplicates", async () => {
    const { client, target } = fakeGitHubIssues({ lateLandingMs: 2_000 });
    const report = await verifyEffectContract({
      contract: createGitHubIssueContract(client),
      target,
      intent,
      otherIntent
    });

    expect(report.passed, formatConformanceReport(report)).toBe(true);

    const lostBeforeCommit = report.results.find((r) => r.scenario === "request-lost-before-commit")!;
    expect(lostBeforeCommit.status).toBe("pass");
    expect(lostBeforeCommit.effects).toBe(0);
    expect(lostBeforeCommit.evidenceState).toBe("UNKNOWN");
    expect(lostBeforeCommit.disposition).toBe("INVESTIGATE");

    const lateLanding = report.results.find((r) => r.scenario === "late-landing")!;
    expect(lateLanding.status).toBe("pass");
    expect(lateLanding.effects).toBe(1);
    expect(lateLanding.disposition).toBe("INVESTIGATE");
  });

  it("embeds the operation identity marker in the created issue body and observes with authoritative: false", async () => {
    const { client } = fakeGitHubIssues();
    const contract = createGitHubIssueContract(client);
    const identity = { id: "gh-issue-marker-check", operationType: contract.operationType };

    const created = await contract.execute({ intent, identity, attemptNumber: 1 });
    expect(created.body).toContain(markerFor(identity.id));

    const observation = await contract.observe({
      intent,
      identity,
      transport: { ok: true, evidence: created },
      attemptStartedAt: new Date().toISOString()
    });
    expect(observation.status).toBe("observed");
    if (observation.status === "observed") {
      expect(observation.authoritative).toBe(false);
      expect(observation.data.matches).toHaveLength(1);
    }
  });

  it("catches the broken variant that maps 'not found -> NOT_APPLIED' and retries: with search lagging behind writes, it posts a second issue", async () => {
    const { client, target } = fakeGitHubIssues({ lateLandingMs: 2_000, searchLagReads: 2 });
    const report = await verifyEffectContract({
      contract: brokenRetryOnEmptySearchContract(client, 500),
      target,
      intent,
      otherIntent
    });

    expect(report.passed).toBe(false);

    const duplicated = report.results.filter((r) => r.status === "fail" && r.effects === 2);
    expect(duplicated.length, formatConformanceReport(report)).toBeGreaterThan(0);

    const lostResponse = report.results.find((r) => r.scenario === "response-lost-after-commit")!;
    expect(lostResponse.status).toBe("fail");
    expect(lostResponse.effects).toBe(2);

    const lateLanding = report.results.find((r) => r.scenario === "late-landing")!;
    expect(lateLanding.status).toBe("fail");
    expect(lateLanding.effects).toBe(2);
  });
});
