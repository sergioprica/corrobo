import { decideDisposition } from "./disposition";
import type { DecideDispositionResult } from "./disposition";
import { fingerprintIntent } from "./fingerprint";
import { StoreConflictError } from "./store";
import type { CoordinatedStore, EffectStore } from "./store";
import type {
  AttemptRecord,
  EffectContract,
  EffectRequest,
  EffectResult,
  EvidenceState,
  ObservationResult,
  OperationRecord,
  OperationStatus,
  ReasonCode,
  ReservedAttempt,
  ResolvedAttempt,
  TransportOutcome
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The clock for safety-relevant times (attempt start, in-flight window checks): the store's
 * shared clock when it has one, otherwise this process's. See CoordinatedStore.now.
 */
async function safetyNow(store: CoordinatedStore): Promise<string> {
  return store.now ? (await store.now()).toISOString() : nowIso();
}

/**
 * A plain string for the persisted error message. Uses an Error's (or an Error-like thrown
 * object's) own `message`; never serializes the thrown value itself, which can carry request
 * headers or response bodies — that is what `error.raw` is for, and PostgresStore strips it.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function defaultReviewReason(): ReasonCode {
  return {
    code: "POLICY_REVIEW_REQUIRED",
    summary: "This operation requires human authorization before it will be attempted."
  };
}

/** Returned to a caller who lost the coordination race and finds no record yet — vanishingly
 *  rare (it means the winner's createOperation hasn't committed at the instant this reads),
 *  but must still be represented honestly rather than guessed at. */
function resultForInProgress<Observation>(identity: OperationRecord["identity"]): EffectResult<Observation> {
  return {
    identity,
    status: "OPEN",
    evidenceState: null,
    disposition: null,
    evidenceReason: null,
    dispositionReason: {
      code: "OPERATION_IN_PROGRESS",
      summary: "Another caller is currently executing this operation. Call run() again shortly for a result."
    },
    observation: null,
    attempts: [],
    retryNotBefore: null
  };
}

/**
 * Throws if this identity was already used for a logically different operation — a different
 * operationType, or the same operationType with a different intent. Never silently return one
 * operation's result for what is actually a second, unrelated request under the same id.
 */
function assertSameLogicalOperation<Intent>(
  contract: EffectContract<Intent, unknown, unknown>,
  request: EffectRequest<Intent>,
  existing: OperationRecord
): void {
  if (existing.identity.operationType !== contract.operationType) {
    throw new Error(
      `corrobo: operation identity "${request.identity.id}" was already used with operationType ` +
        `"${existing.identity.operationType}", but this call uses "${contract.operationType}". ` +
        `Two logically different operations must not share the same identity.`
    );
  }
  const existingFingerprint = fingerprintIntent(contract, existing.intent as Intent);
  const requestFingerprint = fingerprintIntent(contract, request.intent);
  if (existingFingerprint !== requestFingerprint) {
    throw new Error(
      `corrobo: operation identity "${request.identity.id}" was already used with a different intent ` +
        `(operationType "${contract.operationType}"). Two logically different operations must not share the same identity.`
    );
  }
}

/** execute() is caught here — a throw or timeout becomes transport evidence, never an uncaught rejection. */
async function safeExecute<Intent, Evidence>(
  contract: EffectContract<Intent, unknown, Evidence>,
  intent: Intent,
  identity: OperationRecord["identity"],
  attemptNumber: number
): Promise<TransportOutcome<Evidence>> {
  try {
    const evidence = await contract.execute({ intent, identity, attemptNumber });
    return { ok: true, evidence };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err), raw: err } };
  }
}

/** observe() is caught here — a throw becomes observation_failed, never UNKNOWN by accident being skipped. */
async function safeObserve<Intent, Observation, Evidence>(
  contract: EffectContract<Intent, Observation, Evidence>,
  intent: Intent,
  identity: OperationRecord["identity"],
  transport: TransportOutcome<Evidence>,
  attemptStartedAt: string
): Promise<ObservationResult<Observation>> {
  try {
    return await contract.observe({ intent, identity, transport, attemptStartedAt });
  } catch (err) {
    return {
      status: "observation_failed",
      error: { message: errorMessage(err), raw: err },
      source: contract.operationType,
      observedAt: nowIso()
    };
  }
}

