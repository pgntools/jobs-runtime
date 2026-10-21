import { artifactIdOf, blobOf, checkRevision, conflict, joinParts, toBytes } from "../core/store.js";
/**
 * An in-memory JobStore with the IndexedDB adapter's semantics: records and meta values are copied
 * in and out (structured clone), update is an atomic compare-and-set, and every subscriber of this store —
 * any number of runtimes sharing it, like tabs sharing a database — hears every write.
 */
export function memoryJobStore() {
    const records = new Map();
    const parts = new Map();
    const artifacts = new Map();
    const meta = new Map();
    const listeners = new Set();
    const partsKey = (jobId, key) => JSON.stringify([jobId, key]);
    const changed = () => {
        for (const listener of [...listeners])
            queueMicrotask(listener);
    };
    return {
        async list() {
            return [...records.values()].map((job) => structuredClone(job));
        },
        async get(id) {
            const job = records.get(id);
            return job && structuredClone(job);
        },
        async add(job) {
            if (records.has(job.id))
                throw conflict(`job ${job.id} already exists`);
            records.set(job.id, structuredClone(job));
            changed();
        },
        async update(id, edit) {
            const stored = records.get(id);
            if (!stored)
                return undefined;
            const next = edit(structuredClone(stored));
            if (next === undefined)
                return undefined;
            checkRevision(stored, next);
            if (next.id !== id)
                throw new TypeError("update: an edit cannot change the id");
            records.set(id, structuredClone(next));
            changed();
            return structuredClone(next);
        },
        async remove(ids) {
            for (const id of ids) {
                records.delete(id);
                for (const key of [...parts.keys()])
                    if (JSON.parse(key)[0] === id)
                        parts.delete(key);
                for (const [artifactId, artifact] of [...artifacts])
                    if (artifact.jobId === id)
                        artifacts.delete(artifactId);
            }
            changed();
        },
        async putPart(jobId, key, seq, chunk) {
            const k = partsKey(jobId, key);
            const map = parts.get(k) ?? new Map();
            map.set(seq, toBytes(chunk));
            parts.set(k, map);
        },
        async sealArtifact(jobId, key, meta) {
            const artifactId = artifactIdOf(jobId, key);
            const k = partsKey(jobId, key);
            const existing = artifacts.get(artifactId);
            const pending = parts.get(k);
            if (!pending && existing)
                return { artifactId, size: existing.bytes.byteLength };
            const bytes = joinParts(pending ?? new Map());
            artifacts.set(artifactId, { jobId, bytes, mimeType: meta.mimeType });
            parts.delete(k);
            return { artifactId, size: bytes.byteLength };
        },
        async readArtifact(artifactId) {
            const artifact = artifacts.get(artifactId);
            return artifact && blobOf(artifact.bytes, artifact.mimeType);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        async getMeta(key) {
            return structuredClone(meta.get(key));
        },
        async putMeta(key, value) {
            meta.set(key, structuredClone(value));
            changed();
        },
    };
}
//# sourceMappingURL=memoryJobStore.js.map