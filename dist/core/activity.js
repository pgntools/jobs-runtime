// In-flight work of every runtime in this realm, for the testing kit's runUntilIdle() and
// manualClock().advance(). A runtime is idle when none of its store calls is pending; kind
// code waiting on the clock (a long step, a silent one) does not count — it waits for time.
// Nothing here touches a timer or a browser API until a test settles.
const busy = new Set();
export function newTracker() {
    return { inflight: 0, started: false };
}
export function track(tracker, work) {
    tracker.inflight++;
    busy.add(tracker);
    return work.finally(() => {
        tracker.inflight--;
        if (tracker.inflight === 0 && !tracker.started)
            busy.delete(tracker);
    });
}
export function setStarted(tracker, started) {
    tracker.started = started;
    if (started)
        busy.add(tracker);
    else if (tracker.inflight === 0)
        busy.delete(tracker);
}
const QUIET_TURNS = 3;
const MAX_TURNS = 100_000;
function macrotask() {
    const immediate = globalThis.setImmediate;
    return new Promise((resolve) => {
        if (typeof immediate === "function")
            immediate(resolve);
        else
            setTimeout(resolve, 0);
    });
}
/** Waits until every runtime in this realm has had no store call in flight for a few macrotasks. */
export async function settle() {
    let quiet = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
        await macrotask();
        let idle = true;
        for (const tracker of busy)
            if (tracker.inflight > 0)
                idle = false;
        quiet = idle ? quiet + 1 : 0;
        if (quiet >= QUIET_TURNS)
            return;
    }
    throw new Error(`jobs-runtime: still busy after ${MAX_TURNS} turns`);
}
/** Waits until this tracker has nothing in flight (used by stop() before handing back leases). */
export async function drain(tracker) {
    for (let turn = 0; tracker.inflight > 0 && turn < MAX_TURNS; turn++)
        await macrotask();
}
//# sourceMappingURL=activity.js.map