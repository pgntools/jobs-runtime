import { createActor } from "xstate";
import { drain, newTracker, setStarted } from "./activity.js";
import { holdRunning, isFinished, newRecord, releaseLease, requestCancel, requestPause, requestResume, } from "./records.js";
import { rootMachine } from "./root.js";
import { hasMeta, HELD_KEY, readHeld, readRecords, trackedStore, writeRecord } from "./store.js";
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_LIVE_INTERVAL_MS = 250;
export const DEFAULT_LIVE_STALE_MS = 4_000;
export const LIVE_RESEND_MS = 1_000;
/** Lets the testing kit find a runtime's in-flight work without widening the public surface. */
const trackers = new WeakMap();
export function trackerOf(runtime) {
    return trackers.get(runtime);
}
function validate(options) {
    if (typeof options.namespace !== "string" || options.namespace === "") {
        throw new TypeError("createJobRuntime: namespace must be a non-empty string");
    }
    for (const [name, lane] of Object.entries(options.lanes)) {
        if (!Number.isInteger(lane.concurrency) || lane.concurrency < 1) {
            throw new TypeError(`createJobRuntime: lane "${name}" needs a concurrency of at least 1`);
        }
    }
    const kinds = new Map();
    for (const kind of options.kinds) {
        if (kinds.has(kind.id))
            throw new TypeError(`createJobRuntime: kind "${kind.id}" is registered twice`);
        if (!(kind.lane in options.lanes))
            throw new TypeError(`createJobRuntime: kind "${kind.id}" runs on unknown lane "${kind.lane}"`);
        kinds.set(kind.id, kind);
    }
    return kinds;
}
const randomId = () => typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const sharesSubject = (job, subjects) => job.subjects.some((s) => subjects.some((t) => s.type === t.type && s.id === t.id));
/**
 * Creates a runtime; touches nothing (no IndexedDB, lock, channel or timer) until start() or a
 * call. Every tab of the app creates one over the same namespace and store; the one holding the
 * leader lock runs the jobs, the others read and write commands.
 */
