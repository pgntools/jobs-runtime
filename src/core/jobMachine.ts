import { setup, stateIn, transition, type SnapshotFrom } from "xstate";
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
export type JobMachineEvent =
  | { type: "CLAIM" } // queued → running: the leader writes a lease, appends an attempt
  | { type: "CHECKPOINT" } // running → running: a unit committed, the lease renewed
  | { type: "ADVANCE" } // phase: plan → steps → finalize → outputs (while running)
  | { type: "REPLAN" } // phase: → plan (while running: unparsable checkpoint, or a non-resumable kind)
  | { type: "COMPLETE" } // running → done, once the outbox is empty (phase outputs)
  | { type: "RETRY" } // running → queued + runAfter
  | { type: "FAIL" } // running → failed
  | { type: "PAUSE" } // running / queued → paused
  | { type: "CANCEL" } // running / queued / paused / interrupted / failed → cancelled
  | { type: "LEASE_EXPIRED"; autoResume: boolean } // running → queued (autoResume) or interrupted
  | { type: "RESUME" } // paused / interrupted / failed → queued
  | { type: "HOLD" }; // running → queued: the queue was held (no attempt spent)

export type JobMachineEventType = JobMachineEvent["type"];

export const jobMachineEventTypes: readonly JobMachineEventType[] = [
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
    events: {} as JobMachineEvent,
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

type JobSnapshot = SnapshotFrom<typeof jobMachine>;
export type Position = { status: JobStatus; phase: JobPhase };

function snapshotAt(position: Position): JobSnapshot {
  return jobMachine.resolveState({ value: { status: position.status, phase: position.phase }, context: {} });
}

function positionOf(snapshot: JobSnapshot): Position {
  const value = snapshot.value as { status: JobStatus; phase: JobPhase };
  return { status: value.status, phase: value.phase };
}

/** Whether the table allows `event` at `position`. */
export function allows(position: Position, event: JobMachineEvent): boolean {
  return snapshotAt(position).can(event);
}

/**
 * Applies `events` in order through the pure transition table. Undefined when any of them is
 * refused — a refused write writes nothing.
 */
export function step(position: Position, ...events: JobMachineEvent[]): Position | undefined {
  let snapshot = snapshotAt(position);
  for (const event of events) {
    if (!snapshot.can(event)) return undefined;
    [snapshot] = transition(jobMachine, snapshot, event);
  }
  return positionOf(snapshot);
}
