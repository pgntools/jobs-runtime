import type { Env } from "./env.js";
/**
 * The publishing side of ctx.live(), one per running job: a throttle that publishes at most once
 * per liveIntervalMs (the interval's last payload), re-sends the last one every liveResendMs while
 * the job runs so readers keep it fresh, and never writes to the store.
 */
export declare const liveThrottleMachine: import("xstate").StateMachine<{
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
type LiveEntries = Readonly<Record<string, {
    payload: unknown;
}>>;
/**
 * The reading side, one per runtime: the latest payload per job, from this tab's runners and the
 * bus. An entry without news for liveStaleMs is dropped; a clear drops it at once.
 */
export declare const liveViewMachine: import("xstate").StateMachine<{
    env: Env;
    entries: LiveEntries;
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
export {};
//# sourceMappingURL=live.d.ts.map