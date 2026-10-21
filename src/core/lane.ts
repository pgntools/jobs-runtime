import { assign, cancel, enqueueActions, raise, sendParent, setup, stopChild, type ActorRefFrom } from "xstate";
import type { JobRecord } from "../contract.js";
import type { Env } from "./env.js";
import { claimable, leaseExpired } from "./records.js";
import { runnerMachine } from "./runner.js";

type Runner = ActorRefFrom<typeof runnerMachine>;

export type LaneInput = { env: Env; name: string; concurrency: number };

type LaneContext = LaneInput & {
  records: readonly JobRecord[];
  active: boolean;
  /** The queue is held: nothing claimed, this lane's runners told to hold. */
  held: boolean;
  runners: Readonly<Record<string, Runner>>;
  /** The revision each job's last runner was spawned from: not spawned again until the record moves on. */
  spent: Readonly<Record<string, number>>;
};

export type LaneEvent =
  | { type: "SYNC"; records: readonly JobRecord[]; active: boolean; held: boolean }
  | { type: "WAKE" }
  | { type: "ABORT"; ids: readonly string[] }
  | { type: "RUNNER_ENDED"; jobId: string; revision: number };

const runnerId = (jobId: string): string => `runner:${jobId}`;

/** Within a lane: higher priority first, then the oldest, then by id. */
export function byTurn(a: JobRecord, b: JobRecord): number {
  return b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * One named queue. Fed the records on every store change; claims the next jobs (one runner each)
 * up to its concurrency while this tab may schedule and the queue is not held, and wakes itself
 * with a delayed event at the earliest future runAfter — never a polling loop. Jobs other tabs run
 * under a live lease count against the concurrency, so a lane keeps its limit across a handover and
 * in lease-only mode.
 */
export const laneMachine = setup({
  types: {
    input: {} as LaneInput,
    context: {} as LaneContext,
    events: {} as LaneEvent,
  },
  actors: { runner: runnerMachine },
  actions: {
    schedule: enqueueActions(({ context, enqueue }) => {
      const { env, name, concurrency, records, runners } = context;
      const now = env.now();
      enqueue(cancel("wake"));
      if (!context.active) {
        for (const runner of Object.values(runners)) enqueue.sendTo(runner, { type: "RELEASE" });
        return;
      }
      const mine = records.filter((job) => env.kinds.get(job.kind)?.lane === name);
      for (const [jobId, runner] of Object.entries(runners)) {
        enqueue.sendTo(runner, { type: "RECORD", job: records.find((job) => job.id === jobId) });
      }
      if (context.held) {
        // A control request in the RECORD above wins: a runner honouring it ignores the HOLD.
        for (const runner of Object.values(runners)) enqueue.sendTo(runner, { type: "HOLD" });
        return;
      }
      const elsewhere = mine.filter((job) => job.status === "running" && !(job.id in runners) && !leaseExpired(job, now)).length;
      let free = concurrency - Object.keys(runners).length - elsewhere;
      if (free > 0) {
        const ready = mine
          .filter((job) => !(job.id in runners) && claimable(job, now) && !((context.spent[job.id] ?? -1) >= job.revision))
          .sort(byTurn);
        for (const job of ready) {
          if (free-- <= 0) break;
          const kind = env.kinds.get(job.kind)!;
          enqueue.assign({
            runners: ({ context: current, spawn }) => {
              const runner = spawn("runner", { id: runnerId(job.id), input: { env, job, kind } });
              return { ...current.runners, [job.id]: runner };
            },
          });
        }
      }
      const next = mine
        .filter((job) => job.status === "queued" && job.control === undefined && job.runAfter !== undefined)
        .map((job) => Date.parse(job.runAfter!))
        .filter((at) => at > now.getTime())
        .sort((a, b) => a - b)[0];
      if (next !== undefined) enqueue(raise({ type: "WAKE" }, { id: "wake", delay: next - now.getTime() }));
    }),
    reportLocal: sendParent(({ context }) => ({ type: "LOCAL", lane: context.name, ids: Object.keys(context.runners) })),
  },
}).createMachine({
  id: "lane",
  context: ({ input }) => ({ ...input, records: [], active: false, held: false, runners: {}, spent: {} }),
  on: {
    SYNC: {
      actions: [
        assign({
          records: ({ event }) => event.records,
          active: ({ event }) => event.active,
          held: ({ event }) => event.held,
          spent: ({ context, event }) => {
            const ids = new Set(event.records.map((job) => job.id));
            return Object.fromEntries(Object.entries(context.spent).filter(([id]) => ids.has(id)));
          },
        }),
        "schedule",
        "reportLocal",
      ],
    },
    WAKE: { actions: ["schedule", "reportLocal"] },
    ABORT: {
      actions: enqueueActions(({ context, enqueue, event }) => {
        for (const id of event.ids) {
          const runner = context.runners[id];
          if (runner) enqueue.sendTo(runner, { type: "ABORT" });
        }
      }),
    },
    RUNNER_ENDED: {
      actions: [
        stopChild(({ event }) => runnerId(event.jobId)),
        assign({
          runners: ({ context, event }) => {
            const runners = { ...context.runners };
            delete runners[event.jobId];
            return runners;
          },
          spent: ({ context, event }) => ({ ...context.spent, [event.jobId]: event.revision }),
        }),
        "schedule",
        "reportLocal",
      ],
    },
  },
});
