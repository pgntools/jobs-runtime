import { describe, expect, it, vi } from "vitest";
import { createJobRuntime, type JobRecord } from "../src/index.js";
import { manualClock, memoryJobStore, memoryLock } from "../src/testing/index.js";
import { countKind, forever, sleep } from "./helpers/kinds.js";
import { enqueued, idle, job, setup, track } from "./helpers/runtime.js";

describe("a job's life", () => {
  it("runs plan → steps → finalize → outputs to done, one checkpoint per step", async () => {
    const calls: string[] = [];
    const { runtime, store } = setup({ kinds: [countKind({ calls })] });
    const updates = vi.spyOn(store, "update");
    const id = await enqueued(runtime, "test.count", { steps: 3 });
    await idle(runtime);
    const done = job(runtime, id);
    expect(calls).toEqual(["plan", "step 0", "step 1", "step 2", "finalize", "apply count"]);
    expect(done).toMatchObject({
      status: "done",
      phase: "outputs",
      state: { i: 3, visited: [0, 1, 2] },
      progress: { done: 3, total: 3 },
      pendingOutputs: [],
      outputs: [{ key: "count", kind: "data", schema: "count", value: 3 }],
      attempts: [{ n: 1, outcome: "done" }],
      title: "count to 3",
      subjects: [{ type: "game", id: "g1" }],
    });
    expect(done.lease).toBeUndefined();
    expect(done.finishedAt).toBeDefined();
    // claim + plan + 3 steps + finalize + 1 output: every durable change one compare-and-set write.
    expect(updates).toHaveBeenCalledTimes(7);
    expect(done.revision).toBe(7);
    expect(done.history.map((e) => e.type)).toEqual(["enqueued", "claimed", "planned", "finalized", "output-applied", "done"]);
  });

  it("completes in the finalize write when there is nothing to apply", async () => {
    const { runtime } = setup({ kinds: [countKind({ plans: () => [] })] });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "done", outputs: [], revision: 4 });
  });

  it("records a checkpointed history event every 10th step, keeping the last 100 events", async () => {
    const { runtime } = setup({ kinds: [countKind()] });
    const id = await enqueued(runtime, "test.count", { steps: 25 });
    await idle(runtime);
    const types = job(runtime, id).history.map((e) => e.type);
    expect(types.filter((t) => t === "checkpointed")).toHaveLength(2);
  });

  it("forces an applied output's key to its plan's key", async () => {
    const kind = countKind({
      applyOutput: async () => ({ key: "something-else", kind: "data", schema: "s", value: 1 }),
    });
    const { runtime } = setup({ kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "done", outputs: [{ key: "count" }] });
  });

  it("fails a job whose finalize returns no keyed plans", async () => {
    const { runtime } = setup({ kinds: [countKind({ finalize: async () => [{ nokey: true }] as never })] });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "failed", error: { code: "unknown", retryable: false } });
  });

  it("defaults a kind's missing progress", async () => {
    const kind = countKind();
    const { runtime } = setup({
      kinds: [{ ...kind, plan: async () => ({ state: { i: 0, visited: [] }, progress: undefined as never }) }],
    });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("done");
  });
});

