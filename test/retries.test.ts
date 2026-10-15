import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobError, RetryPolicy } from "../src/index.js";
import { backoffMs } from "../src/core/records.js";
import { classify } from "../src/core/runner.js";
import { countKind, forever, sleep } from "./helpers/kinds.js";
import { enqueued, idle, job, setup } from "./helpers/runtime.js";

const policy = (maxAttempts: number, jitter = false): RetryPolicy => ({
  maxAttempts,
  backoff: { initialMs: 1_000, factor: 2, maxMs: 3_000, jitter },
});

const retryable: JobError = { code: "flaky", retryable: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retries", () => {
  it("re-queues a retryable error with exponential backoff on the clock, recording every attempt", async () => {
    let failures = 3;
    const kind = countKind({
      retry: policy(5),
      onStep: () => {
        if (failures-- > 0) throw new Error("flaky");
      },
      classifyError: () => retryable,
    });
    const { runtime, clock } = setup({ kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    const start = clock.now().getTime();
    const runAfter = () => Date.parse(job(runtime, id).runAfter!) - start;

    expect(job(runtime, id)).toMatchObject({ status: "queued", error: retryable });
    expect(runAfter()).toBe(1_000);
    await clock.advance(999);
    expect(job(runtime, id).attempts).toHaveLength(1);
    await clock.advance(1);
    expect(job(runtime, id).attempts).toHaveLength(2);
    expect(runAfter()).toBe(1_000 + 2_000);
    await clock.advance(2_000);
    expect(runAfter()).toBe(3_000 + 3_000); // capped at maxMs
    await clock.advance(3_000);

    const done = job(runtime, id);
    expect(done.status).toBe("done");
    expect(done.error).toBeUndefined();
    expect(done.attempts.map((a) => a.outcome)).toEqual(["retry-scheduled", "retry-scheduled", "retry-scheduled", "done"]);
    expect(done.attempts.map((a) => a.n)).toEqual([1, 2, 3, 4]);
    expect(done.attempts[0]!.error).toEqual(retryable);
    expect(done.history.filter((e) => e.type === "retry-scheduled")).toHaveLength(3);
  });

  it("bounds jitter to the upper half of the backoff", async () => {
    const random = vi.spyOn(Math, "random");
    const delays: number[] = [];
    for (const r of [0, 0.5, 0.999999]) {
      random.mockReturnValue(r);
      const kind = countKind({ retry: policy(2, true), onStep: () => { throw new Error("x"); }, classifyError: () => retryable });
      const { runtime, clock } = setup({ kinds: [kind] });
      const id = await enqueued(runtime, "test.count", { steps: 1 });
      await idle(runtime);
      delays.push(Date.parse(job(runtime, id).runAfter!) - clock.now().getTime());
    }
    expect(delays).toEqual([500, 750, 1_000]);
    for (let failures = 1; failures <= 6; failures++) {
      for (const r of [0, 0.3, 0.7, 0.99]) {
        const ms = backoffMs(policy(9, true), failures, () => r);
        const base = Math.min(3_000, 1_000 * 2 ** (failures - 1));
        expect(ms).toBeGreaterThanOrEqual(base / 2);
        expect(ms).toBeLessThanOrEqual(base);
      }
    }
  });

  it("fails a non-retryable error at once, keeping the checkpoint", async () => {
    const kind = countKind({
      retry: policy(5),
      onStep: (state) => {
        if (state.i === 1) throw new Error("bad move");
      },
    });
    const { runtime } = setup({ kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 3 });
    await idle(runtime);
    expect(job(runtime, id)).toMatchObject({
      status: "failed",
      state: { i: 1, visited: [0] },
      error: { code: "unknown", message: "bad move", retryable: false },
      attempts: [{ n: 1, outcome: "failed" }],
    });
    expect(job(runtime, id).finishedAt).toBeDefined();
  });

  it("fails once the attempts are spent; a resume starts a new budget from the checkpoint", async () => {
    let failing = true;
    const kind = countKind({
      retry: policy(2),
      onStep: (state) => {
        if (failing && state.i === 1) throw new Error("flaky");
      },
      classifyError: () => retryable,
    });
    const { runtime, clock } = setup({ kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 2 });
    await idle(runtime);
    await clock.advance(1_000);
    expect(job(runtime, id)).toMatchObject({ status: "failed", maxAttempts: 2, error: retryable, state: { i: 1 } });
    expect(job(runtime, id).attempts.map((a) => a.outcome)).toEqual(["retry-scheduled", "failed"]);

    failing = false;
    expect(await runtime.resume(id)).toBeUndefined();
    await idle(runtime);
    const resumed = job(runtime, id);
    expect(resumed).toMatchObject({ status: "done", maxAttempts: 4, state: { visited: [0, 1] } });
    expect(resumed.history.map((e) => e.type)).toContain("resumed");
    expect(resumed.attempts).toHaveLength(3);
  });

  it("prefers a pending control request over the retry", async () => {
    const clock = { now: () => new Date() };
    void clock;
    let release: (() => void) | undefined;
    const kind = countKind({
      retry: policy(5),
      onStep: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        throw new Error("flaky");
      },
      classifyError: () => retryable,
    });
    const { runtime, store } = setup({ kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 2 });
    await idle(runtime);
    await store.update(id, (raw) => ({ ...raw, control: "cancel", revision: raw.revision + 1 }));
    release!();
    await idle(runtime);
    expect(job(runtime, id).status).toBe("cancelled");
  });
});