function resultFromRecord<Observation>(record: OperationRecord): EffectResult<Observation> {
  const latest = record.attempts[record.attempts.length - 1];

  if (!latest) {
    // No attempt exists at all: either still AWAITING_REVIEW, or CLOSED because a review was
    // rejected before execute() was ever called (see runCoordinated).
    const dispositionReason =
      record.status === "CLOSED"
        ? {
            code: "POLICY_REVIEW_REJECTED",
            summary: "This operation was reviewed and rejected; it will not be attempted."
          }
        : (record.reviewReason ?? defaultReviewReason());
    return {
      identity: record.identity,
      status: record.status,
      evidenceState: null,
      disposition: "REVIEW",
      evidenceReason: null,
      dispositionReason,
      observation: null,
      attempts: record.attempts,
      retryNotBefore: null
    };
  }

  if (latest.status === "RESERVED") {
    return {
      identity: record.identity,
      status: record.status,
      evidenceState: null,
      disposition: null,
      evidenceReason: null,
      dispositionReason: {
        code: "ATTEMPT_IN_PROGRESS",
        summary: "An attempt has been reserved but not yet resolved. Call run() again shortly for a result."
      },
      observation: null,
      attempts: record.attempts,
      retryNotBefore: null
    };
  }

  const latestObservation = latest.observations[latest.observations.length - 1] ?? null;
  return {
    identity: record.identity,
    status: record.status,
    evidenceState: latest.evidenceState,
    disposition: latest.disposition,
    evidenceReason: latest.evidenceReason,
    dispositionReason: latest.dispositionReason,
    observation: latestObservation as ObservationResult<Observation> | null,
    attempts: record.attempts,
    retryNotBefore: latest.retryNotBefore ?? null
  };
}

function decide(
  contract: EffectContract<unknown, unknown, unknown>,
  evidenceState: EvidenceState,
  attemptNumber: number,
  transport: TransportOutcome<unknown>,
  attemptStartedAt: string,
  now: string
): DecideDispositionResult {
  return decideDisposition({
    evidenceState,
    attemptNumber,
    retryPolicy: contract.retryPolicy,
    settlement: {
      transportOk: transport.ok,
      attemptStartedAt,
      now,
      maxInFlightMs: contract.maxInFlightMs
    }
  });
}

/** OPEN while something further is expected (a retry, or convergence); CLOSED otherwise. */
function statusAfter(evidenceState: EvidenceState, disposition: ResolvedAttempt["disposition"]): OperationStatus {
  return disposition === "RETRY" || evidenceState === "PENDING" ? "OPEN" : "CLOSED";
}

/**
 * Builds the resolved form of an attempt from one observation. `previous` carries earlier
 * observations when an already-resolved attempt is re-observed (PENDING, or a settlement check
 * before a delayed retry); its old retryNotBefore is deliberately not carried over.
 */
function resolveAttempt(
  contract: EffectContract<unknown, unknown, unknown>,
  base: { attemptNumber: number; startedAt: string },
  transport: TransportOutcome<unknown>,
  observations: ObservationResult<unknown>[],
  reconciliation: { evidenceState: EvidenceState; reason: ReasonCode },
  now: string
): ResolvedAttempt {
  const decision = decide(contract, reconciliation.evidenceState, base.attemptNumber, transport, base.startedAt, now);
  const attempt: ResolvedAttempt = {
    status: "RESOLVED",
    attemptNumber: base.attemptNumber,
    startedAt: base.startedAt,
    updatedAt: nowIso(),
    transport,
    observations,
    evidenceState: reconciliation.evidenceState,
    evidenceReason: reconciliation.reason,
    disposition: decision.disposition,
    dispositionReason: decision.reason
  };
  if (decision.retryNotBefore) {
    attempt.retryNotBefore = decision.retryNotBefore;
  }
  return attempt;
}

/**
 * Reserves an attempt, then attempts the real side effect. Reservation is durably persisted
 * BEFORE execute() is called, specifically so a crash between a successful execute() and this
 * function's final persist can never be mistaken, on restart, for "never attempted" — see
 * recoverReservedAttempt below, which is what actually runs in that case.
 *
 * Both writes are version-checked: if another pass wrote to this operation in between (this
 * pass's lock was lost), the reservation or the final resolve throws StoreConflictError and
 * nothing of this pass's is persisted over the other's (see runEffect).
 */
