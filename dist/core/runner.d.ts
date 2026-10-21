import { type AnyActorRef } from "xstate";
import type { JobError, JobOutput, JobPhase, JobProgress, JobRecord, OutputPlan } from "../contract.js";
import type { Env } from "./env.js";
import { type AnyKind } from "./records.js";
type UnitResult = {
    phase: "plan";
    state: unknown;
    progress: JobProgress;
} | {
    phase: "steps";
    state: unknown;
    progress: JobProgress;
    done: boolean;
} | {
    phase: "finalize";
    plans: OutputPlan[];
} | {
    phase: "outputs";
    output: JobOutput;
};
type UnitInput = {
    env: Env;
    kind: AnyKind;
    job: JobRecord;
    input: unknown;
    state: unknown;
    unit: JobPhase;
    runner: AnyActorRef;
};
/** The kind's classifier when it has one; else a timeout is retryable and anything else is not. */
export declare function classify(kind: AnyKind, error: unknown): JobError;
type Prepared = {
    input: unknown;
    state: unknown;
    replan: boolean;
} | {
    error: JobError;
};
/**
 * Re-entry at the recorded phase: the input re-parsed; the checkpoint parsed (and migrated from
 * the record's kindVersion). An unparsable checkpoint in steps — or any for a non-resumable kind —
 * re-plans; finalize cannot run without one; outputs needs none.
 */
export declare function prepare(job: JobRecord, kind: AnyKind): Prepared;
export type RunnerInput = {
    env: Env;
    job: JobRecord;
    kind: AnyKind;
};
type RunnerContext = {
    env: Env;
    kind: AnyKind;
    /** The latest record known: this runner's own writes and newer observed revisions. */
    job: JobRecord;
    input: unknown;
    state: unknown;
    replan: boolean;
    /** Steps committed by this runner (history records every Nth). */
    steps: number;
    /** The revision the lane spawned this runner from. */
    spawnedFrom: number;
    result?: UnitResult;
    error?: JobError;
};
export type RunnerEvent = {
    type: "RECORD";
    job: JobRecord | undefined;
} | {
    type: "ABORT";
} | {
    type: "RELEASE";
} | {
    type: "HOLD";
} | {
    type: "HEARTBEAT";
} | {
    type: "LIVE";
    payload: unknown;
};
/**
 * One claimed job on the leader tab: claim → (execute → commit)* until the job leaves running.
 * The lease is renewed at a third of leaseMs alongside; step and heartbeat timeouts are delayed
 * transitions. Leaving `executing` stops the unit actor, which aborts ctx.signal — that is how a
 * pause, cancel, delete, lost lease, timeout, queue hold or stop() reaches the kind's step.
 */
