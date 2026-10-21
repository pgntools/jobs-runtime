import type { JobPhase, JobStatus } from "../contract.js";
/**
 * The job lifecycle: the one pure transition table (CTA-216 "The state machine").
 *
 * Two parallel regions: `status` (the table in the specification) and `phase` (where a resume
 * re-enters). The machine is never run as a live actor per job — a JobRecord is the durable
 * truth, so every write resolves the record's (status, phase) into a snapshot and asks XState's
 * pure `transition` for the next one. A refused event leaves the snapshot unchanged.
 *
 * `enqueue → queued` is the initial state (queued, plan).
 */
export type JobMachineEvent = {
    type: "CLAIM";
} | {
    type: "CHECKPOINT";
} | {
    type: "ADVANCE";
} | {
    type: "REPLAN";
} | {
    type: "COMPLETE";
} | {
    type: "RETRY";
} | {
    type: "FAIL";
} | {
    type: "PAUSE";
} | {
    type: "CANCEL";
} | {
    type: "LEASE_EXPIRED";
    autoResume: boolean;
} | {
    type: "RESUME";
} | {
    type: "HOLD";
};
export type JobMachineEventType = JobMachineEvent["type"];
export declare const jobMachineEventTypes: readonly JobMachineEventType[];
export declare const jobMachine: import("xstate").StateMachine<import("xstate").MachineContext, {
    type: "CLAIM";
} | {
    type: "CHECKPOINT";
} | {
    type: "ADVANCE";
} | {
    type: "REPLAN";
} | {
    type: "COMPLETE";
} | {
    type: "RETRY";
} | {
    type: "FAIL";
} | {
    type: "PAUSE";
} | {
    type: "CANCEL";
} | {
    type: "LEASE_EXPIRED";
    autoResume: boolean;
} | {
    type: "RESUME";
} | {
    type: "HOLD";
}, {}, never, never, {
    type: "running";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "outboxPhase";
    params: unknown;
} | {
    type: "autoResume";
    params: unknown;
}, never, {
    status: "queued" | "running" | "paused" | "interrupted" | "failed" | "cancelled" | "done";
    phase: "plan" | "steps" | "finalize" | "outputs";
}, string, import("xstate").NonReducibleUnknown, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "job";
    states: {
        readonly status: {
            states: {
                readonly queued: {};
                readonly running: {};
                readonly paused: {};
                readonly interrupted: {};
                readonly failed: {};
                readonly cancelled: {};
                readonly done: {};
            };
        };
        readonly phase: {
            states: {
                readonly plan: {};
                readonly steps: {};
                readonly finalize: {};
                readonly outputs: {};
            };
        };
    };
}, import("xstate").MetaObject>;
export type Position = {
    status: JobStatus;
    phase: JobPhase;
};
/** Whether the table allows `event` at `position`. */
export declare function allows(position: Position, event: JobMachineEvent): boolean;
/**
 * Applies `events` in order through the pure transition table. Undefined when any of them is
 * refused — a refused write writes nothing.
 */
export declare function step(position: Position, ...events: JobMachineEvent[]): Position | undefined;
//# sourceMappingURL=jobMachine.d.ts.map