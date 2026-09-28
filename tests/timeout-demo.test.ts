import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEffect } from "../src/core/runtime";
import { InMemoryStore } from "../src/stores/memory";
import { createIssueCreditContract, naiveIssueCredit } from "../examples/timeout-after-write/contract";
import { countCreditsInLedger, runDemo, verifyProof } from "../examples/timeout-after-write/demo";
import type { DemoResult } from "../examples/timeout-after-write/demo";
import { startLedgerServer } from "../examples/timeout-after-write/ledger-server";
import type { LedgerServer } from "../examples/timeout-after-write/ledger-server";

const intent = { accountId: "acct_1", amountCents: 1_000 };

describe("timeout-after-write demo: the external ledger is the only source of proof", () => {
  let ledger: LedgerServer;

  beforeEach(async () => {
    ledger = await startLedgerServer();
  });

  afterEach(async () => {
    await ledger.close();
  });

  it("naive catch-and-retry duplicates the credit when the response is lost after commit", async () => {
    ledger.loseNextResponse();
    const naive = await naiveIssueCredit(ledger.url, intent, "ref-naive");
    expect(naive.attempts).toBe(2);
    expect(naive.errors).toHaveLength(1);
    expect(ledger.credits().filter((c) => c.reference === "ref-naive")).toHaveLength(2);
  });

  it("the failure is injected after the ledger committed, not before", async () => {
    ledger.loseNextResponse();
    await naiveIssueCredit(ledger.url, intent, "ref-order");
    const kinds = ledger.events().map((e) => e.kind);
    expect(kinds.slice(0, 2)).toEqual(["committed", "response_lost"]);
  });

  it("corrobo: same lost response, one credit, APPLIED / COMPLETE", async () => {
    const contract = createIssueCreditContract(ledger.url);
    ledger.loseNextResponse();
    const result = await runEffect(new InMemoryStore(), contract, {
      identity: { id: "op-1", operationType: contract.operationType },
      intent
    });
    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
    expect(ledger.credits()).toHaveLength(1);
  });

  it("the observer reads the ledger itself: its read shows up in the ledger's own log", async () => {
    const contract = createIssueCreditContract(ledger.url);
    ledger.loseNextResponse();
    const result = await runEffect(new InMemoryStore(), contract, {
      identity: { id: "op-2", operationType: contract.operationType },
      intent
    });
    expect(ledger.events()).toContainEqual({ kind: "read", reference: "op-2", found: 1 });
    expect(result.observation?.status === "observed" && result.observation.source).toBe("ledger GET /credits?reference");
  });

  it("if the ledger can't be read after a lost response: UNKNOWN / INVESTIGATE, and nothing is re-executed", async () => {
    const contract = createIssueCreditContract(ledger.url);
    const store = new InMemoryStore();
    const request = { identity: { id: "op-3", operationType: contract.operationType }, intent };
    ledger.loseNextResponse();
    ledger.failNextRead();

    const result = await runEffect(store, contract, request);
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");

    const again = await runEffect(store, contract, request);
    expect(again.disposition).toBe("INVESTIGATE");
    expect(ledger.credits()).toHaveLength(1);
  });

  it("running the same operation repeatedly never adds a credit", async () => {
    const contract = createIssueCreditContract(ledger.url);
    const store = new InMemoryStore();
    const request = { identity: { id: "op-4", operationType: contract.operationType }, intent };
    ledger.loseNextResponse();
    for (let i = 0; i < 5; i++) {
      await runEffect(store, contract, request);
    }
    expect(ledger.credits()).toHaveLength(1);
  });

  it("a different operation identity is a genuinely new credit", async () => {
    const contract = createIssueCreditContract(ledger.url);
    const store = new InMemoryStore();
    await runEffect(store, contract, { identity: { id: "op-5a", operationType: contract.operationType }, intent });
    await runEffect(store, contract, { identity: { id: "op-5b", operationType: contract.operationType }, intent });
    expect(ledger.credits().map((c) => c.reference)).toEqual(["op-5a", "op-5b"]);
  });

  const waitUntil = (iso: string | null) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(iso!) - Date.now()) + 10));

  it("request lost BEFORE commit: no immediate retry; after the in-flight window, re-check, then exactly one credit", async () => {
    const contract = createIssueCreditContract(ledger.url, { requestTimeoutMs: 100 });
    const store = new InMemoryStore();
    const request = { identity: { id: "op-before", operationType: contract.operationType }, intent };
    ledger.loseNextRequest();

    const first = await runEffect(store, contract, request);
    expect(first.evidenceState).toBe("NOT_APPLIED");
    expect(first.disposition).toBe("RETRY");
    expect(first.retryNotBefore).not.toBeNull();

    const early = await runEffect(store, contract, request);
    expect(early.attempts).toHaveLength(1);
    expect(ledger.events().filter((e) => e.kind === "request_lost" || e.kind === "committed")).toHaveLength(1); // no new POST

    await waitUntil(first.retryNotBefore);
    const retried = await runEffect(store, contract, request);
    expect(retried.evidenceState).toBe("APPLIED");
    expect(retried.attempts).toHaveLength(2);
    expect(ledger.credits()).toHaveLength(1);
  });

  it("request lands LATE, after corrobo first looked: the re-check finds it, and no second POST is sent", async () => {
    const contract = createIssueCreditContract(ledger.url, { requestTimeoutMs: 100 });
    const store = new InMemoryStore();
    const request = { identity: { id: "op-late", operationType: contract.operationType }, intent };
    const land = ledger.holdNextCommit();

    const first = await runEffect(store, contract, request);
    expect(first.evidenceState).toBe("NOT_APPLIED"); // nothing there yet...
    expect(first.disposition).toBe("RETRY"); // ...but not retried until the window passes
    expect(ledger.credits()).toHaveLength(0);

    land(); // the dropped request is applied now, after corrobo's first read
    expect(ledger.credits()).toHaveLength(1);

    await waitUntil(first.retryNotBefore);
    const settled = await runEffect(store, contract, request);
    expect(settled.evidenceState).toBe("APPLIED");
    expect(settled.disposition).toBe("COMPLETE");
    expect(settled.attempts).toHaveLength(1);
    expect(ledger.credits()).toHaveLength(1);
  });

  it("the same late landing duplicates under the naive client", async () => {
    const land = ledger.holdNextCommit();
    await naiveIssueCredit(ledger.url, intent, "ref-late-naive");
    land();
    expect(ledger.credits().filter((c) => c.reference === "ref-late-naive")).toHaveLength(2);
  });

  it("proof counts come from the ledger's HTTP API and match its internal state", async () => {
    ledger.loseNextResponse();
    await naiveIssueCredit(ledger.url, intent, "ref-count");
    expect(await countCreditsInLedger(ledger.url, "ref-count")).toBe(ledger.credits().length);
  });
});

