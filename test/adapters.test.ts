import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastBus, indexedDbJobStore, webLocksLeader } from "../src/browser/index.js";
import { createJobRuntime, type JobRecord, type JobStore } from "../src/index.js";
import { jobStoreConformance, manualClock, memoryJobStore, memoryLock, runUntilIdle } from "../src/testing/index.js";
import { countKind } from "./helpers/kinds.js";
import { track } from "./helpers/runtime.js";

let dbs = 0;
const freshIdb = (): JobStore => indexedDbJobStore({ name: `conformance-${++dbs}` });

describe.each([
  { name: "memoryJobStore", make: memoryJobStore },
  { name: "indexedDbJobStore", make: freshIdb },
])("jobStoreConformance($name)", ({ make }) => {
  for (const check of jobStoreConformance(make)) it(check.name, check.run);
});

describe("jobStoreConformance", () => {
  it("catches a store that breaks the contract", async () => {
    const lax = (): JobStore => {
      const store = memoryJobStore();
      return { ...store, update: async (id, edit) => { const job = await store.get(id); return job && edit(job); } };
    };
    const failures: string[] = [];
    for (const check of jobStoreConformance(lax)) {
      await check.run().catch((error: Error) => failures.push(`${check.name}: ${error.message}`));
    }
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toMatch(/compare-and-set/);
    expect(failures.join("\n")).toMatch(/never lose an update/);
  });
});

describe("indexedDbJobStore", () => {
  const record = (id: string, revision = 0): JobRecord => ({
    id, kind: "k", kindVersion: 1, lane: "l", priority: 0, title: id, subjects: [], status: "queued", phase: "plan",
    input: null, state: null, progress: { done: 0, total: 0 }, pendingOutputs: [], outputs: [], attempts: [],
    maxAttempts: 1, history: [], revision, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("notifies the other stores of the same database, and not of another", async () => {
    const name = `shared-${++dbs}`;
    const one = indexedDbJobStore({ name });
    const two = indexedDbJobStore({ name });
    const elsewhere = indexedDbJobStore({ name: `${name}-other` });
    const heard = { two: 0, elsewhere: 0 };
    const off = two.subscribe(() => heard.two++);
    elsewhere.subscribe(() => heard.elsewhere++);
    await one.add(record("a"));
    expect(heard).toEqual({ two: 1, elsewhere: 0 });
    expect((await two.get("a"))?.id).toBe("a");
    off();
    await one.remove(["a"]);
    expect(heard.two).toBe(1);
  });

  it("refuses an edit that changes the id, and reopens after a version change", async () => {
    const store = freshIdb();
    await store.add(record("a"));
    await expect(store.update("a", (job) => ({ ...job, id: "b", revision: 1 }))).rejects.toThrow(/id/);
    expect(await store.get("b")).toBeUndefined();
    const memory = memoryJobStore();
    await memory.add(record("a"));
    await expect(memory.update("a", (job) => ({ ...job, id: "b", revision: 1 }))).rejects.toThrow(/id/);
  });

  it("reopens the database after another context upgrades it, and reports open errors", async () => {
    const name = `upgrade-${++dbs}`;
    const store = indexedDbJobStore({ name });
    await store.add(record("a"));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    // The store closed its stale connection; version 2 is newer than it knows, so opening fails...
    await expect(store.get("a")).rejects.toBeDefined();
    // ...and it does not cache the failure.
    await expect(store.list()).rejects.toBeDefined();
  });

  it("hears another realm's writes over a BroadcastChannel", async () => {
    const name = `realm-${++dbs}`;
    const store = indexedDbJobStore({ name });
    let heard = 0;
    store.subscribe(() => heard++);
    const foreign = new BroadcastChannel(`${name}.store`);
    foreign.postMessage({ realm: "another-tab" });
    for (let turn = 0; turn < 50 && heard === 0; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
    foreign.close();
    expect(heard).toBe(1);
  });
});

describe("webLocksLeader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects without Web Locks, so the runtime runs lease-only", async () => {
    vi.stubGlobal("navigator", {});
    await expect(webLocksLeader().acquire("x")).rejects.toThrow(/not available/);
  });

  it("grants, releases and reports a stolen lock", async () => {
    type Grant = { name: string; run: () => Promise<void>; settle: (error?: unknown) => void };
    const grants: Grant[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (name: string, _options: unknown, run: () => Promise<void>) =>
          new Promise<void>((resolve, reject) => {
            grants.push({ name, run, settle: (error) => (error ? reject(error) : resolve()) });
          }),
      },
    });
    const onLost = vi.fn();
    const acquiring = webLocksLeader().acquire("ns.leader", onLost);
    expect(grants[0]!.name).toBe("ns.leader");
    const held = grants[0]!.run();
    const release = await acquiring;
    release();
    await held;
    grants[0]!.settle(new DOMException("stolen", "AbortError"));
    await Promise.resolve();
    expect(onLost).toHaveBeenCalledTimes(1);

    const refused = webLocksLeader().acquire("ns.leader");
    grants[1]!.settle(new Error("denied"));
    await expect(refused).rejects.toThrow(/denied/);
  });
});

