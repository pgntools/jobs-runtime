import { type ActorRefFrom } from "xstate";
import type { JobRecord } from "../contract.js";
import { type Env } from "./env.js";
import { laneMachine } from "./lane.js";
export type Role = "pending" | "leader" | "follower" | "lease-only";
export type RootEvent = {
    type: "RECORDS";
    records: readonly JobRecord[];
    held: boolean;
} | {
    type: "ROLE";
    role: Role;
} | {
    type: "LOCAL";
    lane: string;
    ids: readonly string[];
} | {
    type: "WAKE";
} | {
    type: "ABORT";
    ids: readonly string[];
} | {
    type: "LIVE_IN";
    jobId: string;
    payload: unknown;
} | {
    type: "LIVE_CLEAR";
    jobId: string;
};
type Lane = ActorRefFrom<typeof laneMachine>;
type RootContext = {
    env: Env;
    /** Undefined until the first read lands. */
    records: readonly JobRecord[] | undefined;
    /** The queue hold, read with the records: undefined until the first read lands. */
    held: boolean | undefined;
    role: Role;
    lanes: Readonly<Record<string, Lane>>;
    /** Jobs this tab's runners hold, per lane. */
    local: Readonly<Record<string, readonly string[]>>;
    /** Jobs with a stall write in flight. */
    stalling: Readonly<Record<string, true>>;
};
/**
 * The runtime: one root actor per start(). Children: the store reader, the leader election, the
 * live view and one lane per configured lane (each spawning a runner per claimed job). The root
 * holds the records view and, while this tab schedules, stalls running jobs whose lease expired.
 */
export declare const rootMachine: import("xstate").StateMachine<RootContext, {
    type: "RECORDS";
    records: readonly JobRecord[];
    held: boolean;
} | {
    type: "ROLE";
    role: Role;
} | {
    type: "LOCAL";
    lane: string;
    ids: readonly string[];
} | {
    type: "WAKE";
} | {
    type: "ABORT";
    ids: readonly string[];
} | {
    type: "LIVE_IN";
    jobId: string;
    payload: unknown;
} | {
    type: "LIVE_CLEAR";
    jobId: string;
}, {
    [x: string]: import("xstate").ActorRefFromLogic<import("xstate").StateMachine<import("./lane.js").LaneInput & {
        records: readonly JobRecord[];
        active: boolean;
        held: boolean;
        runners: Readonly<Record<string, import("xstate").ActorRef<import("xstate").MachineSnapshot<{
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
        }, "holding" | "ended" | "claiming" | "preparing" | "controlling" | "releasing" | {
            active: {
                lease: "waiting" | "renewing";
                work: "committing" | "failing" | {
                    executing: {
                        heartbeat: "route" | "armed" | "off";
                        deadline: "route" | "armed" | "off";
                    };
                };
            };
        }, string, import("xstate").NonReducibleUnknown, import("xstate").MetaObject, {
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
        }>, {
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
        }, import("xstate").EventObject>>>;
        spent: Readonly<Record<string, number>>;
    }, {
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
    }, never, never, {}, string, import("./lane.js").LaneInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
        id: "lane";
    }, import("xstate").MetaObject> | import("xstate").PromiseActorLogic<JobRecord | undefined, {
        env: Env;
        id: string;
    }, import("xstate").EventObject>> | undefined;
    live?: import("xstate").ActorRefFromLogic<import("xstate").StateMachine<{
        env: Env;
        entries: Readonly<Record<string, {
            payload: unknown;
        }>>;
    }, {
        type: "LIVE_IN";
        jobId: string;
        payload: unknown;
    } | {
        type: "LIVE_CLEAR";
        jobId: string;
    } | {
        type: "LIVE_STALE";
        jobId: string;
    }, {}, never, never, never, never, {}, string, {
        env: Env;
    }, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
        id: "liveView";
    }, import("xstate").MetaObject>> | undefined;
    leader?: import("xstate").ActorRefFromLogic<import("xstate").CallbackActorLogic<RootEvent, {
        env: Env;
    }, import("xstate").EventObject>> | undefined;
    reader?: import("xstate").ActorRefFromLogic<import("xstate").CallbackActorLogic<RootEvent, {
        env: Env;
    }, import("xstate").EventObject>> | undefined;
}, {
    src: "lane";
    logic: import("xstate").StateMachine<import("./lane.js").LaneInput & {
        records: readonly JobRecord[];
        active: boolean;
        held: boolean;
        runners: Readonly<Record<string, import("xstate").ActorRef<import("xstate").MachineSnapshot<{
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
        }, "holding" | "ended" | "claiming" | "preparing" | "controlling" | "releasing" | {
            active: {
                lease: "waiting" | "renewing";
                work: "committing" | "failing" | {
                    executing: {
                        heartbeat: "route" | "armed" | "off";
                        deadline: "route" | "armed" | "off";
                    };
                };
            };
        }, string, import("xstate").NonReducibleUnknown, import("xstate").MetaObject, {
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
        }>, {
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
        }, import("xstate").EventObject>>>;
        spent: Readonly<Record<string, number>>;
    }, {
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
    }, never, never, {}, string, import("./lane.js").LaneInput, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
        id: "lane";
    }, import("xstate").MetaObject>;
    id: string | undefined;
} | {
    src: "liveView";
    logic: import("xstate").StateMachine<{
        env: Env;
        entries: Readonly<Record<string, {
            payload: unknown;
        }>>;
    }, {
        type: "LIVE_IN";
        jobId: string;
        payload: unknown;
    } | {
        type: "LIVE_CLEAR";
        jobId: string;
    } | {
        type: "LIVE_STALE";
        jobId: string;
    }, {}, never, never, never, never, {}, string, {
        env: Env;
    }, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
        id: "liveView";
    }, import("xstate").MetaObject>;
    id: "live";
} | {
    src: "leader";
    logic: import("xstate").CallbackActorLogic<RootEvent, {
        env: Env;
    }, import("xstate").EventObject>;
    id: "leader";
} | {
    src: "reader";
    logic: import("xstate").CallbackActorLogic<RootEvent, {
        env: Env;
    }, import("xstate").EventObject>;
    id: "reader";
} | {
    src: "stall";
    logic: import("xstate").PromiseActorLogic<JobRecord | undefined, {
        env: Env;
        id: string;
    }, import("xstate").EventObject>;
    id: string | undefined;
}, {
    type: "syncLanes";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "stallExpired";
    params: import("xstate").NonReducibleUnknown;
} | {
    type: "stallSettled";
    params: import("xstate").NonReducibleUnknown;
}, never, never, {}, string, {
    env: Env;
}, import("xstate").NonReducibleUnknown, import("xstate").EventObject, import("xstate").MetaObject, {
    id: "root";
}, import("xstate").MetaObject>;
export {};
//# sourceMappingURL=root.d.ts.map