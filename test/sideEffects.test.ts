import { afterEach, describe, expect, it, vi } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const OWN = [SRC, "/node_modules/xstate/", "/node_modules/react/"];

const BROWSER_GLOBALS = ["indexedDB", "IDBKeyRange", "navigator", "BroadcastChannel", "localStorage", "sessionStorage", "requestAnimationFrame"];
const TIMERS = ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"] as const;

type Saved = { name: string; descriptor: PropertyDescriptor | undefined };

/** Every browser API throws when touched; timers record callers from the package (or its dependencies). */
function stubTheWorld(touched: string[]): () => void {
  const saved: Saved[] = [];
  const replace = (name: string, descriptor: PropertyDescriptor): void => {
    saved.push({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) });
    Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
  };
  for (const name of BROWSER_GLOBALS) {
    replace(name, {
      get() {
        touched.push(name);
        throw new Error(`touched ${name} at import`);
      },
    });
  }
  for (const name of TIMERS) {
    const original = (globalThis as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
    replace(name, {
      writable: true,
      value: (...args: unknown[]) => {
        const stack = new Error().stack ?? "";
        if (OWN.some((path) => stack.includes(path))) {
          touched.push(name);
          throw new Error(`called ${name} at import`);
        }
        return original(...args);
      },
    });
  }
  return () => {
    for (const { name, descriptor } of saved.reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
}

describe("no side effect at import", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    ["@pgntools/jobs-runtime", "../src/index.js"],
    ["@pgntools/jobs-runtime/browser", "../src/browser/index.js"],
    ["@pgntools/jobs-runtime/react", "../src/react/index.js"],
    ["@pgntools/jobs-runtime/testing", "../src/testing/index.js"],
  ])("%s touches no browser API or timer", async (_entry, path) => {
    vi.resetModules();
    const touched: string[] = [];
    const restore = stubTheWorld(touched);
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
    } finally {
      restore();
    }
    expect(touched).toEqual([]);
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
  });

  it("creating a runtime and its adapters touches nothing either; start() is the first touch", async () => {
    const { createJobRuntime } = await import("../src/index.js");
    const { indexedDbJobStore, webLocksLeader, broadcastBus } = await import("../src/browser/index.js");
    const touched: string[] = [];
    const restore = stubTheWorld(touched);
    let runtime: ReturnType<typeof createJobRuntime>;
    try {
      runtime = createJobRuntime({
        namespace: "ssr",
        kinds: [],
        lanes: {},
        store: indexedDbJobStore({ name: "ssr" }),
        lock: webLocksLeader(),
        bus: broadcastBus({ name: "ssr.bus" }),
      });
      expect(runtime.snapshot()).toBeUndefined();
      expect(runtime.kindsFor("game")).toEqual([]);
      expect(touched).toEqual([]);
      runtime.start(); // the stubs throw inside the actors; what matters is that start() is the first touch
      expect(touched.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
    await runtime!.stop();
  });
});