describe("broadcastBus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers to other channels of the same name, not to itself", async () => {
    const one = broadcastBus({ name: `bus-${++dbs}` });
    const two = broadcastBus({ name: `bus-${dbs}` });
    const got = { one: [] as unknown[], two: [] as unknown[] };
    one.subscribe((m) => got.one.push(m));
    const off = two.subscribe((m) => got.two.push(m));
    one.publish({ hello: 1 });
    for (let turn = 0; turn < 50 && got.two.length === 0; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(got).toEqual({ one: [], two: [{ hello: 1 }] });
    off();
  });

  it("is a no-op without BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const bus = broadcastBus({ name: "none" });
    const off = bus.subscribe(() => {});
    expect(() => bus.publish({})).not.toThrow();
    off();
    const store = indexedDbJobStore({ name: `no-channel-${++dbs}` });
    expect(() => store.subscribe(() => {})()).not.toThrow();
  });
});

describe("the testing kit", () => {
  it("manualClock fires due timers in order, skipping cleared ones", async () => {
    const clock = manualClock("2026-05-01T00:00:00.000Z");
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("b"), 20);
    clock.setTimeout(() => fired.push("a"), 10);
    clock.setTimeout(() => fired.push("a2"), 10);
    const cleared = clock.setTimeout(() => fired.push("never"), 5);
    clock.clearTimeout(cleared);
    clock.clearTimeout(undefined);
    clock.setTimeout(() => fired.push("later"), 100);
    expect(clock.pending()).toBe(4);
    await clock.advance(20);
    expect(fired).toEqual(["a", "a2", "b"]);
    expect(clock.now().toISOString()).toBe("2026-05-01T00:00:00.020Z");
    await clock.advance(80);
    expect(fired.at(-1)).toBe("later");
    expect(manualClock().now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.setTimeout((x: unknown) => fired.push(String(x)), undefined as never, "arg");
    await clock.advance(0);
    expect(fired.at(-1)).toBe("arg");
  });

  it("memoryLock grants one holder at a time, in request order", async () => {
    const lock = memoryLock();
    const order: string[] = [];
    const first = await lock.acquire("n");
    const second = lock.acquire("n").then((release) => (order.push("second"), release));
    const third = lock.acquire("n").then((release) => (order.push("third"), release));
    const other = await lock.acquire("other");
    other();
    first();
    first(); // releasing twice is harmless
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
  });

  it("runUntilIdle refuses something that is not a runtime", async () => {
    await expect(runUntilIdle({} as never)).rejects.toThrow(/not a runtime/);
  });

  it("runUntilIdle waits for a runtime that has not been started", async () => {
    const runtime = createJobRuntime({
      namespace: "t",
      kinds: [countKind()],
      lanes: { cpu: { concurrency: 1 } },
      store: memoryJobStore(),
      lock: memoryLock(),
      clock: manualClock(),
    });
    track(runtime);
    const enqueue = runtime.enqueue("test.count", { steps: 1 });
    await runUntilIdle(runtime);
    expect("id" in (await enqueue)).toBe(true);
  });
});
