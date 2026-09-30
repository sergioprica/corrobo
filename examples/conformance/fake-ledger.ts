import { defineContract, observed, reconciled } from "corrobo";
import type { ConformanceTarget } from "corrobo/testing";

/**
 * A reference fake of an external system for corrobo's conformance harness: a credits ledger
 * with every fault hook the harness can drive, and a correct contract against it. Copy the
 * shape for your own provider: the fake must encode how the REAL system behaves (does it
 * deduplicate? how late can a dropped request land? can a read fail?), because the harness can
 * only prove things relative to it.
 */
export function fakeLedger(lateLandingMs = 500) {
  const applied = new Map<string, number>();
  const pending = new Map<string, "pending" | "rejected">();
  let mode: "normal" | "loseResponse" | "loseRequest" | "hold" | "pending" = "normal";
  let heldRelease: ((opId: string) => void) | null = null;
  let failRead = false;
  const apply = (opId: string) => applied.set(opId, (applied.get(opId) ?? 0) + 1);

  const client = {
    async write(opId: string): Promise<{ accepted: boolean }> {
      const current = mode;
      mode = "normal";
      if (current === "loseRequest") throw new Error("ECONNRESET before the request reached the ledger");
      if (current === "hold") {
        heldRelease?.(opId);
        throw new Error("timeout (the request is still in flight)");
      }
      if (current === "pending") {
        pending.set(opId, "pending");
        return { accepted: true };
      }
      apply(opId);
      if (current === "loseResponse") throw new Error("socket hang up");
      return { accepted: true };
    },
    async read(opId: string): Promise<{ applied: number; pending: boolean }> {
      if (failRead) {
        failRead = false;
        throw new Error("read replica unavailable");
      }
      return { applied: applied.get(opId) ?? 0, pending: pending.get(opId) === "pending" };
    }
  };

  const target: ConformanceTarget = {
    lateLandingMs,
    reset() {
      applied.clear();
      pending.clear();
      mode = "normal";
      heldRelease = null;
      failRead = false;
    },
    effectCount: (opId) => applied.get(opId) ?? 0,
    faults: {
      loseResponseAfterCommit: () => void (mode = "loseResponse"),
      loseRequestBeforeCommit: () => void (mode = "loseRequest"),
      holdCommit() {
        mode = "hold";
        let heldFor: string | null = null;
        heldRelease = (opId) => (heldFor = opId);
        return () => {
          if (heldFor) apply(heldFor);
        };
      },
      failNextRead: () => void (failRead = true),
      acceptAsPending() {
        mode = "pending";
        const settle = (outcome: "applied" | "rejected") => {
          for (const [opId, state] of pending) {
            if (state !== "pending") continue;
            if (outcome === "applied") {
              pending.delete(opId);
              apply(opId);
            } else {
              pending.set(opId, "rejected");
            }
          }
        };
        return { settle: () => settle("applied"), reject: () => settle("rejected") };
      }
    }
  };
  return { client, target };
}

/** `maxInFlightMs: null` builds the contract without a window (a default parameter would swallow undefined). */
export function correctContract(client: ReturnType<typeof fakeLedger>["client"], maxInFlightMs: number | null = 1_000) {
  return defineContract<{ amount: number }>()({
    operationType: "fake/credit",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs: maxInFlightMs ?? undefined,
    execute: ({ identity }) => client.write(identity.id),
    observe: async ({ identity }) => observed(await client.read(identity.id), { source: "fake ledger", authoritative: true }),
    reconcile: ({ observation }) => {
      if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "read failed");
      const { applied, pending } = observation.data;
      if (pending) return { evidenceState: "PENDING", reason: { code: "PENDING", summary: "accepted, not settled" } };
      if (applied === 0) return reconciled("NOT_APPLIED", "ABSENT", "no credit");
      if (applied === 1) return reconciled("APPLIED", "FOUND", "one credit");
      return reconciled("CONFLICTED", "DUPLICATES", `${applied} credits`);
    }
  });
}
