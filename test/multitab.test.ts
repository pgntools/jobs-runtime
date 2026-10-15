import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createJobRuntime, type JobRuntime, type JobStore, type LeaderLock } from "../src/index.js";
import { indexedDbJobStore } from "../src/browser/index.js";
import { manualClock, memoryLock, runUntilIdle } from "../src/testing/index.js";
import { conflict } from "../src/core/store.js";
import { countKind, forever, sleep, type CountKindOptions } from "./helpers/kinds.js";
import { job, track } from "./helpers/runtime.js";
import { killable, sharedBus } from "./helpers/stores.js";

const LEASE_MS = 30_000;
let dbs = 0;

/** Two tabs: one fake-indexeddb database, a shared lock and bus, one clock; each with its own store handle. */
function tabs(kindOptions: (tab: string) => CountKindOptions[], options: { lock?: LeaderLock | null; wrap?: (store: JobStore) => JobStore } = {}) {
  const name = `tabs-${++dbs}`;
  const clock = manualClock();
  const lock = options.lock === null ? undefined : (options.lock ?? memoryLock());
  const bus = sharedBus();
  let ids = 0;
  const open = <S extends JobStore = JobStore>(tab: string, wrapTab?: (store: JobStore) => S) => {
    const shared = (options.wrap ?? ((s: JobStore) => s))(indexedDbJobStore({ name }));
    const store = (wrapTab ? wrapTab(shared) : shared) as S;
    const runtime = createJobRuntime({
      namespace: "app.jobs",
      kinds: kindOptions(tab).map((o) => countKind(o)),
      lanes: { cpu: { concurrency: 1 }, heavy: { concurrency: 1 } },
      store,
      lock,
      bus,
      clock,
      leaseMs: LEASE_MS,
      newId: () => `${tab}-${++ids}`,
    });
    track(runtime);
    return { runtime, store };
  };
  return { clock, open };
}

async function enqueue(runtime: JobRuntime, kind: string, steps: number) {
  const result = await runtime.enqueue(kind, { steps });
  if (!("id" in result)) throw new Error(result.problem);
  return result.id;
}

async function settle(...runtimes: JobRuntime[]) {
  for (const runtime of runtimes) await runUntilIdle(runtime);
}

