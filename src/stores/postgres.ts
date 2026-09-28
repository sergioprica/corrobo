import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { StoreConflictError } from "../core/store";
import type { CoordinatedStore, EffectStore, NewOperationInput, OperationLock } from "../core/store";
import type {
  AttemptRecord,
  ObservationResult,
  OperationRecord,
  OperationStatus,
  ReservedAttemptInput,
  TransportOutcome
} from "../core/types";

const TABLE = "corrobo_operations";

/**
 * DDL for the single table this store needs. Safe to run repeatedly. The trailing ALTER
 * upgrades a table created by corrobo <= 0.2.x (which had no `version` column) in place;
 * existing rows start at version 0.
 */
export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  intent JSONB NOT NULL,
  status TEXT NOT NULL,
  review_reason JSONB,
  attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
`;

interface Row {
  id: string;
  operation_type: string;
  intent: unknown;
  status: OperationStatus;
  review_reason: unknown;
  attempts: AttemptRecord[];
  created_at: Date;
  updated_at: Date;
  /** BIGINT: node-postgres returns it as a string. */
  version: string;
}

/** Anything with node-postgres's .query() signature — a Pool or a single PoolClient. */
interface Queryable {
  query<T extends QueryResultRow = never>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function rowToRecord(row: Row): OperationRecord {
  return {
    identity: { id: row.id, operationType: row.operation_type },
    intent: row.intent,
    status: row.status,
    reviewReason: (row.review_reason as OperationRecord["reviewReason"]) ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: Number(row.version)
  };
}

/**
 * Every write below is `UPDATE ... WHERE id = $1 AND version = <expected>` and bumps the
 * version, so it applies atomically only if nobody else wrote first. When it matches no row,
 * this works out why — unknown identity, a concurrent write (StoreConflictError), or a
 * write-specific precondition (`preconditionError`) — and throws accordingly.
 */
async function versionedWriteResult(
  q: Queryable,
  identityId: string,
  expectedVersion: number,
  row: Row | undefined,
  preconditionError?: string
): Promise<OperationRecord> {
  if (row) {
    return rowToRecord(row);
  }
  const current = await getOperationImpl(q, identityId);
  if (!current) {
    throw new Error(`corrobo: unknown operation identity "${identityId}"`);
  }
  if (current.version !== expectedVersion) {
    throw new StoreConflictError(identityId, expectedVersion, current.version);
  }
  throw new Error(preconditionError ?? `corrobo: write to operation "${identityId}" was not applied`);
}

/**
 * PostgresStore's own durable-persistence boundary: strips `error.raw` — the caller's raw
 * thrown value, whatever shape it is — from the two specific locations it can appear
 * (a failed transport outcome, and a failed observation), before anything is written to
 * Postgres. `error.message` (a plain string) is kept. This is deliberately narrow: it does
 * not scan for "secret-looking" field names anywhere else (intent, observedEffect, reason
 * metadata) — that would give false confidence over data this store has no way to safely
 * judge. It only removes the one field known, by construction, to be an unexamined
 * passthrough of an arbitrary caller-supplied error object (see runtime.ts's safeExecute/
 * safeObserve). Never mutates the input — returns a new object so the in-memory
 * EffectResult for the current call (built before this runs) is unaffected.
 */
function sanitizeAttemptForPersistence(attempt: AttemptRecord): AttemptRecord {
  if (attempt.status !== "RESOLVED") {
    return attempt; // a RESERVED attempt carries no transport/observation data at all
  }
  return {
    ...attempt,
    transport: sanitizeTransportForPersistence(attempt.transport),
    observations: attempt.observations.map(sanitizeObservationForPersistence)
  };
}

function sanitizeTransportForPersistence(transport: TransportOutcome<unknown>): TransportOutcome<unknown> {
  if (transport.ok) {
    return transport; // the success branch carries no error object at all
  }
  return { ok: false, error: { message: transport.error.message } };
}

function sanitizeObservationForPersistence(observation: ObservationResult<unknown>): ObservationResult<unknown> {
  if (observation.status !== "observation_failed") {
    return observation; // "observed"/"pending" never carry an error.raw field
  }
  return {
    status: "observation_failed",
    error: { message: observation.error.message },
    source: observation.source,
    observedAt: observation.observedAt
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "23505";
}

/**
 * Deterministically derives a signed 64-bit key for pg_(try_)advisory_lock from an operation
 * identity string. A hash collision between two different identities would only cause them
 * to unnecessarily serialize against each other — never an incorrect safety outcome — since
 * the actual guarantee comes from Postgres allowing only one holder per key at a time.
 */
function advisoryLockKey(identityId: string): string {
  const digest = createHash("sha256").update(identityId).digest();
  const unsigned = digest.readBigUInt64BE(0);
  return BigInt.asIntN(64, unsigned).toString();
}

// --- Query implementations, parameterized over Queryable so both the shared pool (for
// standalone/test use) and a single dedicated lock-holding connection (for a coordinated
// runEffect pass) can run the identical SQL without duplicating it. ---

async function getOperationImpl(q: Queryable, identityId: string): Promise<OperationRecord | null> {
  const result = await q.query<Row>(`SELECT * FROM ${TABLE} WHERE id = $1`, [identityId]);
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

async function createOperationImpl(q: Queryable, input: NewOperationInput): Promise<OperationRecord> {
  try {
    const result = await q.query<Row>(
      `INSERT INTO ${TABLE} (id, operation_type, intent, status, review_reason, attempts)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, '[]'::jsonb)
       RETURNING *`,
      [
        input.identity.id,
        input.identity.operationType,
        JSON.stringify(input.intent),
        input.status,
        input.reviewReason ? JSON.stringify(input.reviewReason) : null
      ]
    );
    return rowToRecord(result.rows[0]);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      const existing = await getOperationImpl(q, input.identity.id);
      throw new StoreConflictError(input.identity.id, null, existing?.version ?? 0);
    }
    throw err;
  }
}

async function reserveAttemptImpl(
  q: Queryable,
  identityId: string,
  reserved: ReservedAttemptInput,
  expectedVersion: number
): Promise<OperationRecord> {
  const placeholder: AttemptRecord = {
    status: "RESERVED",
    attemptNumber: reserved.attemptNumber,
    startedAt: reserved.startedAt,
    updatedAt: reserved.startedAt
  };
  const result = await q.query<Row>(
    `UPDATE ${TABLE} SET attempts = attempts || $2::jsonb, updated_at = now(), version = version + 1
     WHERE id = $1 AND version = $3 RETURNING *`,
    [identityId, JSON.stringify([placeholder]), expectedVersion]
  );
  return versionedWriteResult(q, identityId, expectedVersion, result.rows[0]);
}

async function appendAttemptImpl(
  q: Queryable,
  identityId: string,
  attempt: AttemptRecord,
  status: OperationStatus,
  expectedVersion: number
): Promise<OperationRecord> {
  const result = await q.query<Row>(
    `UPDATE ${TABLE}
     SET attempts = attempts || $2::jsonb, status = $3, updated_at = now(), version = version + 1
     WHERE id = $1 AND version = $4
     RETURNING *`,
    [identityId, JSON.stringify([sanitizeAttemptForPersistence(attempt)]), status, expectedVersion]
  );
  return versionedWriteResult(q, identityId, expectedVersion, result.rows[0]);
}

async function updateLatestAttemptImpl(
  q: Queryable,
  identityId: string,
  attempt: AttemptRecord,
  status: OperationStatus,
  expectedVersion: number
): Promise<OperationRecord> {
  const result = await q.query<Row>(
    `UPDATE ${TABLE}
     SET attempts = jsonb_set(attempts, array[(jsonb_array_length(attempts) - 1)::text], $2::jsonb),
         status = $3,
         updated_at = now(),
         version = version + 1
     WHERE id = $1 AND version = $4 AND jsonb_array_length(attempts) > 0
     RETURNING *`,
    [identityId, JSON.stringify(sanitizeAttemptForPersistence(attempt)), status, expectedVersion]
  );
  return versionedWriteResult(
    q,
    identityId,
    expectedVersion,
    result.rows[0],
    `corrobo: no attempt to update for operation "${identityId}"`
  );
}

/** The database server's clock — one clock for every process sharing this database. */
async function nowImpl(q: Queryable): Promise<Date> {
  const result = await q.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  return result.rows[0].now;
}

async function setStatusImpl(
  q: Queryable,
  identityId: string,
  status: OperationStatus,
  expectedVersion: number
): Promise<OperationRecord> {
  const result = await q.query<Row>(
    `UPDATE ${TABLE} SET status = $2, updated_at = now(), version = version + 1
     WHERE id = $1 AND version = $3 RETURNING *`,
    [identityId, status, expectedVersion]
  );
  return versionedWriteResult(q, identityId, expectedVersion, result.rows[0]);
}

function boundStore(q: Queryable): CoordinatedStore {
  return {
    getOperation: (id) => getOperationImpl(q, id),
    createOperation: (input) => createOperationImpl(q, input),
    reserveAttempt: (id, r, v) => reserveAttemptImpl(q, id, r, v),
    appendAttempt: (id, a, s, v) => appendAttemptImpl(q, id, a, s, v),
    updateLatestAttempt: (id, a, s, v) => updateLatestAttemptImpl(q, id, a, s, v),
    setStatus: (id, s, v) => setStatusImpl(q, id, s, v),
    now: () => nowImpl(q)
  };
}

/**
 * Postgres-backed store: durable across process restarts. This is the mode intended
 * for real applications — operation identity and prior evidence survive a crash.
 *
 * Concurrency: tryAcquireLock() checks out ONE dedicated connection from the pool, uses it to
 * take a session-scoped Postgres advisory lock (pg_try_advisory_lock, keyed by a hash of the
 * operation identity), and returns that SAME connection (as OperationLock.store) for every
 * store operation the coordinated pass performs — reservation, reads, and the final resolve
 * all run on the one connection that holds the lock. One in-flight identity therefore consumes
 * exactly one pool connection for the duration of its pass, never two: earlier revisions held
 * the lock on a dedicated connection while routing the pass's own bookkeeping queries through
 * the shared pool, which could self-deadlock once concurrently in-flight distinct identities
 * reached pool.max (every connection held by a lock, none left for any pass's own reads/writes).
 * If the process holding the connection crashes, Postgres releases the advisory lock
 * automatically — no lease timers, no permanent locks. Different operation identities hash to
 * different lock keys and never serialize against each other; the connection is not held
 * across a transaction and does not lock the row itself, so ordinary reads of that row by
 * other tools are never blocked.
 *
 * Persistence acknowledgement: constructing a PostgresStore durably writes operation state —
 * including whatever application-supplied intent, transport evidence, observations, and
 * reason metadata your contracts produce — into the database you configure, with no
 * automatic expiry (see README's "Privacy and data handling" section). This is not
 * telemetry, not a network permission dialog, and not a corrobo account setting — it is a
 * one-time, code-level acknowledgement that you understand this store is durable.
 */
export interface PostgresStoreOptions {
  /** Must be the literal `true`. See the persistence-acknowledgement note above. */
  acknowledgePersistence: true;
}

export class PostgresStore implements EffectStore {
  constructor(
    private readonly pool: Pool,
    options: PostgresStoreOptions
  ) {
    if (!options || options.acknowledgePersistence !== true) {
      throw new Error(
        "corrobo: PostgresStore persists operation state to the configured database, including " +
          "application-supplied intent/evidence/observations/reason metadata, and corrobo does not " +
          "automatically expire those records. Pass { acknowledgePersistence: true } to explicitly opt in."
      );
    }
  }

  /** Creates the schema if it doesn't exist. Call once at startup. */
  static async migrate(pool: Pool | PoolClient): Promise<void> {
    await pool.query(POSTGRES_SCHEMA_SQL);
  }

  async tryAcquireLock(identityId: string): Promise<OperationLock | null> {
    const client = await this.pool.connect();
    const key = advisoryLockKey(identityId);
    // While checked out, a client whose connection dies (backend terminated, network drop)
    // emits 'error'; with no listener that is an uncaught exception that would crash the
    // caller's process. The failure still surfaces where it matters — the pass's next query on
    // this client rejects — and a lost lock can't cause a stale overwrite (writes are
    // version-checked), so the event itself only needs to be absorbed here.
    const onClientError = () => {};
    client.on("error", onClientError);
    const done = (err?: Error) => {
      client.off("error", onClientError);
      client.release(err);
    };
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
      if (!result.rows[0]?.locked) {
        done();
        return null;
      }
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    let released = false;
    return {
      store: boundStore(client),
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [key]);
        } catch (err) {
          // Could not confirm the unlock (e.g. the connection is broken). Destroy the connection
          // instead of returning it to the pool: ending the session releases any advisory lock
          // it still holds, so the lock can never outlive this pass. Not rethrown — the lock is
          // released either way, and throwing here would mask the pass's own result.
          done(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        done();
      }
    };
  }

  // Standalone instance methods (used directly by tests/tooling outside a coordinated pass,
  // and by runEffect's non-blocking "lock loser" read) go through the shared pool as before —
  // each is a single, independent query, so there is nothing to reuse a connection across.
  getOperation(identityId: string): Promise<OperationRecord | null> {
    return getOperationImpl(this.pool, identityId);
  }

  createOperation(input: NewOperationInput): Promise<OperationRecord> {
    return createOperationImpl(this.pool, input);
  }

  reserveAttempt(identityId: string, reserved: ReservedAttemptInput, expectedVersion: number): Promise<OperationRecord> {
    return reserveAttemptImpl(this.pool, identityId, reserved, expectedVersion);
  }

  appendAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return appendAttemptImpl(this.pool, identityId, attempt, status, expectedVersion);
  }

  updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return updateLatestAttemptImpl(this.pool, identityId, attempt, status, expectedVersion);
  }

  setStatus(identityId: string, status: OperationStatus, expectedVersion: number): Promise<OperationRecord> {
    return setStatusImpl(this.pool, identityId, status, expectedVersion);
  }

  now(): Promise<Date> {
    return nowImpl(this.pool);
  }
}
