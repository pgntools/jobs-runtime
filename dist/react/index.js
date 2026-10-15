import { useCallback, useSyncExternalStore } from "react";
/** Every job record; undefined until the runtime's first read lands. */
export function useJobs(runtime) {
    return useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
}
/** One job record; undefined while loading or once it is gone. */
export function useJob(runtime, id) {
    const select = useCallback(() => runtime.snapshot()?.find((job) => job.id === id), [runtime, id]);
    return useSyncExternalStore(runtime.subscribe, select, select);
}
/** A running job's live telemetry, from whichever tab runs it; undefined when there is none. */
export function useJobLive(runtime, id) {
    const select = useCallback(() => runtime.liveOf(id), [runtime, id]);
    return useSyncExternalStore(runtime.subscribeLive, select, () => undefined);
}
//# sourceMappingURL=index.js.map