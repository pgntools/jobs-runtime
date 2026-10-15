import type { JobRuntime, JobRuntimeOptions } from "../contract.js";
import { type Tracker } from "./activity.js";
export declare const DEFAULT_LEASE_MS = 30000;
export declare const DEFAULT_LIVE_INTERVAL_MS = 250;
export declare const DEFAULT_LIVE_STALE_MS = 4000;
export declare const LIVE_RESEND_MS = 1000;
export declare function trackerOf(runtime: JobRuntime): Tracker | undefined;
/**
 * Creates a runtime; touches nothing (no IndexedDB, lock, channel or timer) until start() or a
 * call. Every tab of the app creates one over the same namespace and store; the one holding the
 * leader lock runs the jobs, the others read and write commands.
 */
export declare function createJobRuntime(options: JobRuntimeOptions): JobRuntime;
//# sourceMappingURL=runtime.d.ts.map