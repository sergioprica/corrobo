import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import type { EffectContract } from "../src/core/types";
import { runEffect } from "../src/core/runtime";
import { InMemoryStore } from "../src/stores/memory";
import {
  createIssueCreditContract,
  naiveIssueCredit,
  type CreditIntent,
  type CreditObservation
} from "../examples/timeout-after-write/contract";
import {
  countCreditsInLedger,
  runDemo,
  verifyProof
} from "../examples/timeout-after-write/demo";
import {
  startLedgerServer,
  type Credit,
  type LedgerEvent,
  type LedgerServer
} from "../examples/timeout-after-write/ledger-server";

const INTENT: CreditIntent = { accountId: "acct_42", amountCents: 5_000 };

type CreditContract = EffectContract<CreditIntent, CreditObservation, Credit>;

let localListenersAvailable = false;

beforeAll(async () => {
  localListenersAvailable = await canOpenLocalListener();
});

async function canOpenLocalListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

function eventsFor(server: LedgerServer, reference: string): LedgerEvent[] {
  return server.events().filter((e) => e.reference === reference);
}

function expectLostAfterCommit(events: LedgerEvent[]): void {
  const lostIndex = events.findIndex((e) => e.kind === "response_lost");
  expect(lostIndex).toBeGreaterThan(0);
  expect(events[lostIndex - 1]).toMatchObject({ kind: "committed", creditId: (events[lostIndex] as { creditId: string }).creditId });
}

function directCreditCount(server: LedgerServer, reference: string): number {
  return server.credits().filter((credit) => credit.reference === reference).length;
}

function requireLocalListener(ctx: TestContext): void {
  ctx.skip(!localListenersAvailable, "local HTTP listeners are unavailable in this environment");
}

function makeTransportTrustingContract(baseUrl: string): CreditContract {
  const base = createIssueCreditContract(baseUrl);
  return {
    ...base,
    async observe({ transport }) {
      return {
        status: "observed",
        data: { credits: transport.ok ? [transport.evidence] : [] },
        authoritative: false,
        source: "client transport outcome",
        observedAt: new Date().toISOString()
      };
    }
  };
}

function makeNoResponseMeansNotAppliedContract(baseUrl: string): CreditContract {
  const base = createIssueCreditContract(baseUrl);
  return {
    ...base,
    maxInFlightMs: 0,
    reconcile(input) {
      if (!input.transport.ok) {
        return {
          evidenceState: "NOT_APPLIED",
          reason: {
            code: "NO_RESPONSE_MEANS_NO_CREDIT",
            summary: "Incorrectly treats a lost response as proof the credit did not happen."
          }
        };
      }
      return base.reconcile(input);
    }
  };
}

function makeReadFailureMeansNotAppliedContract(baseUrl: string): CreditContract {
  const base = createIssueCreditContract(baseUrl);
  return {
    ...base,
    maxInFlightMs: undefined,
    async observe() {
      throw new Error("simulated ledger read failure");
    },
    reconcile(input) {
      if (input.observation.status === "observation_failed") {
        return {
          evidenceState: "NOT_APPLIED",
          reason: {
            code: "FALSE_ABSENCE_FROM_READ_FAILURE",
            summary: "Incorrectly treats an unreadable ledger as evidence of absence."
          }
        };
      }
      return base.reconcile(input);
    }
  };
}