describe("enqueue", () => {
  it("refuses an unknown kind and an invalid input", async () => {
    const { runtime } = setup({ kinds: [countKind()] });
    expect(await runtime.enqueue("nope", {})).toEqual({ problem: "unknown-kind" });
    expect(await runtime.enqueue("test.count", { steps: "x" })).toEqual({ problem: "invalid" });
    const throwing = countKind({ id: "test.throws", title: () => { throw new Error("bad"); } });
    const { runtime: other } = setup({ kinds: [throwing] });
    expect(await other.enqueue("test.throws", { steps: 1 })).toEqual({ problem: "invalid" });
  });

  it("reports a storage problem", async () => {
    const store = memoryJobStore();
    store.add = () => Promise.reject(new Error("quota"));
    const { runtime } = setup({ kinds: [countKind()], store });
    expect(await runtime.enqueue("test.count", { steps: 1 })).toEqual({ problem: "storage" });
  });

  it("stores the parsed input, priority and runAfter", async () => {
    const { runtime, clock } = setup({ kinds: [countKind({ parseInput: (v) => ({ ...(v as object), steps: 1, tag: "parsed" }) })] });
    runtime.stop();
    const later = new Date(clock.now().getTime() + 60_000);
    const id = await enqueued(runtime, "test.count", { steps: 9, extra: true }, { priority: 5, runAfter: later });
    runtime.start();
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({
      status: "queued",
      priority: 5,
      runAfter: later.toISOString(),
      input: { steps: 1, tag: "parsed", extra: true },
      subjects: [{ type: "game", id: "parsed" }],
    });
  });

  it("generates ids with crypto.randomUUID by default", async () => {
    const clock = manualClock();
    const runtime = createJobRuntime({ namespace: "t", kinds: [countKind()], lanes: { cpu: { concurrency: 1 } }, store: memoryJobStore(), clock });
    const result = await runtime.enqueue("test.count", { steps: 1 });
    expect("id" in result && result.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("scheduling", () => {
  it("runs a lane's jobs by priority, then createdAt", async () => {
    const calls: string[] = [];
    const kind = countKind({ onStep: (_s, _c, input) => void calls.push(input.tag!) });
    const { runtime, clock } = setup({ kinds: [kind] });
    await runtime.stop();
    await enqueued(runtime, "test.count", { steps: 1, tag: "low-old" });
    await clock.advance(1);
    await enqueued(runtime, "test.count", { steps: 1, tag: "high" }, { priority: 2 });
    await clock.advance(1);
    await enqueued(runtime, "test.count", { steps: 1, tag: "low-new" });
    await clock.advance(1);
    await enqueued(runtime, "test.count", { steps: 1, tag: "high-new" }, { priority: 2 });
    runtime.start();
    await idle(runtime);
    expect(calls).toEqual(["high", "high-new", "low-old", "low-new"]);
  });

  it("respects each lane's concurrency, counting lanes apart", async () => {
    let running = 0;
    let peak = 0;
    const clock = manualClock();
    const onStep = async (_s: unknown, ctx: { signal: AbortSignal }) => {
      peak = Math.max(peak, ++running);
      await sleep(clock, 100, ctx.signal);
      running--;
    };
    const cpu = countKind({ onStep });
    const io = countKind({ id: "test.io", lane: "io", onStep });
    const { runtime } = setup({ clock, kinds: [cpu, io], lanes: { cpu: { concurrency: 2 }, io: { concurrency: 1 } } });
    const ids = [
      await enqueued(runtime, "test.count", { steps: 1 }),
      await enqueued(runtime, "test.count", { steps: 1 }),
      await enqueued(runtime, "test.count", { steps: 1 }),
      await enqueued(runtime, "test.io", { steps: 1 }),
    ];
    await idle(runtime);
    expect(peak).toBe(3);
    expect(runtime.snapshot()!.filter((j) => j.status === "running")).toHaveLength(3);
    await clock.advance(100);
    await clock.advance(100);
    expect(ids.map((id) => job(runtime, id).status)).toEqual(["done", "done", "done", "done"]);
  });

  it("waits for runAfter on a timer, not by polling", async () => {
    const { runtime, clock } = setup({ kinds: [countKind()] });
    const id = await enqueued(runtime, "test.count", { steps: 1 }, { runAfter: new Date(clock.now().getTime() + 5_000) });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("queued");
    await clock.advance(4_999);
    expect(job(runtime, id).status).toBe("queued");
    await clock.advance(1);
    expect(job(runtime, id).status).toBe("done");
  });

  it("never claims a record of an unregistered kind, and only deletes it", async () => {
    const store = memoryJobStore();
    const { runtime: first } = setup({ kinds: [countKind({ id: "old.kind" })], store });
    await first.stop();
    const id = await enqueued(first, "old.kind", { steps: 1 });
    const { runtime } = setup({ kinds: [countKind()], store });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("queued");
    expect(runtime.kindOf(id)).toBeUndefined();
    expect(await runtime.pause(id)).toBe("not-allowed");
    expect(await runtime.cancel(id)).toBe("not-allowed");
    expect(await runtime.resume(id)).toBe("not-allowed");
    expect(await runtime.remove([id])).toBeUndefined();
    await idle(runtime);
    expect(runtime.snapshot()).toEqual([]);
  });

  it("reads an unknown status as interrupted and never runs it unasked", async () => {
    const store = memoryJobStore();
    const { runtime: writer } = setup({ kinds: [countKind()], store });
    await writer.stop();
    const id = await enqueued(writer, "test.count", { steps: 1 });
    await store.update(id, (raw) => ({ ...raw, status: "zombie" as never, revision: raw.revision + 1 }));
    const { runtime } = setup({ kinds: [countKind()], store });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("interrupted");
    expect(await runtime.resume(id)).toBeUndefined();
    await idle(runtime);
    expect(job(runtime, id).status).toBe("done");
  });

  it("ignores values in the store that are not records", async () => {
    const store = memoryJobStore();
    await store.add({ id: "" } as JobRecord);
    const { runtime } = setup({ kinds: [countKind()], store });
    await idle(runtime);
    expect(runtime.snapshot()).toEqual([]);
  });
});

describe("re-entry", () => {
  it("migrates a checkpoint with parseState(value, fromVersion) and records the new version", async () => {
    const store = memoryJobStore();
    const clock = manualClock();
    const v1 = countKind({ onStep: (_s, ctx) => sleep(clock, 100, ctx.signal) });
    const { runtime: old } = setup({ kinds: [v1], store, clock });
    const id = await enqueued(old, "test.count", { steps: 3 });
    await clock.advance(100); // one step done, the second in flight
    await old.stop();
    const seen: number[] = [];
    const v2 = countKind({
      version: 2,
      parseState: (value, from) => {
        seen.push(from);
        return { ...(value as { i: number; visited: number[] }) };
      },
    });
    const { runtime } = setup({ kinds: [v2], store, clock });
    await idle(runtime);
    expect(seen).toEqual([1]);
    expect(job(runtime, id)).toMatchObject({ status: "done", kindVersion: 2, state: { visited: [0, 1, 2] } });
  });

  it("re-plans when parseState refuses the checkpoint, or the kind is not resumable", async () => {
    for (const variant of [{ parseState: () => undefined }, { resumable: false }]) {
      const store = memoryJobStore();
      const clock = manualClock();
      const calls: string[] = [];
      const kind = countKind({ calls, onStep: (_s, ctx) => sleep(clock, 100, ctx.signal) });
      const { runtime: first } = setup({ kinds: [kind], store, clock });
      const id = await enqueued(first, "test.count", { steps: 2 });
      await clock.advance(100);
      await first.stop();
      const { runtime } = setup({ kinds: [{ ...kind, ...variant }], store, clock });
      await idle(runtime);
      await clock.advance(100);
      await clock.advance(100);
      expect(job(runtime, id)).toMatchObject({ status: "done", state: { visited: [0, 1] } });
      expect(calls.filter((c) => c === "plan")).toHaveLength(2);
    }
  });

  it("fails at once when the stored input no longer parses", async () => {
    const store = memoryJobStore();
    const { runtime: writer } = setup({ kinds: [countKind()], store });
    await writer.stop();
    const id = await enqueued(writer, "test.count", { steps: 1 });
    const { runtime } = setup({ kinds: [countKind({ parseInput: () => { throw new Error("no"); } })], store });
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "failed", error: { code: "invalid-input", retryable: false } });
  });

  it("cannot finalize without a checkpoint, and applies outputs without one", async () => {
    const store = memoryJobStore();
    const { runtime: writer } = setup({ kinds: [countKind()], store });
    await writer.stop();
    const finalizeId = await enqueued(writer, "test.count", { steps: 1 });
    const outputsId = await enqueued(writer, "test.count", { steps: 1 });
    await store.update(finalizeId, (raw) => ({ ...raw, phase: "finalize", state: "garbage", revision: raw.revision + 1 }));
    await store.update(outputsId, (raw) => ({
      ...raw,
      phase: "outputs",
      state: "garbage",
      pendingOutputs: [{ key: "count", value: 7 }],
      revision: raw.revision + 1,
    }));
    const { runtime } = setup({ kinds: [countKind()], store });
    await idle(runtime);
    expect(job(runtime, finalizeId)).toMatchObject({ status: "failed", error: { code: "invalid-state" } });
    expect(job(runtime, outputsId)).toMatchObject({ status: "done", outputs: [{ key: "count", value: 7 }] });
  });
});

describe("commands", () => {
  it("pauses a queued job at once and resumes it", async () => {
    const { runtime, clock } = setup({ kinds: [countKind()] });
    const id = await enqueued(runtime, "test.count", { steps: 1 }, { runAfter: new Date(clock.now().getTime() + 1_000) });
    expect(await runtime.pause(id)).toBeUndefined();
    await idle(runtime);
    expect(job(runtime, id).status).toBe("paused");
    expect(await runtime.pause(id)).toBe("not-allowed");
    expect(await runtime.resume(id)).toBeUndefined();
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "done" });
    expect(job(runtime, id).runAfter).toBeUndefined();
  });

  it("cancels at once what is not running, and refuses a finished job", async () => {
    const { runtime, clock } = setup({ kinds: [countKind()] });
    const queued = await enqueued(runtime, "test.count", { steps: 1 }, { runAfter: new Date(clock.now().getTime() + 1_000) });
    expect(await runtime.cancel(queued)).toBeUndefined();
    await idle(runtime);
    expect(job(runtime, queued)).toMatchObject({ status: "cancelled" });
    expect(job(runtime, queued).finishedAt).toBeDefined();
    expect(await runtime.cancel(queued)).toBe("not-allowed");
    expect(await runtime.resume(queued)).toBe("not-allowed");
    const done = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(await runtime.cancel(done)).toBe("not-allowed");
    expect(await runtime.pause(done)).toBe("not-allowed");
  });

  it("aborts a running step on pause, keeping the checkpoint, and resumes from it", async () => {
    const clock = manualClock();
    const calls: string[] = [];
    let aborted = 0;
    const kind = countKind({
      calls,
      onStep: async (_s, ctx) => {
        ctx.signal.addEventListener("abort", () => aborted++);
        await sleep(clock, 100, ctx.signal);
      },
    });
    const { runtime } = setup({ clock, kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 3 });
    await clock.advance(100);
    expect(job(runtime, id).state).toEqual({ i: 1, visited: [0] });
    expect(await runtime.pause(id)).toBeUndefined();
    await idle(runtime);
    expect(aborted).toBe(1);
    expect(job(runtime, id)).toMatchObject({ status: "paused", state: { i: 1, visited: [0] }, attempts: [{ outcome: "paused" }] });
    expect(job(runtime, id).control).toBeUndefined();
    expect(await runtime.cancel(id)).toBeUndefined(); // a request on the paused job: cancelled at once
    await idle(runtime);
    expect(job(runtime, id).status).toBe("cancelled");
  });

  it("cancels a running job through its worker, and a second request is refused", async () => {
    const clock = manualClock();
    const { runtime } = setup({ clock, kinds: [countKind({ onStep: (_s, ctx) => forever(ctx.signal) })] });
    const id = await enqueued(runtime, "test.count", { steps: 3 });
    await idle(runtime);
    const store = runtime;
    expect(await store.cancel(id)).toBeUndefined();
    expect(await store.cancel(id)).toBe("not-allowed");
    expect(await store.pause(id)).toBe("not-allowed");
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "cancelled", attempts: [{ outcome: "cancelled" }] });
  });

  it("honours a control request written in the same write as a finished step", async () => {
    const clock = manualClock();
    let release: (() => void) | undefined;
    const kind = countKind({
      onStep: async () => {
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    const { runtime, store } = setup({ clock, kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 3 });
    await idle(runtime);
    // Another tab's pause lands without notifying this one; the step then finishes.
    await store.update(id, (raw) => ({ ...raw, control: "pause", revision: raw.revision + 1 }));
    release!();
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({ status: "paused", state: { i: 1 } });
  });

  it("reports missing and storage problems", async () => {
    const store = memoryJobStore();
    const { runtime } = setup({ kinds: [countKind()], store });
    expect(await runtime.pause("nope")).toBe("missing");
    expect(await runtime.remove(["nope"])).toBe("missing");
    expect(await runtime.remove([])).toBeUndefined();
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    store.update = () => Promise.reject(new Error("io"));
    store.get = () => Promise.reject(new Error("io"));
    expect(await runtime.resume(id)).toBe("storage");
    expect(await runtime.remove([id])).toBe("storage");
  });

  it("deletes a running job, aborting its step first, with its artifacts", async () => {
    const clock = manualClock();
    let aborted = false;
    const kind = countKind({
      onStep: async (state, ctx) => {
        ctx.signal.addEventListener("abort", () => (aborted = true));
        await ctx.artifacts.writePart("file", state.i, "x");
        await forever(ctx.signal);
      },
    });
    const { runtime, store } = setup({ clock, kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 2 });
    await idle(runtime);
    expect(await runtime.remove([id])).toBeUndefined();
    await idle(runtime);
    expect(aborted).toBe(true);
    expect(runtime.snapshot()).toEqual([]);
    expect((await store.sealArtifact(id, "file", { name: "f", mimeType: "text/plain" })).size).toBe(0);
  });

  it("removes the unfinished jobs of a deleted entity, keeping finished ones", async () => {
    const { runtime, clock } = setup({ kinds: [countKind()] });
    const finished = await enqueued(runtime, "test.count", { steps: 1, tag: "a" });
    await idle(runtime);
    const later = new Date(clock.now().getTime() + 1_000);
    const pending = await enqueued(runtime, "test.count", { steps: 1, tag: "a" }, { runAfter: later });
    const other = await enqueued(runtime, "test.count", { steps: 1, tag: "b" }, { runAfter: later });
    await runtime.removeUnfinishedOf([{ type: "game", id: "a" }]);
    await runtime.removeUnfinishedOf([{ type: "game", id: "nothing" }]);
    await idle(runtime);
    expect(runtime.snapshot()!.map((j) => j.id).sort()).toEqual([finished, other].sort());
    expect(pending).toBeDefined();
  });

  it("works before start(), writing to the store only", async () => {
    const clock = manualClock();
    const store = memoryJobStore();
    const runtime = createJobRuntime({ namespace: "t", kinds: [countKind()], lanes: { cpu: { concurrency: 1 } }, store, clock });
    track(runtime);
    const result = await runtime.enqueue("test.count", { steps: 1 });
    expect(runtime.snapshot()).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
    expect("id" in result).toBe(true);
  });
});

describe("the runtime object", () => {
  it("validates its options", () => {
    const base = { namespace: "t", kinds: [countKind()], lanes: { cpu: { concurrency: 1 } }, store: memoryJobStore() };
    expect(() => createJobRuntime({ ...base, namespace: "" })).toThrow(/namespace/);
    expect(() => createJobRuntime({ ...base, lanes: { cpu: { concurrency: 0 } } })).toThrow(/concurrency/);
    expect(() => createJobRuntime({ ...base, kinds: [countKind(), countKind()] })).toThrow(/twice/);
    expect(() => createJobRuntime({ ...base, kinds: [countKind({ lane: "gpu" })] })).toThrow(/unknown lane/);
  });

  it("start() is idempotent and stop() can be called twice; a stopped runtime starts again", async () => {
    const { runtime } = setup({ kinds: [countKind()] });
    runtime.start();
    await idle(runtime);
    expect(runtime.snapshot()).toEqual([]);
    const first = runtime.stop();
    expect(runtime.stop()).toBe(first);
    await first;
    await runtime.stop();
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    runtime.start();
    await idle(runtime);
    expect(job(runtime, id).status).toBe("done");
  });

  it("starting while a stop is in flight keeps the new session", async () => {
    const { runtime } = setup({ kinds: [countKind()] });
    await idle(runtime);
    const stopping = runtime.stop();
    runtime.start();
    await stopping;
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("done");
  });

  it("notifies subscribers and lists kinds by entity type", async () => {
    const other = countKind({ id: "test.other", appliesTo: ["position"] });
    const { runtime } = setup({ kinds: [countKind(), other] });
    const heard = vi.fn();
    const unsubscribe = runtime.subscribe(heard);
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(heard).toHaveBeenCalled();
    unsubscribe();
    expect(runtime.kindsFor("game").map((k) => k.id)).toEqual(["test.count"]);
    expect(runtime.kindsFor("position").map((k) => k.id)).toEqual(["test.other"]);
    expect(runtime.kindOf(id)?.id).toBe("test.count");
    expect(runtime.kindOf("missing")).toBeUndefined();
  });

  it("keeps running when the bus throws", async () => {
    const bus = { publish: () => { throw new Error("DataCloneError"); }, subscribe: () => () => {} };
    const { runtime } = setup({ kinds: [countKind({ onStep: (_s, ctx) => ctx.live({ fn: () => 1 }) })], bus });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("done");
  });

  it("uses real timers and Date when no clock is given", async () => {
    const runtime = createJobRuntime({
      namespace: "t",
      kinds: [countKind()],
      lanes: { cpu: { concurrency: 1 } },
      store: memoryJobStore(),
      lock: memoryLock(),
    });
    track(runtime);
    runtime.start();
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(job(runtime, id).status).toBe("done");
    expect(Math.abs(Date.parse(job(runtime, id).createdAt) - Date.now())).toBeLessThan(10_000);
  });
});
