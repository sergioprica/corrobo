import { decideDisposition } from "./disposition";
import type { DecideDispositionResult } from "./disposition";
import { canonicalStringify, fingerprintIntent, materializeIntent } from "./fingerprint";
import { StoreConflictError } from "./store";
import type { CoordinatedStore, EffectStore } from "./store";
import type {
  AttemptRecord,
  BlockingCheck,
  EffectContract,
  EffectRequest,
  EffectResult,
  EvidenceState,
  ObservationResult,
  OperationIdentity,
  OperationRecord,
  OperationStatus,
  PreExecuteCheck,
  ReasonCode,
  RecordedReview,
  ReviewDecision,
  ReviewRequest,
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
  // Whatever was thrown is caller-controlled and may itself throw (a getter, a Proxy, a toString
  // that throws). Reading it must never abort the pass: the effect may already have happened.
  try {
    if (err !== null && typeof err === "object") {
      const message: unknown = (err as { message?: unknown }).message; // read exactly once
      if (typeof message === "string") return message;
    }
    return String(err);
  } catch {
    return "(the thrown value could not be converted to a message)";
  }
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
    retryNotBefore: null,
    review: null
  };
}

/**
 * Throws if this identity was already used for a logically different operation — a different
 * operationType, or the same operationType with a different intent. Never silently return one
 * operation's result for what is actually a second, unrelated request under the same id.
 */
/**
 * The request's intent as it will be stored, read once per runEffect() call. With the default
 * fingerprint, `stored` is the plain-JSON form (see materializeIntent) and `fingerprint` is
 * computed from it, so what is fingerprinted is exactly what is persisted. With a contract's own
 * fingerprintIntent(), the intent is stored as given and fingerprinted lazily, only when there
 * is an existing record to compare against.
 */
interface PreparedIntent {
  stored: unknown;
  fingerprint: string | null;
}

function prepareIntent<Intent>(contract: EffectContract<Intent, unknown, unknown>, intent: Intent): PreparedIntent {
  if (contract.fingerprintIntent) {
    return { stored: intent, fingerprint: null };
  }
  const stored = materializeIntent(intent);
  return { stored, fingerprint: canonicalStringify(stored) };
}

/** A review decision after validation; the deprecated runEffect() strings have reviewer null. */
type ValidDecision = Omit<ReviewDecision, "reviewer"> & { reviewer: string | null };

/** An EffectRequest after identity shorthand is resolved (see runEffect). */
type ResolvedRequest<Intent, Context = unknown> = Omit<EffectRequest<Intent, Context>, "identity" | "reviewDecision"> & {
  identity: OperationIdentity;
  /** The deprecated reviewDecision string, as a decision with no reviewer. */
  review?: ValidDecision;
};

/**
 * Thrown by reviewEffect() when another call holds this operation right now (it is being
 * attempted, re-observed or reviewed). Nothing was recorded; try again shortly.
 */
export class OperationBusyError extends Error {
  readonly identityId: string;
  constructor(identityId: string) {
    super(`corrobo: operation "${identityId}" is busy (another call holds it); the review decision was not recorded. Try again.`);
    this.name = "OperationBusyError";
    this.identityId = identityId;
  }
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/i;

/**
 * A strict, absolute RFC 3339 timestamp (`Z` or an explicit offset) that names a real calendar
 * time in years 0000–9999, canonicalized to `toISOString()` form; otherwise null. Leap seconds
 * (`:60`) are rejected because a JavaScript Date can't represent them. Deliberately not Date.parse(),
 * which accepts other formats, rolls 30 February over to March, and reads a time without an
 * offset in the host's local zone, so two workers could disagree about when an approval expires.
 */
function canonicalTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = RFC3339.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offsetOk = m[8].toUpperCase() === "Z" || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || !offsetOk) {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const canonical = new Date(ms).toISOString();
  // An offset can carry a time outside four-digit years (e.g. 9999-12-31T23:59:59-23:59);
  // that would be stored in a form that isn't RFC 3339 and couldn't be read back by this check.
  return /^\d{4}-/.test(canonical) ? canonical : null;
}

