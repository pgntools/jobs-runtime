import type { JobRecord, JobStore } from "../contract.js";
import { type Tracker } from "./activity.js";
/** How a store signals a lost compare-and-set (JobStore.update, JobStore.add). */
export type ConflictError = Error & {
    code: "conflict";
};
export declare function conflict(message: string): ConflictError;
export declare function isConflict(error: unknown): boolean;
/** The stored revision, read the way every adapter reads it (a missing one counts as 0). */
export declare function revisionOf(stored: unknown): number;
/** The compare-and-set every adapter applies to an edit's result. */
export declare function checkRevision(stored: unknown, next: JobRecord): void;
/**
 * Every durable change: one read-modify-write through the normaliser. A conflict means another
 * write landed in between; the edit is re-run on the fresh record, never an update lost.
 */
export declare function writeRecord(store: JobStore, id: string, edit: (job: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined>;
export declare function readRecords(store: JobStore): Promise<JobRecord[]>;
/** The queue hold's meta key. */
export declare const HELD_KEY = "held";
type MetaStore = JobStore & Required<Pick<JobStore, "getMeta" | "putMeta">>;
/** Whether the store keeps meta values: both members, or it is treated as having neither. */
export declare function hasMeta(store: JobStore): store is MetaStore;
/** Read leniently: anything but true is not held; a store without meta is never held. */
export declare function readHeld(store: JobStore): Promise<boolean>;
/** The store as the runtime sees it: every call counted as in-flight work. */
export declare function trackedStore(store: JobStore, tracker: Tracker): JobStore;
export declare function toBytes(chunk: string | Uint8Array): Uint8Array;
export declare function artifactIdOf(jobId: string, key: string): string;
/** Parts 0..n-1, in order, up to the first gap. */
export declare function joinParts(parts: ReadonlyMap<number, Uint8Array>): Uint8Array;
export declare function blobOf(bytes: Uint8Array, mimeType: string): Blob;
export {};
//# sourceMappingURL=store.d.ts.map