function spawnDemo(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "examples/timeout-after-write/demo.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("demo command timed out"));
    }, 15_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("timeout-after-write demo: adversarial proof checks", () => {
  let server: LedgerServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("loses the response after the ledger commits, and the naive client sees a real network error", async (ctx) => {
    requireLocalListener(ctx);
    server = await startLedgerServer();
    const reference = "adversarial-naive-lost-response";

    server.loseNextResponse();
    const naive = await naiveIssueCredit(server.url, INTENT, reference, 1);
    const events = eventsFor(server, reference);

    expectLostAfterCommit(events);
    expect(directCreditCount(server, reference)).toBe(1);
    expect(naive.attempts).toBe(1);
    expect(naive.errors).toHaveLength(1);
    expect(naive.errors[0]).toMatch(/fetch failed|socket|closed|terminated|hang up|other side/i);
  });

  it("proof counts match the ledger's direct state, not corrobo records", async (ctx) => {
    requireLocalListener(ctx);
    server = await startLedgerServer();
    const naiveReference = "adversarial-proof-naive";
    const corroboReference = "adversarial-proof-corrobo";

    server.loseNextResponse();
    await naiveIssueCredit(server.url, INTENT, naiveReference);

    const store = new InMemoryStore();
    const contract = createIssueCreditContract(server.url);
    const request = {
      identity: { id: corroboReference, operationType: contract.operationType },
      intent: INTENT
    };
    server.loseNextResponse();
    const first = await runEffect(store, contract, request);
    const again = await runEffect(store, contract, request);

    expect(first.evidenceState).toBe("APPLIED");
    expect(first.disposition).toBe("COMPLETE");
    expect(again.disposition).toBe("COMPLETE");
    expect(await countCreditsInLedger(server.url, naiveReference)).toBe(directCreditCount(server, naiveReference));
    expect(await countCreditsInLedger(server.url, corroboReference)).toBe(directCreditCount(server, corroboReference));
    expect(directCreditCount(server, naiveReference)).toBe(2);
    expect(directCreditCount(server, corroboReference)).toBe(1);
  });

  it("verifyProof rejects a contract that trusts transport outcome instead of reading the ledger", async (ctx) => {
    requireLocalListener(ctx);
    const result = await runDemo({ makeContract: makeTransportTrustingContract });

    expect(result.corrobo.creditsInLedger).toBe(1);
    expect(result.corrobo.first.evidenceState).toBe("NOT_APPLIED");
    expect(verifyProof(result)).toEqual(
      expect.arrayContaining([
        "corrobo: evidence NOT_APPLIED, expected APPLIED",
        "corrobo: disposition RETRY, expected COMPLETE",
        "corrobo: never read the ledger"
      ])
    );
  });

  it("verifyProof rejects a contract that retries after treating no response as NOT_APPLIED", async (ctx) => {
    requireLocalListener(ctx);
    const result = await runDemo({ makeContract: makeNoResponseMeansNotAppliedContract });

    expect(result.corrobo.creditsInLedger).toBe(2);
    expect(verifyProof(result)).toEqual(
      expect.arrayContaining([
        "corrobo: expected 1 credit in the ledger, found 2",
        "corrobo: evidence NOT_APPLIED, expected APPLIED",
        "corrobo: disposition RETRY, expected COMPLETE",
        "corrobo: running again did not stay COMPLETE"
      ])
    );
  });

  it("verifyProof rejects a contract that turns ledger read failure into false absence", async (ctx) => {
    requireLocalListener(ctx);
    const result = await runDemo({ makeContract: makeReadFailureMeansNotAppliedContract });

    expect(result.corrobo.creditsInLedger).toBe(1);
    expect(result.corrobo.first.evidenceState).toBe("NOT_APPLIED");
    expect(result.corrobo.first.disposition).toBe("INVESTIGATE");
    expect(verifyProof(result)).toEqual(
      expect.arrayContaining([
        "corrobo: never read the ledger",
        "corrobo: evidence NOT_APPLIED, expected APPLIED",
        "corrobo: disposition INVESTIGATE, expected COMPLETE"
      ])
    );
  });

  it("observation failure after a lost response becomes UNKNOWN / INVESTIGATE and repeated runs do not add credit", async (ctx) => {
    requireLocalListener(ctx);
    server = await startLedgerServer();
    const reference = "adversarial-observe-fails-after-commit";
    const store = new InMemoryStore();
    const contract = createIssueCreditContract(server.url);
    const request = {
      identity: { id: reference, operationType: contract.operationType },
      intent: INTENT
    };

    server.loseNextResponse();
    server.failNextRead();
    const first = await runEffect(store, contract, request);
    const second = await runEffect(store, contract, request);
    const third = await runEffect(store, contract, request);

    expectLostAfterCommit(eventsFor(server, reference));
    expect(eventsFor(server, reference).some((e) => e.kind === "read_failed")).toBe(true);
    expect(first.evidenceState).toBe("UNKNOWN");
    expect(first.disposition).toBe("INVESTIGATE");
    expect(second.disposition).toBe("INVESTIGATE");
    expect(third.disposition).toBe("INVESTIGATE");
    expect(directCreditCount(server, reference)).toBe(1);
  });

  // Lost-before-commit and late-landing cases: covered in tests/timeout-demo.test.ts via
  // ledger.loseNextRequest() / ledger.holdNextCommit(), added after this review.

  it("coordinates concurrent runEffect calls with the same identity while the response is lost", async (ctx) => {
    requireLocalListener(ctx);
    server = await startLedgerServer();
    const reference = "adversarial-concurrent-same-identity";
    const store = new InMemoryStore();
    const contract = createIssueCreditContract(server.url);
    const request = {
      identity: { id: reference, operationType: contract.operationType },
      intent: INTENT
    };

    server.loseNextResponse();
    await Promise.all([runEffect(store, contract, request), runEffect(store, contract, request)]);
    const settled = await runEffect(store, contract, request);

    expect(settled.evidenceState).toBe("APPLIED");
    expect(settled.disposition).toBe("COMPLETE");
    expect(directCreditCount(server, reference)).toBe(1);
    expect(eventsFor(server, reference).filter((e) => e.kind === "committed")).toHaveLength(1);
  });

  it("demo command exits 0 and prints the naive duplicate beside the corrobo single credit", async (ctx) => {
    requireLocalListener(ctx);
    const result = await spawnDemo();

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 credits");
    expect(result.stdout).toContain("1 credit");
  });
});