export declare const runnerMachine: import("xstate").StateMachine<RunnerContext, {
    type: "RECORD";
    job: JobRecord | undefined;
} | {
    type: "ABORT";
} | {
    type: "RELEASE";
} | {
    type: "HOLD";
} | {
    type: "HEARTBEAT";
} | {
    type: "LIVE";
    payload: unknown;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").StateMachine<{
        env: Env;
        jobId: string;
        last?: {
            payload: unknown;
        };
        pending?: {
            payload: unknown;
        };
    }, {
        type: "LIVE";
        payload: unknown;
    }, {}, never, {
        type: "publishNow";
        params: import("xstate").NonReducibleUnknown;
    } | {
        type: "hold";
        params: import("xstate").NonReducibleUnknown;
    } | {
        type: "publishPending";
        params: import("xstate").NonReducibleUnknown;
    } | {
        type: "resend";
        params: unknown;
    }, {
        type: "hasPending";
        params: unknown;
    }, "resend" | "interval", "silent" | "throttling" | "holding", string, {
        env: Env;
        jobId: string;
    }, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
        id: "liveThrottle";
        states: {
            readonly silent: {};
            readonly throttling: {};
            readonly holding: {};
        };
    }, import("xstate").MetaObject> | import("xstate").PromiseActorLogic<UnitResult, UnitInput, import("xstate").EventObject> | import("xstate").PromiseActorLogic<JobRecord | undefined, {
        env: Env;
        id: string;
        edit: (job: JobRecord) => JobRecord | undefined;
    }, import("xstate").EventObject>> | undefined;
}, {
    src: "liveThrottle";
    logic: import("xstate").StateMachine<{
        env: Env;
        jobId: string;
        last?: {
            payload: unknown;
        };
        pending?: {
            payload: unknown;
        };
    }, {
        type: "LIVE";
        payload: unknown;
    }, {}, never, {
        type: "publishNow";
        params: import("xstate").NonReducibleUnknown;
    } | {
        type: "hold";
        params: import("xstate").NonReducibleUnknown;
    } | {
        type: "publishPending";
        params: import("xstate").NonReducibleUnknown;
    } | {
        type: "resend";
        params: unknown;
    }, {
        type: "hasPending";
        params: unknown;
    }, "resend" | "interval", "silent" | "throttling" | "holding", string, {
        env: Env;
        jobId: string;
    }, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
        id: "liveThrottle";
        states: {
            readonly silent: {};
            readonly throttling: {};
            readonly holding: {};
        };
    }, import("xstate").MetaObject>;
    id: string | undefined;
} | {
    src: "write";
    logic: import("xstate").PromiseActorLogic<JobRecord | undefined, {
        env: Env;
        id: string;
        edit: (job: JobRecord) => JobRecord | undefined;
    }, import("xstate").EventObject>;
    id: string | undefined;
} | {
    src: "unit";
    logic: import("xstate").PromiseActorLogic<UnitResult, UnitInput, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "keep";
    params: JobRecord | undefined;
} | {
    type: "prepared";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "advance";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "timedOut";
    params: "step" | "heartbeat";
} | {
    type: "ended";
    params: import("xstate").NonReducibleUnknown;
}, {
    type: "running";
    params: JobRecord | undefined;
} | {
    type: "wrote";
    params: JobRecord | undefined;
} | {
    type: "failedToPrepare";
    params: unknown;
} | {
    type: "deleted";
    params: unknown;
} | {
    type: "stale";
    params: unknown;
} | {
    type: "leaseLost";
    params: unknown;
} | {
    type: "controlRequested";
    params: unknown;
} | {
    type: "hasStepTimeout";
    params: unknown;
} | {
    type: "hasHeartbeatTimeout";
    params: unknown;
}, "renew" | "stepTimeout" | "heartbeatTimeout", "holding" | "ended" | "claiming" | "preparing" | "controlling" | "releasing" | {
    active: {
        lease: "waiting" | "renewing";
        work: "committing" | "failing" | {
            executing: {
                heartbeat: "route" | "armed" | "off";
                deadline: "route" | "armed" | "off";
            };
        };
    };
}, string, RunnerInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "runner";
    states: {
        readonly claiming: {};
        readonly preparing: {};
        readonly active: {
            states: {
                readonly lease: {
                    states: {
                        readonly waiting: {};
                        readonly renewing: {};
                    };
                };
                readonly work: {
                    states: {
                        readonly executing: {
                            states: {
                                readonly deadline: {
                                    states: {
                                        readonly route: {};
                                        readonly armed: {};
                                        readonly off: {};
                                    };
                                };
                                readonly heartbeat: {
                                    states: {
                                        readonly route: {};
                                        readonly armed: {};
                                        readonly off: {};
                                    };
                                };
                            };
                        };
                        readonly committing: {};
                        readonly failing: {};
                    };
                };
            };
        };
        readonly controlling: {};
        readonly releasing: {};
        readonly holding: {};
        readonly ended: {};
    };
}, import("xstate").MetaObject>;
export {};
//# sourceMappingURL=runner.d.ts.map