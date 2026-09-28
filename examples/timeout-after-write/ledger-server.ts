import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The external system in the demo: a tiny account-credit ledger over real HTTP, with its own
 * state that corrobo never touches. Like many real APIs, it lets a caller attach a `reference`
 * to a credit and look credits up by it, but it does NOT deduplicate on it — posting the same
 * request twice creates two credits.
 *
 * Faults are real transport failures, injected deterministically: `loseNextResponse()` makes
 * the ledger commit the next credit and then destroy the connection without answering, so the
 * caller sees a genuine "socket hang up" for a write that did happen.
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
  | { kind: "response_lost"; creditId: string; reference: string }
  | { kind: "responded"; creditId: string; reference: string; status: number }
  | { kind: "read"; reference: string; found: number }
  | { kind: "read_failed"; reference: string };

export interface LedgerServer {
  url: string;
  /** Commit the next credit, then drop the connection instead of responding. */
  loseNextResponse(): void;
  /** Answer the next read with 503 instead of the data. */
  failNextRead(): void;
  /** Direct view of the ledger's own state (the demo's proof also reads it over HTTP). */
  credits(): readonly Credit[];
  events(): readonly LedgerEvent[];
  close(): Promise<void>;
}

export async function startLedgerServer(): Promise<LedgerServer> {
  const credits: Credit[] = [];
  const events: LedgerEvent[] = [];
  let loseNext = false;
  let failRead = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://ledger");
    if (req.method === "POST" && url.pathname === "/credits") {
      readJson(req).then((body) => {
        const credit: Credit = {
          id: `cr_${credits.length + 1}`,
          accountId: String(body.accountId),
          amountCents: Number(body.amountCents),
          reference: String(body.reference)
        };
        credits.push(credit); // committed: this is now true in the external world
        events.push({ kind: "committed", creditId: credit.id, reference: credit.reference });
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    loseNextResponse: () => {
      loseNext = true;
    },
    failNextRead: () => {
      failRead = true;
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
