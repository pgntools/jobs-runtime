import type { JobRecord, JobStore } from "../contract.js";
import { artifactIdOf, blobOf, checkRevision, conflict, joinParts, toBytes } from "../core/store.js";

/** 1: jobs, parts, artifacts. 2: meta (runtime-wide values: the queue hold). */
const VERSION = 2;
const JOBS = "jobs";
const PARTS = "parts";
const ARTIFACTS = "artifacts";
const META = "meta";

type PartRow = { jobId: string; key: string; seq: number; bytes: Uint8Array };
type ArtifactRow = { artifactId: string; jobId: string; key: string; name: string; mimeType: string; bytes: Uint8Array };

// Stores of one database opened in this realm hear each other directly; other realms (tabs,
// workers) hear a BroadcastChannel message, which this realm ignores from itself.
const realmListeners = new Map<string, Set<() => void>>();
let realmId: string | undefined;

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(JOBS, { keyPath: "id" });
        db.createObjectStore(PARTS, { keyPath: ["jobId", "key", "seq"] });
        db.createObjectStore(ARTIFACTS, { keyPath: "artifactId" }).createIndex("byJob", "jobId");
      }
      if (event.oldVersion < 2) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** All the parts of (jobId, key), or of every key of jobId: array keys sort after strings and numbers. */
const partsOf = (jobId: string, key?: string): IDBKeyRange =>
  key === undefined ? IDBKeyRange.bound([jobId], [jobId, []]) : IDBKeyRange.bound([jobId, key], [jobId, key, []]);

/**
 * The JobStore over IndexedDB, database `name`: records, artifact parts, sealed artifacts and meta
 * values in their own object stores. update() is a read-modify-write in one readwrite transaction with the
 * revision compare-and-set. subscribe() hears every write, from this tab or another.
 * Nothing is opened until the first call.
 */
