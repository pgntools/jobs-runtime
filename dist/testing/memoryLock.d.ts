import type { LeaderLock } from "../contract.js";
/**
 * Web Locks in memory: one exclusive holder per name, the rest queued in request order. Share one
 * instance between runtimes to model tabs of one origin.
 */
export declare function memoryLock(): LeaderLock;
//# sourceMappingURL=memoryLock.d.ts.map