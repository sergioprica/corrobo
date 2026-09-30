import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The external system in the demo: a tiny account-credit ledger over real HTTP, with its own
 * state that corrobo never touches. Like many real APIs, it lets a caller attach a `reference`
 * to a credit and look credits up by it, but it does NOT deduplicate on it — posting the same
 * request twice creates two credits.
 *
 * Faults are real transport failures, injected deterministically — the caller always sees a
 * genuine dropped connection, never a simulated exception:
 * - `loseNextResponse()`: commit the next credit, then drop the connection (write happened).
 * - `loseNextRequest()`: drop the connection before committing anything (write did not happen).
 * - `holdNextCommit()`: drop the connection, then commit only when the returned function is
 *   called — a request that lands *after* the caller has already looked (a late landing).
 */

export interface Credit {
  id: string;
  accountId: string;
  amountCents: number;
  reference: string;
}

/** What the ledger itself saw and did, in order — the ground truth the demo prints from. */
export type LedgerEvent =
  | { kind: "committed"; creditId: string; reference: string }
  | { kind: "request_lost"; reference: string }
  | { kind: "commit_delayed"; reference: string }
  | { kind: "response_lost"; creditId: string; reference: string }
  | { kind: "responded"; creditId: string; reference: string; status: number }
  | { kind: "read"; reference: string; found: number }
  | { kind: "read_failed"; reference: string };

export interface LedgerServer {
  url: string;
  /** Commit the next credit, then drop the connection instead of responding. */
  loseNextResponse(): void;
  /** Drop the next POST's connection before committing anything. */
  loseNextRequest(): void;
  /** Drop the next POST's connection now; commit its credit only when the returned function is called. */
  holdNextCommit(): () => void;
  /** Answer the next read with 503 instead of the data. */
  failNextRead(): void;
  /** Forget every credit, event and pending fault. */
  reset(): void;
  /** Direct view of the ledger's own state (the demo's proof also reads it over HTTP). */
  credits(): readonly Credit[];
  events(): readonly LedgerEvent[];
  close(): Promise<void>;
}

export async function startLedgerServer(): Promise<LedgerServer> {
  const credits: Credit[] = [];
  const events: LedgerEvent[] = [];
  let loseNext = false;
  let loseRequest = false;
  let held: { arm: (commit: () => void) => void } | null = null;
  let failRead = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://ledger");
    if (req.method === "POST" && url.pathname === "/credits") {
      readJson(req).then((body) => {
        const reference = String(body.reference);
        const commit = (): Credit => {
          const credit: Credit = {
            id: `cr_${credits.length + 1}`,
            accountId: String(body.accountId),
            amountCents: Number(body.amountCents),
            reference
          };
          credits.push(credit); // committed: this is now true in the external world
          events.push({ kind: "committed", creditId: credit.id, reference });
          return credit;
        };
        if (loseRequest) {
          loseRequest = false;
          events.push({ kind: "request_lost", reference });
          req.socket.destroy(); // nothing was written
          return;
        }
        if (held) {
          const pending = held;
          held = null;
          events.push({ kind: "commit_delayed", reference });
          pending.arm(() => commit());
          req.socket.destroy(); // the caller gives up now; the write lands later
          return;
        }
        const credit = commit();
        if (loseNext) {
          loseNext = false;
          events.push({ kind: "response_lost", creditId: credit.id, reference: credit.reference });
          req.socket.destroy(); // the write happened; the answer never arrives
          return;
        }
        events.push({ kind: "responded", creditId: credit.id, reference: credit.reference, status: 201 });
        json(res, 201, credit);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/credits") {
      const reference = url.searchParams.get("reference") ?? "";
      if (failRead) {
        failRead = false;
        events.push({ kind: "read_failed", reference });
        json(res, 503, { error: "ledger read replica unavailable" });
        return;
      }
      const found = credits.filter((c) => c.reference === reference);
      events.push({ kind: "read", reference, found: found.length });
      json(res, 200, { credits: found });
      return;
    }
    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    loseNextResponse: () => {
      loseNext = true;
    },
    loseNextRequest: () => {
      loseRequest = true;
    },
    holdNextCommit: () => {
      let commit: (() => void) | null = null;
      let released = false;
      held = {
        arm: (c) => {
          commit = c;
          if (released) c();
        }
      };
      return () => {
        released = true;
        commit?.();
      };
    },
    failNextRead: () => {
      failRead = true;
    },
    reset: () => {
      credits.length = 0;
      events.length = 0;
      loseNext = false;
      loseRequest = false;
      held = null;
      failRead = false;
    },
    credits: () => credits,
    events: () => events,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}
