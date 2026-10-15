import type { EventBus, LeaderLock } from "../contract.js";

export { indexedDbJobStore } from "./indexedDbJobStore.js";

/**
 * The leader lock over the Web Locks API (navigator.locks). Where it is missing (jsdom, old
 * browsers) acquire() rejects, and the runtime falls back to lease-only mode. A lock taken away
 * (another context requesting it with `steal`) calls onLost.
 */
export function webLocksLeader(): LeaderLock {
  return {
    acquire(name, onLost) {
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (!locks) return Promise.reject(new Error("Web Locks are not available"));
      return new Promise((resolve, reject) => {
        let granted = false;
        locks
          .request(name, { mode: "exclusive" }, () => {
            granted = true;
            return new Promise<void>((release) => resolve(() => release()));
          })
          .then(undefined, (error: unknown) => {
            if (granted) onLost?.();
            else reject(error);
          });
      });
    },
  };
}

/**
 * The bus over a BroadcastChannel named `name`: every other tab hears a publish, this one does not
 * (the runtime applies its own messages itself). Without BroadcastChannel it is a no-op.
 * Nothing is opened until the first call.
 */
export function broadcastBus({ name }: { name: string }): EventBus {
  let channel: BroadcastChannel | null | undefined;
  const listeners = new Set<(message: unknown) => void>();
  const open = (): BroadcastChannel | null => {
    if (channel === undefined) {
      channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;
      if (channel) {
        channel.onmessage = (event: MessageEvent) => {
          for (const listener of [...listeners]) listener(event.data);
        };
        (channel as { unref?: () => void }).unref?.();
      }
    }
    return channel;
  };
  return {
    publish(message) {
      open()?.postMessage(message);
    },
    subscribe(listener) {
      open();
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
