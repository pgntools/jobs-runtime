export type Tracker = {
    inflight: number;
    started: boolean;
};
export declare function newTracker(): Tracker;
export declare function track<T>(tracker: Tracker, work: Promise<T>): Promise<T>;
export declare function setStarted(tracker: Tracker, started: boolean): void;
/** Waits until every runtime in this realm has had no store call in flight for a few macrotasks. */
export declare function settle(): Promise<void>;
/** Waits until this tracker has nothing in flight (used by stop() before handing back leases). */
export declare function drain(tracker: Tracker): Promise<void>;
//# sourceMappingURL=activity.d.ts.map