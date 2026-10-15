import type { JobKind, JobOutput, OutputPlan, StepContext } from "../../src/index.js";

type Clock = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

/** Waits `ms` on the given clock; rejects with the abort reason when ctx.signal aborts. */
export function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clock.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Never settles on its own: resolves only by aborting (a silent step). */
export function forever(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

export type CountInput = { steps: number; tag?: string };
export type CountState = { i: number; visited: number[] };

export type CountKindOptions = Partial<Omit<JobKind<CountInput, CountState>, "step">> & {
  /** Runs inside every step before it returns; may throw, wait or call ctx. */
  onStep?: (state: CountState, ctx: StepContext, input: CountInput) => Promise<void> | void;
  /** Output plans (default: one data output with the final count). */
  plans?: (state: CountState) => OutputPlan[];
  /** Records every call, for assertions. */
  calls?: string[];
};

/** A scripted kind: plan → `steps` steps (each one counted in the state) → finalize → outputs. */
export function countKind(options: CountKindOptions = {}): JobKind<CountInput, CountState> {
  const { onStep, plans, calls, ...rest } = options;
  const log = (entry: string): void => void calls?.push(entry);
  return {
    id: "test.count",
    version: 1,
    lane: "cpu",
    appliesTo: ["game"],
    resumable: true,
    autoResume: true,
    retry: { maxAttempts: 1, backoff: { initialMs: 1_000, factor: 2, maxMs: 60_000, jitter: false } },
    parseInput: (value) =>
      typeof value === "object" && value !== null && typeof (value as CountInput).steps === "number" ? (value as CountInput) : undefined,
    parseState: (value) =>
      typeof value === "object" && value !== null && typeof (value as CountState).i === "number" ? (value as CountState) : undefined,
    title: (input) => `count to ${input.steps}`,
    subjects: (input) => [{ type: "game", id: input.tag ?? "g1" }],
    plan: async (input) => {
      log("plan");
      return { state: { i: 0, visited: [] }, progress: { done: 0, total: input.steps } };
    },
    step: async (state, input, ctx) => {
      log(`step ${state.i}`);
      await onStep?.(state, ctx, input);
      const i = state.i + 1;
      return { state: { i, visited: [...state.visited, state.i] }, progress: { done: i, total: input.steps }, done: i >= input.steps };
    },
    finalize: async (state) => {
      log("finalize");
      return plans ? plans(state) : [{ key: "count", value: state.i }];
    },
    applyOutput: async (plan): Promise<JobOutput> => {
      log(`apply ${plan.key}`);
      return { key: plan.key, kind: "data", schema: "count", value: plan.value };
    },
    ...rest,
  };
}
