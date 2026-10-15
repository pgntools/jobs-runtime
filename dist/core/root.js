import { assign, cancel, enqueueActions, fromCallback, fromPromise, raise, sendTo, setup, stopChild } from "xstate";
import { readEnvelope } from "./env.js";
import { laneMachine } from "./lane.js";
import { liveViewMachine } from "./live.js";
import { leaseExpired, stall } from "./records.js";
import { readRecords, writeRecord } from "./store.js";
/**
 * The store channel: every store change (this tab or another) and every "changed" nudge on the bus
 * re-reads the records — one read at a time, coalesced — and sends them up as RECORDS. Live
 * telemetry from other tabs arrives here too.
 */
const readerLogic = fromCallback(({ sendBack, input: { env } }) => {
    let disposed = false;
    let reading = false;
    let dirty = false;
    const read = async () => {
        if (reading) {
            dirty = true;
            return;
        }
        reading = true;
        do {
            dirty = false;
            try {
                const records = await readRecords(env.store);
                if (!disposed)
                    sendBack({ type: "RECORDS", records });
            }
            catch {
                // The view stays as it was; the next store change reads again.
            }
        } while (dirty && !disposed);
        reading = false;
    };
    // A port that throws on subscribe leaves this tab without that channel, never without a runtime.
    const listen = (subscribe) => {
        try {
            return subscribe();
        }
        catch {
            return undefined;
        }
    };
    const unsubscribeStore = listen(() => env.store.subscribe(() => void read()));
    const unsubscribeBus = listen(() => env.bus?.subscribe((raw) => {
        const message = readEnvelope(raw, env);
        if (message?.type === "changed")
            void read();
        else if (message?.type === "live")
            sendBack({ type: "LIVE_IN", jobId: message.jobId, payload: message.payload });
        else if (message?.type === "live-clear")
            sendBack({ type: "LIVE_CLEAR", jobId: message.jobId });
    }));
    void read();
    return () => {
        disposed = true;
        unsubscribeStore?.();
        unsubscribeBus?.();
    };
});
/**
 * Leader election: the Web Lock `<namespace>.leader`. Without a lock — or when acquiring rejects
 * (no Web Locks in this browser) — every tab runs in lease-only mode. A lost lock makes this tab a
 * follower again, queued for the lock; a lock granted after stop() is handed straight back.
 */
const leaderLogic = fromCallback(({ sendBack, input: { env } }) => {
    const lock = env.lock;
    if (!lock) {
        sendBack({ type: "ROLE", role: "lease-only" });
        return;
    }
    let disposed = false;
    let release;
    const acquire = () => {
        sendBack({ type: "ROLE", role: "follower" });
        const lost = () => {
            if (disposed)
                return;
            release = undefined;
            acquire();
        };
        let granting;
        try {
            granting = lock.acquire(`${env.namespace}.leader`, lost);
        }
        catch (error) {
            granting = Promise.reject(error);
        }
        granting.then((granted) => {
            if (disposed) {
                granted();
                return;
            }
            release = granted;
            sendBack({ type: "ROLE", role: "leader" });
        }, () => {
            if (!disposed)
                sendBack({ type: "ROLE", role: "lease-only" });
        });
    };
    acquire();
    return () => {
        disposed = true;
        release?.();
    };
});
const stallLogic = fromPromise(({ input: { env, id } }) => writeRecord(env.store, id, (job) => stall(job, env.now(), env.kinds.get(job.kind))));
const STALL_DONE = "xstate.done.actor.stall:";
const STALL_ERROR = "xstate.error.actor.stall:";
const schedules = (role) => role === "leader" || role === "lease-only";
/**
 * The runtime: one root actor per start(). Children: the store reader, the leader election, the
 * live view and one lane per configured lane (each spawning a runner per claimed job). The root
 * holds the records view and, while this tab schedules, stalls running jobs whose lease expired.
 */
export const rootMachine = setup({
    types: {
        input: {},
        context: {},
        events: {},
    },
    actors: { reader: readerLogic, leader: leaderLogic, liveView: liveViewMachine, lane: laneMachine, stall: stallLogic },
    actions: {
        syncLanes: enqueueActions(({ context, enqueue }) => {
            if (!context.records)
                return;
            for (const lane of Object.values(context.lanes)) {
                enqueue.sendTo(lane, { type: "SYNC", records: context.records, active: schedules(context.role) });
            }
        }),
        stallExpired: enqueueActions(({ context, enqueue }) => {
            enqueue(cancel("wake"));
            if (!context.records || !schedules(context.role))
                return;
            const { env } = context;
            const now = env.now();
            const local = new Set(Object.values(context.local).flat());
            const theirs = context.records.filter((job) => job.status === "running" && !local.has(job.id));
            const stalling = { ...context.stalling };
            for (const job of theirs) {
                if (!leaseExpired(job, now) || stalling[job.id])
                    continue;
                stalling[job.id] = true;
                enqueue.spawnChild("stall", { id: `stall:${job.id}`, input: { env, id: job.id } });
            }
            enqueue.assign({ stalling });
            const next = theirs
                .filter((job) => !leaseExpired(job, now))
                .map((job) => Date.parse(job.lease.expiresAt))
                .sort((a, b) => a - b)[0];
            if (next !== undefined)
                enqueue(raise({ type: "WAKE" }, { id: "wake", delay: next - now.getTime() }));
        }),
        stallSettled: enqueueActions(({ context, enqueue, event }) => {
            const type = event.type;
            const prefix = [STALL_DONE, STALL_ERROR].find((p) => type.startsWith(p));
            if (prefix === undefined)
                return;
            const jobId = type.slice(prefix.length);
            enqueue(stopChild(`stall:${jobId}`));
            const stalling = { ...context.stalling };
            delete stalling[jobId];
            enqueue.assign({ stalling });
        }),
    },
}).createMachine({
    id: "root",
    context: ({ input, spawn }) => ({
        env: input.env,
        records: undefined,
        role: "pending",
        local: {},
        stalling: {},
        lanes: Object.fromEntries(Object.entries(input.env.lanes).map(([name, { concurrency }]) => [
            name,
            spawn("lane", { id: `lane:${name}`, input: { env: input.env, name, concurrency } }),
        ])),
    }),
    invoke: [
        { id: "live", src: "liveView", input: ({ context }) => ({ env: context.env }) },
        { id: "reader", src: "reader", input: ({ context }) => ({ env: context.env }) },
        { id: "leader", src: "leader", input: ({ context }) => ({ env: context.env }) },
    ],
    on: {
        RECORDS: { actions: [assign({ records: ({ event }) => event.records }), "syncLanes", "stallExpired"] },
        ROLE: { actions: [assign({ role: ({ event }) => event.role }), "syncLanes", "stallExpired"] },
        LOCAL: { actions: [assign({ local: ({ context, event }) => ({ ...context.local, [event.lane]: event.ids }) }), "stallExpired"] },
        WAKE: { actions: "stallExpired" },
        ABORT: {
            actions: enqueueActions(({ context, enqueue, event }) => {
                for (const lane of Object.values(context.lanes))
                    enqueue.sendTo(lane, event);
            }),
        },
        LIVE_IN: { actions: sendTo("live", ({ event }) => event) },
        LIVE_CLEAR: { actions: sendTo("live", ({ event }) => event) },
        "xstate.done.actor.*": { actions: "stallSettled" },
        "xstate.error.actor.*": { actions: "stallSettled" },
    },
});
//# sourceMappingURL=root.js.map