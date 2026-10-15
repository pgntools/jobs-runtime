import { settle } from "../core/activity.js";

type Timer = { at: number; seq: number; run: () => void };

/**
 * A clock that only moves when told to. Pass it as `clock` to createJobRuntime: every delay of the
 * runtime (leases, backoff, timeouts, live throttling, staleness) then waits for advance().
 */
export function manualClock(start: Date | string | number = "2026-01-01T00:00:00.000Z") {
  let current = new Date(start).getTime();
  let seq = 0;
  const timers = new Map<number, Timer>();

  const due = (until: number): [number, Timer] | undefined => {
    let next: [number, Timer] | undefined;
    for (const entry of timers) {
      const [, timer] = entry;
      if (timer.at > until) continue;
      if (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq)) next = entry;
    }
    return next;
  };

  return {
    now: (): Date => new Date(current),
    setTimeout: ((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = ++seq;
      timers.set(id, { at: current + Math.max(0, ms ?? 0), seq: id, run: () => run(...args) });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number | undefined) => {
      if (id !== undefined) timers.delete(id);
    }) as unknown as typeof clearTimeout,
    /**
     * Moves time forward by `ms`, firing due timers in order; every started runtime settles (as in
     * runUntilIdle) before and after each one, so a chain of timers plays out as it would live.
     */
    async advance(ms: number): Promise<void> {
      const until = current + ms;
      await settle();
      for (let next = due(until); next; next = due(until)) {
        const [id, timer] = next;
        timers.delete(id);
        current = Math.max(current, timer.at);
        timer.run();
        await settle();
      }
      current = until;
      await settle();
    },
    /** Timers waiting to fire. */
    pending: (): number => timers.size,
  };
}