export function createJobRuntime(options) {
    const kinds = validate(options);
    const tracker = newTracker();
    const store = trackedStore(options.store, tracker);
    const clock = options.clock;
    const now = () => (clock ? clock.now() : new Date());
    const newId = options.newId ?? randomId;
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    let session;
    let records;
    let held;
    let live = {};
    const listeners = new Set();
    const liveListeners = new Set();
    const notify = (set) => {
        for (const listener of [...set])
            listener();
    };
    const publishRaw = (owner, message) => {
        try {
            options.bus?.publish({ ...message, ns: options.namespace, from: owner });
        }
        catch {
            // A failing bus loses telemetry and nudges, never durable state.
        }
    };
    /** A command landed: nudge the other tabs (and the leader) to re-read. */
    const nudge = () => {
        if (session)
            publishRaw(session.env.owner, { type: "changed" });
        else
            publishRaw("", { type: "changed" });
    };
    const start = () => {
        if (session && !session.stopping)
            return;
        const owner = newId();
        const env = {
            namespace: options.namespace,
            owner,
            kinds,
            lanes: options.lanes,
            store,
            lock: options.lock,
            bus: options.bus,
            now,
            random: Math.random,
            leaseMs,
            liveIntervalMs: options.liveIntervalMs ?? DEFAULT_LIVE_INTERVAL_MS,
            liveStaleMs: options.liveStaleMs ?? DEFAULT_LIVE_STALE_MS,
            liveResendMs: LIVE_RESEND_MS,
            publish: (message) => {
                publishRaw(owner, message);
                if (message.type === "live")
                    actor.send({ type: "LIVE_IN", jobId: message.jobId, payload: message.payload });
                else if (message.type === "live-clear")
                    actor.send({ type: "LIVE_CLEAR", jobId: message.jobId });
            },
        };
        const timers = clock ?? globalThis;
        const actor = createActor(rootMachine, {
            input: { env },
            clock: {
                setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
                clearTimeout: (id) => timers.clearTimeout(id),
            },
        });
        const current = { actor, env };
        session = current;
        setStarted(tracker, true);
        actor.subscribe({
            next: (snapshot) => {
                if (session !== current)
                    return;
                if (snapshot.context.records !== records || snapshot.context.held !== held) {
                    records = snapshot.context.records;
                    held = snapshot.context.held;
                    notify(listeners);
                }
            },
            error: () => {
                // Actions never throw by design; should one, the runtime stops scheduling and keeps its view.
            },
        });
        actor.start();
        const liveView = actor.getSnapshot().children.live;
        liveView.subscribe((snapshot) => {
            if (session !== current)
                return;
            if (snapshot.context.entries !== live) {
                live = snapshot.context.entries;
                notify(liveListeners);
            }
        });
    };
    const stop = () => {
        const current = session;
        if (!current)
            return Promise.resolve();
        current.stopping ??= (async () => {
            const { local, held: wasHeld } = current.actor.getSnapshot().context;
            const ran = Object.values(local).flat();
            current.actor.stop();
            await drain(tracker);
            // Hand back this tab's leases so the next leader stalls the jobs at once, not after leaseMs;
            // while the queue is held, hold them instead — back to queued, as the hold would have.
            const owner = current.env.owner;
            const handBack = wasHeld === true ? holdRunning : releaseLease;
            const mine = await readRecords(store).catch(() => []);
            await Promise.allSettled(mine
                .filter((job) => job.lease?.owner === owner)
                .map((job) => writeRecord(store, job.id, (stored) => handBack(stored, { owner, now: now() }))));
            for (const jobId of ran)
                publishRaw(owner, { type: "live-clear", jobId });
            if (session !== current)
                return; // started again meanwhile: the new session owns the view
            session = undefined;
            setStarted(tracker, false);
            if (Object.keys(live).length > 0) {
                live = {};
                notify(liveListeners);
            }
        })();
        return current.stopping;
    };
    const command = async (id, decide) => {
        let refused = false;
        try {
            const written = await writeRecord(store, id, (job) => {
                const decision = decide(job, kinds.get(job.kind), now());
                refused = "problem" in decision;
                return "next" in decision ? decision.next : undefined;
            });
            if (!written)
                return refused ? "not-allowed" : "missing";
        }
        catch {
            return "storage";
        }
        nudge();
        return undefined;
    };
    /** The queue hold: one meta write, skipped when the store already reads `value`. */
    const setHeld = async (value) => {
        if (!hasMeta(store))
            return value ? "not-allowed" : undefined;
        try {
            if ((await readHeld(store)) === value)
                return undefined;
            await store.putMeta(HELD_KEY, value);
        }
        catch {
            return "storage";
        }
        nudge();
        return undefined;
    };
    /** Retention: prune the oldest finished records to make room for one more; too-many when none is finished. */
    const makeRoom = async (maxJobs) => {
        const all = await readRecords(store);
        const excess = all.length - maxJobs + 1;
        if (excess <= 0)
            return undefined;
        const finished = all
            .filter(isFinished)
            .sort((a, b) => (a.finishedAt ?? a.updatedAt).localeCompare(b.finishedAt ?? b.updatedAt) || a.createdAt.localeCompare(b.createdAt));
        if (finished.length < excess)
            return "too-many";
        await store.remove(finished.slice(0, excess).map((job) => job.id));
        return undefined;
    };
    const runtime = {
        start,
        stop,
        async enqueue(kindId, input, enqueueOptions) {
            const kind = kinds.get(kindId);
            if (!kind)
                return { problem: "unknown-kind" };
            let job;
            try {
                const parsed = kind.parseInput(input);
                if (parsed === undefined)
                    return { problem: "invalid" };
                job = newRecord({
                    id: newId(),
                    kind,
                    input: parsed,
                    priority: enqueueOptions?.priority ?? 0,
                    ...(enqueueOptions?.runAfter ? { runAfter: enqueueOptions.runAfter } : {}),
                    now: now(),
                });
            }
            catch {
                return { problem: "invalid" };
            }
            try {
                if (options.retention) {
                    const problem = await makeRoom(options.retention.maxJobs);
                    if (problem)
                        return { problem };
                }
                await store.add(job);
            }
            catch {
                return { problem: "storage" };
            }
            nudge();
            return { id: job.id };
        },
        pause: (id) => command(id, requestPause),
        resume: (id) => command(id, requestResume),
        cancel: (id) => command(id, requestCancel),
        async remove(ids) {
            if (ids.length === 0)
                return undefined;
            try {
                const found = await Promise.all(ids.map((id) => store.get(id)));
                const present = ids.filter((_, i) => found[i] !== undefined);
                if (present.length === 0)
                    return "missing";
                session?.actor.send({ type: "ABORT", ids: present });
                await store.remove(present);
            }
            catch {
                return "storage";
            }
            nudge();
            return undefined;
        },
        async removeUnfinishedOf(subjects) {
            const all = await readRecords(store);
            const ids = all.filter((job) => !isFinished(job) && sharesSubject(job, subjects)).map((job) => job.id);
            if (ids.length === 0)
                return;
            session?.actor.send({ type: "ABORT", ids });
            await store.remove(ids);
            nudge();
        },
        hold: () => setHeld(true),
        release: () => setHeld(false),
        held: () => held,
        snapshot: () => records,
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        liveOf: (id) => live[id]?.payload,
        subscribeLive(listener) {
            liveListeners.add(listener);
            return () => void liveListeners.delete(listener);
        },
        readArtifact: (artifactId) => store.readArtifact(artifactId),
        kindOf(id) {
            const job = records?.find((record) => record.id === id);
            return job && kinds.get(job.kind);
        },
        kindsFor: (entityType) => [...kinds.values()].filter((kind) => kind.appliesTo.includes(entityType)),
    };
    trackers.set(runtime, tracker);
    return runtime;
}
//# sourceMappingURL=runtime.js.map