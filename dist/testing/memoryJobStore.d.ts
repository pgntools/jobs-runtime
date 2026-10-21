import type { JobStore } from "../contract.js";
/**
 * An in-memory JobStore with the IndexedDB adapter's semantics: records and meta values are copied
 * in and out (structured clone), update is an atomic compare-and-set, and every subscriber of this store —
 * any number of runtimes sharing it, like tabs sharing a database — hears every write.
 */
export declare function memoryJobStore(): JobStore;
//# sourceMappingURL=memoryJobStore.d.ts.map