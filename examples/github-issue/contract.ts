import { defineContract, observed, reconciled } from "corrobo";
import type { ConformanceTarget } from "corrobo/testing";

export interface CreateIssueIntent {
  repo: string;
  title: string;
  body: string;
}

export interface CreatedIssue {
  number: number;
  repo: string;
  title: string;
  body: string;
  htmlUrl: string;
}

export interface GitHubIssueObservation {
  matches: CreatedIssue[];
}

export interface GitHubIssuesClientLike {
  createIssue(params: { repo: string; title: string; body: string }): Promise<CreatedIssue>;
  searchIssues(params: { repo: string; query: string }): Promise<CreatedIssue[]>;
}

/**
 * Deterministic marker derived from the Corrobo operation identity and embedded in the issue
 * body so a later search can look for this logical operation's effect.
 */
export function markerFor(operationId: string): string {
  return `<!-- corrobo:operation=${operationId} -->`;
}

export function bodyWithMarker(body: string, operationId: string): string {
  return `${body}\n\n${markerFor(operationId)}`;
}

/**
 * Deterministic fake of GitHub's issue creation + search endpoints.
 *
 * Creating a GitHub issue has no idempotency key, and GitHub's issue search index is eventually
 * consistent: a newly created issue can lag behind writes before showing up in search results.
 *
 * - `lateLandingMs`: how long a dropped/in-flight request (`holdCommit`) can take before it
 *   lands and becomes visible in search.
 * - `searchLagReads`: optional number of initial `searchIssues()` calls after a write commits
 *   during which the newly created issue has not yet been indexed by search (while already
 *   existing in the repository).
 */
export function fakeGitHubIssues(options: { lateLandingMs?: number; searchLagReads?: number } = {}) {
  const lateLandingMs = options.lateLandingMs ?? 2_000;
  const defaultSearchLagReads = options.searchLagReads ?? 0;

  interface StoredIssue {
    issue: CreatedIssue;
    remainingLagReads: number;
  }

  let issues: StoredIssue[] = [];
  let mode: "normal" | "loseResponse" | "loseRequest" | "hold" = "normal";
  let heldWrite: (() => void) | null = null;
  let failRead = false;
  let nextNumber = 1;

  const commitIssue = (params: { repo: string; title: string; body: string }, lagReads: number): CreatedIssue => {
    const number = nextNumber++;
    const issue: CreatedIssue = {
      number,
      repo: params.repo,
      title: params.title,
      body: params.body,
      htmlUrl: `https://github.com/${params.repo}/issues/${number}`
    };
    issues.push({ issue, remainingLagReads: lagReads });
    return issue;
  };

  const client: GitHubIssuesClientLike = {
    async createIssue(params) {
      const current = mode;
      mode = "normal";

      if (current === "loseRequest") {
        throw new Error("ECONNRESET before POST /repos/:owner/:repo/issues reached GitHub");
      }

      if (current === "hold") {
        heldWrite = () => {
          commitIssue(params, 0);
        };
        throw new Error("timeout waiting for GitHub issue creation response (write still in flight)");
      }

      const created = commitIssue(params, defaultSearchLagReads);
      if (current === "loseResponse") {
        throw new Error("socket hang up after GitHub created the issue");
      }
      return created;
    },

    async searchIssues(params) {
      if (failRead) {
        failRead = false;
        throw new Error("GitHub search API 503 Service Unavailable");
      }
      const visible: CreatedIssue[] = [];
      for (const entry of issues) {
        if (entry.issue.repo !== params.repo || !entry.issue.body.includes(params.query)) {
          continue;
        }
        if (entry.remainingLagReads > 0) {
          entry.remainingLagReads -= 1;
          continue;
        }
        visible.push(entry.issue);
      }
      return visible;
    }
  };

  const target: ConformanceTarget = {
    lateLandingMs,
    reset() {
      issues = [];
      mode = "normal";
      heldWrite = null;
      failRead = false;
      nextNumber = 1;
    },
    effectCount(operationId: string) {
      const marker = markerFor(operationId);
      return issues.filter((entry) => entry.issue.body.includes(marker)).length;
    },
    faults: {
      loseResponseAfterCommit: () => {
        mode = "loseResponse";
      },
      loseRequestBeforeCommit: () => {
        mode = "loseRequest";
      },
      holdCommit() {
        mode = "hold";
        heldWrite = null;
        return () => {
          const release = heldWrite;
          heldWrite = null;
          release?.();
        };
      },
      failNextRead: () => {
        failRead = true;
      }
    }
  };

  return { client, target };
}

