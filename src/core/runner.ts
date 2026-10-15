import { assign, enqueueActions, fromPromise, sendParent, sendTo, setup, type AnyActorRef } from "xstate";
import type { JobError, JobOutput, JobPhase, JobProgress, JobRecord, OutputPlan, StepContext } from "../contract.js";
import type { Env } from "./env.js";
import { liveThrottleMachine } from "./live.js";
import {
  applyControl,
  CHECKPOINT_HISTORY_EVERY,
  claim,
  commit,
  fail,
  releaseLease,
  renewLease,
  type AnyKind,
  type Commit,
  type Worker,
} from "./records.js";
import { writeRecord } from "./store.js";

// ── Units: one call into the kind, the checkpoint unit ──────────────────

type UnitResult =
  | { phase: "plan"; state: unknown; progress: JobProgress }
  | { phase: "steps"; state: unknown; progress: JobProgress; done: boolean }
  | { phase: "finalize"; plans: OutputPlan[] }
  | { phase: "outputs"; output: JobOutput };

type UnitInput = {
  env: Env;
  kind: AnyKind;
  job: JobRecord;
  input: unknown;
  state: unknown;
  unit: JobPhase;
  runner: AnyActorRef;
};

const abortError = (): Error => Object.assign(new Error("The step was aborted"), { name: "AbortError" });

function stepContext({ env, job, runner }: UnitInput, signal: AbortSignal): StepContext {
  const guard = (): void => {
    if (signal.aborted) throw abortError();
  };
  return {
    jobId: job.id,
    attempt: job.attempts.at(-1)?.n ?? 1,
    signal,
    heartbeat: () => {
      if (!signal.aborted) runner.send({ type: "HEARTBEAT" });
    },
    live: (payload) => {
      if (!signal.aborted) runner.send({ type: "LIVE", payload });
    },
    artifacts: {
      writePart: async (key, seq, chunk) => {
        guard();
        await env.store.putPart(job.id, key, seq, chunk);
      },
      seal: async (key, meta) => {
        guard();
        return env.store.sealArtifact(job.id, key, meta);
      },
    },
    now: () => env.now(),
  };
}

const progressOf = (value: unknown): JobProgress =>
  typeof value === "object" && value !== null && typeof (value as JobProgress).done === "number" && typeof (value as JobProgress).total === "number"
    ? (value as JobProgress)
    : { done: 0, total: 0 };

const unitLogic = fromPromise<UnitResult, UnitInput>(async ({ input, signal }) => {
  const { kind } = input;
  const ctx = stepContext(input, signal);
  switch (input.unit) {
    case "plan": {
      const planned = await kind.plan(input.input, ctx);
      return { phase: "plan", state: planned.state, progress: progressOf(planned.progress) };
    }
    case "steps": {
      const result = await kind.step(input.state, input.input, ctx);
      return { phase: "steps", state: result.state, progress: progressOf(result.progress), done: result.done === true };
    }
    case "finalize": {
      const plans: unknown = await kind.finalize(input.state, input.input, ctx);
      if (!Array.isArray(plans) || !plans.every((plan) => typeof (plan as OutputPlan)?.key === "string")) {
        throw new TypeError(`${kind.id}: finalize must return output plans with a string key`);
      }
      return { phase: "finalize", plans: plans as OutputPlan[] };
    }
    case "outputs": {
      const plan = input.job.pendingOutputs[0]!;
      const output = await kind.applyOutput(plan, input.input, ctx);
      // The outbox is keyed by plan.key; the output carries the same key whatever the kind returned.
      return { phase: "outputs", output: { ...output, key: plan.key } };
    }
  }
});

const writeLogic = fromPromise<JobRecord | undefined, { env: Env; id: string; edit: (job: JobRecord) => JobRecord | undefined }>(
  ({ input }) => writeRecord(input.env.store, input.id, input.edit),
);

// ── Errors ──────────────────────────────────────────────────────────────

const isJobError = (value: unknown): value is JobError =>
  typeof value === "object" && value !== null && typeof (value as JobError).code === "string" && typeof (value as JobError).retryable === "boolean";

const messageOf = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

function timeoutError(kind: "step" | "heartbeat"): Error {
  return Object.assign(new Error(kind === "step" ? "The step timed out" : "The step stopped heartbeating"), {
    name: "TimeoutError",
  });
}