export function indexedDbJobStore({ name }: { name: string }): JobStore {
  let db: Promise<IDBDatabase> | undefined;
  let channel: BroadcastChannel | null | undefined;
  const listeners = new Set<() => void>();

  const database = (): Promise<IDBDatabase> => {
    db ??= openDatabase(name).then((opened) => {
      opened.onversionchange = () => {
        opened.close();
        db = undefined;
      };
      return opened;
    });
    db.catch(() => {
      db = undefined;
    });
    return db;
  };

  const realm = (): Set<() => void> => {
    let set = realmListeners.get(name);
    if (!set) realmListeners.set(name, (set = new Set()));
    return set;
  };

  const channelOf = (): BroadcastChannel | null => {
    if (channel === undefined) {
      realmId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`${name}.store`) : null;
      if (channel) {
        channel.onmessage = (event: MessageEvent) => {
          if ((event.data as { realm?: unknown } | null)?.realm === realmId) return;
          for (const listener of [...listeners]) listener();
        };
        (channel as { unref?: () => void }).unref?.();
      }
    }
    return channel;
  };

  const changed = (): void => {
    for (const notify of [...realm()]) notify();
    channelOf()?.postMessage({ realm: realmId });
  };

  async function run<T>(
    names: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction, finish: (value: T) => void, fail: (error: unknown) => void) => void,
  ): Promise<T> {
    const opened = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = opened.transaction(names, mode);
      let result: T;
      let failure: { error: unknown } | undefined;
      body(
        tx,
        (value) => {
          result = value;
        },
        (error) => {
          failure = { error };
          tx.abort();
        },
      );
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ? failure.error : tx.error);
      tx.onerror = (event) => {
        if (failure) event.preventDefault();
      };
    });
  }

  const notifyHere = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    list: () =>
      run<JobRecord[]>([JOBS], "readonly", (tx, finish) => {
        const request = tx.objectStore(JOBS).getAll();
        request.onsuccess = () => finish(request.result as JobRecord[]);
      }),

    get: (id) =>
      run<JobRecord | undefined>([JOBS], "readonly", (tx, finish) => {
        const request = tx.objectStore(JOBS).get(id);
        request.onsuccess = () => finish(request.result as JobRecord | undefined);
      }),

    async add(job) {
      await run<void>([JOBS], "readwrite", (tx, _finish, fail) => {
        const request = tx.objectStore(JOBS).add(job);
        request.onerror = (event) => {
          event.preventDefault();
          fail(conflict(`job ${job.id} already exists`));
        };
      });
      changed();
    },

    async update(id, edit) {
      const written = await run<JobRecord | undefined>([JOBS], "readwrite", (tx, finish, fail) => {
        const jobs = tx.objectStore(JOBS);
        const request = jobs.get(id);
        request.onsuccess = () => {
          const stored = request.result as JobRecord | undefined;
          if (stored === undefined) return finish(undefined);
          try {
            const next = edit(stored);
            if (next === undefined) return finish(undefined);
            checkRevision(stored, next);
            if (next.id !== id) throw new TypeError("update: an edit cannot change the id");
            jobs.put(next);
            finish(next);
          } catch (error) {
            fail(error);
          }
        };
      });
      if (written) changed();
      return written;
    },

    async remove(ids) {
      await run<void>([JOBS, PARTS, ARTIFACTS], "readwrite", (tx) => {
        const artifacts = tx.objectStore(ARTIFACTS);
        for (const id of ids) {
          tx.objectStore(JOBS).delete(id);
          tx.objectStore(PARTS).delete(partsOf(id));
          const keys = artifacts.index("byJob").getAllKeys(id);
          keys.onsuccess = () => {
            for (const key of keys.result) artifacts.delete(key);
          };
        }
      });
      changed();
    },

    putPart: (jobId, key, seq, chunk) =>
      run<void>([PARTS], "readwrite", (tx) => {
        tx.objectStore(PARTS).put({ jobId, key, seq, bytes: toBytes(chunk) } satisfies PartRow);
      }),

    sealArtifact: (jobId, key, meta) =>
      run<{ artifactId: string; size: number }>([PARTS, ARTIFACTS], "readwrite", (tx, finish) => {
        const artifactId = artifactIdOf(jobId, key);
        const parts = tx.objectStore(PARTS);
        const artifacts = tx.objectStore(ARTIFACTS);
        const rows = parts.getAll(partsOf(jobId, key));
        rows.onsuccess = () => {
          const found = rows.result as PartRow[];
          const existing = artifacts.get(artifactId);
          existing.onsuccess = () => {
            const sealed = existing.result as ArtifactRow | undefined;
            if (found.length === 0 && sealed) return finish({ artifactId, size: sealed.bytes.byteLength });
            const bytes = joinParts(new Map(found.map((row) => [row.seq, row.bytes])));
            artifacts.put({ artifactId, jobId, key, name: meta.name, mimeType: meta.mimeType, bytes } satisfies ArtifactRow);
            parts.delete(partsOf(jobId, key));
            finish({ artifactId, size: bytes.byteLength });
          };
        };
      }),

    readArtifact: (artifactId) =>
      run<Blob | undefined>([ARTIFACTS], "readonly", (tx, finish) => {
        const request = tx.objectStore(ARTIFACTS).get(artifactId);
        request.onsuccess = () => {
          const row = request.result as ArtifactRow | undefined;
          finish(row && blobOf(row.bytes, row.mimeType));
        };
      }),

    getMeta: (key) =>
      run<unknown>([META], "readonly", (tx, finish) => {
        const request = tx.objectStore(META).get(key);
        request.onsuccess = () => finish(request.result);
      }),

    async putMeta(key, value) {
      await run<void>([META], "readwrite", (tx) => {
        tx.objectStore(META).put(value, key);
      });
      changed();
    },

    subscribe(listener) {
      channelOf();
      const set = realm();
      listeners.add(listener);
      if (listeners.size === 1) set.add(notifyHere);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) set.delete(notifyHere);
      };
    },
  };
}
