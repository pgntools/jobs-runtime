import type { EventBus, JobRecord, JobStore } from "../../src/index.js";

/** A bus shared by several runtimes, like a BroadcastChannel between tabs (asynchronous delivery). */
export function sharedBus(): EventBus & { messages: unknown[] } {
  const listeners = new Set<(message: unknown) => void>();
  const messages: unknown[] = [];
  return {
    messages,
    publish(message) {
      messages.push(structuredClone(message));
      for (const listener of [...listeners]) queueMicrotask(() => listener(structuredClone(message)));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const WRITES = ["add", "update", "remove", "putPart", "sealArtifact"] as const;

/** Counts the store writes that landed (an update counts only when it wrote). */
export function countingStore(store: JobStore): JobStore & { writes: () => number; log: string[] } {
  const log: string[] = [];
  const counted = { ...store } as JobStore;
  for (const method of WRITES) {
    const original = store[method] as (...args: unknown[]) => Promise<unknown>;
    (counted as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const result = await original(...args);
      if (method !== "update" || result !== undefined) log.push(method);
      return result;
    };
  }
  return Object.assign(counted, { writes: () => log.length, log });
}

/**
 * The crash injector (internal to the tests, not part of the testing kit): lets `n` store writes
 * land, then the "tab" is dead — every later call rejects and nothing more reaches the store.
 */
export function crashAfter(store: JobStore, n: number): JobStore & { crashed: () => boolean } {
  let landed = 0;
  let dead = n <= 0;
  const crashed = (): Promise<never> => Promise.reject(new Error("crashed"));
  const write =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>, wrote: (result: R) => boolean = () => true) =>
    async (...args: A): Promise<R> => {
      if (dead) return crashed();
      const result = await run(...args);
      if (wrote(result) && ++landed >= n) dead = true;
      return result;
    };
  const read =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      dead ? crashed() : run(...args);
  return {
    list: read(() => store.list()),
    get: read((id: string) => store.get(id)),
    readArtifact: read((id: string) => store.readArtifact(id)),
    add: write((job: JobRecord) => store.add(job)),
    update: write(
      (id: string, edit: (job: JobRecord) => JobRecord | undefined) => store.update(id, edit),
      (result) => result !== undefined,
    ),
    remove: write((ids: readonly string[]) => store.remove(ids)),
    putPart: write((jobId: string, key: string, seq: number, chunk: string | Uint8Array) => store.putPart(jobId, key, seq, chunk)),
    sealArtifact: write((jobId: string, key: string, meta: { name: string; mimeType: string }) => store.sealArtifact(jobId, key, meta)),
    subscribe: (listener) => store.subscribe(() => {
      if (!dead) listener();
    }),
    crashed: () => dead,
  };
}

/** Kills a store at once (a closed tab): every call rejects from now on. */
export function killable(store: JobStore): JobStore & { kill: () => void } {
  const crash = crashAfter(store, Number.POSITIVE_INFINITY);
  let killed = false;
  const dead = (): Promise<never> => Promise.reject(new Error("killed"));
  const guard =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      killed ? dead() : run(...args);
  return {
    list: guard(crash.list),
    get: guard(crash.get),
    readArtifact: guard(crash.readArtifact),
    add: guard(crash.add),
    update: guard(crash.update),
    remove: guard(crash.remove),
    putPart: guard(crash.putPart),
    sealArtifact: guard(crash.sealArtifact),
    subscribe: (listener) => store.subscribe(() => {
      if (!killed) listener();
    }),
    kill: () => {
      killed = true;
    },
  };
}
