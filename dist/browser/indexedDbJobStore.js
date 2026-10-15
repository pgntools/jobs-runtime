import { artifactIdOf, blobOf, checkRevision, conflict, joinParts, toBytes } from "../core/store.js";
const VERSION = 1;
const JOBS = "jobs";
const PARTS = "parts";
const ARTIFACTS = "artifacts";
// Stores of one database opened in this realm hear each other directly; other realms (tabs,
// workers) hear a BroadcastChannel message, which this realm ignores from itself.
const realmListeners = new Map();
let realmId;
function openDatabase(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore(JOBS, { keyPath: "id" });
            db.createObjectStore(PARTS, { keyPath: ["jobId", "key", "seq"] });
            db.createObjectStore(ARTIFACTS, { keyPath: "artifactId" }).createIndex("byJob", "jobId");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
/** All the parts of (jobId, key), or of every key of jobId: array keys sort after strings and numbers. */
const partsOf = (jobId, key) => key === undefined ? IDBKeyRange.bound([jobId], [jobId, []]) : IDBKeyRange.bound([jobId, key], [jobId, key, []]);
/**
 * The JobStore over IndexedDB, database `name`: records, artifact parts and sealed artifacts in
 * their own object stores. update() is a read-modify-write in one readwrite transaction with the
 * revision compare-and-set. subscribe() hears every write, from this tab or another.
 * Nothing is opened until the first call.
 */
export function indexedDbJobStore({ name }) {
    let db;
    let channel;
    const listeners = new Set();
    const database = () => {
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
    const realm = () => {
        let set = realmListeners.get(name);
        if (!set)
            realmListeners.set(name, (set = new Set()));
        return set;
    };
    const channelOf = () => {
        if (channel === undefined) {
            realmId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`${name}.store`) : null;
            if (channel) {
                channel.onmessage = (event) => {
                    if (event.data?.realm === realmId)
                        return;
                    for (const listener of [...listeners])
                        listener();
                };
                channel.unref?.();
            }
        }
        return channel;
    };
    const changed = () => {
        for (const notify of [...realm()])
            notify();
        channelOf()?.postMessage({ realm: realmId });
    };
    async function run(names, mode, body) {
        const opened = await database();
        return new Promise((resolve, reject) => {
            const tx = opened.transaction(names, mode);
            let result;
            let failure;
            body(tx, (value) => {
                result = value;
            }, (error) => {
                failure = { error };
                tx.abort();
            });
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(failure ? failure.error : tx.error);
            tx.onerror = (event) => {
                if (failure)
                    event.preventDefault();
            };
        });
    }
    const notifyHere = () => {
        for (const listener of [...listeners])
            listener();
    };
    return {
        list: () => run([JOBS], "readonly", (tx, finish) => {
            const request = tx.objectStore(JOBS).getAll();
            request.onsuccess = () => finish(request.result);
        }),
        get: (id) => run([JOBS], "readonly", (tx, finish) => {
            const request = tx.objectStore(JOBS).get(id);
            request.onsuccess = () => finish(request.result);
        }),
        async add(job) {
            await run([JOBS], "readwrite", (tx, _finish, fail) => {
                const request = tx.objectStore(JOBS).add(job);
                request.onerror = (event) => {
                    event.preventDefault();
                    fail(conflict(`job ${job.id} already exists`));
                };
            });
            changed();
        },
        async update(id, edit) {
            const written = await run([JOBS], "readwrite", (tx, finish, fail) => {
                const jobs = tx.objectStore(JOBS);
                const request = jobs.get(id);
                request.onsuccess = () => {
                    const stored = request.result;
                    if (stored === undefined)
                        return finish(undefined);
                    try {
                        const next = edit(stored);
                        if (next === undefined)
                            return finish(undefined);
                        checkRevision(stored, next);
                        if (next.id !== id)
                            throw new TypeError("update: an edit cannot change the id");
                        jobs.put(next);
                        finish(next);
                    }
                    catch (error) {
                        fail(error);
                    }
                };
            });
            if (written)
                changed();
            return written;
        },
        async remove(ids) {
            await run([JOBS, PARTS, ARTIFACTS], "readwrite", (tx) => {
                const artifacts = tx.objectStore(ARTIFACTS);
                for (const id of ids) {
                    tx.objectStore(JOBS).delete(id);
                    tx.objectStore(PARTS).delete(partsOf(id));
                    const keys = artifacts.index("byJob").getAllKeys(id);
                    keys.onsuccess = () => {
                        for (const key of keys.result)
                            artifacts.delete(key);
                    };
                }
            });
            changed();
        },
        putPart: (jobId, key, seq, chunk) => run([PARTS], "readwrite", (tx) => {
            tx.objectStore(PARTS).put({ jobId, key, seq, bytes: toBytes(chunk) });
        }),
        sealArtifact: (jobId, key, meta) => run([PARTS, ARTIFACTS], "readwrite", (tx, finish) => {
            const artifactId = artifactIdOf(jobId, key);
            const parts = tx.objectStore(PARTS);
            const artifacts = tx.objectStore(ARTIFACTS);
            const rows = parts.getAll(partsOf(jobId, key));
            rows.onsuccess = () => {
                const found = rows.result;
                const existing = artifacts.get(artifactId);
                existing.onsuccess = () => {
                    const sealed = existing.result;
                    if (found.length === 0 && sealed)
                        return finish({ artifactId, size: sealed.bytes.byteLength });
                    const bytes = joinParts(new Map(found.map((row) => [row.seq, row.bytes])));
                    artifacts.put({ artifactId, jobId, key, name: meta.name, mimeType: meta.mimeType, bytes });
                    parts.delete(partsOf(jobId, key));
                    finish({ artifactId, size: bytes.byteLength });
                };
            };
        }),
        readArtifact: (artifactId) => run([ARTIFACTS], "readonly", (tx, finish) => {
            const request = tx.objectStore(ARTIFACTS).get(artifactId);
            request.onsuccess = () => {
                const row = request.result;
                finish(row && blobOf(row.bytes, row.mimeType));
            };
        }),
        subscribe(listener) {
            channelOf();
            const set = realm();
            listeners.add(listener);
            if (listeners.size === 1)
                set.add(notifyHere);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0)
                    set.delete(notifyHere);
            };
        },
    };
}
//# sourceMappingURL=indexedDbJobStore.js.map