/** The kind's classifier when it has one; else a timeout is retryable and anything else is not. */
export function classify(kind: AnyKind, error: unknown): JobError {
  if (kind.classifyError) {
    try {
      const classified = kind.classifyError(error);
      if (isJobError(classified)) return classified;
    } catch {
      // A throwing classifier falls back to the defaults below.
    }
  }
  const message = messageOf(error);
  const base = message === undefined ? {} : { message };
  if (error instanceof Error && error.name === "TimeoutError") return { code: "timeout", ...base, retryable: true };
  return { code: "unknown", ...base, retryable: false };
}

// ── Claiming: what a resume re-enters with ──────────────────────────────

type Prepared = { input: unknown; state: unknown; replan: boolean } | { error: JobError };

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Re-entry at the recorded phase: the input re-parsed; the checkpoint parsed (and migrated from
 * the record's kindVersion). An unparsable checkpoint in steps — or any for a non-resumable kind —
 * re-plans; finalize cannot run without one; outputs needs none.
 */
export function prepare(job: JobRecord, kind: AnyKind): Prepared {
  const input = attempt(() => kind.parseInput(job.input));
  if (input === undefined) return { error: { code: "invalid-input", message: "parseInput refused the stored input", retryable: false } };
  if (job.phase === "plan") return { input, state: null, replan: false };
  if (job.phase === "outputs") return { input, state: job.state, replan: false };
  const state = job.state === null ? undefined : attempt(() => kind.parseState(job.state, job.kindVersion));
  if (job.phase === "steps") {
    return kind.resumable && state !== undefined ? { input, state, replan: false } : { input, state: null, replan: true };
  }
  if (state === undefined) return { error: { code: "invalid-state", message: "parseState refused the checkpoint", retryable: false } };
  return { input, state, replan: false };
}

function nextUnit(job: JobRecord, replan: boolean): JobPhase {
  return replan ? "plan" : job.phase;
}

const UNIT_PHASES: Record<JobPhase, readonly JobPhase[]> = {
  plan: ["plan", "steps"],
  steps: ["steps"],
  finalize: ["finalize"],
  outputs: ["outputs"],
};

function changeOf(result: UnitResult, kind: AnyKind, steps: number, job: JobRecord): Commit | undefined {
  if (!UNIT_PHASES[result.phase].includes(job.phase)) return undefined;
  const kindVersion = kind.version;
  switch (result.phase) {
    case "plan":
      return {
        kindVersion,
        moves: job.phase === "steps" ? ["REPLAN", "ADVANCE"] : ["ADVANCE"],
        state: result.state,
        progress: result.progress,
        event: { type: "planned" },
      };
    case "steps":
      return {
        kindVersion,
        moves: result.done ? ["ADVANCE"] : [],
        state: result.state,
        progress: result.progress,
        ...((steps + 1) % CHECKPOINT_HISTORY_EVERY === 0 ? { event: { type: "checkpointed", data: { steps: steps + 1 } } } : {}),
      };
    case "finalize":
      return { kindVersion, moves: ["ADVANCE"], pendingOutputs: result.plans, event: { type: "finalized", data: { outputs: result.plans.length } } };
    case "outputs":
      return { kindVersion, moves: [], applied: result.output, event: { type: "output-applied", data: { key: result.output.key } } };
  }
}

// ── The runner ──────────────────────────────────────────────────────────

export type RunnerInput = { env: Env; job: JobRecord; kind: AnyKind };

type RunnerContext = {
  env: Env;
  kind: AnyKind;
  /** The latest record known: this runner's own writes and newer observed revisions. */
  job: JobRecord;
  input: unknown;
  state: unknown;
  replan: boolean;
  /** Steps committed by this runner (history records every Nth). */
  steps: number;
  /** The revision the lane spawned this runner from. */
  spawnedFrom: number;
  result?: UnitResult;
  error?: JobError;
};

export type RunnerEvent =
  | { type: "RECORD"; job: JobRecord | undefined }
  | { type: "ABORT" }
  | { type: "RELEASE" }
  | { type: "HEARTBEAT" }
  | { type: "LIVE"; payload: unknown };

const worker = (env: Env): Worker => ({ owner: env.owner, now: env.now(), leaseMs: env.leaseMs });

/**
 * One claimed job on the leader tab: claim → (execute → commit)* until the job leaves running.
 * The lease is renewed at a third of leaseMs alongside; step and heartbeat timeouts are delayed
 * transitions. Leaving `executing` stops the unit actor, which aborts ctx.signal — that is how a
 * pause, cancel, delete, lost lease, timeout or stop() reaches the kind's step.
 */
export const runnerMachine = setup({
  types: {
    input: {} as RunnerInput,
    context: {} as RunnerContext,
    events: {} as RunnerEvent,
  },
  actors: { write: writeLogic, unit: unitLogic, liveThrottle: liveThrottleMachine },
  actions: {
    keep: assign({
      job: ({ context }, record: JobRecord | undefined) =>
        record && record.revision > context.job.revision ? record : context.job,
    }),
    prepared: assign(({ context }) => {
      const prepared = prepare(context.job, context.kind);
      return "error" in prepared ? { error: prepared.error } : { ...prepared };
    }),
    advance: assign(({ context }) => {
      const result = context.result!;
      return {
        state: result.phase === "plan" || result.phase === "steps" ? result.state : context.state,
        replan: false,
        steps: result.phase === "steps" ? context.steps + 1 : context.steps,
        result: undefined,
      };
    }),
    timedOut: assign({ error: ({ context }, which: "step" | "heartbeat") => classify(context.kind, timeoutError(which)) }),
    ended: enqueueActions(({ enqueue, context }) => {
      enqueue(() => context.env.publish({ type: "live-clear", jobId: context.job.id }));
      enqueue(sendParent({ type: "RUNNER_ENDED", jobId: context.job.id, revision: context.spawnedFrom }));
    }),
  },
  guards: {
    wrote: (_, record: JobRecord | undefined) => record !== undefined,
    running: (_, record: JobRecord | undefined) => record?.status === "running",
    failedToPrepare: ({ context }) => context.error !== undefined,
    deleted: ({ event }) => event.type === "RECORD" && event.job === undefined,
    stale: ({ context, event }) => event.type === "RECORD" && event.job!.revision <= context.job.revision,
    leaseLost: ({ context, event }) =>
      event.type === "RECORD" && (event.job!.status !== "running" || event.job!.lease?.owner !== context.env.owner),
    controlRequested: ({ event }) => event.type === "RECORD" && event.job!.control !== undefined,
    hasStepTimeout: ({ context }) => context.kind.timeouts?.stepMs !== undefined,
    hasHeartbeatTimeout: ({ context }) => context.kind.timeouts?.heartbeatMs !== undefined,
  },
  delays: {
    renew: ({ context }) => Math.max(1, Math.floor(context.env.leaseMs / 3)),
    stepTimeout: ({ context }) => context.kind.timeouts!.stepMs!,
    heartbeatTimeout: ({ context }) => context.kind.timeouts!.heartbeatMs!,
  },
}).createMachine({
  id: "runner",
  context: ({ input }) => ({ env: input.env, kind: input.kind, job: input.job, input: undefined, state: null, replan: false, steps: 0, spawnedFrom: input.job.revision }),
  initial: "claiming",
  states: {
    claiming: {
      invoke: {
        src: "write",
        input: ({ context }) => ({ env: context.env, id: context.job.id, edit: (job: JobRecord) => claim(job, worker(context.env)) }),
        onDone: [
          {
            guard: { type: "wrote", params: ({ event }) => event.output },
            target: "preparing",
            actions: [{ type: "keep", params: ({ event }) => event.output }, "prepared"],
          },
          { target: "ended" },
        ],
        onError: { target: "ended" },
      },
    },
    preparing: {
      always: [{ guard: "failedToPrepare", target: "#runner.active.work.failing" }, { target: "active" }],
    },
    active: {
      type: "parallel",
      invoke: { id: "live", src: "liveThrottle", input: ({ context }) => ({ env: context.env, jobId: context.job.id }) },
      on: {
        RECORD: [
          { guard: "deleted", target: "ended" },
          { guard: "stale" },
          { guard: "leaseLost", target: "ended", actions: { type: "keep", params: ({ event }) => event.job } },
          { guard: "controlRequested", target: "controlling", actions: { type: "keep", params: ({ event }) => event.job } },
          { actions: { type: "keep", params: ({ event }) => event.job } },
        ],
        ABORT: { target: "ended" },
        RELEASE: { target: "releasing" },
        LIVE: { actions: sendTo("live", ({ event }) => event) },
      },
      states: {
        lease: {
          initial: "waiting",
          states: {
            waiting: { after: { renew: "renewing" } },
            renewing: {
              invoke: {
                src: "write",
                input: ({ context }) => ({ env: context.env, id: context.job.id, edit: (job: JobRecord) => renewLease(job, worker(context.env)) }),
                onDone: [
                  {
                    guard: { type: "wrote", params: ({ event }) => event.output },
                    target: "waiting",
                    actions: { type: "keep", params: ({ event }) => event.output },
                  },
                  { target: "#runner.ended" },
                ],
                onError: { target: "waiting" },
              },
            },
          },
        },
        work: {
          initial: "executing",
          states: {
            executing: {
              type: "parallel",
              invoke: {
                id: "unit",
                src: "unit",
                input: ({ context, self }) => ({
                  env: context.env,
                  kind: context.kind,
                  job: context.job,
                  input: context.input,
                  state: context.state,
                  unit: nextUnit(context.job, context.replan),
                  runner: self,
                }),
                onDone: { target: "committing", actions: assign({ result: ({ event }) => event.output }) },
                onError: { target: "failing", actions: assign({ error: ({ context, event }) => classify(context.kind, event.error) }) },
              },
              states: {
                deadline: {
                  initial: "route",
                  states: {
                    route: { always: [{ guard: "hasStepTimeout", target: "armed" }, { target: "off" }] },
                    armed: {
                      after: { stepTimeout: { target: "#runner.active.work.failing", actions: { type: "timedOut", params: "step" } } },
                    },
                    off: {},
                  },
                },
                heartbeat: {
                  initial: "route",
                  states: {
                    route: { always: [{ guard: "hasHeartbeatTimeout", target: "armed" }, { target: "off" }] },
                    armed: {
                      on: { HEARTBEAT: { target: "armed", reenter: true } },
                      after: {
                        heartbeatTimeout: { target: "#runner.active.work.failing", actions: { type: "timedOut", params: "heartbeat" } },
                      },
                    },
                    off: {},
                  },
                },
              },
            },
            committing: {
              invoke: {
                src: "write",
                input: ({ context }) => {
                  const { env, kind, steps } = context;
                  const result = context.result!;
                  return {
                    env,
                    id: context.job.id,
                    edit: (job: JobRecord) => {
                      const change = changeOf(result, kind, steps, job);
                      return change && commit(job, worker(env), change);
                    },
                  };
                },
                onDone: [
                  {
                    guard: { type: "running", params: ({ event }) => event.output },
                    target: "executing",
                    actions: [{ type: "keep", params: ({ event }) => event.output }, "advance"],
                  },
                  { target: "#runner.ended", actions: { type: "keep", params: ({ event }) => event.output } },
                ],
                onError: { target: "#runner.ended" },
              },
            },
            failing: {
              invoke: {
                src: "write",
                input: ({ context }) => {
                  const { env, kind } = context;
                  const error = context.error!;
                  return { env, id: context.job.id, edit: (job: JobRecord) => fail(job, worker(env), error, kind.retry, env.random) };
                },
                onDone: { target: "#runner.ended", actions: { type: "keep", params: ({ event }) => event.output } },
                onError: { target: "#runner.ended" },
              },
            },
          },
        },
      },
    },
    controlling: {
      invoke: {
        src: "write",
        input: ({ context }) => ({ env: context.env, id: context.job.id, edit: (job: JobRecord) => applyControl(job, worker(context.env)) }),
        onDone: { target: "ended", actions: { type: "keep", params: ({ event }) => event.output } },
        onError: { target: "ended" },
      },
    },
    releasing: {
      invoke: {
        src: "write",
        input: ({ context }) => ({ env: context.env, id: context.job.id, edit: (job: JobRecord) => releaseLease(job, worker(context.env)) }),
        onDone: { target: "ended", actions: { type: "keep", params: ({ event }) => event.output } },
        onError: { target: "ended" },
      },
    },
    ended: { type: "final", entry: "ended" },
  },
});
