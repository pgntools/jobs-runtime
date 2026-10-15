import { assign, enqueueActions, setup } from "xstate";
/**
 * The publishing side of ctx.live(), one per running job: a throttle that publishes at most once
 * per liveIntervalMs (the interval's last payload), re-sends the last one every liveResendMs while
 * the job runs so readers keep it fresh, and never writes to the store.
 */
export const liveThrottleMachine = setup({
    types: {
        input: {},
        context: {},
        events: {},
    },
    actions: {
        publishNow: enqueueActions(({ enqueue, context, event }) => {
            enqueue(() => context.env.publish({ type: "live", jobId: context.jobId, payload: event.payload }));
            enqueue.assign({ last: { payload: event.payload }, pending: undefined });
        }),
        hold: assign({ pending: ({ event }) => ({ payload: event.payload }) }),
        publishPending: enqueueActions(({ enqueue, context }) => {
            const payload = context.pending.payload;
            enqueue(() => context.env.publish({ type: "live", jobId: context.jobId, payload }));
            enqueue.assign({ last: { payload }, pending: undefined });
        }),
        resend: ({ context }) => context.env.publish({ type: "live", jobId: context.jobId, payload: context.last.payload }),
    },
    guards: { hasPending: ({ context }) => context.pending !== undefined },
    delays: {
        interval: ({ context }) => context.env.liveIntervalMs,
        resend: ({ context }) => context.env.liveResendMs,
    },
}).createMachine({
    id: "liveThrottle",
    context: ({ input }) => ({ env: input.env, jobId: input.jobId }),
    initial: "silent",
    states: {
        silent: { on: { LIVE: { target: "throttling", actions: "publishNow" } } },
        throttling: {
            on: { LIVE: { actions: "hold" } },
            after: {
                interval: [
                    { guard: "hasPending", target: "throttling", reenter: true, actions: "publishPending" },
                    { target: "holding" },
                ],
            },
        },
        holding: {
            on: { LIVE: { target: "throttling", actions: "publishNow" } },
            after: { resend: { target: "holding", reenter: true, actions: "resend" } },
        },
    },
});
/**
 * The reading side, one per runtime: the latest payload per job, from this tab's runners and the
 * bus. An entry without news for liveStaleMs is dropped; a clear drops it at once.
 */
export const liveViewMachine = setup({
    types: {
        input: {},
        context: {},
        events: {},
    },
}).createMachine({
    id: "liveView",
    context: ({ input }) => ({ env: input.env, entries: {} }),
    on: {
        LIVE_IN: {
            actions: enqueueActions(({ enqueue, context, event }) => {
                enqueue.assign({ entries: { ...context.entries, [event.jobId]: { payload: event.payload } } });
                enqueue.cancel(`stale:${event.jobId}`);
                enqueue.raise({ type: "LIVE_STALE", jobId: event.jobId }, { id: `stale:${event.jobId}`, delay: context.env.liveStaleMs });
            }),
        },
        LIVE_CLEAR: {
            actions: enqueueActions(({ enqueue, context, event }) => {
                enqueue.cancel(`stale:${event.jobId}`);
                enqueue.assign({ entries: drop(context.entries, event.jobId) });
            }),
        },
        LIVE_STALE: { actions: assign({ entries: ({ context, event }) => drop(context.entries, event.jobId) }) },
    },
});
function drop(entries, jobId) {
    if (!(jobId in entries))
        return entries;
    const next = { ...entries };
    delete next[jobId];
    return next;
}
//# sourceMappingURL=live.js.map