describe("runDemo / verifyProof", () => {
  it("the real demo proves its point", async () => {
    const result = await runDemo();
    expect(verifyProof(result)).toEqual([]);
    expect(result.naive.creditsInLedger).toBe(2);
    expect(result.corrobo.creditsInLedger).toBe(1);
  });

  it("verifyProof rejects results that don't prove the point", async () => {
    const good = await runDemo();
    const tweak = (patch: (r: DemoResult) => void) => {
      const copy = structuredClone(good);
      patch(copy);
      return verifyProof(copy);
    };
    expect(tweak((r) => (r.corrobo.creditsInLedger = 2))).toContain("corrobo: expected 1 credit in the ledger, found 2");
    expect(tweak((r) => (r.naive.creditsInLedger = 1))).toContain("naive: expected 2 credits in the ledger, found 1");
    expect(tweak((r) => (r.corrobo.events = r.corrobo.events.filter((e) => e.kind !== "read")))).toContain(
      "corrobo: never read the ledger"
    );
    expect(tweak((r) => (r.naive.events = r.naive.events.filter((e) => e.kind !== "response_lost")))).toContain(
      "naive: the response was not lost after a commit"
    );
  });

  it("a contract that trusts the transport instead of the ledger fails the proof", async () => {
    const result = await runDemo({
      makeContract: (url) => {
        const real = createIssueCreditContract(url);
        return {
          ...real,
          maxInFlightMs: 0,
          // Broken on purpose: "no response" is read as "not applied", so it retries at once.
          reconcile: ({ transport }) =>
            transport.ok
              ? { evidenceState: "APPLIED", reason: { code: "OK", summary: "201" } }
              : { evidenceState: "NOT_APPLIED", reason: { code: "NO_RESPONSE", summary: "request failed" } }
        };
      }
    });
    expect(verifyProof(result)).toContain("corrobo: expected 1 credit in the ledger, found 2");
  });
});

describe("npm run demo", () => {
  it("exits 0 and prints both ledger counts", async () => {
    const { stdout } = await promisify(execFile)("npx", ["tsx", "examples/timeout-after-write/demo.ts"], {
      env: { ...process.env, NO_COLOR: "1" }
    });
    expect(stdout).toContain("ledger: 2 credits");
    expect(stdout).toContain("ledger: 1 credit ");
  }, 30_000);
});