describe("multi-tab", () => {
  it("only the leader runs; every tab sees the result", async () => {
    const ran: string[] = [];
    const { open } = tabs((tab) => [{ onStep: () => void ran.push(tab) }]);
    const a = open("A").runtime;
    const b = open("B").runtime;
    a.start();
    await settle(a);
    b.start();
    const ids = [await enqueue(b, "test.count", 2), await enqueue(b, "test.count", 1)];
    await settle(a, b);
    expect(ran).toEqual(["A", "A", "A"]);
    for (const id of ids) {
      expect(job(a, id).status).toBe("done");
      expect(job(b, id).status).toBe("done");
    }
  });

  it("honours a pause or cancel written by another tab within one step", async () => {
    const { open, clock } = tabs(() => [{ onStep: (_s, ctx) => sleep(clock, 100, ctx.signal) }]);
    const a = open("A").runtime;
    const b = open("B").runtime;
    a.start();
    b.start();
    const paused = await enqueue(b, "test.count", 10);
    await settle(a, b);
    await clock.advance(250); // two steps done, the third in flight
    expect(job(b, paused).state).toEqual({ i: 2, visited: [0, 1] });
    expect(await b.pause(paused)).toBeUndefined();
    await settle(a, b);
    expect(job(b, paused)).toMatchObject({ status: "paused", state: { i: 2 } });

    const cancelled = await enqueue(b, "test.count", 10);
    await settle(a, b);
    await clock.advance(100);
    expect(await b.cancel(cancelled)).toBeUndefined();
    await settle(a, b);
    expect(job(a, cancelled)).toMatchObject({ status: "cancelled", state: { i: 1 } });

    expect(await b.resume(paused)).toBeUndefined();
    await settle(a, b);
    for (let n = 0; n < 8; n++) await clock.advance(100);
    expect(job(b, paused)).toMatchObject({ status: "done", state: { visited: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } });
  });

  it("hands over when the leader is killed; stalled jobs follow their kind's autoResume", async () => {
    const { open, clock } = tabs(() => [
      { onStep: (_s, ctx) => sleep(clock, 1_000, ctx.signal) },
      { id: "test.heavy", lane: "heavy", autoResume: false, onStep: (_s, ctx) => sleep(clock, 1_000, ctx.signal) },
    ]);
    const tabA = open("A", killable);
    const a = tabA.runtime;
    const b = open("B").runtime;
    a.start();
    b.start();
    const cheap = await enqueue(b, "test.count", 3);
    const heavy = await enqueue(b, "test.heavy", 3);
    await settle(a, b);
    await clock.advance(1_000);
    expect(job(b, cheap)).toMatchObject({ status: "running", state: { i: 1 } });
    expect(job(b, cheap).lease!.owner).toMatch(/^A-/);

    // The leader's tab dies: its store handle is gone, its lock released by the browser.
    tabA.store.kill();
    await a.stop();
    await settle(b);
    expect(job(b, cheap).status).toBe("running"); // its lease is still live
    await clock.advance(LEASE_MS);
    await settle(b);
    expect(job(b, heavy)).toMatchObject({ status: "interrupted", state: { i: 1 } });
    expect(job(b, heavy).attempts.at(-1)!.outcome).toBe("interrupted");
    expect(job(b, cheap).lease?.owner ?? "").toMatch(/^B-/);
    await clock.advance(1_000);
    await clock.advance(1_000);
    expect(job(b, cheap)).toMatchObject({ status: "done", state: { visited: [0, 1, 2] } });
    expect(job(b, cheap).attempts.map((x) => x.outcome)).toEqual(["interrupted", "done"]);

    expect(await b.resume(heavy)).toBeUndefined();
    await settle(b);
    await clock.advance(1_000);
    await clock.advance(1_000);
    expect(job(b, heavy)).toMatchObject({ status: "done", state: { visited: [0, 1, 2] } });
  }, 20_000);

  it("stops at once when the lock is taken away, handing its leases back", async () => {
    let lose: (() => void) | undefined;
    let grants = 0;
    const stealable: LeaderLock = {
      acquire: (_name, onLost) => {
        grants++;
        if (grants > 1) return new Promise(() => {}); // re-queued for the lock, never granted again
        lose = onLost;
        return Promise.resolve(() => {});
      },
    };
    const { open } = tabs(() => [{ onStep: (_s, ctx) => forever(ctx.signal) }], { lock: stealable });
    const a = open("A").runtime;
    a.start();
    const id = await enqueue(a, "test.count", 2);
    await settle(a);
    expect(job(a, id).lease?.owner).toMatch(/^A-/);
    lose!();
    await settle(a);
    expect(job(a, id).status).toBe("running");
    expect(job(a, id).lease).toBeUndefined();
    expect(grants).toBe(2);
  });

  it("runs every job exactly once in lease-only mode (no Web Locks)", async () => {
    const ran: string[] = [];
    const { open } = tabs((tab) => [{ onStep: (_s, _c, input) => void ran.push(`${tab}:${input.steps}`) }], { lock: null });
    const a = open("A").runtime;
    const b = open("B").runtime;
    a.start();
    b.start();
    const ids = await Promise.all([1, 1, 1, 1].map(() => enqueue(a, "test.count", 1)));
    await settle(a, b);
    expect(ran).toHaveLength(4);
    for (const id of ids) expect(job(b, id).attempts).toHaveLength(1);
  });

  it("falls back to lease-only mode when the lock is unavailable", async () => {
    const unavailable: LeaderLock = { acquire: () => Promise.reject(new Error("no Web Locks")) };
    const { open } = tabs(() => [{}], { lock: unavailable });
    const a = open("A").runtime;
    a.start();
    const id = await enqueue(a, "test.count", 1);
    await settle(a);
    expect(job(a, id).status).toBe("done");
  });

  it("never loses an update under concurrent writes: the revision conflict is retried", async () => {
    let conflicts = 0;
    // A store whose read and write are separate transactions (a synced or remote adapter would be):
    // concurrent edits race, and the compare-and-set turns a race into a conflict.
    const optimistic = (store: JobStore): JobStore => ({
      ...store,
      update: async (id, edit) => {
        const seen = await store.get(id);
        if (!seen) return undefined;
        const next = edit(structuredClone(seen));
        if (!next) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return store.update(id, (stored) => {
          if (stored.revision !== seen.revision) {
            conflicts++;
            throw conflict("revision moved");
          }
          return next;
        });
      },
    });
    const { open } = tabs(() => [{}], { wrap: optimistic });
    // Commands are store writes from any tab; neither tab schedules here, so nothing claims the job.
    const tabA = open("A");
    const a = tabA.runtime;
    const b = open("B").runtime;
    const id = await enqueue(a, "test.count", 1);
    const outcomes: (string | undefined)[] = [];
    for (let round = 0; round < 6; round++) {
      // Four racing writes per round from both tabs; exactly one may land, the rest must see it.
      const command = (tab: JobRuntime) => (round % 2 === 0 ? tab.pause(id) : tab.resume(id));
      const results = await Promise.all([command(a), command(b), command(a), command(b)]);
      expect(results.filter((r) => r === undefined)).toHaveLength(1);
      outcomes.push(...results);
    }
    const record = (await tabA.store.get(id))!;
    const landed = outcomes.filter((o) => o === undefined).length;
    expect(conflicts).toBeGreaterThan(0);
    expect(landed).toBe(6);
    expect(outcomes.every((o) => o === undefined || o === "not-allowed")).toBe(true);
    // every command that reported success is in the record: none overwritten by a racing tab
    const commands = record.history.filter((e) => e.type === "paused" || e.type === "resumed");
    expect(commands.map((e) => e.type)).toEqual(["paused", "resumed", "paused", "resumed", "paused", "resumed"]);
    expect(record.revision).toBe(landed);
  });
});
