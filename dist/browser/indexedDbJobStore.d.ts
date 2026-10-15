import type { JobStore } from "../contract.js";
/**
 * The JobStore over IndexedDB, database `name`: records, artifact parts and sealed artifacts in
 * their own object stores. update() is a read-modify-write in one readwrite transaction with the
 * revision compare-and-set. subscribe() hears every write, from this tab or another.
 * Nothing is opened until the first call.
 */
export declare function indexedDbJobStore({ name }: {
    name: string;
}): JobStore;
//# sourceMappingURL=indexedDbJobStore.d.ts.map