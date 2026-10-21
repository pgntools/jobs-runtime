import type {
  EntityRef,
  JobAttempt,
  JobError,
  JobEvent,
  JobKind,
  JobOutput,
  JobPhase,
  JobProgress,
  JobRecord,
  JobStatus,
  OutputPlan,
  RetryPolicy,
} from "../contract.js";
import { step, type JobMachineEvent } from "./jobMachine.js";

// Pure record transforms. Each takes the stored record (inside the store's read-modify-write)
// and returns its successor with the revision bumped, or undefined to write nothing. Status and
// phase only ever move through the job machine.

export type AnyKind = JobKind<any, any, any>;

export const HISTORY_LIMIT = 100;
/** History records a "checkpointed" event every Nth step, not every step. */
export const CHECKPOINT_HISTORY_EVERY = 10;

const STATUSES: readonly JobStatus[] = ["queued", "running", "paused", "interrupted", "failed", "cancelled", "done"];
const PHASES: readonly JobPhase[] = ["plan", "steps", "finalize", "outputs"];
const FINISHED: readonly JobStatus[] = ["done", "cancelled", "failed"];

export const iso = (date: Date): string => date.toISOString();
const plus = (date: Date, ms: number): string => new Date(date.getTime() + ms).toISOString();
const reached = (at: string | undefined, now: Date): boolean => at === undefined || Date.parse(at) <= now.getTime();

/** Done, cancelled and failed records are finished: retention may prune them. */
export const isFinished = (job: JobRecord): boolean => FINISHED.includes(job.status);

export const leaseExpired = (job: JobRecord, now: Date): boolean => reached(job.lease?.expiresAt, now);

// ── Reading ─────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const optStr = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const list = <T>(value: unknown, keep: (item: unknown) => item is T): T[] =>
  Array.isArray(value) ? value.filter(keep) : [];

const isEntityRef = (value: unknown): value is EntityRef =>
  isObject(value) && typeof value.type === "string" && typeof value.id === "string";
const isKeyed = <T>(value: unknown): value is T => isObject(value) && typeof value.key === "string";
const isAttempt = (value: unknown): value is JobAttempt =>
  isObject(value) && typeof value.n === "number" && typeof value.startedAt === "string";
const isEvent = (value: unknown): value is JobEvent =>
  isObject(value) && typeof value.at === "string" && typeof value.type === "string";

function readError(value: unknown): JobError | undefined {
  if (!isObject(value) || typeof value.code !== "string") return undefined;
  return { ...value, code: value.code, retryable: value.retryable === true } as JobError;
}

/**
 * Every record read goes through here: lenient and total. A value without an id is not a record
 * (undefined). An unknown status reads as interrupted — never run unasked — and an unknown phase
 * as plan; missing fields take their defaults.
 */
export function normalise(raw: unknown): JobRecord | undefined {
  if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "") return undefined;
  const createdAt = str(raw.createdAt, new Date(0).toISOString());
  const progress = isObject(raw.progress) ? raw.progress : {};
  const lease = isObject(raw.lease) && typeof raw.lease.owner === "string" && typeof raw.lease.expiresAt === "string"
    ? { owner: raw.lease.owner, expiresAt: raw.lease.expiresAt }
    : undefined;
  const job: JobRecord = {
    id: raw.id,
    kind: str(raw.kind, ""),
    kindVersion: num(raw.kindVersion, 0),
    lane: str(raw.lane, ""),
    priority: num(raw.priority, 0),
    title: str(raw.title, ""),
    subjects: list(raw.subjects, isEntityRef),
    status: STATUSES.includes(raw.status as JobStatus) ? (raw.status as JobStatus) : "interrupted",
    phase: PHASES.includes(raw.phase as JobPhase) ? (raw.phase as JobPhase) : "plan",
    input: raw.input,
    state: raw.state === undefined ? null : raw.state,
    progress: {
      done: num(progress.done, 0),
      total: num(progress.total, 0),
      ...(typeof progress.label === "string" ? { label: progress.label } : {}),
    },
    pendingOutputs: list<OutputPlan>(raw.pendingOutputs, isKeyed),
    outputs: list<JobOutput>(raw.outputs, isKeyed),
    attempts: list(raw.attempts, isAttempt),
    maxAttempts: num(raw.maxAttempts, 1),
    history: list(raw.history, isEvent).slice(-HISTORY_LIMIT),
    revision: num(raw.revision, 0),
    createdAt,
    updatedAt: str(raw.updatedAt, createdAt),
  };
  if (raw.control === "pause" || raw.control === "cancel") job.control = raw.control;
  const runAfter = optStr(raw.runAfter);
  if (runAfter !== undefined) job.runAfter = runAfter;
  if (lease) job.lease = lease;
  const error = readError(raw.error);
  if (error) job.error = error;
  const startedAt = optStr(raw.startedAt);
  if (startedAt !== undefined) job.startedAt = startedAt;
  const finishedAt = optStr(raw.finishedAt);
  if (finishedAt !== undefined) job.finishedAt = finishedAt;
  return job;
}

