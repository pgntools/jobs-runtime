import type { EventBus, LeaderLock } from "../contract.js";
export { indexedDbJobStore } from "./indexedDbJobStore.js";
/**
 * The leader lock over the Web Locks API (navigator.locks). Where it is missing (jsdom, old
 * browsers) acquire() rejects, and the runtime falls back to lease-only mode. A lock taken away
 * (another context requesting it with `steal`) calls onLost.
 */
export declare function webLocksLeader(): LeaderLock;
/**
 * The bus over a BroadcastChannel named `name`: every other tab hears a publish, this one does not
 * (the runtime applies its own messages itself). Without BroadcastChannel it is a no-op.
 * Nothing is opened until the first call.
 */
export declare function broadcastBus({ name }: {
    name: string;
}): EventBus;
//# sourceMappingURL=index.d.ts.map