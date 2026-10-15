import type { JobRuntime } from "../contract.js";
import { settle } from "../core/activity.js";
import { trackerOf } from "../core/runtime.js";

export { jobStoreConformance } from "./conformance.js";
export { manualClock } from "./manualClock.js";
export { memoryJobStore } from "./memoryJobStore.js";
export { memoryLock } from "./memoryLock.js";

/**
 * Resolves once `runtime` — and every other started runtime it shares a store or bus with — has
 * nothing left to do without time moving: no store call in flight for a few macrotasks. Timers
 * stay pending; move a manualClock() to fire them.
 */
export async function runUntilIdle(runtime: JobRuntime): Promise<void> {
  if (!trackerOf(runtime)) throw new TypeError("runUntilIdle: not a runtime made by createJobRuntime");
  await settle();
}