// ── Writing ─────────────────────────────────────────────────────────────

type Field = "control" | "runAfter" | "lease" | "error" | "finishedAt";

function without(job: JobRecord, ...fields: Field[]): JobRecord {
  const next = { ...job };
  for (const field of fields) delete next[field];
  return next;
}

function revise(job: JobRecord, now: Date): JobRecord {
  return { ...job, revision: job.revision + 1, updatedAt: iso(now) };
}

function withEvent(job: JobRecord, now: Date, type: string, data?: unknown): JobRecord {
  const event: JobEvent = data === undefined ? { at: iso(now), type } : { at: iso(now), type, data };
  return { ...job, history: [...job.history, event].slice(-HISTORY_LIMIT) };
}

function closeAttempt(job: JobRecord, now: Date, outcome: NonNullable<JobAttempt["outcome"]>, error?: JobError): JobRecord {
  const last = job.attempts.at(-1);
  if (!last || last.endedAt !== undefined) return job;
  const closed: JobAttempt = { ...last, endedAt: iso(now), outcome, ...(error ? { error } : {}) };
  return { ...job, attempts: [...job.attempts.slice(0, -1), closed] };
}

function moved(job: JobRecord, ...events: JobMachineEvent[]): JobRecord | undefined {
  const position = step(job, ...events);
  return position && { ...job, ...position };
}

/** Attempts spent against the budget: the ones that ended in an error. */
export function countedFailures(job: JobRecord): number {
  return job.attempts.filter((a) => a.outcome === "failed" || a.outcome === "retry-scheduled").length;
}

export function backoffMs(policy: RetryPolicy, failures: number, random: () => number): number {
  const { initialMs, factor, maxMs, jitter } = policy.backoff;
  const base = Math.min(maxMs, initialMs * factor ** Math.max(0, failures - 1));
  return Math.round(jitter ? base / 2 + random() * (base / 2) : base);
}

export type Enqueue = {
  id: string;
  kind: AnyKind;
  input: unknown;
  priority: number;
  runAfter?: Date;
  now: Date;
};

export function newRecord({ id, kind, input, priority, runAfter, now }: Enqueue): JobRecord {
  const at = iso(now);
  const job: JobRecord = {
    id,
    kind: kind.id,
    kindVersion: kind.version,
    lane: kind.lane,
    priority,
    title: kind.title(input),
    subjects: kind.subjects(input),
    status: "queued",
    phase: "plan",
    input,
    state: null,
    progress: { done: 0, total: 0 },
    pendingOutputs: [],
    outputs: [],
    attempts: [],
    maxAttempts: kind.retry.maxAttempts,
    history: [{ at, type: "enqueued" }],
    revision: 0,
    createdAt: at,
    updatedAt: at,
  };
  if (runAfter) job.runAfter = iso(runAfter);
  return job;
}

// ── The worker (the leader tab) ─────────────────────────────────────────

export type Worker = { owner: string; now: Date; leaseMs: number };

const ownedBy = (job: JobRecord, owner: string): boolean => job.status === "running" && job.lease?.owner === owner;

/** Claimable: queued, not deferred, no live lease, no pending control. */
export function claimable(job: JobRecord, now: Date): boolean {
  return job.status === "queued" && job.control === undefined && reached(job.runAfter, now) && leaseExpired(job, now);
}

/** queued → running: writes the lease and appends an attempt. */
export function claim(job: JobRecord, { owner, now, leaseMs }: Worker): JobRecord | undefined {
  if (!claimable(job, now)) return undefined;
  const next = moved(job, { type: "CLAIM" });
  if (!next) return undefined;
  const n = job.attempts.length + 1;
  return revise(
    withEvent(
      {
        ...without(next, "runAfter", "error"),
        lease: { owner, expiresAt: plus(now, leaseMs) },
        attempts: [...job.attempts, { n, startedAt: iso(now) }],
        startedAt: job.startedAt ?? iso(now),
      },
      now,
      "claimed",
      { attempt: n },
    ),
    now,
  );
}