async function performAttempt<Intent, Observation, Evidence>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  record: OperationRecord,
  intent: Intent
): Promise<EffectResult<Observation>> {
  const attemptNumber = record.attempts.length + 1;
  const startedAt = await safetyNow(store);

  const reservedRecord = await store.reserveAttempt(record.identity.id, { attemptNumber, startedAt }, record.version);

  const transport = await safeExecute(contract, intent, record.identity, attemptNumber);
  const observation = await safeObserve(contract, intent, record.identity, transport, startedAt);
  const reconciliation = contract.reconcile({ intent, transport, observation });

  const attempt = resolveAttempt(
    contract as EffectContract<unknown, unknown, unknown>,
    { attemptNumber, startedAt },
    transport as TransportOutcome<unknown>,
    [observation as ObservationResult<unknown>],
    reconciliation,
    await safetyNow(store)
  );
  const updated = await store.updateLatestAttempt(
    record.identity.id,
    attempt,
    statusAfter(attempt.evidenceState, attempt.disposition),
    reservedRecord.version
  );
  return resultFromRecord(updated);
}

/**
 * Restart-time recovery for an attempt that was reserved but never resolved (the process died
 * — or lost its lock — somewhere between execute() being called and the outcome being
 * persisted). Never calls execute() again here — goes straight to observe()/reconcile() using
 * an honest "transport outcome unknown" value, exactly the same ok:false shape used for a
 * genuine execute() throw. Because the transport outcome is unknown, the original request may
 * still be in flight, so a NOT_APPLIED observation is subject to the same settlement rule as a
 * timed-out execute() (see EffectContract.maxInFlightMs): it never becomes an immediate RETRY
 * unless the in-flight window has already passed.
 */
async function recoverReservedAttempt<Intent, Observation, Evidence>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  record: OperationRecord,
  intent: Intent,
  reserved: ReservedAttempt
): Promise<EffectResult<Observation>> {
  const transport: TransportOutcome<Evidence> = {
    ok: false,
    error: {
      message:
        "This attempt was reserved before execute() ran, but no resolution was ever recorded " +
        "(the process may have restarted mid-attempt). The transport outcome of execute() is unknown."
    }
  };

  const observation = await safeObserve(contract, intent, record.identity, transport, reserved.startedAt);
  const reconciliation = contract.reconcile({ intent, transport, observation });

  const attempt = resolveAttempt(
    contract as EffectContract<unknown, unknown, unknown>,
    reserved,
    transport as TransportOutcome<unknown>,
    [observation as ObservationResult<unknown>],
    reconciliation,
    await safetyNow(store)
  );
  const updated = await store.updateLatestAttempt(
    record.identity.id,
    attempt,
    statusAfter(attempt.evidenceState, attempt.disposition),
    record.version
  );
  return resultFromRecord(updated);
}

/**
 * Re-observes the latest, already-resolved attempt WITHOUT re-executing the mutation, and
 * re-decides from the new observation. Used for PENDING (awaiting convergence) and for the
 * settlement check that precedes a delayed RETRY (catching a late landing before a new
 * attempt). Returns the persisted record so the caller can continue from it.
 */
async function reObserve<Intent, Observation, Evidence>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  record: OperationRecord,
  intent: Intent,
  latest: ResolvedAttempt
): Promise<OperationRecord> {
  const transport = latest.transport as TransportOutcome<Evidence>;
  const observation = await safeObserve(contract, intent, record.identity, transport, latest.startedAt);
  const reconciliation = contract.reconcile({ intent, transport, observation });

  const attempt = resolveAttempt(
    contract as EffectContract<unknown, unknown, unknown>,
    latest,
    latest.transport,
    [...latest.observations, observation as ObservationResult<unknown>],
    reconciliation,
    await safetyNow(store)
  );
  return store.updateLatestAttempt(
    record.identity.id,
    attempt,
    statusAfter(attempt.evidenceState, attempt.disposition),
    record.version
  );
}

/**
 * Runs one lifecycle pass for the given intent/identity. Safe to call repeatedly with the
 * same identity: it only invokes execute() when doing so is actually safe (see docs/v0.1-spec.md).
 *
 * Coordination: the whole pass runs while holding store.tryAcquireLock(identity.id), using the
 * lock's own bound store (lock.store) for every operation in the pass, so two genuinely
 * concurrent callers for the SAME identity can never both reach execute(), and one in-flight
 * identity never needs more than the one session/connection its lock already holds. The loser
 * does not block — it returns the operation's current recorded state (or an honest
 * "in progress" placeholder) immediately. Different identities never serialize against each
 * other. See docs/v0.1-spec.md for the exact guarantee this does and does not provide.
 */
