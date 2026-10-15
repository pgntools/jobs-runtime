import type { EventBus, JobStore, LeaderLock } from "../contract.js";
import type { AnyKind } from "./records.js";

/** What every actor of one started runtime shares. Passed down as actor input. */
export type Env = {
  namespace: string;
  /** This start()'s lease owner id. */
  owner: string;
  kinds: ReadonlyMap<string, AnyKind>;
  lanes: Readonly<Record<string, { concurrency: number }>>;
  /** Tracked: every call is in-flight work. */
  store: JobStore;
  lock: LeaderLock | undefined;
  bus: EventBus | undefined;
  now(): Date;
  random(): number;
  leaseMs: number;
  liveIntervalMs: number;
  liveStaleMs: number;
  liveResendMs: number;
  /** Publishes on the bus and applies to this tab's own live view (the bus never echoes). */
  publish(message: BusMessage): void;
};

/** Everything the runtime puts on the bus. `ns` and `from` keep namespaces and echoes apart. */
export type BusMessage =
  | { type: "changed" }
  | { type: "live"; jobId: string; payload: unknown }
  | { type: "live-clear"; jobId: string };

export type Envelope = BusMessage & { ns: string; from: string };

export function readEnvelope(message: unknown, env: Pick<Env, "namespace" | "owner">): BusMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Partial<Envelope> & { jobId?: unknown };
  if (m.ns !== env.namespace || m.from === env.owner) return undefined;
  if (m.type === "changed") return { type: "changed" };
  if (typeof m.jobId !== "string") return undefined;
  if (m.type === "live") return { type: "live", jobId: m.jobId, payload: (m as { payload?: unknown }).payload };
  if (m.type === "live-clear") return { type: "live-clear", jobId: m.jobId };
  return undefined;
}
