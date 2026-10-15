import type { JobStore } from "../contract.js";
/**
 * The JobStore contract as runnable checks, framework-free: each check throws on failure.
 *
 *   for (const check of jobStoreConformance(() => myStore())) it(check.name, check.run);
 *
 * `make` is called once per check and must return an empty store.
 */
export declare function jobStoreConformance(make: () => JobStore | Promise<JobStore>): {
    name: string;
    run: () => Promise<void>;
}[];
//# sourceMappingURL=conformance.d.ts.map