/** runEffect()'s deprecated reviewDecision: only the two strings; a decision object belongs to reviewEffect(). */
function legacyReviewDecision(input: unknown): ValidDecision | undefined {
  if (input === undefined) return undefined;
  if (input === "approved" || input === "rejected") return { decision: input, reviewer: null };
  throw new TypeError(
    `corrobo: runEffect()'s reviewDecision only accepts the deprecated "approved" / "rejected". Record a ` +
      `ReviewDecision with reviewEffect(), then call runEffect() to act on it; nothing was recorded or executed.`
  );
}

/** Validates a ReviewDecision before anything runs: a malformed approval must never count as one. */
function parseReviewDecision(input: unknown): ValidDecision {
  const fail = (problem: string): never => {
    throw new TypeError(`corrobo: the review decision ${problem}; nothing was recorded.`);
  };
  if (typeof input !== "object" || input === null) fail(`must be a ReviewDecision object`);
  // Each field is read exactly once, so what is validated is what is recorded.
  const { decision, reviewer, decidedAt, expiresAt, intentFingerprint, note } = input as ReviewDecision;
  if (decision !== "approved" && decision !== "rejected") fail(`.decision must be "approved" or "rejected"`);
  if (typeof reviewer !== "string" || reviewer.trim() === "") fail(`.reviewer must be a non-empty string`);
  const timeFormat = `an RFC 3339 timestamp with Z or an offset, e.g. "2026-10-01T12:00:00Z"`;
  const decided = decidedAt === undefined ? undefined : (canonicalTime(decidedAt) ?? fail(`.decidedAt must be ${timeFormat}`));
  let expires: string | undefined;
  if (expiresAt !== undefined) {
    if (decision !== "approved") fail(`.expiresAt applies only to approvals`);
    expires = canonicalTime(expiresAt) ?? fail(`.expiresAt must be ${timeFormat}`);
    if (decided !== undefined && Date.parse(expires) <= Date.parse(decided)) {
      fail(`.expiresAt must be after .decidedAt`);
    }
  }
  if (intentFingerprint !== undefined && typeof intentFingerprint !== "string") fail(`.intentFingerprint must be a string`);
  if (note !== undefined && typeof note !== "string") fail(`.note must be a string`);
  const review: ValidDecision = { decision, reviewer };
  if (decided !== undefined) review.decidedAt = decided;
  if (expires !== undefined) review.expiresAt = expires;
  if (intentFingerprint !== undefined) review.intentFingerprint = intentFingerprint;
  if (note !== undefined) review.note = note;
  return review;
}

function resolveRequest<Intent, Context>(
  contract: EffectContract<Intent, unknown, unknown, Context>,
  input: EffectRequest<Intent, Context>
): ResolvedRequest<Intent, Context> {
  const { reviewDecision, ...rest } = input;
  const review = legacyReviewDecision(reviewDecision);
  const request: Omit<ResolvedRequest<Intent, Context>, "identity"> & { identity: OperationIdentity | string } =
    review ? { ...rest, review } : rest;
  return { ...request, identity: resolveIdentity(contract as EffectContract<unknown, unknown, unknown>, request.identity) };
}

/** A string id is shorthand for { id, operationType: contract.operationType }; an object's type must match. */
function resolveIdentity(contract: EffectContract<unknown, unknown, unknown>, identity: OperationIdentity | string): OperationIdentity {
  if (typeof identity === "string") {
    return { id: identity, operationType: contract.operationType };
  }
  if (identity?.operationType !== contract.operationType) {
    throw new Error(
      `corrobo: this request's identity says operationType "${identity?.operationType}", but the ` +
        `contract is "${contract.operationType}". Pass identity as a plain string id to use the contract's ` +
        `operationType, or run it with the matching contract.`
    );
  }
  return identity;
}

