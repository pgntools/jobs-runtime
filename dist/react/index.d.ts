import type { JobRecord, JobRuntime } from "../contract.js";
/** Every job record; undefined until the runtime's first read lands. */
export declare function useJobs(runtime: JobRuntime): readonly JobRecord[] | undefined;
/** One job record; undefined while loading or once it is gone. */
export declare function useJob(runtime: JobRuntime, id: string): JobRecord | undefined;
/** A running job's live telemetry, from whichever tab runs it; undefined when there is none. */
export declare function useJobLive(runtime: JobRuntime, id: string): unknown;
//# sourceMappingURL=index.d.ts.map