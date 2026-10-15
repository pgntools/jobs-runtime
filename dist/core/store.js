import { track } from "./activity.js";
import { normalise } from "./records.js";
export function conflict(message) {
    return Object.assign(new Error(message), { name: "ConflictError", code: "conflict" });
}
export function isConflict(error) {
    return typeof error === "object" && error !== null && error.code === "conflict";
}
/** The stored revision, read the way every adapter reads it (a missing one counts as 0). */
export function revisionOf(stored) {
    const revision = stored?.revision;
    return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}
/** The compare-and-set every adapter applies to an edit's result. */
export function checkRevision(stored, next) {
    const expected = revisionOf(stored) + 1;
    if (next.revision !== expected) {
        throw conflict(`revision moved: expected ${expected}, the edit wrote ${String(next.revision)}`);
    }
}
const CONFLICT_RETRIES = 8;
/**
 * Every durable change: one read-modify-write through the normaliser. A conflict means another
 * write landed in between; the edit is re-run on the fresh record, never an update lost.
 */
export async function writeRecord(store, id, edit) {
    for (let attempt = 0;; attempt++) {
        try {
            const written = await store.update(id, (raw) => {
                const job = normalise(raw);
                return job && edit(job);
            });
            return written && normalise(written);
        }
        catch (error) {
            if (!isConflict(error) || attempt >= CONFLICT_RETRIES)
                throw error;
        }
    }
}
export async function readRecords(store) {
    const records = [];
    for (const raw of await store.list()) {
        const job = normalise(raw);
        if (job)
            records.push(job);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
/** The store as the runtime sees it: every call counted as in-flight work. */
export function trackedStore(store, tracker) {
    return {
        list: () => track(tracker, store.list()),
        get: (id) => track(tracker, store.get(id)),
        add: (job) => track(tracker, store.add(job)),
        update: (id, edit) => track(tracker, store.update(id, edit)),
        remove: (ids) => track(tracker, store.remove(ids)),
        putPart: (jobId, key, seq, chunk) => track(tracker, store.putPart(jobId, key, seq, chunk)),
        sealArtifact: (jobId, key, meta) => track(tracker, store.sealArtifact(jobId, key, meta)),
        readArtifact: (artifactId) => track(tracker, store.readArtifact(artifactId)),
        subscribe: (listener) => store.subscribe(listener),
    };
}
// ── Shared by the memory and IndexedDB adapters ─────────────────────────
const encoder = { current: undefined };
export function toBytes(chunk) {
    if (typeof chunk === "string")
        return (encoder.current ??= new TextEncoder()).encode(chunk);
    return new Uint8Array(chunk);
}
export function artifactIdOf(jobId, key) {
    return `${jobId}/${key}`;
}
/** Parts 0..n-1, in order, up to the first gap. */
export function joinParts(parts) {
    const chunks = [];
    for (let seq = 0; parts.has(seq); seq++)
        chunks.push(parts.get(seq));
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
export function blobOf(bytes, mimeType) {
    return new Blob([bytes], { type: mimeType });
}
//# sourceMappingURL=store.js.map