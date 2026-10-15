import { afterEach } from "vitest";
import { createJobRuntime, type JobRecord, type JobRuntime } from "../../src/index.js";
import { manualClock, memoryJobStore, memoryLock, runUntilIdle } from "../../src/testing/index.js";

type Options = Parameters<typeof createJobRuntime>[0];

const started: JobRuntime[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((runtime) => runtime.stop()));
});

let ids = 0;

/** A started runtime on a manual clock and a memory store; stopped after the test. */
export function setup(overrides: Partial<Options> = {}) {
  const clock = manualClock();
  const options: Options = {
    namespace: "test",
    kinds: [],
    lanes: { cpu: { concurrency: 1 } },
    store: memoryJobStore(),
    lock: memoryLock(),
    clock,
    newId: () => `id-${++ids}`,
    ...overrides,
  };
  const runtime = createJobRuntime(options);
  started.push(runtime);
  runtime.start();
  return { runtime, clock: (overrides.clock ?? clock) as ReturnType<typeof manualClock>, store: options.store, options };
}

export function track(runtime: JobRuntime): void {
  started.push(runtime);
}

export async function enqueued(runtime: JobRuntime, kind: string, input: unknown, options?: { priority?: number; runAfter?: Date }) {
  const result = await runtime.enqueue(kind, input, options);
  if (!("id" in result)) throw new Error(`enqueue refused: ${result.problem}`);
  return result.id;
}

export function job(runtime: JobRuntime, id: string): JobRecord {
  const found = runtime.snapshot()?.find((record) => record.id === id);
  if (!found) throw new Error(`no job ${id} in the snapshot`);
  return found;
}

export const idle = runUntilIdle;
