import { describe, expect, it, vi } from "vitest";
import { createJobRuntime, type JobStore } from "../src/index.js";
import { manualClock, memoryJobStore, memoryLock, runUntilIdle } from "../src/testing/index.js";
import { countKind, forever, sleep } from "./helpers/kinds.js";
import { enqueued, idle, job, setup, track } from "./helpers/runtime.js";

/** A few macrotasks: for waiting while a store call is deliberately left in flight (idle would wait for it). */
async function turns(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("the queue hold", () => {
  it("aborts the running step, puts the job back to queued from its checkpoint, and claims nothing in any lane", async () => {
    const clock = manualClock();
    const calls: string[] = [];
    let aborted = 0;
    const cpu = countKind({
      onStep: async (state, ctx, input) => {
        calls.push(`${input.tag} ${state.i}`);
        ctx.signal.addEventListener("abort", () => aborted++);
        await sleep(clock, 100, ctx.signal);
      },
    });
    const io = countKind({ id: "test.io", lane: "io", onStep: (state, _c, input) => void calls.push(`${input.tag} ${state.i}`) });
    const { runtime } = setup({ clock, kinds: [cpu, io], lanes: { cpu: { concurrency: 1 }, io: { concurrency: 1 } } });
    const notified = vi.fn();
    runtime.subscribe(notified);
    const running = await enqueued(runtime, "test.count", { steps: 3, tag: "a" });
    const waiting = await enqueued(runtime, "test.count", { steps: 1, tag: "b" });
    await clock.advance(100);
    expect(job(runtime, running).state).toEqual({ i: 1, visited: [0] });
    expect(runtime.held()).toBe(false);

    expect(await runtime.hold()).toBeUndefined();
    await idle(runtime);
    expect(runtime.held()).toBe(true);
    expect(notified).toHaveBeenCalled();
    expect(aborted).toBe(1);
    const held = job(runtime, running);
    expect(held).toMatchObject({ status: "queued", phase: "steps", state: { i: 1, visited: [0] }, attempts: [{ n: 1, outcome: "held" }] });
    expect(held.lease).toBeUndefined();
    expect(held.control).toBeUndefined();
    expect(held.history.at(-1)?.type).toBe("held");
    expect(job(runtime, waiting).status).toBe("queued");

    // Nothing is claimed while held, in this lane or another, however long it waits.
    const other = await enqueued(runtime, "test.io", { steps: 1, tag: "c" });
    await clock.advance(10_000);
    await idle(runtime);
    expect(job(runtime, other).status).toBe("queued");
    expect(job(runtime, running).status).toBe("queued");
    expect(calls).toEqual(["a 0", "a 1"]);
  });

  it("release() continues the held job from its checkpoint, then the queue in its usual order, spending no attempt", async () => {
    const clock = manualClock();
    const calls: string[] = [];
    let failOnce = true;
    const kind = countKind({
      retry: { maxAttempts: 2, backoff: { initialMs: 1_000, factor: 2, maxMs: 60_000, jitter: false } },
      onStep: async (state, ctx, input) => {
        calls.push(`${input.tag} ${state.i}`);
        await sleep(clock, 100, ctx.signal);
        if (input.tag === "a" && state.i === 2 && failOnce) {
          failOnce = false;
          throw new Error("flaky");
        }
      },
      classifyError: () => ({ code: "flaky", retryable: true }),
    });
    const { runtime } = setup({ clock, kinds: [kind] });
    const a = await enqueued(runtime, "test.count", { steps: 3, tag: "a" });
    await clock.advance(1);
    const low = await enqueued(runtime, "test.count", { steps: 1, tag: "low" });
    await clock.advance(100);
    expect(await runtime.hold()).toBeUndefined();
    await idle(runtime);
    const high = await enqueued(runtime, "test.count", { steps: 1, tag: "high" }, { priority: 1 });
    const later = await enqueued(runtime, "test.count", { steps: 1, tag: "later" }, { runAfter: new Date(clock.now().getTime() + 5_000) });
    await idle(runtime);
    expect([a, low, high, later].map((id) => job(runtime, id).status)).toEqual(["queued", "queued", "queued", "queued"]);
    calls.length = 0;

    expect(await runtime.release()).toBeUndefined();
    await idle(runtime);
    expect(runtime.held()).toBe(false);
    for (let n = 0; n < 60; n++) await clock.advance(100);
    // Priority first, then createdAt: the held job is the oldest of its priority and re-enters at step 1;
    // its retry waits for its backoff, the deferred job for its runAfter.
    expect(calls).toEqual(["high 0", "a 1", "a 2", "low 0", "a 2", "later 0"]);
    // The hold spent no attempt: the one retryable failure still had an attempt left to retry with.
    expect(job(runtime, a)).toMatchObject({
      status: "done",
      state: { visited: [0, 1, 2] },
      attempts: [{ outcome: "held" }, { outcome: "retry-scheduled" }, { outcome: "done" }],
    });
    expect([low, high, later].map((id) => job(runtime, id).status)).toEqual(["done", "done", "done"]);
  });

  it("keeps per-job pause, resume, cancel and remove working while held; release resumes no paused job", async () => {
    const clock = manualClock();
    const { runtime } = setup({ clock, kinds: [countKind({ onStep: (_s, ctx) => sleep(clock, 100, ctx.signal) })] });
    await runtime.stop();
    const pausedBefore = await enqueued(runtime, "test.count", { steps: 1 });
    const pausedDuring = await enqueued(runtime, "test.count", { steps: 1 });
    const resumed = await enqueued(runtime, "test.count", { steps: 1 });
    const cancelled = await enqueued(runtime, "test.count", { steps: 1 });
    const removed = await enqueued(runtime, "test.count", { steps: 1 });
    expect(await runtime.pause(pausedBefore)).toBeUndefined();
    expect(await runtime.pause(resumed)).toBeUndefined();
    expect(await runtime.hold()).toBeUndefined(); // before start(): a store write only
    runtime.start();
    await idle(runtime);
    expect(runtime.held()).toBe(true);

    expect(await runtime.pause(pausedDuring)).toBeUndefined();
    expect(await runtime.resume(resumed)).toBeUndefined();
    expect(await runtime.cancel(cancelled)).toBeUndefined();
    expect(await runtime.remove([removed])).toBeUndefined();
    await idle(runtime);
    expect(job(runtime, pausedDuring).status).toBe("paused");
    expect(job(runtime, resumed).status).toBe("queued"); // back in the queue, waiting for the release
    expect(job(runtime, cancelled).status).toBe("cancelled");
    expect(runtime.snapshot()?.some((record) => record.id === removed)).toBe(false);

    expect(await runtime.release()).toBeUndefined();
    await idle(runtime);
    await clock.advance(100);
    await idle(runtime);
    expect(job(runtime, resumed).status).toBe("done");
    expect(job(runtime, pausedBefore).status).toBe("paused");
    expect(job(runtime, pausedDuring).status).toBe("paused");
  });

  it("lets a pause requested on the running job win over the hold", async () => {
    const clock = manualClock();
    let finish: (() => void) | undefined;
    const kind = countKind({ onStep: () => new Promise<void>((resolve) => (finish = resolve)) });
    const { runtime, store } = setup({ clock, kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 3 });
    await idle(runtime);
    // Another tab's pause lands without notifying this one, then the queue is held.
    await store.update(id, (raw) => ({ ...raw, control: "pause", revision: raw.revision + 1 }));
    expect(await runtime.hold()).toBeUndefined();
    await idle(runtime);
    finish?.();
    expect(job(runtime, id)).toMatchObject({ status: "paused", attempts: [{ outcome: "paused" }] });
    expect(await runtime.release()).toBeUndefined();
    await idle(runtime);
    expect(job(runtime, id).status).toBe("paused");
  });

  it("is durable: a new runtime over the same store starts held", async () => {
    const clock = manualClock();
    const store = memoryJobStore();
    const first = setup({ clock, store, kinds: [countKind()] }).runtime;
    expect(await first.hold()).toBeUndefined();
    await first.stop();
    const second = setup({ clock, store, kinds: [countKind()] }).runtime;
    expect(second.held()).toBeUndefined(); // until the first read lands
    const id = await enqueued(second, "test.count", { steps: 1 });
    await idle(second);
    expect(second.held()).toBe(true);
    expect(job(second, id).status).toBe("queued");
    expect(await second.release()).toBeUndefined();
    await idle(second);
    expect(job(second, id).status).toBe("done");
  });

  it("is idempotent: a second hold and a release with nothing held write nothing", async () => {
    const { runtime, store } = setup({ kinds: [countKind()] });
    const puts = vi.spyOn(store, "putMeta");
    expect(await runtime.release()).toBeUndefined();
    expect(puts).not.toHaveBeenCalled();
    expect(await runtime.hold()).toBeUndefined();
    expect(await runtime.hold()).toBeUndefined();
    expect(puts).toHaveBeenCalledTimes(1);
    expect(await runtime.release()).toBeUndefined();
    expect(await runtime.release()).toBeUndefined();
    expect(puts).toHaveBeenCalledTimes(2);
    await idle(runtime);
    expect(runtime.held()).toBe(false);
  });

  it("degrades over a store without meta: hold() is not allowed and the queue never reads held", async () => {
    const { getMeta: _get, putMeta: _put, ...plain } = memoryJobStore();
    const { runtime } = setup({ store: plain, kinds: [countKind()] });
    expect(await runtime.hold()).toBe("not-allowed");
    expect(await runtime.release()).toBeUndefined();
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    expect(runtime.held()).toBe(false);
    expect(job(runtime, id).status).toBe("done");
  });

  it("reports a storage problem", async () => {
    const store: JobStore = { ...memoryJobStore(), putMeta: () => Promise.reject(new Error("quota")) };
    const { runtime } = setup({ store, kinds: [countKind()] });
    expect(await runtime.hold()).toBe("storage");
    const failingRead: JobStore = { ...memoryJobStore(), getMeta: () => Promise.reject(new Error("closed")) };
    const other = setup({ store: failingRead, kinds: [countKind()] }).runtime;
    expect(await other.release()).toBe("storage");
  });

  it("stop() while held hands a job claimed meanwhile back to queued, not to a stall", async () => {
    const clock = manualClock();
    const base = memoryJobStore();
    let gate: Promise<void> | undefined;
    const store: JobStore = {
      ...base,
      update: async (id, edit) => {
        if (gate) await gate;
        return base.update(id, edit);
      },
    };
    const kind = countKind({ autoResume: false, onStep: (_s, ctx) => forever(ctx.signal) });
    const runtime = createJobRuntime({ namespace: "t", kinds: [kind], lanes: { cpu: { concurrency: 1 } }, store, lock: memoryLock(), clock });
    track(runtime);
    runtime.start();
    await runUntilIdle(runtime);
    let open!: () => void;
    gate = new Promise<void>((resolve) => (open = resolve));
    const id = await enqueued(runtime, "test.count", { steps: 2 });
    await turns(); // the claim is in flight, held at the gate
    expect(await runtime.hold()).toBeUndefined();
    await turns(); // the hold is read while the runner is still claiming
    expect(runtime.held()).toBe(true);
    gate = undefined;
    open(); // the claim lands...
    await runtime.stop(); // ...and stop() hands the job back as the hold would have
    const stored = await base.get(id);
    expect(stored).toMatchObject({ status: "queued", attempts: [{ outcome: "held" }] });
    expect(stored?.lease).toBeUndefined();
    expect(stored?.history.at(-1)?.type).toBe("held");
  });
});
