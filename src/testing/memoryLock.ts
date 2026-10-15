import type { LeaderLock } from "../contract.js";

/**
 * Web Locks in memory: one exclusive holder per name, the rest queued in request order. Share one
 * instance between runtimes to model tabs of one origin.
 */
export function memoryLock(): LeaderLock {
  const holders = new Map<string, object>();
  const queues = new Map<string, (() => void)[]>();

  const grant = (name: string): void => {
    const next = queues.get(name)?.shift();
    if (next) next();
  };

  return {
    acquire(name) {
      return new Promise((resolve) => {
        const take = (): void => {
          const token = {};
          holders.set(name, token);
          resolve(() => {
            if (holders.get(name) !== token) return;
            holders.delete(name);
            grant(name);
          });
        };
        if (!holders.has(name)) take();
        else queues.set(name, [...(queues.get(name) ?? []), take]);
      });
    },
  };
}
