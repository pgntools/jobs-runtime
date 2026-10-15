import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createJobRuntime, type JobKind, type JobOutput, type JobRecord, type JobStore } from "../src/index.js";
import { indexedDbJobStore } from "../src/browser/index.js";
import { manualClock, memoryJobStore, memoryLock, runUntilIdle } from "../src/testing/index.js";
import { countingStore, crashAfter } from "./helpers/stores.js";

const STEPS = 4;
const LEASE_MS = 30_000;

type State = { i: number; visited: number[]; sum: number };

/**
 * A multi-step job with an artifact and two outputs. `effects` is the outside world the outputs
 * touch (the app's entities): applyOutput is idempotent by plan.key against it.
 */
function crashKind(effects: Map<string, number>): JobKind<{ steps: number }, State> {
  return {
    id: "crash.multi",
    version: 1,
    lane: "cpu",
    appliesTo: ["game"],
    resumable: true,
    autoResume: true,
    retry: { maxAttempts: 3, backoff: { initialMs: 1_000, factor: 2, maxMs: 10_000, jitter: false } },
    parseInput: (value) => value as { steps: number },
    parseState: (value) => value as State,
    title: () => "crash test",
    subjects: () => [{ type: "game", id: "g" }],
    plan: async (input) => ({ state: { i: 0, visited: [], sum: 0 }, progress: { done: 0, total: input.steps } }),
    step: async (state, input, ctx) => {
      await ctx.artifacts.writePart("pgn", state.i, `[Game ${state.i}]\n1. e4 e5 ${"♞".repeat(state.i)}\n`);
      const i = state.i + 1;
      return { state: { i, visited: [...state.visited, state.i], sum: state.sum + state.i }, progress: { done: i, total: input.steps }, done: i >= input.steps };
    },
    finalize: async (state, _input, ctx) => {
      const sealed = await ctx.artifacts.seal("pgn", { name: "games.pgn", mimeType: "application/x-chess-pgn" });
      return [
        { key: "report", sum: state.sum },
        { key: "file", artifactId: sealed.artifactId, size: sealed.size },
      ];
    },
    applyOutput: async (plan): Promise<JobOutput> => {
      effects.set(plan.key, (effects.get(plan.key) ?? 0) + (effects.has(plan.key) ? 0 : 1));
      return plan.key === "file"
        ? { key: "file", kind: "artifact", artifactId: plan.artifactId as string, name: "games.pgn", mimeType: "application/x-chess-pgn", size: plan.size as number }
        : { key: "report", kind: "data", schema: "sum", value: plan.sum };
    },
  };
}

type Backend = { name: string; open: (db: string) => JobStore };
const backends: Backend[] = [
  { name: "memoryJobStore", open: (() => { const stores = new Map<string, JobStore>(); return (db: string) => { if (!stores.has(db)) stores.set(db, memoryJobStore()); return stores.get(db)!; }; })() },
  { name: "indexedDbJobStore", open: (db) => indexedDbJobStore({ name: db }) },
];

let run = 0;

async function scenario(backend: Backend, crashAt?: number) {
  const db = `crash-${backend.name}-${++run}`;
  const clock = manualClock();
  const lock = memoryLock();
  const effects = new Map<string, number>();
  let ids = 0;
  const make = (store: JobStore) =>
    createJobRuntime({
      namespace: "crash",
      kinds: [crashKind(effects)],
      lanes: { cpu: { concurrency: 1 } },
      store,
      lock,
      clock,
      leaseMs: LEASE_MS,
      newId: () => `${db}-${++ids}`,
    });

  const counted = countingStore(backend.open(db));
  const first = make(crashAt === undefined ? counted : crashAfter(counted, crashAt));
  first.start();
  const enqueued = await first.enqueue("crash.multi", { steps: STEPS });
  await runUntilIdle(first);
  await first.stop();
  const atCrash = (await backend.open(db).list())[0]?.status;

  // The restart: a fresh runtime (a reloaded tab) over the same database.
  const second = make(backend.open(db));
  second.start();
  await runUntilIdle(second);
  await clock.advance(LEASE_MS); // a lease the crashed tab left behind expires
  await clock.advance(10_000); // and any retry it scheduled comes due
  await runUntilIdle(second);
  const jobs = second.snapshot()!;
  const job = jobs[0]!;
  const file = job.outputs.find((o) => o.key === "file");
  const artifact = file?.kind === "artifact" ? await second.readArtifact(file.artifactId) : undefined;
  const bytes = artifact ? new Uint8Array(await artifact.arrayBuffer()) : undefined;
  await second.stop();
  return { enqueued, jobs, job, effects, bytes, writes: counted.writes(), atCrash };
}

function expectCompleted(result: Awaited<ReturnType<typeof scenario>>, reference: Uint8Array) {
  const { jobs, job, effects, bytes } = result;
  expect(jobs).toHaveLength(1);
  // a restart reaches done
  expect(job.status).toBe("done");
  // no step's effect is counted twice in the kind's state
  expect((job.state as State).visited).toEqual([0, 1, 2, 3]);
  expect((job.state as State).sum).toBe(0 + 1 + 2 + 3);
  // every output is applied exactly once
  expect([...effects.entries()].sort()).toEqual([["file", 1], ["report", 1]]);
  expect(job.outputs.map((o: JobRecord["outputs"][number]) => o.key).sort()).toEqual(["file", "report"]);
  expect(job.pendingOutputs).toEqual([]);
  // the artifact is byte-identical to an uncrashed run
  expect(bytes).toEqual(reference);
}

describe.each(backends)("crash safety over $name", (backend) => {
  it("survives a crash after every single store write", async () => {
    const clean = await scenario(backend);
    expect(clean.job.status).toBe("done");
    const reference = clean.bytes!;
    expect(new TextDecoder().decode(reference)).toContain("[Game 3]");
    // add, claim, plan, 4 × (part + step), seal, finalize, 2 outputs
    expect(clean.writes).toBe(1 + 1 + 1 + STEPS * 2 + 1 + 1 + 2);

    for (let crashAt = 1; crashAt <= clean.writes; crashAt++) {
      const result = await scenario(backend, crashAt);
      try {
        // the crash really cut the run short: only the very last write completes the job
        expect(result.atCrash === "done").toBe(crashAt === clean.writes);
        expectCompleted(result, reference);
      } catch (error) {
        throw new Error(`crash after write ${crashAt}: ${(error as Error).message}`, { cause: error });
      }
    }
  });
});