export function renewLease(job: JobRecord, { owner, now, leaseMs }: Worker): JobRecord | undefined {
  if (!ownedBy(job, owner)) return undefined;
  return revise({ ...job, lease: { owner, expiresAt: plus(now, leaseMs) } }, now);
}

/** A worker's own lease handed back on stop(): the next leader stalls the job at once. */
export function releaseLease(job: JobRecord, { owner, now }: Pick<Worker, "owner" | "now">): JobRecord | undefined {
  if (!ownedBy(job, owner)) return undefined;
  return revise(withEvent(without(job, "lease"), now, "lease-released"), now);
}

/** Honours a control request on a running job: pause or cancel, its checkpoint kept. */
function honourControl(job: JobRecord, now: Date): JobRecord | undefined {
  if (job.control === "pause") {
    const next = moved(job, { type: "PAUSE" });
    return next && withEvent(closeAttempt(without(next, "control", "lease"), now, "paused"), now, "paused");
  }
  const next = moved(job, { type: "CANCEL" });
  return (
    next &&
    withEvent(
      { ...closeAttempt(without(next, "control", "lease"), now, "cancelled"), finishedAt: iso(now) },
      now,
      "cancelled",
    )
  );
}

/**
 * The queue was held: the worker's running job goes back to queued from its checkpoint (its step
 * already aborted), the attempt closed as held — not spent. A pending pause or cancel wins.
 */
export function holdRunning(job: JobRecord, { owner, now }: Pick<Worker, "owner" | "now">): JobRecord | undefined {
  if (!ownedBy(job, owner)) return undefined;
  if (job.control !== undefined) {
    const next = honourControl(job, now);
    return next && revise(next, now);
  }
  const next = moved(job, { type: "HOLD" });
  return next && revise(withEvent(closeAttempt(without(next, "lease"), now, "held"), now, "held"), now);
}

/** The worker acting on an observed control request (its step already aborted). */
export function applyControl(job: JobRecord, { owner, now }: Pick<Worker, "owner" | "now">): JobRecord | undefined {
  if (!ownedBy(job, owner) || job.control === undefined) return undefined;
  const next = honourControl(job, now);
  return next && revise(next, now);
}

function complete(job: JobRecord, now: Date): JobRecord | undefined {
  const next = moved(job, { type: "COMPLETE" });
  return (
    next &&
    withEvent(
      { ...closeAttempt(without(next, "control", "lease", "error"), now, "done"), finishedAt: iso(now) },
      now,
      "done",
    )
  );
}

export type Commit = {
  /** Phase moves after the CHECKPOINT: ADVANCE, or REPLAN + ADVANCE when a plan replaced a checkpoint. */
  moves: readonly ("ADVANCE" | "REPLAN")[];
  kindVersion: number;
  state?: unknown;
  progress?: JobProgress;
  pendingOutputs?: OutputPlan[];
  /** An applied output: moved from pendingOutputs (by key) to outputs. */
  applied?: JobOutput;
  event?: { type: string; data?: unknown };
};

/**
 * One unit's checkpoint: the kind's state, progress and phase, the lease renewed — one write.
 * An emptied outbox completes the job in the same write; a control request written meanwhile is
 * honoured in it too, so a pause or cancel is never more than one step away.
 */
export function commit(job: JobRecord, worker: Worker, change: Commit): JobRecord | undefined {
  const { owner, now, leaseMs } = worker;
  if (!ownedBy(job, owner)) return undefined;
  let next = moved(job, { type: "CHECKPOINT" }, ...change.moves.map((type) => ({ type })));
  if (!next) return undefined;
  next = { ...next, kindVersion: change.kindVersion, lease: { owner, expiresAt: plus(now, leaseMs) } };
  if (change.state !== undefined) next.state = change.state;
  if (change.progress) next.progress = change.progress;
  if (change.pendingOutputs) next.pendingOutputs = change.pendingOutputs;
  const applied = change.applied;
  if (applied) {
    next.pendingOutputs = next.pendingOutputs.filter((plan) => plan.key !== applied.key);
    next.outputs = [...next.outputs.filter((output) => output.key !== applied.key), applied];
  }
  if (change.event) next = withEvent(next, now, change.event.type, change.event.data);
  if (next.phase === "outputs" && next.pendingOutputs.length === 0) next = complete(next, now);
  else if (next.control !== undefined) next = honourControl(next, now);
  return next && revise(next, now);
}

