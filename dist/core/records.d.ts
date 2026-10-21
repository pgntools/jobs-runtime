import type { JobError, JobKind, JobOutput, JobProgress, JobRecord, OutputPlan, RetryPolicy } from "../contract.js";
export type AnyKind = JobKind<any, any, any>;
export declare const HISTORY_LIMIT = 100;
/** History records a "checkpointed" event every Nth step, not every step. */
export declare const CHECKPOINT_HISTORY_EVERY = 10;
export declare const iso: (date: Date) => string;
/** Done, cancelled and failed records are finished: retention may prune them. */
export declare const isFinished: (job: JobRecord) => boolean;
export declare const leaseExpired: (job: JobRecord, now: Date) => boolean;
/**
 * Every record read goes through here: lenient and total. A value without an id is not a record
 * (undefined). An unknown status reads as interrupted — never run unasked — and an unknown phase
 * as plan; missing fields take their defaults.
 */
export declare function normalise(raw: unknown): JobRecord | undefined;
/** Attempts spent against the budget: the ones that ended in an error. */
export declare function countedFailures(job: JobRecord): number;
export declare function backoffMs(policy: RetryPolicy, failures: number, random: () => number): number;
export type Enqueue = {
    id: string;
    kind: AnyKind;
    input: unknown;
    priority: number;
    runAfter?: Date;
    now: Date;
};
export declare function newRecord({ id, kind, input, priority, runAfter, now }: Enqueue): JobRecord;
export type Worker = {
    owner: string;
    now: Date;
    leaseMs: number;
};
/** Claimable: queued, not deferred, no live lease, no pending control. */
export declare function claimable(job: JobRecord, now: Date): boolean;
/** queued → running: writes the lease and appends an attempt. */
export declare function claim(job: JobRecord, { owner, now, leaseMs }: Worker): JobRecord | undefined;
export declare function renewLease(job: JobRecord, { owner, now, leaseMs }: Worker): JobRecord | undefined;
/** A worker's own lease handed back on stop(): the next leader stalls the job at once. */
export declare function releaseLease(job: JobRecord, { owner, now }: Pick<Worker, "owner" | "now">): JobRecord | undefined;
/**
 * The queue was held: the worker's running job goes back to queued from its checkpoint (its step
 * already aborted), the attempt closed as held — not spent. A pending pause or cancel wins.
 */
export declare function holdRunning(job: JobRecord, { owner, now }: Pick<Worker, "owner" | "now">): JobRecord | undefined;
/** The worker acting on an observed control request (its step already aborted). */
export declare function applyControl(job: JobRecord, { owner, now }: Pick<Worker, "owner" | "now">): JobRecord | undefined;
export type Commit = {
    /** Phase moves after the CHECKPOINT: ADVANCE, or REPLAN + ADVANCE when a plan replaced a checkpoint. */
    moves: readonly ("ADVANCE" | "REPLAN")[];
    kindVersion: number;
    state?: unknown;
    progress?: JobProgress;
    pendingOutputs?: OutputPlan[];
    /** An applied output: moved from pendingOutputs (by key) to outputs. */
    applied?: JobOutput;
    event?: {
        type: string;
        data?: unknown;
    };
};
/**
 * One unit's checkpoint: the kind's state, progress and phase, the lease renewed — one write.
 * An emptied outbox completes the job in the same write; a control request written meanwhile is
 * honoured in it too, so a pause or cancel is never more than one step away.
 */
export declare function commit(job: JobRecord, worker: Worker, change: Commit): JobRecord | undefined;
/** A unit failed: re-queue with backoff while attempts are left, else fail with the checkpoint kept. */
export declare function fail(job: JobRecord, worker: Worker, error: JobError, retry: RetryPolicy, random: () => number): JobRecord | undefined;
/**
 * Taking over a running job whose lease expired (tab closed, crash, takeover): a pending control
 * request is honoured, otherwise the job goes back to queued when its kind auto-resumes, and to
 * interrupted when it does not or its kind is not registered.
 */
export declare function stall(job: JobRecord, now: Date, kind: AnyKind | undefined): JobRecord | undefined;
export type Command = {
    next: JobRecord;
} | {
    problem: "not-allowed";
};
/** Queued → paused at once; a running job gets a request its worker honours. */
export declare function requestPause(job: JobRecord, kind: AnyKind | undefined, now: Date): Command;
/** Queued, paused, interrupted, failed → cancelled at once; a running job gets a request. */
export declare function requestCancel(job: JobRecord, kind: AnyKind | undefined, now: Date): Command;
/** Paused, interrupted, failed → queued from the checkpoint; a failed job's attempt budget starts again. */
export declare function requestResume(job: JobRecord, kind: AnyKind | undefined, now: Date): Command;
//# sourceMappingURL=records.d.ts.map