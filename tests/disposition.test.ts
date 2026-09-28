import { describe, expect, it } from "vitest";
import { decideDisposition } from "../src/core/disposition";
import type { RetryPolicy } from "../src/core/types";

const retryPolicy: RetryPolicy = { maxAttempts: 3, retryOnNotApplied: true };
/** execute() returned a response: the request is no longer in flight, so NOT_APPLIED is final. */
const settlement = { transportOk: true, attemptStartedAt: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:01.000Z" };

describe("decideDisposition", () => {
  it("APPLIED -> COMPLETE", () => {
    const result = decideDisposition({ evidenceState: "APPLIED", attemptNumber: 1, retryPolicy, settlement });
    expect(result.disposition).toBe("COMPLETE");
  });

  it("CONFLICTED -> REPLAN", () => {
    const result = decideDisposition({ evidenceState: "CONFLICTED", attemptNumber: 1, retryPolicy, settlement });
    expect(result.disposition).toBe("REPLAN");
  });

  it("UNKNOWN -> INVESTIGATE, never RETRY", () => {
    const result = decideDisposition({ evidenceState: "UNKNOWN", attemptNumber: 1, retryPolicy, settlement });
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("PENDING -> no disposition (null), not treated as failure", () => {
    const result = decideDisposition({ evidenceState: "PENDING", attemptNumber: 1, retryPolicy, settlement });
    expect(result.disposition).toBeNull();
    expect(result.reason.code).toBe("AWAITING_CONVERGENCE");
  });

  it("NOT_APPLIED with attempts remaining and retry allowed -> RETRY", () => {
    const result = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 1, retryPolicy, settlement });
    expect(result.disposition).toBe("RETRY");
  });

  it("NOT_APPLIED with retry exhausted -> INVESTIGATE, represented conservatively", () => {
    const exhausted: RetryPolicy = { maxAttempts: 1, retryOnNotApplied: true };
    const result = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 1, retryPolicy: exhausted, settlement });
    expect(result.disposition).toBe("INVESTIGATE");
    expect(result.reason.metadata).toMatchObject({ attemptNumber: 1, maxAttempts: 1 });
  });

  it("NOT_APPLIED not declared retryable for this operation type -> INVESTIGATE, not RETRY", () => {
    const noRetry: RetryPolicy = { maxAttempts: 5, retryOnNotApplied: false };
    const result = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 1, retryPolicy: noRetry, settlement });
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("UNKNOWN cannot be configured into RETRY — retryOnNotApplied only affects NOT_APPLIED", () => {
    const alwaysRetry: RetryPolicy = { maxAttempts: 5, retryOnNotApplied: true };
    const result = decideDisposition({ evidenceState: "UNKNOWN", attemptNumber: 1, retryPolicy: alwaysRetry, settlement });
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("PENDING cannot be configured into RETRY — it never carries a disposition", () => {
    const alwaysRetry: RetryPolicy = { maxAttempts: 5, retryOnNotApplied: true };
    const result = decideDisposition({ evidenceState: "PENDING", attemptNumber: 1, retryPolicy: alwaysRetry, settlement });
    expect(result.disposition).toBeNull();
  });

  it("is deterministic: identical input always produces identical output", () => {
    const a = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 2, retryPolicy, settlement });
    const b = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 2, retryPolicy, settlement });
    expect(a).toEqual(b);
  });

  describe("settlement: NOT_APPLIED after a failed/unknown transport", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const failed = (now: string, maxInFlightMs?: number) => ({
      transportOk: false,
      attemptStartedAt: startedAt,
      now,
      maxInFlightMs
    });

    it("no maxInFlightMs declared -> INVESTIGATE (a late landing cannot be ruled out), never RETRY", () => {
      const result = decideDisposition({
        evidenceState: "NOT_APPLIED",
        attemptNumber: 1,
        retryPolicy,
        settlement: failed("2026-01-02T00:00:00.000Z")
      });
      expect(result.disposition).toBe("INVESTIGATE");
      expect(result.reason.code).toBe("IN_FLIGHT_NOT_RULED_OUT");
      expect(result.retryNotBefore).toBeUndefined();
    });

    it("inside the in-flight window -> RETRY that may not proceed before startedAt + maxInFlightMs", () => {
      const result = decideDisposition({
        evidenceState: "NOT_APPLIED",
        attemptNumber: 1,
        retryPolicy,
        settlement: failed("2026-01-01T00:00:10.000Z", 30_000)
      });
      expect(result.disposition).toBe("RETRY");
      expect(result.reason.code).toBe("SAFE_RETRY_AFTER_SETTLEMENT");
      expect(result.retryNotBefore).toBe("2026-01-01T00:00:30.000Z");
    });

    it("window already passed at observation time -> ordinary RETRY", () => {
      const result = decideDisposition({
        evidenceState: "NOT_APPLIED",
        attemptNumber: 1,
        retryPolicy,
        settlement: failed("2026-01-01T00:00:30.000Z", 30_000)
      });
      expect(result.disposition).toBe("RETRY");
      expect(result.reason.code).toBe("SAFE_RETRY");
      expect(result.retryNotBefore).toBeUndefined();
    });

    it("maxInFlightMs: 0 (re-execution provider-deduplicated) -> ordinary RETRY immediately", () => {
      const result = decideDisposition({
        evidenceState: "NOT_APPLIED",
        attemptNumber: 1,
        retryPolicy,
        settlement: failed(startedAt, 0)
      });
      expect(result.disposition).toBe("RETRY");
      expect(result.retryNotBefore).toBeUndefined();
    });

    it("retry exhausted still wins -> INVESTIGATE regardless of settlement", () => {
      const result = decideDisposition({
        evidenceState: "NOT_APPLIED",
        attemptNumber: 3,
        retryPolicy,
        settlement: failed("2026-01-01T00:00:10.000Z", 30_000)
      });
      expect(result.disposition).toBe("INVESTIGATE");
      expect(result.reason.code).toBe("RETRY_NOT_SAFE_OR_EXHAUSTED");
    });

    it("settlement never affects the other evidence states", () => {
      for (const evidenceState of ["APPLIED", "CONFLICTED", "UNKNOWN", "PENDING"] as const) {
        const withSettled = decideDisposition({ evidenceState, attemptNumber: 1, retryPolicy, settlement });
        const withFailed = decideDisposition({ evidenceState, attemptNumber: 1, retryPolicy, settlement: failed(startedAt) });
        expect(withFailed).toEqual(withSettled);
      }
    });
  });
});
