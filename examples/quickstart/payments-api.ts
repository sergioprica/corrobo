/**
 * A stand-in for a real payments API, so the quickstart runs with no network or credentials.
 * Like many real APIs, it stores a `reference` you send and lets you look refunds up by it, but
 * it does not deduplicate on it. `loseNextResponse()` makes the next refund happen and then
 * fail anyway, as if the response was lost on the way back.
 */
export interface Refund {
  id: string;
  orderId: string;
  amountCents: number;
  reference: string;
}

export function createPaymentsApi() {
  const refunds: Refund[] = [];
  let loseNext = false;
  return {
    async createRefund(input: Omit<Refund, "id">): Promise<Refund> {
      const refund = { id: `re_${refunds.length + 1}`, ...input };
      refunds.push(refund); // the refund is made
      if (loseNext) {
        loseNext = false;
        throw new Error("socket hang up"); // ...but the caller never hears about it
      }
      return refund;
    },
    async findRefunds(reference: string): Promise<Refund[]> {
      return refunds.filter((r) => r.reference === reference);
    },
    loseNextResponse() {
      loseNext = true;
    },
    refundCount: () => refunds.length
  };
}
