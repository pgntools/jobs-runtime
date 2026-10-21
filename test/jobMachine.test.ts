import { getNextSnapshot, initialTransition } from "xstate";
import { describe, expect, it } from "vitest";
import type { JobPhase, JobStatus } from "../src/index.js";
import { allows, jobMachine, jobMachineEventTypes, step, type JobMachineEvent, type Position } from "../src/core/jobMachine.js";

const statuses: JobStatus[] = ["queued", "running", "paused", "interrupted", "failed", "cancelled", "done"];
const phases: JobPhase[] = ["plan", "steps", "finalize", "outputs"];

const events: JobMachineEvent[] = jobMachineEventTypes.flatMap((type): JobMachineEvent[] =>
  type === "LEASE_EXPIRED" ? [{ type, autoResume: true }, { type, autoResume: false }] : [{ type } as JobMachineEvent],
);

const nextPhase: Partial<Record<JobPhase, JobPhase>> = { plan: "steps", steps: "finalize", finalize: "outputs" };

/**
 * The specification's table, written out independently of the machine:
 *   queued → running (claim); running → running (checkpoint); running → done (outbox emptied);
 *   running → queued (retry); running → failed; running / queued → paused;
 *   running / queued / paused / interrupted / failed → cancelled;
 *   running → interrupted, or queued when its kind auto-resumes; paused / interrupted / failed → queued;
 *   running → queued (the queue held);
 *   done and cancelled are terminal. Phases move only while running.
 */
function expected({ status, phase }: Position, event: JobMachineEvent): Position | undefined {
  const to = (s: JobStatus): Position => ({ status: s, phase });
  switch (event.type) {
    case "CLAIM":
      return status === "queued" ? to("running") : undefined;
    case "CHECKPOINT":
      return status === "running" ? to("running") : undefined;
    case "ADVANCE":
      return status === "running" && nextPhase[phase] ? { status, phase: nextPhase[phase] } : undefined;
    case "REPLAN":
      return status === "running" && phase === "steps" ? { status, phase: "plan" } : undefined;
    case "COMPLETE":
      return status === "running" && phase === "outputs" ? to("done") : undefined;
    case "RETRY":
      return status === "running" ? to("queued") : undefined;
    case "FAIL":
      return status === "running" ? to("failed") : undefined;
    case "PAUSE":
      return status === "running" || status === "queued" ? to("paused") : undefined;
    case "CANCEL":
      return ["running", "queued", "paused", "interrupted", "failed"].includes(status) ? to("cancelled") : undefined;
    case "LEASE_EXPIRED":
      return status === "running" ? to(event.autoResume ? "queued" : "interrupted") : undefined;
    case "RESUME":
      return ["paused", "interrupted", "failed"].includes(status) ? to("queued") : undefined;
    case "HOLD":
      return status === "running" ? to("queued") : undefined;
  }
}

describe("the job state machine", () => {
  it("starts where enqueue puts a job: queued, plan", () => {
    const [snapshot] = initialTransition(jobMachine);
    expect(snapshot.value).toEqual({ status: "queued", phase: "plan" });
  });

  const cases = statuses.flatMap((status) => phases.flatMap((phase) => events.map((event) => ({ status, phase, event }))));

  it(`covers every (status, phase, event): ${cases.length} cases`, () => {
    expect(cases).toHaveLength(statuses.length * phases.length * events.length);
  });

  it.each(cases)("$status/$phase + $event.type $event.autoResume", ({ status, phase, event }) => {
    const position = { status, phase };
    const want = expected(position, event);
    expect(allows(position, event)).toBe(want !== undefined);
    expect(step(position, event)).toEqual(want);
    // The same answer straight from XState's pure transition function: a refusal changes nothing.
    const snapshot = jobMachine.resolveState({ value: { status, phase }, context: {} });
    const next = getNextSnapshot(jobMachine, snapshot, event);
    expect(next.value).toEqual(want ? { status: want.status, phase: want.phase } : { status, phase });
  });

  it("applies several events as one write, refusing the whole write when any is refused", () => {
    expect(step({ status: "running", phase: "steps" }, { type: "CHECKPOINT" }, { type: "REPLAN" }, { type: "ADVANCE" })).toEqual({
      status: "running",
      phase: "steps",
    });
    expect(step({ status: "running", phase: "finalize" }, { type: "ADVANCE" }, { type: "COMPLETE" })).toEqual({
      status: "done",
      phase: "outputs",
    });
    expect(step({ status: "running", phase: "steps" }, { type: "CHECKPOINT" }, { type: "COMPLETE" })).toBeUndefined();
    expect(step({ status: "done", phase: "outputs" })).toEqual({ status: "done", phase: "outputs" });
  });
});