/** A unit failed: re-queue with backoff while attempts are left, else fail with the checkpoint kept. */
export function fail(
  job: JobRecord,
  worker: Worker,
  error: JobError,
  retry: RetryPolicy,
  random: () => number,
): JobRecord | undefined {
  const { owner, now } = worker;
  if (!ownedBy(job, owner)) return undefined;
  if (job.control !== undefined) {
    const next = honourControl(job, now);
    return next && revise(next, now);
  }
  const failures = countedFailures(job) + 1;
  if (error.retryable && failures < job.maxAttempts) {
    const next = moved(job, { type: "RETRY" });
    if (!next) return undefined;
    const runAfter = plus(now, backoffMs(retry, failures, random));
    return revise(
      withEvent(
        { ...closeAttempt(without(next, "lease"), now, "retry-scheduled", error), runAfter, error },
        now,
        "retry-scheduled",
        { runAfter, error },
      ),
      now,
    );
  }
  const next = moved(job, { type: "FAIL" });
  if (!next) return undefined;
  return revise(
    withEvent({ ...closeAttempt(without(next, "lease"), now, "failed", error), error, finishedAt: iso(now) }, now, "failed", {
      error,
    }),
    now,
  );
}

/**
 * Taking over a running job whose lease expired (tab closed, crash, takeover): a pending control
 * request is honoured, otherwise the job goes back to queued when its kind auto-resumes, and to
 * interrupted when it does not or its kind is not registered.
 */
export function stall(job: JobRecord, now: Date, kind: AnyKind | undefined): JobRecord | undefined {
  if (job.status !== "running" || !leaseExpired(job, now)) return undefined;
  if (job.control !== undefined) {
    const next = honourControl(job, now);
    return next && revise(next, now);
  }
  const autoResume = kind?.autoResume ?? false;
  const next = moved(job, { type: "LEASE_EXPIRED", autoResume });
  if (!next) return undefined;
  return revise(
    withEvent(closeAttempt(without(next, "lease"), now, "interrupted"), now, next.status === "queued" ? "requeued" : "interrupted", {
      reason: "lease-expired",
    }),
    now,
  );
}

// ── Commands (any tab) ──────────────────────────────────────────────────

export type Command = { next: JobRecord } | { problem: "not-allowed" };

const notAllowed: Command = { problem: "not-allowed" };

/** Queued → paused at once; a running job gets a request its worker honours. */
export function requestPause(job: JobRecord, kind: AnyKind | undefined, now: Date): Command {
  if (!kind || job.control !== undefined) return notAllowed;
  if (job.status === "running") return { next: revise(withEvent({ ...job, control: "pause" }, now, "pause-requested"), now) };
  const next = moved(job, { type: "PAUSE" });
  return next ? { next: revise(withEvent(next, now, "paused"), now) } : notAllowed;
}

/** Queued, paused, interrupted, failed → cancelled at once; a running job gets a request. */
export function requestCancel(job: JobRecord, kind: AnyKind | undefined, now: Date): Command {
  if (!kind || job.control === "cancel") return notAllowed;
  if (job.status === "running") return { next: revise(withEvent({ ...job, control: "cancel" }, now, "cancel-requested"), now) };
  const next = moved(job, { type: "CANCEL" });
  return next
    ? { next: revise(withEvent({ ...without(next, "runAfter"), finishedAt: iso(now) }, now, "cancelled"), now) }
    : notAllowed;
}

/** Paused, interrupted, failed → queued from the checkpoint; a failed job's attempt budget starts again. */
export function requestResume(job: JobRecord, kind: AnyKind | undefined, now: Date): Command {
  if (!kind) return notAllowed;
  const next = moved(job, { type: "RESUME" });
  if (!next) return notAllowed;
  const budget = job.status === "failed" ? { maxAttempts: countedFailures(job) + kind.retry.maxAttempts } : {};
  return { next: revise(withEvent({ ...without(next, "runAfter", "error", "finishedAt"), ...budget }, now, "resumed"), now) };
}
