import { describe, expect, it } from "vitest";
import { formatConformanceReport, verifyEffectContract } from "../src/testing";
import type { ConformanceTarget } from "../src/testing";
import { createRefundContract, idempotencyKeyFor } from "../examples/stripe-refund/contract";
import { FakeStripeClient } from "../examples/stripe-refund/fake-stripe-client";
import type { StripeClientLike } from "../examples/stripe-refund/types";

describe("Stripe refund example through verifyEffectContract()", () => {
  it("passes every conformance scenario the FakeStripeClient target can drive (skipping late-landing and pending)", async () => {
    const chargeId = "ch_conformance";
    let client = new FakeStripeClient();
    client.seedCharge(chargeId, 10_000);

    // Delegate through a stable StripeClientLike wrapper so target.reset() can swap in a fresh
    // FakeStripeClient per scenario while createRefundContract keeps a single client reference.
    const delegatingClient: StripeClientLike = {
      refunds: {
        create: (params, options) => client.refunds.create(params, options),
        retrieve: (id) => client.refunds.retrieve(id)
      }
    };

    const target: ConformanceTarget = {
      reset() {
        client = new FakeStripeClient();
        // Seed enough refundable balance for neighbor-effect-isolation (two operations on the same charge).
        client.seedCharge(chargeId, 10_000);
      },
      effectCount(operationId: string) {
        return client.createdRefundCountForKey(idempotencyKeyFor(operationId));
      },
      faults: {
        loseResponseAfterCommit() {
          client.scheduleFault(chargeId, { createFailures: 1, mode: "afterCommit" });
        },
        loseRequestBeforeCommit() {
          client.scheduleFault(chargeId, { createFailures: 1, mode: "beforeCommit" });
        },
        holdCommit() {
          // FakeStripeClient commits synchronously inside create(); lateLandingMs is intentionally
          // left unset on the target so the harness skips late-landing with a clear reason.
          return () => {};
        },
        failNextRead() {
          client.scheduleFault(chargeId, { retrieveFailures: 1 });
        }
      }
    };

    const report = await verifyEffectContract({
      contract: createRefundContract({ client: delegatingClient }),
      target,
      intent: { chargeId, amountCents: 1_000 },
      otherIntent: { chargeId, amountCents: 2_500 }
    });

    expect(report.passed, formatConformanceReport(report)).toBe(true);

    const skipped = report.results.filter((r) => r.status === "skipped").map((r) => r.scenario).sort();
    expect(skipped).toEqual(["late-landing", "pending-then-rejected", "pending-then-settled"]);

    const lateLanding = report.results.find((r) => r.scenario === "late-landing")!;
    expect(lateLanding.notes[0]).toMatch(/target\.lateLandingMs is not set/);

    const ran = report.results.filter((r) => r.status !== "skipped");
    expect(ran).toHaveLength(9);
    for (const scenarioResult of ran) {
      expect(scenarioResult.status, `${scenarioResult.scenario}: ${scenarioResult.notes.join("; ")}`).toBe("pass");
    }
  });
});
