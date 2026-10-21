/** What a job is applied to; opaque to the runtime. */
export type EntityRef = {
    type: string;
    id: string;
};
export type JobStatus = "queued" | "running" | "paused" | "interrupted" | "failed" | "cancelled" | "done";
/** Where a resume re-enters. */
export type JobPhase = "plan" | "steps" | "finalize" | "outputs";
export type JobError = {
    code: string;
    message?: string;
    retryable: boolean;
    details?: unknown;
};
export type JobProgress = {
    done: number;
    total: number;
    label?: string;
};
/** What the reader collects. */
export type JobOutput = {
    key: string;
    kind: "entity";
    ref: EntityRef;
    label: string;
} | {
    key: string;
    kind: "artifact";
    artifactId: string;
    name: string;
    mimeType: string;
    size: number;
} | {
    key: string;
    kind: "data";
    schema: string;
    value: unknown;
};
/** The outbox entry, decided by finalize. */
export type OutputPlan = {
    key: string;
} & Record<string, unknown>;
export type JobAttempt = {
    n: number;
    startedAt: string;
    endedAt?: string;
    outcome?: "done" | "failed" | "retry-scheduled" | "paused" | "cancelled" | "interrupted" | "held";
    error?: JobError;
};
/** Bounded history, last 100. */
export type JobEvent = {
    at: string;
    type: string;
    data?: unknown;
};
export type JobRecord<I = unknown, S = unknown> = {
    id: string;
    kind: string;
    kindVersion: number;
    lane: string;
    priority: number;
    title: string;
    subjects: EntityRef[];
    status: JobStatus;
    phase: JobPhase;
    /** A request written by any tab, acted on by the worker. */
    control?: "pause" | "cancel";
    /** Immutable once enqueued: the snapshot the job works from. */
    input: I;
    /** The kind's durable checkpoint (Kafka: the committed offset). */
    state: S | null;
    progress: JobProgress;
    /** The outbox: decided, not yet applied. */
    pendingOutputs: OutputPlan[];
    /** Applied. */
    outputs: JobOutput[];
    attempts: JobAttempt[];
    maxAttempts: number;
    runAfter?: string;
    lease?: {
        owner: string;
        expiresAt: string;
    };
    error?: JobError;
    history: JobEvent[];
    /** Optimistic concurrency: every write is a compare-and-set. */
    revision: number;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
};
export interface StepContext {
    readonly jobId: string;
    readonly attempt: number;
    /** Aborted on pause, cancel, delete, lease lost, step timeout, stop(). */
    readonly signal: AbortSignal;
    /** Proves liveness inside a long step (Temporal's activity heartbeat). */
    heartbeat(): void;
    /** Ephemeral telemetry: throttled, broadcast to every tab, never stored. */
    live(payload: unknown): void;
    /** Resumable file output. */
    artifacts: ArtifactWriter;
    now(): Date;
}
export interface ArtifactWriter {
    /** Idempotent by (key, seq): a step re-run after a crash rewrites the same part, never appends twice. */
    writePart(key: string, seq: number, chunk: string | Uint8Array): Promise<void>;
    /** Seals the parts 0..n-1 into one artifact; idempotent by key. */
    seal(key: string, meta: {
        name: string;
        mimeType: string;
    }): Promise<{
        artifactId: string;
        size: number;
    }>;
}
export type StepResult<S> = {
    state: S;
    progress: JobProgress;
    done: boolean;
};
export type RetryPolicy = {
    /** 1 = never retried automatically. */
    maxAttempts: number;
    backoff: {
        initialMs: number;
        factor: number;
        maxMs: number;
        jitter: boolean;
    };
};
export interface JobKind<I, S, P extends OutputPlan = OutputPlan> {
    /** Namespaced: "analysis.computer-analysis". */
    id: string;
    /** Bumped when S changes shape; parseState migrates. */
    version: number;
    /** The queue it runs on (Celery's queue). */
    lane: string;
    /** The entity types it can be started on. */
    appliesTo: readonly string[];
    /** false: a resume re-plans from scratch. */
    resumable: boolean;
    /** After an expired lease: re-queue (cheap) or interrupt (heavy). */
    autoResume: boolean;
    retry: RetryPolicy;
    timeouts?: {
        heartbeatMs?: number;
        stepMs?: number;
    };
    /** Lenient, total; undefined = invalid. */
    parseInput(value: unknown): I | undefined;
    /** Lenient + migration; undefined = re-plan. */
    parseState(value: unknown, fromVersion: number): S | undefined;
    title(input: I): string;
    subjects(input: I): EntityRef[];
    plan(input: I, ctx: StepContext): Promise<{
        state: S;
        progress: JobProgress;
    }>;
    /** One unit of work — the checkpoint unit. At-least-once: must be safe to re-run from the same state. */
    step(state: S, input: I, ctx: StepContext): Promise<StepResult<S>>;
    /** Decides the outputs; may seal artifacts; writes nothing else. */
    finalize(state: S, input: I, ctx: StepContext): Promise<P[]>;
    /** Applies one output; idempotent by plan.key (a re-run after a crash creates nothing twice). */
    applyOutput(plan: P, input: I, ctx: StepContext): Promise<JobOutput>;
    /** Default: { code: "unknown", retryable: false }. A step timeout is passed in as an Error named "TimeoutError". */
    classifyError?(error: unknown): JobError;
}
export interface JobStore {
    list(): Promise<JobRecord[]>;
    get(id: string): Promise<JobRecord | undefined>;
    /** Rejects with a conflict when a record with the same id exists. */
    add(job: JobRecord): Promise<void>;
    /**
     * Read-modify-write in one transaction; rejects with a conflict when the revision moved.
     *
     * `edit` receives the stored record and returns its successor, whose `revision` must be the
     * stored one plus one (the compare-and-set), or undefined to write nothing. Resolves with the
     * written record, or undefined when the record is missing or nothing was written. A conflict
     * is an Error whose `code` is "conflict".
     */
    update(id: string, edit: (job: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined>;
    /** And their artifacts. */
    remove(ids: readonly string[]): Promise<void>;
    putPart(jobId: string, key: string, seq: number, chunk: string | Uint8Array): Promise<void>;
    sealArtifact(jobId: string, key: string, meta: {
        name: string;
        mimeType: string;
    }): Promise<{
        artifactId: string;
        size: number;
    }>;
    readArtifact(artifactId: string): Promise<Blob | undefined>;
    /** Any write, this tab or another. */
    subscribe(listener: () => void): () => void;
    /**
     * Optional, both or neither: small runtime-wide values (the queue hold), kept apart from the
     * records and read by value. A store without them cannot hold the queue: hold() resolves
     * "not-allowed" and held() reads false. putMeta is a write: subscribe() hears it.
     */
    getMeta?(key: string): Promise<unknown>;
    putMeta?(key: string, value: unknown): Promise<void>;
}
export interface LeaderLock {
    acquire(name: string, onLost?: () => void): Promise<() => void>;
}
export interface EventBus {
    publish(message: unknown): void;
    subscribe(listener: (message: unknown) => void): () => void;
}
export type EnqueueProblem = "unknown-kind" | "invalid" | "storage" | "too-many";
export type ControlProblem = "missing" | "not-allowed" | "storage";
export interface JobRuntime {
    /** Never at import; idempotent. */
    start(): void;
    /** Aborts steps, releases the lock and leases. */
    stop(): Promise<void>;
    enqueue(kind: string, input: unknown, options?: {
        priority?: number;
        runAfter?: Date;
    }): Promise<{
        id: string;
    } | {
        problem: EnqueueProblem;
    }>;
    pause(id: string): Promise<ControlProblem | undefined>;
    /** Paused, interrupted, failed → queued (from the checkpoint). */
    resume(id: string): Promise<ControlProblem | undefined>;
    cancel(id: string): Promise<ControlProblem | undefined>;
    remove(ids: readonly string[]): Promise<ControlProblem | undefined>;
    /** An entity deleted. */
    removeUnfinishedOf(subjects: readonly EntityRef[]): Promise<void>;
    /**
     * Holds the queue, durably and for every tab: no lane claims a queued job, and every running job
     * stops at its checkpoint (its step aborted) and goes back to queued. Idempotent.
     */
    hold(): Promise<ControlProblem | undefined>;
    /** Lets the queue run again from its checkpoints, in its usual order. Idempotent: a no-op when not held. */
    release(): Promise<ControlProblem | undefined>;
    /** Undefined until the first read lands. */
    held(): boolean | undefined;
    /** Undefined until the first read lands. */
    snapshot(): readonly JobRecord[] | undefined;
    /** Any change of snapshot() or held(). */
    subscribe(listener: () => void): () => void;
    liveOf(id: string): unknown | undefined;
    subscribeLive(listener: () => void): () => void;
    readArtifact(artifactId: string): Promise<Blob | undefined>;
    kindOf(id: string): JobKind<any, any, any> | undefined;
    kindsFor(entityType: string): readonly JobKind<any, any, any>[];
}
export type JobRuntimeOptions = {
    /** The app's: "chessapp.backgroundJobs" — lock and channel names derive from it. */
    namespace: string;
    kinds: readonly JobKind<any, any, any>[];
    /** The app's: { engine: 1, cpu: 1 }. */
    lanes: Record<string, {
        concurrency: number;
    }>;
    store: JobStore;
    lock?: LeaderLock;
    bus?: EventBus;
    clock?: {
        now(): Date;
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
    };
    newId?: () => string;
    /** Oldest finished pruned (with artifacts); refused when all unfinished. */
    retention?: {
        maxJobs: number;
    };
    leaseMs?: number;
    liveIntervalMs?: number;
    liveStaleMs?: number;
};
//# sourceMappingURL=contract.d.ts.map