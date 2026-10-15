// The CTA-216 contract, copied verbatim (comments trimmed). The type test compares the package's
// exports against this copy, so the two can only drift together — never silently on one side.

export type EntityRef = { type: string; id: string };

export type JobStatus = "queued" | "running" | "paused" | "interrupted" | "failed" | "cancelled" | "done";

export type JobPhase = "plan" | "steps" | "finalize" | "outputs";

export type JobError = { code: string; message?: string; retryable: boolean; details?: unknown };

export type JobProgress = { done: number; total: number; label?: string };

export type JobOutput =
  | { key: string; kind: "entity"; ref: EntityRef; label: string }
  | { key: string; kind: "artifact"; artifactId: string; name: string; mimeType: string; size: number }
  | { key: string; kind: "data"; schema: string; value: unknown };

export type OutputPlan = { key: string } & Record<string, unknown>;

export type JobAttempt = {
  n: number; startedAt: string; endedAt?: string;
  outcome?: "done" | "failed" | "retry-scheduled" | "paused" | "cancelled" | "interrupted";
  error?: JobError;
};

export type JobEvent = { at: string; type: string; data?: unknown };

export type JobRecord<I = unknown, S = unknown> = {
  id: string;
  kind: string; kindVersion: number; lane: string; priority: number;
  title: string; subjects: EntityRef[];
  status: JobStatus; phase: JobPhase;
  control?: "pause" | "cancel";
  input: I;
  state: S | null;
  progress: JobProgress;
  pendingOutputs: OutputPlan[];
  outputs: JobOutput[];
  attempts: JobAttempt[]; maxAttempts: number; runAfter?: string;
  lease?: { owner: string; expiresAt: string };
  error?: JobError;
  history: JobEvent[];
  revision: number;
  createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string;
};

export interface StepContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  heartbeat(): void;
  live(payload: unknown): void;
  artifacts: ArtifactWriter;
  now(): Date;
}

export interface ArtifactWriter {
  writePart(key: string, seq: number, chunk: string | Uint8Array): Promise<void>;
  seal(key: string, meta: { name: string; mimeType: string }): Promise<{ artifactId: string; size: number }>;
}

export type StepResult<S> = { state: S; progress: JobProgress; done: boolean };

export type RetryPolicy = {
  maxAttempts: number;
  backoff: { initialMs: number; factor: number; maxMs: number; jitter: boolean };
};

export interface JobKind<I, S, P extends OutputPlan = OutputPlan> {
  id: string;
  version: number;
  lane: string;
  appliesTo: readonly string[];
  resumable: boolean;
  autoResume: boolean;
  retry: RetryPolicy;
  timeouts?: { heartbeatMs?: number; stepMs?: number };
  parseInput(value: unknown): I | undefined;
  parseState(value: unknown, fromVersion: number): S | undefined;
  title(input: I): string;
  subjects(input: I): EntityRef[];
  plan(input: I, ctx: StepContext): Promise<{ state: S; progress: JobProgress }>;
  step(state: S, input: I, ctx: StepContext): Promise<StepResult<S>>;
  finalize(state: S, input: I, ctx: StepContext): Promise<P[]>;
  applyOutput(plan: P, input: I, ctx: StepContext): Promise<JobOutput>;
  classifyError?(error: unknown): JobError;
}

export interface JobStore {
  list(): Promise<JobRecord[]>;
  get(id: string): Promise<JobRecord | undefined>;
  add(job: JobRecord): Promise<void>;
  update(id: string, edit: (job: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined>;
  remove(ids: readonly string[]): Promise<void>;
  putPart(jobId: string, key: string, seq: number, chunk: string | Uint8Array): Promise<void>;
  sealArtifact(jobId: string, key: string, meta: { name: string; mimeType: string }): Promise<{ artifactId: string; size: number }>;
  readArtifact(artifactId: string): Promise<Blob | undefined>;
  subscribe(listener: () => void): () => void;
}
export interface LeaderLock { acquire(name: string, onLost?: () => void): Promise<() => void> }
export interface EventBus { publish(message: unknown): void; subscribe(listener: (message: unknown) => void): () => void }

export declare function createJobRuntime(options: {
  namespace: string;
  kinds: readonly JobKind<any, any, any>[];
  lanes: Record<string, { concurrency: number }>;
  store: JobStore; lock?: LeaderLock; bus?: EventBus;
  clock?: { now(): Date; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  newId?: () => string;
  retention?: { maxJobs: number };
  leaseMs?: number; liveIntervalMs?: number; liveStaleMs?: number;
}): JobRuntime;

export type EnqueueProblem = "unknown-kind" | "invalid" | "storage" | "too-many";
export type ControlProblem = "missing" | "not-allowed" | "storage";

export interface JobRuntime {
  start(): void;
  stop(): Promise<void>;
  enqueue(kind: string, input: unknown, options?: { priority?: number; runAfter?: Date }): Promise<{ id: string } | { problem: EnqueueProblem }>;
  pause(id: string): Promise<ControlProblem | undefined>;
  resume(id: string): Promise<ControlProblem | undefined>;
  cancel(id: string): Promise<ControlProblem | undefined>;
  remove(ids: readonly string[]): Promise<ControlProblem | undefined>;
  removeUnfinishedOf(subjects: readonly EntityRef[]): Promise<void>;
  snapshot(): readonly JobRecord[] | undefined;
  subscribe(listener: () => void): () => void;
  liveOf(id: string): unknown | undefined;
  subscribeLive(listener: () => void): () => void;
  readArtifact(artifactId: string): Promise<Blob | undefined>;
  kindOf(id: string): JobKind<any, any, any> | undefined;
  kindsFor(entityType: string): readonly JobKind<any, any, any>[];
}