describe("error classification", () => {
  const kind = countKind();
  it("defaults to unknown, non-retryable; a timeout to retryable", () => {
    expect(classify(kind, new Error("x"))).toEqual({ code: "unknown", message: "x", retryable: false });
    expect(classify(kind, "text")).toEqual({ code: "unknown", message: "text", retryable: false });
    expect(classify(kind, 42)).toEqual({ code: "unknown", retryable: false });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(classify(kind, timeout)).toEqual({ code: "timeout", message: "t", retryable: true });
  });

  it("uses the kind's classifier, falling back when it throws or returns junk", () => {
    expect(classify({ ...kind, classifyError: () => retryable }, new Error())).toEqual(retryable);
    expect(classify({ ...kind, classifyError: () => ({ code: 1 }) as never }, new Error("j"))).toMatchObject({ code: "unknown" });
    expect(classify({ ...kind, classifyError: () => { throw new Error(); } }, new Error("k"))).toMatchObject({ code: "unknown" });
  });
});

describe("timeouts and heartbeats", () => {
  it("fails a silent step with a retryable timeout after heartbeatMs", async () => {
    const kind = countKind({ timeouts: { heartbeatMs: 1_000 }, onStep: (_s, ctx) => forever(ctx.signal) });
    const { runtime, clock } = setup({ kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    await clock.advance(999);
    expect(job(runtime, id).status).toBe("running");
    await clock.advance(1);
    expect(job(runtime, id)).toMatchObject({
      status: "failed",
      error: { code: "timeout", retryable: true },
      attempts: [{ outcome: "failed" }],
    });
  });

  it("keeps a heartbeating step alive past heartbeatMs", async () => {
    const { runtime, clock } = setup();
    const kind = countKind({
      timeouts: { heartbeatMs: 1_000 },
      onStep: async (_s, ctx) => {
        for (let beat = 0; beat < 5; beat++) {
          await sleep(clock, 600, ctx.signal);
          ctx.heartbeat();
        }
      },
    });
    const { runtime: worker } = setup({ kinds: [kind], clock });
    void runtime;
    const id = await enqueued(worker, "test.count", { steps: 1 });
    await idle(worker);
    for (let i = 0; i < 5; i++) await clock.advance(600);
    expect(job(worker, id).status).toBe("done");
  });

  it("bounds a step by stepMs even while it heartbeats, and lets the kind classify the timeout", async () => {
    const { clock } = setup();
    const kind = countKind({
      timeouts: { stepMs: 2_000, heartbeatMs: 1_000 },
      retry: policy(3),
      onStep: async (_s, ctx) => {
        for (;;) {
          await sleep(clock, 500, ctx.signal);
          ctx.heartbeat();
        }
      },
      classifyError: (error) => ({ code: (error as Error).name, retryable: false }),
    });
    const { runtime } = setup({ kinds: [kind], clock });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    await clock.advance(1_999);
    expect(job(runtime, id).status).toBe("running");
    await clock.advance(1);
    expect(job(runtime, id)).toMatchObject({ status: "failed", error: { code: "TimeoutError", retryable: false } });
  });

  it("renews the lease at a third of leaseMs while a step runs", async () => {
    const { clock } = setup();
    const kind = countKind({ onStep: (_s, ctx) => sleep(clock, 25_000, ctx.signal) });
    const { runtime } = setup({ kinds: [kind], clock, leaseMs: 9_000 });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await idle(runtime);
    const expiry = () => Date.parse(job(runtime, id).lease!.expiresAt) - clock.now().getTime();
    expect(expiry()).toBe(9_000);
    await clock.advance(3_000);
    expect(expiry()).toBe(9_000);
    await clock.advance(10_000);
    expect(expiry()).toBeGreaterThan(6_000);
    await clock.advance(12_000);
    expect(job(runtime, id).status).toBe("done");
  });
});
