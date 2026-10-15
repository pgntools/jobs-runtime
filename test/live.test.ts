import { describe, expect, it } from "vitest";
import { createJobRuntime } from "../src/index.js";
import { manualClock, memoryJobStore, memoryLock, runUntilIdle } from "../src/testing/index.js";
import { countKind, sleep } from "./helpers/kinds.js";
import { enqueued, job, setup, track } from "./helpers/runtime.js";
import { countingStore, sharedBus } from "./helpers/stores.js";

type Live = { type: string; jobId: string; payload?: unknown; from: string; ns: string };

const liveOn = (bus: ReturnType<typeof sharedBus>) =>
  (bus.messages as Live[]).filter((m) => m.type === "live" || m.type === "live-clear").map((m) => (m.type === "live" ? m.payload : "clear"));

describe("live telemetry", () => {
  it("throttles to the interval's last payload, re-sends every second, clears when the run ends — and never writes", async () => {
    const clock = manualClock();
    const bus = sharedBus();
    const store = countingStore(memoryJobStore());
    let writesDuringLive = -1;
    const kind = countKind({
      onStep: async (_s, ctx) => {
        const before = store.writes();
        for (let n = 1; n <= 5; n++) ctx.live(n); // one burst: 1 at once, then the last (5) after the interval
        await sleep(clock, 250, ctx.signal);
        await sleep(clock, 3_000, ctx.signal); // silence: re-sent every second once the throttle idles (t=500)
        for (let n = 0; n < 100; n++) ctx.live(`x${n}`);
        writesDuringLive = store.writes() - before;
        await sleep(clock, 100, ctx.signal);
      },
    });
    const { runtime } = setup({ clock, bus, store, kinds: [kind] });
    const id = await enqueued(runtime, "test.count", { steps: 1 });
    await runUntilIdle(runtime);
    expect(liveOn(bus)).toEqual([1]);
    expect(runtime.liveOf(id)).toBe(1);
    await clock.advance(250);
    expect(liveOn(bus)).toEqual([1, 5]);
    expect(runtime.liveOf(id)).toBe(5);
    await clock.advance(2_999);
    expect(liveOn(bus)).toEqual([1, 5, 5, 5]); // re-sent at t=1500 and t=2500
    await clock.advance(1);
    expect(liveOn(bus)).toEqual([1, 5, 5, 5, "x0"]);
    await clock.advance(100);
    expect(writesDuringLive).toBe(0);
    expect(liveOn(bus)).toEqual([1, 5, 5, 5, "x0", "clear"]);
    expect(job(runtime, id).status).toBe("done");
    expect(runtime.liveOf(id)).toBeUndefined();
    expect(JSON.stringify(await store.list())).not.toContain("x99");
  });

  it("reaches every tab; a reader drops it after liveStaleMs without news", async () => {
    const clock = manualClock();
    const bus = sharedBus();
    const store = memoryJobStore();
    const lock = memoryLock();
    const kind = countKind({
      onStep: async (_s, ctx) => {
        ctx.live({ depth: 12 });
        await sleep(clock, 60_000, ctx.signal);
      },
    });
    const leader = createJobRuntime({ namespace: "ns", kinds: [kind], lanes: { cpu: { concurrency: 1 } }, store, lock, bus, clock });
    const neverGranted = { acquire: () => new Promise<() => void>(() => {}) };
    const reader = createJobRuntime({ namespace: "ns", kinds: [kind], lanes: { cpu: { concurrency: 1 } }, store, lock: neverGranted, bus, clock });
    const stranger = createJobRuntime({ namespace: "other", kinds: [kind], lanes: { cpu: { concurrency: 1 } }, store: memoryJobStore(), bus, clock });
    for (const runtime of [leader, reader, stranger]) {
      track(runtime);
      runtime.start();
    }
    const heard: unknown[] = [];
    const unsubscribe = reader.subscribeLive(() => heard.push(reader.liveOf(id)));
    const id = await enqueued(reader, "test.count", { steps: 1 });
    await runUntilIdle(leader);
    expect(reader.liveOf(id)).toEqual({ depth: 12 });
    expect(stranger.liveOf(id)).toBeUndefined();
    expect(heard).toEqual([{ depth: 12 }]);

    await leader.stop(); // stop() clears what this tab published
    await runUntilIdle(reader);
    expect(reader.liveOf(id)).toBeUndefined();
    // A tab that dies without a word: no clear, no re-sends — the reader drops the entry after 4 s.
    bus.publish({ ns: "ns", from: "ghost", type: "live", jobId: id, payload: "late" });
    await runUntilIdle(reader);
    expect(reader.liveOf(id)).toBe("late");
    await clock.advance(3_999);
    expect(reader.liveOf(id)).toBe("late");
    await clock.advance(1);
    expect(reader.liveOf(id)).toBeUndefined();
    unsubscribe();
  });

  it("ignores malformed bus messages", async () => {
    const bus = sharedBus();
    const { runtime } = setup({ bus, kinds: [countKind()] });
    for (const junk of [null, 1, "x", { ns: "test", from: "z", type: "live" }, { ns: "test", from: "z", type: "what", jobId: "j" }]) bus.publish(junk);
    await runUntilIdle(runtime);
    expect(runtime.liveOf("j")).toBeUndefined();
  });
});

describe("retention", () => {
  it("prunes the oldest finished records, with their artifacts, to make room", async () => {
    const kind = countKind({
      onStep: async (state, ctx) => ctx.artifacts.writePart("file", state.i, "data"),
      plans: () => [],
      finalize: async (_s, _i, ctx) => {
        await ctx.artifacts.seal("file", { name: "f.txt", mimeType: "text/plain" });
        return [];
      },
    });
    const { runtime, clock, store } = setup({ kinds: [kind], retention: { maxJobs: 3 } });
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      ids.push(await enqueued(runtime, "test.count", { steps: 1 }));
      await runUntilIdle(runtime);
      await clock.advance(1_000);
    }
    expect(await store.readArtifact(`${ids[0]}/file`)).toBeDefined();
    ids.push(await enqueued(runtime, "test.count", { steps: 1 }));
    await runUntilIdle(runtime);
    expect(runtime.snapshot()!.map((j) => j.id)).toEqual(ids.slice(1));
    expect(await store.readArtifact(`${ids[0]}/file`)).toBeUndefined();
  });

  it("refuses an enqueue with too-many when every record is unfinished", async () => {
    const { runtime, clock } = setup({ kinds: [countKind()], retention: { maxJobs: 2 } });
    const later = new Date(clock.now().getTime() + 60_000);
    await enqueued(runtime, "test.count", { steps: 1 }, { runAfter: later });
    const paused = await enqueued(runtime, "test.count", { steps: 1 }, { runAfter: later });
    await runtime.pause(paused);
    expect(await runtime.enqueue("test.count", { steps: 1 })).toEqual({ problem: "too-many" });
    await runtime.cancel(paused);
    expect("id" in (await runtime.enqueue("test.count", { steps: 1 }))).toBe(true);
  });
});
