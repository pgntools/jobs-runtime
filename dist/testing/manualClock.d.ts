/**
 * A clock that only moves when told to. Pass it as `clock` to createJobRuntime: every delay of the
 * runtime (leases, backoff, timeouts, live throttling, staleness) then waits for advance().
 */
export declare function manualClock(start?: Date | string | number): {
    now: () => Date;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    /**
     * Moves time forward by `ms`, firing due timers in order; every started runtime settles (as in
     * runUntilIdle) before and after each one, so a chain of timers plays out as it would live.
     */
    advance(ms: number): Promise<void>;
    /** Timers waiting to fire. */
    pending: () => number;
};
//# sourceMappingURL=manualClock.d.ts.map