/**
 * Correct contract for GitHub issue creation (failure matrix row 3.4 / 11.4):
 *
 * - Embeds a deterministic marker derived from `identity.id` in the issue body.
 * - Observes by searching for that marker with `authoritative: false`.
 * - Maps `"found"` (1 match) to `APPLIED`, and `"not found"` (0 matches) to `UNKNOWN` — NEVER
 *   `NOT_APPLIED` — because GitHub search is eventually consistent and cannot prove an issue
 *   does not exist yet.
 * - Uses `retryPolicy: { maxAttempts: 1, retryOnNotApplied: false }` (and no `maxInFlightMs`):
 *   since search cannot prove absence, the contract never retries automatically.
 */
export function createGitHubIssueContract(client: GitHubIssuesClientLike) {
  return defineContract<CreateIssueIntent>()({
    operationType: "github/create-issue",
    capabilities: {
      nativeIdempotency: false,
      callerGeneratedIdentity: false,
      optimisticConcurrency: false,
      convergence: false
    },
    retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
    execute: ({ intent, identity }) =>
      client.createIssue({
        repo: intent.repo,
        title: intent.title,
        body: bodyWithMarker(intent.body, identity.id)
      }),
    observe: async ({ intent, identity }) => {
      const matches = await client.searchIssues({
        repo: intent.repo,
        query: markerFor(identity.id)
      });
      return observed({ matches }, { source: "github:search.issues", authoritative: false });
    },
    reconcile: ({ observation }) => {
      if (observation.status !== "observed") {
        return reconciled(
          "UNKNOWN",
          "SEARCH_UNAVAILABLE",
          "GitHub issue search failed; cannot determine whether the issue was created."
        );
      }

      const { matches } = observation.data;
      if (matches.length === 1) {
        return reconciled(
          "APPLIED",
          "ISSUE_FOUND_BY_MARKER",
          "Found the created GitHub issue carrying this operation's marker.",
          { issueNumber: matches[0].number }
        );
      }

      if (matches.length > 1) {
        return reconciled(
          "CONFLICTED",
          "DUPLICATE_ISSUES_FOUND",
          `Found ${matches.length} GitHub issues carrying this operation's marker.`,
          { issueNumbers: matches.map((m) => m.number) }
        );
      }

      // Why UNKNOWN and NOT NOT_APPLIED (failure matrix row 3.4):
      // GitHub issue creation has no idempotency key, and the only way to check afterwards is
      // search/list, which is eventually consistent and lags behind writes. An empty search
      // result ("not found") cannot prove the issue was not created — the POST may have
      // succeeded (or still be in flight) while the search index has not caught up yet.
      // Returning NOT_APPLIED here would tell corrobo absence is proven and allow a retry that
      // posts a duplicate issue.
      return reconciled(
        "UNKNOWN",
        "SEARCH_CANNOT_PROVE_ABSENCE",
        "No issue with this operation's marker appeared in search, but search is eventually consistent and cannot prove absence."
      );
    }
  });
}

/**
 * Broken variant for contrast: mistakenly treats an empty search ("not found") as `NOT_APPLIED`
 * and enables retries (`retryOnNotApplied: true` with a `maxInFlightMs` window). When the
 * search index lags behind writes, the harness catches this variant posting a second issue.
 */
export function brokenRetryOnEmptySearchContract(client: GitHubIssuesClientLike, maxInFlightMs = 500) {
  const correct = createGitHubIssueContract(client);
  return defineContract<CreateIssueIntent>()({
    ...correct,
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs,
    reconcile: (input) => {
      const base = correct.reconcile(input);
      if (input.observation.status === "observed" && input.observation.data.matches.length === 0) {
        // BUG: treating an empty eventually-consistent search as proof of absence.
        return reconciled("NOT_APPLIED", "ASSUMED_ABSENT_FROM_SEARCH", "Search returned no matches; assuming issue was not created.");
      }
      return base;
    }
  });
}