export async function runEffect<Intent, Observation, Evidence>(
  store: EffectStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  request: EffectRequest<Intent>
): Promise<EffectResult<Observation>> {
  // Validates the intent before anything else happens: an intent that can't be fingerprinted
  // faithfully (see canonicalStringify) is rejected here, never after an effect has been made.
  fingerprintIntent(contract, request.intent);
  const lock = await store.tryAcquireLock(request.identity.id);
  if (!lock) {
    const existing = await store.getOperation(request.identity.id);
    if (!existing) {
      return resultForInProgress(request.identity);
    }
    assertSameLogicalOperation(contract, request, existing);
    return resultFromRecord(existing);
  }
  try {
    return await runCoordinated(lock.store, contract, request);
  } catch (err) {
    if (!(err instanceof StoreConflictError)) {
      throw err;
    }
    // Another pass wrote to this operation after this one read it — this pass's lock was lost
    // (e.g. its database session died mid-execute). Its own pending write was rejected, not
    // applied; report what is actually recorded now instead of guessing.
    // Re-read through the outer store: the lock's own connection may be the thing that died.
    const current = await store.getOperation(request.identity.id);
    if (!current) {
      throw err;
    }
    assertSameLogicalOperation(contract, request, current);
    return resultFromRecord(current);
  } finally {
    await lock.release();
  }
}

async function runCoordinated<Intent, Observation, Evidence>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  request: EffectRequest<Intent>
): Promise<EffectResult<Observation>> {
  const existing = await store.getOperation(request.identity.id);

  if (existing) {
    assertSameLogicalOperation(contract, request, existing);
  }

  if (!existing) {
    const auth = contract.authorize ? await contract.authorize(request.intent) : { requiresReview: false };
    const initialStatus: OperationStatus = auth.requiresReview ? "AWAITING_REVIEW" : "OPEN";
    const created = await store.createOperation({
      identity: request.identity,
      intent: request.intent,
      status: initialStatus,
      reviewReason: auth.requiresReview ? (auth.reason ?? defaultReviewReason()) : undefined
    });

    if (auth.requiresReview) {
      return resultFromRecord(created);
    }
    return await performAttempt(store, contract, created, request.intent);
  }

  if (existing.status === "CLOSED") {
    return resultFromRecord(existing);
  }

  if (existing.status === "AWAITING_REVIEW") {
    if (request.reviewDecision === "rejected") {
      const closed = await store.setStatus(existing.identity.id, "CLOSED", existing.version);
      return resultFromRecord(closed);
    }
    if (request.reviewDecision !== "approved") {
      return resultFromRecord(existing);
    }
    const reopened = await store.setStatus(existing.identity.id, "OPEN", existing.version);
    return await performAttempt(store, contract, reopened, request.intent);
  }

  // status === "OPEN"
  const latest = existing.attempts[existing.attempts.length - 1];
  if (!latest) {
    return await performAttempt(store, contract, existing, request.intent);
  }

  if (latest.status === "RESERVED") {
    return await recoverReservedAttempt(store, contract, existing, request.intent, latest);
  }

  if (latest.evidenceState === "PENDING") {
    return resultFromRecord(await reObserve(store, contract, existing, request.intent, latest));
  }

  if (latest.disposition === "RETRY") {
    if (latest.transport.ok) {
      // execute() returned a response: that request is finished, the NOT_APPLIED was final.
      return await performAttempt(store, contract, existing, request.intent);
    }
    // The failed request could still land. Nothing happens before retryNotBefore.
    if (latest.retryNotBefore && Date.parse(await safetyNow(store)) < Date.parse(latest.retryNotBefore)) {
      return resultFromRecord(existing);
    }
    // Settlement check: observe again and re-decide under the current rules before any new
    // attempt. A late landing shows up here as APPLIED (→ COMPLETE, no new attempt). This also
    // covers RETRYs recorded without a settlement window (e.g. by corrobo 0.2.x): with no
    // maxInFlightMs they now become INVESTIGATE instead of executing.
    const settled = await reObserve(store, contract, existing, request.intent, latest);
    const settledLatest = settled.attempts[settled.attempts.length - 1];
    if (
      settled.status === "OPEN" &&
      settledLatest?.status === "RESOLVED" &&
      settledLatest.disposition === "RETRY" &&
      !settledLatest.retryNotBefore
    ) {
      return await performAttempt(store, contract, settled, request.intent);
    }
    return resultFromRecord(settled);
  }

  // OPEN with a resolved latest attempt that is neither PENDING nor RETRY shouldn't occur
  // (performAttempt/reObserve/recoverReservedAttempt always close otherwise) — return current
  // state rather than guessing.
  return resultFromRecord(existing);
}