function assertSameLogicalOperation<Intent>(
  contract: EffectContract<Intent, unknown, unknown, any>,
  request: ResolvedRequest<Intent, any>,
  prepared: PreparedIntent,
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
  const requestFingerprint = prepared.fingerprint ?? fingerprintIntent(contract, request.intent);
  if (existingFingerprint !== requestFingerprint) {
    throw new Error(
      `corrobo: operation identity "${request.identity.id}" was already used with a different intent ` +
        `(operationType "${contract.operationType}"). Two logically different operations must not share the same identity: ` +
        `use a new identity for the new intent, or a fingerprintIntent() that ignores fields that don't change the effect.`
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

/**
 * The result for an operation whose current state was set before any (further) attempt: it is
 * awaiting review, was rejected in review, or revalidate() stopped the next attempt. Evidence
 * from the latest resolved attempt, if any, is still reported: a revalidation that stops
 * attempt 2 doesn't change what attempt 1 found.
 */
function resultBeforeAttempt<Observation>(
  record: OperationRecord,
  disposition: EffectResult<Observation>["disposition"],
  dispositionReason: ReasonCode
): EffectResult<Observation> {
  const latest = record.attempts[record.attempts.length - 1];
  const resolved = latest?.status === "RESOLVED" ? latest : undefined;
  const observation = resolved?.observations[resolved.observations.length - 1] ?? null;
  return {
    identity: record.identity,
    status: record.status,
    evidenceState: resolved?.evidenceState ?? null,
    disposition,
    evidenceReason: resolved?.evidenceReason ?? null,
    dispositionReason,
    observation: observation as ObservationResult<Observation> | null,
    attempts: record.attempts,
    retryNotBefore: null,
    review: record.review ?? null
  };
}

function rejectedInReview(review: RecordedReview | undefined): ReasonCode {
  return {
    code: "POLICY_REVIEW_REJECTED",
    summary: `This operation was reviewed and rejected${review?.reviewer ? ` by ${review.reviewer}` : ""}; nothing more will be attempted.`
  };
}

/** The check that stopped the next attempt, if it still describes the record (see BlockingCheck). */
function currentBlock(record: OperationRecord): BlockingCheck | null {
  const blocked = record.blockedBy;
  return blocked && blocked.recordVersion === record.version ? blocked : null;
}

function resultFromRecord<Observation>(record: OperationRecord): EffectResult<Observation> {
  if (record.status === "AWAITING_REVIEW") {
    return resultBeforeAttempt(record, "REVIEW", record.reviewReason ?? defaultReviewReason());
  }
  if (record.status === "CLOSED" && record.review?.decision === "rejected") {
    return resultBeforeAttempt(record, "REVIEW", rejectedInReview(record.review));
  }

  const blocked = currentBlock(record);
  if (blocked?.outcome === "reject") {
    return resultBeforeAttempt(record, "REPLAN", blocked.reason);
  }
  if (blocked?.outcome === "failed") {
    return resultBeforeAttempt(record, null, blocked.reason);
  }

  const latest = record.attempts[record.attempts.length - 1];

  // CLOSED, yet the latest attempt didn't close it (there is none, or it asked for a retry):
  // the only remaining way to close an operation is a review rejection before the next attempt
  // (this covers rejections recorded by corrobo 0.3.x, which kept no review record).
  const latestLeftItOpen =
    latest?.status === "RESOLVED" && statusAfter(latest.evidenceState, latest.disposition) === "OPEN";
  if (record.status === "CLOSED" && (!latest || latestLeftItOpen)) {
    return resultBeforeAttempt(record, "REVIEW", rejectedInReview(record.review));
  }

  if (!latest) {
    if (record.review?.decision === "approved") {
      return resultBeforeAttempt(record, null, {
        code: "REVIEW_APPROVED",
        summary:
          `Approved in review${record.review.reviewer ? ` by ${record.review.reviewer}` : ""}; not attempted yet. ` +
          "The next runEffect() call checks the approval and makes the attempt."
      });
    }
    // Otherwise an operation with no attempt is AWAITING_REVIEW, CLOSED (above), or OPEN only
    // for the instant before its first reservation. Report it as not yet attempted.
    return resultBeforeAttempt(record, null, {
      code: "OPERATION_IN_PROGRESS",
      summary: "No attempt has been recorded yet. Call run() again shortly for a result."
    });
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
      retryNotBefore: null,
      review: record.review ?? null
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
    retryNotBefore: latest.retryNotBefore ?? null,
    review: record.review ?? null
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
  base: { attemptNumber: number; startedAt: string; check?: PreExecuteCheck },
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
  if (base.check) {
    attempt.check = base.check;
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
  base: AttemptBase,
  intent: Intent,
  check?: PreExecuteCheck
): Promise<EffectResult<Observation>> {
  const { identity, attemptNumber } = base;
  // With a check, the attempt starts at the reading the check was made against (an approval's
  // expiry is judged at the attempt's start time, not some earlier moment).
  const startedAt = check ? check.checkedAt : await safetyNow(store);

  const reservedRecord = await store.reserveAttempt(
    identity.id,
    check ? { attemptNumber, startedAt, check } : { attemptNumber, startedAt },
    base.version
  );

  const transport = await safeExecute(contract, intent, identity, attemptNumber);
  const observation = await safeObserve(contract, intent, identity, transport, startedAt);
  const reconciliation = contract.reconcile({ intent, transport, observation });

  const attempt = resolveAttempt(
    contract as EffectContract<unknown, unknown, unknown>,
    check ? { attemptNumber, startedAt, check } : { attemptNumber, startedAt },
    transport as TransportOutcome<unknown>,
    [observation as ObservationResult<unknown>],
    reconciliation,
    await safetyNow(store)
  );
  const updated = await store.updateLatestAttempt(
    identity.id,
    attempt,
    statusAfter(attempt.evidenceState, attempt.disposition),
    reservedRecord.version
  );
  return resultFromRecord(updated);
}

function approvedReason(approval: RecordedReview): ReasonCode {
  return {
    code: "REVIEW_APPROVED",
    summary: `Approved in review${approval.reviewer ? ` by ${approval.reviewer}` : ""}.`
  };
}

/**
 * corrobo's own checks of a recorded approval before each attempt: it must still apply to the
 * recorded intent, and must not have expired. Either problem sends the operation back to review.
 */
function checkApproval(
  contract: EffectContract<any, unknown, unknown, any>,
  record: OperationRecord,
  approval: RecordedReview,
  now: string
): ReasonCode | null {
  if (fingerprintIntent(contract, record.intent) !== approval.intentFingerprint) {
    return {
      code: "APPROVAL_INTENT_MISMATCH",
      summary: "The recorded approval was given for a different intent than the one recorded for this operation. It needs a new review."
    };
  }
  if (approval.expiresAt !== undefined && Date.parse(now) >= Date.parse(approval.expiresAt)) {
    return {
      code: "APPROVAL_EXPIRED",
      summary: `The approval expired at ${approval.expiresAt}, before this attempt. Nothing was executed; it needs a new review.`,
      metadata: { expiresAt: approval.expiresAt }
    };
  }
  return null;
}

const APPROVAL_NOT_RECORDED: ReasonCode = {
  code: "APPROVAL_NOT_RECORDED",
  summary:
    "This operation was approved before corrobo recorded review decisions (0.3.x), so there is no record of who " +
    "approved what. Nothing was executed; it needs a new review."
};

/** What performAttempt needs from the record, read before revalidate() sees the record. */
interface AttemptBase {
  identity: OperationIdentity;
  version: number;
  attemptNumber: number;
}

const REVALIDATION_DEFAULT_REASONS: Record<RevalidationOutcome, ReasonCode> = {
  proceed: { code: "REVALIDATION_PASSED", summary: "revalidate() allowed this attempt." },
  requiresReview: {
    code: "REVALIDATION_REQUIRES_REVIEW",
    summary: "revalidate() requires human review before this attempt is made. Nothing was executed."
  },
  reject: {
    code: "REVALIDATION_REJECTED",
    summary:
      "revalidate() rejected this attempt. Nothing was executed, and this operation will not be attempted again; " +
      "if the action is still wanted, it needs a fresh decision and a new identity."
  }
};

type RevalidationOutcome = "proceed" | "requiresReview" | "reject";

function isReasonCode(value: unknown): value is ReasonCode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReasonCode).code === "string" &&
    typeof (value as ReasonCode).summary === "string"
  );
}

function revalidationFailed(summary: string): Pick<PreExecuteCheck, "outcome" | "reason"> {
  return {
    outcome: "failed",
    reason: {
      code: "REVALIDATION_FAILED",
      summary: `${summary} Nothing was executed; the operation stays open, so a later call checks again.`
    }
  };
}

/** Runs revalidate(); anything other than a well-formed result fails closed (no execute). */
async function runRevalidate<Intent, Context>(
  contract: EffectContract<Intent, unknown, unknown, Context>,
  record: OperationRecord,
  request: ResolvedRequest<Intent, Context>,
  attemptNumber: number,
  approval: RecordedReview | null
): Promise<Pick<PreExecuteCheck, "outcome" | "reason">> {
  let decision: unknown;
  let reason: unknown;
  try {
    const result: unknown = await contract.revalidate!({
      intent: request.intent,
      identity: { ...record.identity },
      attemptNumber,
      approval: approval ? { ...approval } : null,
      record,
      context: request.context
    });
    // Read each field once, inside the try: a throwing getter fails closed like a throw.
    if (typeof result === "object" && result !== null) {
      ({ decision, reason } = result as { decision?: unknown; reason?: unknown });
      if (typeof reason === "object" && reason !== null) {
        const { code, summary, metadata } = reason as ReasonCode;
        reason = metadata === undefined ? { code, summary } : { code, summary, metadata };
      }
    }
  } catch (err) {
    return revalidationFailed(`revalidate() threw: ${errorMessage(err)}.`);
  }
  if (decision !== "proceed" && decision !== "requiresReview" && decision !== "reject") {
    return revalidationFailed(`revalidate() returned no valid decision (expected "proceed", "requiresReview" or "reject").`);
  }
  if (reason !== undefined && !isReasonCode(reason)) {
    return revalidationFailed(`revalidate() returned a reason without a string code and summary.`);
  }
  return { outcome: decision, reason: reason ?? REVALIDATION_DEFAULT_REASONS[decision] };
}

/**
 * The only way runCoordinated makes a new attempt: revalidate() first (when the contract has
 * one), then reserve and execute only if it says proceed. Runs before reserveAttempt, so a
 * check that says no never leaves a reserved attempt that recovery would have to treat as an
 * unknown outcome.
 */
async function checkThenAttempt<Intent, Observation, Evidence, Context>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence, Context>,
  record: OperationRecord,
  request: ResolvedRequest<Intent, Context>
): Promise<EffectResult<Observation>> {
  // Read everything performAttempt needs before revalidate() is handed the record.
  const base: AttemptBase = {
    identity: { ...record.identity },
    version: record.version,
    attemptNumber: record.attempts.length + 1
  };
  const approval = record.review?.decision === "approved" ? { ...record.review } : null;
  // Left review (it has a review reason) but no decision is recorded: approved by corrobo
  // 0.3.x, which kept no record of who approved what. Fail closed: it needs a fresh review.
  const unrecordedApproval = !record.review && record.reviewReason !== undefined;
  if (!contract.revalidate && !approval && !unrecordedApproval) {
    return performAttempt(store, contract, base, request.intent);
  }

  // corrobo's own checks of the approval come first; revalidate() only sees a valid one.
  // They run again after revalidate() (which may take a while), at the reading the attempt
  // then starts at, so an approval can't expire between the check and the reservation.
  const approvalProblem = (now: string): ReasonCode | null =>
    unrecordedApproval ? APPROVAL_NOT_RECORDED : approval ? checkApproval(contract, record, approval, now) : null;
  const before = approvalProblem(await safetyNow(store));
  let result: Pick<PreExecuteCheck, "outcome" | "reason"> = before
    ? { outcome: "requiresReview", reason: before }
    : contract.revalidate
      ? await runRevalidate(contract, record, request, base.attemptNumber, approval)
      : { outcome: "proceed", reason: approvedReason(approval!) };
  const checkedAt = await safetyNow(store);
  if (result.outcome === "proceed") {
    const after = approvalProblem(checkedAt);
    if (after) result = { outcome: "requiresReview", reason: after };
  }
  const checked = {
    reason: result.reason,
    ...(approval ? { approval } : {}),
    attemptNumber: base.attemptNumber,
    checkedAt
  };
  if (result.outcome === "proceed") {
    return performAttempt(store, contract, base, request.intent, { outcome: "proceed", ...checked });
  }

  const blockedBy: BlockingCheck = { outcome: result.outcome, ...checked, recordVersion: base.version + 1 };
  const status: OperationStatus | undefined =
    result.outcome === "requiresReview" ? "AWAITING_REVIEW" : result.outcome === "reject" ? "CLOSED" : undefined;
  const updated = await store.updateOperation(
    base.identity.id,
    {
      blockedBy,
      ...(status ? { status } : {}),
      ...(result.outcome === "requiresReview" ? { reviewReason: result.reason } : {})
    },
    base.version
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
export async function runEffect<Intent, Observation, Evidence, Context = unknown>(
  store: EffectStore,
  contract: EffectContract<Intent, Observation, Evidence, Context>,
  input: EffectRequest<Intent, Context>
): Promise<EffectResult<Observation>> {
  const request = resolveRequest(contract as EffectContract<Intent, unknown, unknown, Context>, input);
  // Read the intent once, first. With the default fingerprint, an intent that can't be stored
  // faithfully as JSON is rejected here, before anything else happens — never after an effect.
  // A contract-supplied fingerprintIntent() takes responsibility for its own intents instead.
  const prepared = prepareIntent(contract, request.intent);
  const lock = await store.tryAcquireLock(request.identity.id);
  if (!lock) {
    const existing = await store.getOperation(request.identity.id);
    if (!existing) {
      return resultForInProgress(request.identity);
    }
    assertSameLogicalOperation(contract, request, prepared, existing);
    return resultFromRecord(existing);
  }
  try {
    return await runCoordinated(lock.store, contract, request, prepared);
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
    assertSameLogicalOperation(contract, request, prepared, current);
    return resultFromRecord(current);
  } finally {
    await lock.release();
  }
}

/**
 * Records a reviewer's decision on an operation left AWAITING_REVIEW, and nothing else: it never
 * executes or observes. Call it from your own review flow (never from anything a model can
 * call), then let runEffect() act on the operation, which checks the approval again before
 * every attempt. Keeping the two apart means the code that makes attempts can't approve them.
 *
 * - The decision is validated first (a malformed one throws TypeError) and bound to the recorded
 *   intent: if `decision.intentFingerprint` names a different intent, or an approval has already
 *   expired, it throws and nothing changes.
 * - Approved: the operation becomes OPEN; the result says it hasn't been attempted since.
 *   Rejected: CLOSED, terminally.
 * - If the operation isn't awaiting review (already decided, never needed review, closed), the
 *   decision is not recorded and the current state is returned; compare `result.review`.
 * - If another call holds the operation right now, throws OperationBusyError (nothing recorded).
 */
export async function reviewEffect<Intent, Observation, Evidence, Context = unknown>(
  store: EffectStore,
  contract: EffectContract<Intent, Observation, Evidence, Context>,
  request: ReviewRequest
): Promise<EffectResult<Observation>> {
  const identity = resolveIdentity(contract as EffectContract<unknown, unknown, unknown>, request?.identity);
  const decision = parseReviewDecision(request?.decision);
  const lock = await store.tryAcquireLock(identity.id);
  if (!lock) {
    throw new OperationBusyError(identity.id);
  }
  try {
    const existing = await lock.store.getOperation(identity.id);
    if (!existing) {
      throw new Error(`corrobo: no operation "${identity.id}" to review; runEffect() creates it (and authorize() sends it to review).`);
    }
    if (existing.identity.operationType !== contract.operationType) {
      throw new Error(
        `corrobo: operation "${identity.id}" has operationType "${existing.identity.operationType}", but this ` +
          `review was made with the "${contract.operationType}" contract; nothing was recorded.`
      );
    }
    if (existing.status !== "AWAITING_REVIEW") {
      return resultFromRecord(existing);
    }
    const review = await recordReview(lock.store, contract, existing, decision);
    const updated = await lock.store.updateOperation(
      identity.id,
      { status: review.decision === "approved" ? "OPEN" : "CLOSED", review },
      existing.version
    );
    return resultFromRecord(updated);
  } catch (err) {
    if (err instanceof StoreConflictError) {
      throw new OperationBusyError(identity.id);
    }
    throw err;
  } finally {
    await lock.release();
  }
}

async function runCoordinated<Intent, Observation, Evidence, Context>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence, Context>,
  request: ResolvedRequest<Intent, Context>,
  prepared: PreparedIntent
): Promise<EffectResult<Observation>> {
  const existing = await store.getOperation(request.identity.id);

  if (existing) {
    assertSameLogicalOperation(contract, request, prepared, existing);
  }

  if (!existing) {
    const auth = contract.authorize
      ? await contract.authorize(request.intent, { identity: { ...request.identity }, context: request.context })
      : { requiresReview: false };
    const initialStatus: OperationStatus = auth.requiresReview ? "AWAITING_REVIEW" : "OPEN";
    const created = await store.createOperation({
      identity: request.identity,
      intent: prepared.stored,
      status: initialStatus,
      reviewReason: auth.requiresReview ? (auth.reason ?? defaultReviewReason()) : undefined
    });

    if (auth.requiresReview) {
      return resultFromRecord(created);
    }
    return await checkThenAttempt(store, contract, created, request);
  }

  if (existing.status === "CLOSED") {
    return resultFromRecord(existing);
  }

  if (existing.status === "AWAITING_REVIEW") {
    if (!request.review) {
      return resultFromRecord(existing);
    }
    const review = await recordReview(store, contract, existing, request.review);
    if (review.decision !== "approved") {
      const closed = await store.updateOperation(existing.identity.id, { status: "CLOSED", review }, existing.version);
      return resultFromRecord(closed);
    }
    // Approved (deprecated path: decided and acted on in one call): continue as an OPEN
    // operation would; see continueOpen for the re-observation after a review wait.
    const reopened = await store.updateOperation(existing.identity.id, { status: "OPEN", review }, existing.version);
    return await continueOpen(store, contract, reopened, request);
  }

  return await continueOpen(store, contract, existing, request);
}

/**
 * Binds a review decision to the recorded intent. Throws, changing nothing, if the reviewer was
 * shown a different intent (intentFingerprint) or the approval has already expired.
 */
async function recordReview(
  store: CoordinatedStore,
  contract: EffectContract<any, unknown, unknown, any>,
  record: OperationRecord,
  decision: ValidDecision
): Promise<RecordedReview> {
  const intentFingerprint = fingerprintIntent(contract, record.intent);
  if (decision.intentFingerprint !== undefined && decision.intentFingerprint !== intentFingerprint) {
    throw new Error(
      `corrobo: this review decision for operation "${record.identity.id}" was made for a different intent than ` +
        `the one recorded (intentFingerprint doesn't match); nothing was recorded or executed. Show the reviewer the ` +
        `recorded intent and use fingerprintIntent(contract, intent) on that.`
    );
  }
  const now = await safetyNow(store);
  if (decision.expiresAt !== undefined && Date.parse(decision.expiresAt) <= Date.parse(now)) {
    throw new Error(
      `corrobo: this approval for operation "${record.identity.id}" expired at ${decision.expiresAt}, before it was ` +
        `recorded; nothing was recorded or executed.`
    );
  }
  const review: RecordedReview = {
    decision: decision.decision,
    reviewer: decision.reviewer,
    decidedAt: decision.decidedAt ?? now,
    intentFingerprint,
    recordedAt: now,
    attemptCount: record.attempts.length
  };
  if (decision.expiresAt !== undefined) review.expiresAt = decision.expiresAt;
  if (decision.note !== undefined) review.note = decision.note;
  return review;
}

async function continueOpen<Intent, Observation, Evidence, Context>(
  store: CoordinatedStore,
  contract: EffectContract<Intent, Observation, Evidence, Context>,
  existing: OperationRecord,
  request: ResolvedRequest<Intent, Context>
): Promise<EffectResult<Observation>> {
  const latest = existing.attempts[existing.attempts.length - 1];
  // Approved after the latest attempt (revalidate() asked for review before the next one):
  // time has passed while it waited, so that attempt is re-observed before anything executes
  // again, even if its NOT_APPLIED was final when it was recorded.
  const approvedSinceLatest =
    existing.review?.decision === "approved" && existing.review.attemptCount === existing.attempts.length;
  if (!latest) {
    return await checkThenAttempt(store, contract, existing, request);
  }

  if (latest.status === "RESERVED") {
    return await recoverReservedAttempt(store, contract, existing, request.intent, latest);
  }

  if (latest.evidenceState === "PENDING") {
    return resultFromRecord(await reObserve(store, contract, existing, request.intent, latest));
  }

  if (latest.disposition === "RETRY") {
    if (latest.transport.ok && !approvedSinceLatest) {
      // execute() returned a response: that request is finished, the NOT_APPLIED was final.
      return await checkThenAttempt(store, contract, existing, request);
    }
    // The failed request could still land. Nothing happens before retryNotBefore.
    if (latest.retryNotBefore && Date.parse(await safetyNow(store)) < Date.parse(latest.retryNotBefore)) {
      return resultFromRecord(existing);
    }
    // Settlement check (and the re-check after a review wait): observe again and re-decide
    // under the current rules before any new attempt. A late landing shows up here as APPLIED (→ COMPLETE, no new attempt). This also
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
      return await checkThenAttempt(store, contract, settled, request);
    }
    return resultFromRecord(settled);
  }

  // OPEN with a resolved latest attempt that is neither PENDING nor RETRY shouldn't occur
  // (performAttempt/reObserve/recoverReservedAttempt always close otherwise) — return current
  // state rather than guessing.
  return resultFromRecord(existing);
}
