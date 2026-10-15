import { useCallback, useSyncExternalStore } from "react";
import type { JobRecord, JobRuntime } from "../contract.js";

/** Every job record; undefined until the runtime's first read lands. */
export function useJobs(runtime: JobRuntime): readonly JobRecord[] | undefined {
  return useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
}

/** One job record; undefined while loading or once it is gone. */
export function useJob(runtime: JobRuntime, id: string): JobRecord | undefined {
  const select = useCallback(() => runtime.snapshot()?.find((job) => job.id === id), [runtime, id]);
  return useSyncExternalStore(runtime.subscribe, select, select);
}

/** A running job's live telemetry, from whichever tab runs it; undefined when there is none. */
export function useJobLive(runtime: JobRuntime, id: string): unknown {
  const select = useCallback(() => runtime.liveOf(id), [runtime, id]);
  return useSyncExternalStore(runtime.subscribeLive, select, () => undefined);
}
