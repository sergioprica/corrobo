import type { RefundLike, StripeClientLike } from "./types";

/**
 * Mirrors the shape of a real Stripe SDK error for a request Stripe rejected synchronously
 * (the SDK's own `StripeInvalidRequestError` has an equivalent `.code`/`.message`, and its
 * `.type` is checked by `isDefiniteRejection` in ./types). No state changed on this call.
 */
export class FakeStripeRejection extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FakeStripeRejection";
  }
}

interface ChargeState {
  refundableAmount: number;
  alreadyRefunded: boolean;
  convergeAsync: boolean;
  terminalFailure: boolean;
}

interface ChargeFaults {
  /** How many subsequent create() calls for this charge should throw a generic (ambiguous) error before behaving normally. */
  createFailures: number;
  mode: "beforeCommit" | "afterCommit";
  retrieveFailures: number;
}

/**
 * A deterministic stand-in for the Stripe Node SDK, preserving the semantics this example
 * depends on: idempotency-key caching (a replayed key never creates a second refund),
 * synchronous validation rejections that never touch state, and asynchronous status
 * convergence (pending -> succeeded). No network access, no real credentials.
 */
export class FakeStripeClient implements StripeClientLike {
  private readonly charges = new Map<string, ChargeState>();
  private readonly faults = new Map<string, ChargeFaults>();
  private readonly byIdempotencyKey = new Map<string, RefundLike>();
  private readonly createdByKey = new Map<string, number>();
  private readonly byId = new Map<string, RefundLike>();
  private createdRefunds = 0;

  seedCharge(
    chargeId: string,
    refundableAmount: number,
    options: { alreadyRefunded?: boolean; convergeAsync?: boolean; terminalFailure?: boolean } = {}
  ): void {
    this.charges.set(chargeId, {
      refundableAmount,
      alreadyRefunded: options.alreadyRefunded ?? false,
      convergeAsync: options.convergeAsync ?? false,
      terminalFailure: options.terminalFailure ?? false
    });
  }

  /** Injects N ambiguous (non-Stripe-shaped) failures on the next create()/retrieve() calls for a charge. */
  scheduleFault(chargeId: string, fault: Partial<ChargeFaults>): void {
    const existing = this.faults.get(chargeId) ?? { createFailures: 0, mode: "beforeCommit", retrieveFailures: 0 };
    this.faults.set(chargeId, { ...existing, ...fault });
  }

  /** Every Idempotency-Key a create() call arrived with, in order (replays included). For test assertions. */
  readonly idempotencyKeysReceived: string[] = [];

  /** Real refund creations only — a cache hit on an idempotency key does not count. For test assertions. */
  get createdRefundCount(): number {
    return this.createdRefunds;
  }

  /** Real refund creations for a single Idempotency-Key (per-operation effect count for the conformance harness). */
  createdRefundCountForKey(idempotencyKey: string): number {
    return this.createdByKey.get(idempotencyKey) ?? 0;
  }

  getRefundState(id: string): RefundLike | undefined {
    return this.byId.get(id);
  }

  refunds = {
    create: (params: { charge: string; amount: number; reason?: string }, opts: { idempotencyKey: string }): Promise<RefundLike> =>
      this.doCreate(params, opts.idempotencyKey),
    retrieve: (id: string): Promise<RefundLike> => this.doRetrieve(id)
  };

  private async doCreate(
    params: { charge: string; amount: number; reason?: string },
    idempotencyKey: string
  ): Promise<RefundLike> {
    this.idempotencyKeysReceived.push(idempotencyKey);
    const fault = this.faults.get(params.charge);
    const cached = this.byIdempotencyKey.get(idempotencyKey);
    if (cached) {
      if (fault && fault.retrieveFailures > 0) {
        fault.retrieveFailures -= 1;
        throw new Error("simulated network failure during read-back");
      }
      return cached;
    }

    if (fault && fault.createFailures > 0 && fault.mode === "beforeCommit") {
      fault.createFailures -= 1;
      throw new Error("simulated network failure before the request reached Stripe");
    }

    const charge = this.charges.get(params.charge);
    if (!charge) {
      throw new FakeStripeRejection("resource_missing", `No such charge: ${params.charge}`);
    }
    if (charge.alreadyRefunded) {
      throw new FakeStripeRejection("charge_already_refunded", "The charge has already been refunded.");
    }
    if (params.amount > charge.refundableAmount) {
      throw new FakeStripeRejection(
        "amount_too_large",
        "Refund amount is greater than the unrefunded amount on the charge."
      );
    }

    this.createdRefunds += 1;
    const id = `re_fake_${this.createdRefunds}`;
    const refund: RefundLike = {
      id,
      charge: params.charge,
      amount: params.amount,
      status: charge.convergeAsync ? "pending" : charge.terminalFailure ? "failed" : "succeeded"
    };

    if (!charge.terminalFailure) {
      charge.refundableAmount -= params.amount;
      if (charge.refundableAmount === 0) charge.alreadyRefunded = true;
    }

    this.byIdempotencyKey.set(idempotencyKey, refund);
    this.createdByKey.set(idempotencyKey, (this.createdByKey.get(idempotencyKey) ?? 0) + 1);
    this.byId.set(id, refund);

    if (charge.convergeAsync) {
      setTimeout(() => {
        const current = this.byId.get(id);
        if (current && current.status === "pending") {
          const resolved = { ...current, status: "succeeded" as const };
          this.byId.set(id, resolved);
          this.byIdempotencyKey.set(idempotencyKey, resolved);
        }
      }, 150);
    }

    if (fault && fault.createFailures > 0 && fault.mode === "afterCommit") {
      fault.createFailures -= 1;
      throw new Error("simulated network failure after Stripe committed the refund");
    }

    return refund;
  }

  private async doRetrieve(id: string): Promise<RefundLike> {
    const refund = this.byId.get(id);
    const fault = refund ? this.faults.get(refund.charge) : undefined;
    if (fault && fault.retrieveFailures > 0) {
      fault.retrieveFailures -= 1;
      throw new Error("simulated network failure during read-back");
    }
    if (!refund) {
      throw new FakeStripeRejection("resource_missing", `No such refund: ${id}`);
    }
    return refund;
  }
}
