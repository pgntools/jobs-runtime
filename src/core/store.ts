import type { JobRecord, JobStore } from "../contract.js";
import { track, type Tracker } from "./activity.js";
import { normalise } from "./records.js";

/** How a store signals a lost compare-and-set (JobStore.update, JobStore.add). */
export type ConflictError = Error & { code: "conflict" };

export function conflict(message: string): ConflictError {
  return Object.assign(new Error(message), { name: "ConflictError", code: "conflict" as const });
}

export function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "conflict";
}

/** The stored revision, read the way every adapter reads it (a missing one counts as 0). */
export function revisionOf(stored: unknown): number {
  const revision = (stored as { revision?: unknown } | undefined)?.revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

/** The compare-and-set every adapter applies to an edit's result. */
export function checkRevision(stored: unknown, next: JobRecord): void {
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
export async function writeRecord(
  store: JobStore,
  id: string,
  edit: (job: JobRecord) => JobRecord | undefined,
): Promise<JobRecord | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const written = await store.update(id, (raw) => {
        const job = normalise(raw);
        return job && edit(job);
      });
      return written && normalise(written);
    } catch (error) {
      if (!isConflict(error) || attempt >= CONFLICT_RETRIES) throw error;
    }
  }
}

export async function readRecords(store: JobStore): Promise<JobRecord[]> {
  const records: JobRecord[] = [];
  for (const raw of await store.list()) {
    const job = normalise(raw);
    if (job) records.push(job);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The store as the runtime sees it: every call counted as in-flight work. */
export function trackedStore(store: JobStore, tracker: Tracker): JobStore {
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

const encoder = { current: undefined as TextEncoder | undefined };

export function toBytes(chunk: string | Uint8Array): Uint8Array {
  if (typeof chunk === "string") return (encoder.current ??= new TextEncoder()).encode(chunk);
  return new Uint8Array(chunk);
}

export function artifactIdOf(jobId: string, key: string): string {
  return `${jobId}/${key}`;
}

/** Parts 0..n-1, in order, up to the first gap. */
export function joinParts(parts: ReadonlyMap<number, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let seq = 0; parts.has(seq); seq++) chunks.push(parts.get(seq)!);
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function blobOf(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
}
