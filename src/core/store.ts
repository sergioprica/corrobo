import type {
  AttemptRecord,
  BlockingCheck,
  OperationIdentity,
  RecordedReview,
  OperationRecord,
  OperationStatus,
  ReasonCode,
  ReservedAttemptInput
} from "./types";

/**
 * Thrown by a store write whose `expectedVersion` no longer matches the record — someone else
 * wrote to this operation since it was read. runEffect() treats this as "this pass no longer
 * owns the operation": it discards its own pending write and returns the current record.
 */
export class StoreConflictError extends Error {
  readonly identityId: string;
  /** The version the write was based on, or null for a create that expected no record to exist. */
  readonly expectedVersion: number | null;
  readonly actualVersion: number;

  constructor(identityId: string, expectedVersion: number | null, actualVersion: number) {
    super(
      expectedVersion === null
        ? `corrobo: operation identity "${identityId}" already exists; this create was not applied.`
        : `corrobo: operation "${identityId}" was modified concurrently ` +
            `(expected version ${expectedVersion}, found ${actualVersion}); this write was not applied.`
    );
    this.name = "StoreConflictError";
    this.identityId = identityId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface NewOperationInput {
  identity: OperationIdentity;
  intent: unknown;
  status: OperationStatus;
  reviewReason?: ReasonCode;
}

/**
 * Fields of the operation itself (not its attempts) that runEffect() changes. A field that is
 * absent is left as it is; `null` clears it.
 */
export interface OperationUpdate {
  status?: OperationStatus;
  reviewReason?: ReasonCode | null;
  blockedBy?: BlockingCheck | null;
  review?: RecordedReview | null;
}

/**
 * The store operations a coordinated runEffect() pass actually needs. Exposed both as
 * instance methods on EffectStore itself (for standalone/test use outside a lock) and as
 * OperationLock.store (bound to whatever session/connection holds the lock, so a pass never
 * needs a second connection for its own bookkeeping — see PostgresStore).
 *
 * Fencing: every write names the `version` of the record it was based on and must be applied
 * atomically only if the stored version still equals it (then increment it by one); otherwise
 * it must throw StoreConflictError and change nothing. The lock keeps concurrent passes apart
 * in the normal case; versions keep a pass that silently lost its lock (e.g. its database
 * session died while execute() was still running) from overwriting another pass's record.
 */
export interface CoordinatedStore {
  getOperation(identityId: string): Promise<OperationRecord | null>;

  /** Must throw StoreConflictError (expectedVersion null) if identityId already exists. Returns version 0. */
  createOperation(input: NewOperationInput): Promise<OperationRecord>;

  /**
   * Durably records that an attempt is about to be made, BEFORE execute() is ever called.
   * This is what lets a restart distinguish "never attempted" from "attempted, outcome
   * unknown" — see runtime.ts's crash-recovery path.
   */
  reserveAttempt(identityId: string, reserved: ReservedAttemptInput, expectedVersion: number): Promise<OperationRecord>;

  appendAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord>;

  /**
   * Replaces the latest attempt (RESERVED -> RESOLVED, or adding an observation to a resolved
   * attempt). Must throw if the operation has no attempts.
   */
  updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus,
    expectedVersion: number
  ): Promise<OperationRecord>;

  /** Applies `update` to the operation's own fields (see OperationUpdate), version-checked like every write. */
  updateOperation(identityId: string, update: OperationUpdate, expectedVersion: number): Promise<OperationRecord>;

  /** @deprecated runEffect() no longer calls this; use updateOperation({ status }). It will be removed in 0.5. */
  setStatus(identityId: string, status: OperationStatus, expectedVersion: number): Promise<OperationRecord>;

  /**
   * Optional shared clock for time-based safety decisions: when an attempt started, and whether
   * its in-flight window (EffectContract.maxInFlightMs) has passed. Those two readings may come
   * from different processes on different hosts, so they must come from one clock; a store
   * backed by a shared database should read the database's clock (PostgresStore does). When
   * omitted, the local process clock is used — fine for a single host, not across hosts.
   */
  now?(): Promise<Date>;
}

export interface OperationLock {
  /** Store operations bound to this lock's session — use these, not the outer store, for the duration of a coordinated pass. */
  store: CoordinatedStore;
  /** Must be called exactly once, however the pass concludes (success or throw). */
  release(): Promise<void>;
}

/**
 * Minimal persistence surface for the reliability lifecycle. Deliberately narrow:
 * operation identity, intent, attempts, and their outcomes — not an audit platform.
 */
export interface EffectStore extends CoordinatedStore {
  /**
   * Non-blocking attempt to become the sole coordinator of this operation identity for the
   * duration of one runEffect() pass. Returns null immediately if another caller already
   * holds it — callers MUST NOT wait/retry internally; the loser returns the operation's
   * current recorded state (or an "in progress" placeholder) and it is up to the application
   * to call run() again if it needs a fresher answer. Must survive a crash without leaving a
   * permanent lock: PostgresStore uses a session-scoped advisory lock (released automatically
   * if the connection dies), InMemoryStore uses an in-process mutex (no cross-process meaning).
   */
  tryAcquireLock(identityId: string): Promise<OperationLock | null>;
}
