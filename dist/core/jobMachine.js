import { setup, stateIn, transition } from "xstate";
export const jobMachineEventTypes = [
    "CLAIM",
    "CHECKPOINT",
    "ADVANCE",
    "REPLAN",
    "COMPLETE",
    "RETRY",
    "FAIL",
    "PAUSE",
    "CANCEL",
    "LEASE_EXPIRED",
    "RESUME",
    "HOLD",
];
const whileRunning = stateIn({ status: "running" });
export const jobMachine = setup({
    types: {
        events: {},
    },
    guards: {
        running: whileRunning,
        outboxPhase: stateIn({ phase: "outputs" }),
        autoResume: ({ event }) => event.type === "LEASE_EXPIRED" && event.autoResume,
    },
}).createMachine({
    id: "job",
    type: "parallel",
    states: {
        status: {
            initial: "queued",
            states: {
                queued: {
                    on: { CLAIM: "running", PAUSE: "paused", CANCEL: "cancelled" },
                },
                running: {
                    on: {
                        CHECKPOINT: "running",
                        COMPLETE: { guard: "outboxPhase", target: "done" },
                        RETRY: "queued",
                        FAIL: "failed",
                        PAUSE: "paused",
                        CANCEL: "cancelled",
                        LEASE_EXPIRED: [{ guard: "autoResume", target: "queued" }, { target: "interrupted" }],
                        HOLD: "queued",
                    },
                },
                paused: { on: { RESUME: "queued", CANCEL: "cancelled" } },
                interrupted: { on: { RESUME: "queued", CANCEL: "cancelled" } },
                failed: { on: { RESUME: "queued", CANCEL: "cancelled" } },
                cancelled: {},
                done: {},
            },
        },
        phase: {
            initial: "plan",
            states: {
                plan: { on: { ADVANCE: { guard: "running", target: "steps" } } },
                steps: {
                    on: {
                        ADVANCE: { guard: "running", target: "finalize" },
                        REPLAN: { guard: "running", target: "plan" },
                    },
                },
                finalize: { on: { ADVANCE: { guard: "running", target: "outputs" } } },
                outputs: {},
            },
        },
    },
});
function snapshotAt(position) {
    return jobMachine.resolveState({ value: { status: position.status, phase: position.phase }, context: {} });
}
function positionOf(snapshot) {
    const value = snapshot.value;
    return { status: value.status, phase: value.phase };
}
/** Whether the table allows `event` at `position`. */
export function allows(position, event) {
    return snapshotAt(position).can(event);
}
/**
 * Applies `events` in order through the pure transition table. Undefined when any of them is
 * refused — a refused write writes nothing.
 */
export function step(position, ...events) {
    let snapshot = snapshotAt(position);
    for (const event of events) {
        if (!snapshot.can(event))
            return undefined;
        [snapshot] = transition(jobMachine, snapshot, event);
    }
    return positionOf(snapshot);
}
//# sourceMappingURL=jobMachine.js.map