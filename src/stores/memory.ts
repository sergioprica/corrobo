import { StoreConflictError } from "../core/store";
import type { CoordinatedStore, EffectStore, NewOperationInput, OperationLock, OperationUpdate } from "../core/store";
import type { AttemptRecord, OperationRecord, OperationStatus, ReservedAttemptInput } from "../core/types";

/**
 * Deep-copies a record so callers can never mutate stored state (and vice versa), except for
 * `error.raw` on transport/observation errors: that is the caller's own thrown value, passed
 * through as-is, and may be something structuredClone cannot copy (a function, a class
 * instance holding one, ...). It is shared by reference rather than letting one odd thrown
 * value make the whole record uncloneable.
 */
function cloneRecord(record: OperationRecord): OperationRecord {
  const raws: unknown[] = [];
  const stash = <E extends { message: string; raw?: unknown }>(error: E): E => {
    if (!("raw" in error)) return error;
    raws.push(error.raw);
    return { ...error, raw: raws.length - 1 };
  };
  const withoutRaw: OperationRecord = {
    ...record,
    attempts: record.attempts.map((attempt) => {
      if (attempt.status !== "RESOLVED") return attempt;
      return {
        ...attempt,
        transport: attempt.transport.ok ? attempt.transport : { ok: false, error: stash(attempt.transport.error) },
        observations: attempt.observations.map((o) =>
          o.status === "observation_failed" ? { ...o, error: stash(o.error) } : o
        )
      };
    })
  };
  const copy = structuredClone(withoutRaw);
  const restore = (error: { message: string; raw?: unknown }) => {
    if ("raw" in error) error.raw = raws[error.raw as number];
  };
  for (const attempt of copy.attempts) {
    if (attempt.status !== "RESOLVED") continue;
    if (!attempt.transport.ok) restore(attempt.transport.error);
    for (const o of attempt.observations) if (o.status === "observation_failed") restore(o.error);
  }
  return copy;
}

/**
 * In-memory store for tests, examples, and quick local development.
 *
 * LIMITATION: state lives only in process memory. A process restart loses every
 * operation record — there is no crash-survival and no durable-idempotency guarantee.
 * Do not use this for anything where a lost operation identity could cause a duplicate
 * side effect after a restart. Use the Postgres store for that.
 *
 * tryAcquireLock() is a per-identity in-process mutex: it correctly coordinates concurrent
 * runEffect() calls WITHIN one Node process (e.g. two overlapping requests to the same
 * server), but provides no cross-process or distributed guarantee. Use PostgresStore where
 * multiple processes/workers can race the same operation identity.
 */
export class InMemoryStore implements EffectStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly locked = new Set<string>();

  async tryAcquireLock(identityId: string): Promise<OperationLock | null> {
    if (this.locked.has(identityId)) {
      return null;
    }
    this.locked.add(identityId);
    let released = false;
    const scopedStore: CoordinatedStore = this;
    return {
      store: scopedStore,
      release: async () => {
        if (released) return;
        released = true;
        this.locked.delete(identityId);
      }
    };
  }

  async getOperation(identityId: string): Promise<OperationRecord | null> {
    const record = this.records.get(identityId);
    return record ? cloneRecord(record) : null;
  }

  async createOperation(input: NewOperationInput): Promise<OperationRecord> {
    const existing = this.records.get(input.identity.id);
    if (existing) {
      throw new StoreConflictError(input.identity.id, null, existing.version);
    }
    const now = new Date().toISOString();
    const record: OperationRecord = {
      identity: input.identity,
      intent: input.intent,
      status: input.status,
      reviewReason: input.reviewReason,
      attempts: [],
      createdAt: now,
      updatedAt: now,
      version: 0
    };
    this.records.set(input.identity.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async reserveAttempt(
    identityId: string,
    reserved: ReservedAttemptInput,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.write(identityId, expectedVersion, (record) => {
      record.attempts.push({
        status: "RESERVED",
        attemptNumber: reserved.attemptNumber,
        startedAt: reserved.startedAt,
        updatedAt: reserved.startedAt,
        ...(reserved.check ? { check: reserved.check } : {})
      });
    });
  }

  async appendAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.write(identityId, expectedVersion, (record) => {
      record.attempts.push(attempt);
      record.status = status;
    });
  }

  async updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord> {
    return this.write(identityId, expectedVersion, (record) => {
      if (record.attempts.length === 0) {
        throw new Error(`corrobo: operation "${identityId}" has no attempt to update (reserve one first; runEffect() always does)`);
      }
      record.attempts[record.attempts.length - 1] = attempt;
      record.status = status;
    });
  }

  async updateOperation(identityId: string, update: OperationUpdate, expectedVersion: number): Promise<OperationRecord> {
    return this.write(identityId, expectedVersion, (record) => {
      if (update.status !== undefined) record.status = update.status;
      if (update.reviewReason !== undefined) {
        if (update.reviewReason === null) delete record.reviewReason;
        else record.reviewReason = update.reviewReason;
      }
      if (update.blockedBy !== undefined) {
        if (update.blockedBy === null) delete record.blockedBy;
        else record.blockedBy = update.blockedBy;
      }
    });
  }

  /** @deprecated See CoordinatedStore.setStatus. */
  async setStatus(identityId: string, status: OperationStatus, expectedVersion: number): Promise<OperationRecord> {
    return this.write(identityId, expectedVersion, (record) => {
      record.status = status;
    });
  }

  /**
   * Version-checked write: applies `change` to a copy and stores it only if everything
   * succeeded, so a failed write (conflict, missing attempt, uncloneable value) leaves the
   * stored record exactly as it was.
   */
  private write(
    identityId: string,
    expectedVersion: number,
    change: (record: OperationRecord) => void
  ): OperationRecord {
    const current = this.mustGet(identityId);
    if (current.version !== expectedVersion) {
      throw new StoreConflictError(identityId, expectedVersion, current.version);
    }
    const next = cloneRecord(current);
    change(next);
    next.updatedAt = new Date().toISOString();
    next.version = current.version + 1;
    const stored = cloneRecord(next);
    this.records.set(identityId, stored);
    return cloneRecord(stored);
  }

  private mustGet(identityId: string): OperationRecord {
    const record = this.records.get(identityId);
    if (!record) {
      throw new Error(
        `corrobo: no operation "${identityId}" in this store. Store write methods are called by runEffect() on ` +
          `operations it created; if you're calling them directly, create the operation first.`
      );
    }
    return record;
  }
}
