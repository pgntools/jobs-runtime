import { type ActorRefFrom } from "xstate";
import type { JobRecord } from "../contract.js";
import type { Env } from "./env.js";
import { runnerMachine } from "./runner.js";
type Runner = ActorRefFrom<typeof runnerMachine>;
export type LaneInput = {
    env: Env;
    name: string;
    concurrency: number;
};
type LaneContext = LaneInput & {
    records: readonly JobRecord[];
    active: boolean;
    /** The queue is held: nothing claimed, this lane's runners told to hold. */
    held: boolean;
    runners: Readonly<Record<string, Runner>>;
    /** The revision each job's last runner was spawned from: not spawned again until the record moves on. */
    spent: Readonly<Record<string, number>>;
};
export type LaneEvent = {
    type: "SYNC";
    records: readonly JobRecord[];
    active: boolean;
    held: boolean;
} | {
    type: "WAKE";
} | {
    type: "ABORT";
    ids: readonly string[];
} | {
    type: "RUNNER_ENDED";
    jobId: string;
    revision: number;
};
/** Within a lane: higher priority first, then the oldest, then by id. */
export declare function byTurn(a: JobRecord, b: JobRecord): number;
/**
 * One named queue. Fed the records on every store change; claims the next jobs (one runner each)
 * up to its concurrency while this tab may schedule and the queue is not held, and wakes itself
 * with a delayed event at the earliest future runAfter — never a polling loop. Jobs other tabs run
 * under a live lease count against the concurrency, so a lane keeps its limit across a handover and
 * in lease-only mode.
 */
export declare const laneMachine: import("xstate").StateMachine<LaneContext, {
    type: "SYNC";
    records: readonly JobRecord[];
    active: boolean;
    held: boolean;
} | {
    type: "WAKE";
} | {
    type: "ABORT";
    ids: readonly string[];
} | {
    type: "RUNNER_ENDED";
    jobId: string;
    revision: number;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").StateMachine<{
        env: Env;
        kind: import("./records.js").AnyKind;
        job: JobRecord;
        input: unknown;
        state: unknown;
        replan: boolean;
        steps: number;
        spawnedFrom: number;
        result?: {
            phase: "plan";
            state: unknown;
            progress: import("../contract.js").JobProgress;
        } | {
            phase: "steps";
            state: unknown;
            progress: import("../contract.js").JobProgress;
            done: boolean;
        } | {
            phase: "finalize";
            plans: import("../contract.js").OutputPlan[];
        } | {
            phase: "outputs";
            output: import("../contract.js").JobOutput;
        };
        error?: import("../contract.js").JobError;
    }, {
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
        }, import("xstate").MetaObject> | import("xstate").PromiseActorLogic<{
            phase: "plan";
            state: unknown;
            progress: import("../contract.js").JobProgress;
        } | {
            phase: "steps";
            state: unknown;
            progress: import("../contract.js").JobProgress;
            done: boolean;
        } | {
            phase: "finalize";
            plans: import("../contract.js").OutputPlan[];
        } | {
            phase: "outputs";
            output: import("../contract.js").JobOutput;
        }, {
            env: Env;
            kind: import("./records.js").AnyKind;
            job: JobRecord;
            input: unknown;
            state: unknown;
            unit: import("../contract.js").JobPhase;
            runner: import("xstate").AnyActorRef;
        }, import("xstate").EventObject> | import("xstate").PromiseActorLogic<JobRecord | undefined, {
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
        logic: import("xstate").PromiseActorLogic<{
            phase: "plan";
            state: unknown;
            progress: import("../contract.js").JobProgress;
        } | {
            phase: "steps";
            state: unknown;
            progress: import("../contract.js").JobProgress;
            done: boolean;
        } | {
            phase: "finalize";
            plans: import("../contract.js").OutputPlan[];
        } | {
            phase: "outputs";
            output: import("../contract.js").JobOutput;
        }, {
            env: Env;
            kind: import("./records.js").AnyKind;
            job: JobRecord;
            input: unknown;
            state: unknown;
            unit: import("../contract.js").JobPhase;
            runner: import("xstate").AnyActorRef;
        }, import("xstate").EventObject>;
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
    }, string, import("./runner.js").RunnerInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
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
    }, import("xstate").MetaObject>> | undefined;
}, {
    src: "runner";
    logic: import("xstate").StateMachine<{
        env: Env;
        kind: import("./records.js").AnyKind;
        job: JobRecord;
        input: unknown;
        state: unknown;
        replan: boolean;
        steps: number;
        spawnedFrom: number;
        result?: {
            phase: "plan";
            state: unknown;
            progress: import("../contract.js").JobProgress;
        } | {
            phase: "steps";
            state: unknown;
            progress: import("../contract.js").JobProgress;
            done: boolean;
        } | {
            phase: "finalize";
            plans: import("../contract.js").OutputPlan[];
        } | {
            phase: "outputs";
            output: import("../contract.js").JobOutput;
        };
        error?: import("../contract.js").JobError;
    }, {
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
        }, import("xstate").MetaObject> | import("xstate").PromiseActorLogic<{
            phase: "plan";
            state: unknown;
            progress: import("../contract.js").JobProgress;
        } | {
            phase: "steps";
            state: unknown;
            progress: import("../contract.js").JobProgress;
            done: boolean;
        } | {
            phase: "finalize";
            plans: import("../contract.js").OutputPlan[];
        } | {
            phase: "outputs";
            output: import("../contract.js").JobOutput;
        }, {
            env: Env;
            kind: import("./records.js").AnyKind;
            job: JobRecord;
            input: unknown;
            state: unknown;
            unit: import("../contract.js").JobPhase;
            runner: import("xstate").AnyActorRef;
        }, import("xstate").EventObject> | import("xstate").PromiseActorLogic<JobRecord | undefined, {
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
        logic: import("xstate").PromiseActorLogic<{
            phase: "plan";
            state: unknown;
            progress: import("../contract.js").JobProgress;
        } | {
            phase: "steps";
            state: unknown;
            progress: import("../contract.js").JobProgress;
            done: boolean;
        } | {
            phase: "finalize";
            plans: import("../contract.js").OutputPlan[];
        } | {
            phase: "outputs";
            output: import("../contract.js").JobOutput;
        }, {
            env: Env;
            kind: import("./records.js").AnyKind;
            job: JobRecord;
            input: unknown;
            state: unknown;
            unit: import("../contract.js").JobPhase;
            runner: import("xstate").AnyActorRef;
        }, import("xstate").EventObject>;
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
    }, string, import("./runner.js").RunnerInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
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
    id: string | undefined;
}, {
    type: "schedule";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "reportLocal";
    params: import("xstate").NonReducibleUnknown;
}, never, never, {}, string, LaneInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "lane";
}, import("xstate").MetaObject>;
export {};
//# sourceMappingURL=lane.d.ts.map