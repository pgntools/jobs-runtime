/**
 * The JobStore contract as runnable checks, framework-free: each check throws on failure.
 *
 *   for (const check of jobStoreConformance(() => myStore())) it(check.name, check.run);
 *
 * `make` is called once per check and must return an empty store.
 */
export function jobStoreConformance(make) {
    const check = (name, body) => ({
        name,
        run: async () => body(await make()),
    });
    return [
        check("add, get and list round-trip a record by value", async (store) => {
            const job = record("a");
            await store.add(job);
            job.title = "mutated after add";
            const read = await store.get("a");
            equal(read?.title, "job a", "get returns what was added, not a live reference");
            read.title = "mutated after get";
            equal((await store.get("a"))?.title, "job a", "a read record is a copy");
            equal((await store.list()).map((j) => j.id).join(), "a", "list returns every record");
            equal(await store.get("missing"), undefined, "get of an unknown id is undefined");
        }),
        check("add rejects a duplicate id with a conflict", async (store) => {
            await store.add(record("a"));
            await rejectsWithConflict(() => store.add(record("a")), "a duplicate add");
        }),
        check("update is a compare-and-set on revision", async (store) => {
            await store.add(record("a"));
            const written = await store.update("a", (job) => ({ ...job, title: "edited", revision: job.revision + 1 }));
            equal(written?.revision, 1, "update resolves the written record");
            equal((await store.get("a"))?.title, "edited", "the edit is stored");
            await rejectsWithConflict(() => store.update("a", (job) => ({ ...job, title: "stale", revision: job.revision })), "a stale revision");
            await rejectsWithConflict(() => store.update("a", (job) => ({ ...job, title: "ahead", revision: job.revision + 2 })), "a skipped revision");
            equal((await store.get("a"))?.title, "edited", "a conflicting edit writes nothing");
        }),
        check("update writes nothing when the edit returns undefined, or the record is missing", async (store) => {
            await store.add(record("a"));
            equal(await store.update("a", () => undefined), undefined, "a declined edit resolves undefined");
            equal((await store.get("a"))?.revision, 0, "a declined edit writes nothing");
            let called = false;
            const missing = await store.update("missing", (job) => {
                called = true;
                return job;
            });
            equal(missing, undefined, "updating a missing record resolves undefined");
            equal(called, false, "the edit is not called for a missing record");
        }),
        check("update rejects when the edit throws, writing nothing", async (store) => {
            await store.add(record("a"));
            let threw = false;
            try {
                await store.update("a", () => {
                    throw new Error("boom");
                });
            }
            catch {
                threw = true;
            }
            equal(threw, true, "a throwing edit rejects");
            equal((await store.get("a"))?.revision, 0, "a throwing edit writes nothing");
        }),
        check("concurrent updates never lose an update", async (store) => {
            await store.add(record("a"));
            await Promise.all(Array.from({ length: 20 }, () => store.update("a", (job) => ({ ...job, state: (job.state ?? 0) + 1, revision: job.revision + 1 }))));
            const job = await store.get("a");
            equal(job?.state, 20, "every increment landed");
            equal(job?.revision, 20, "every write moved the revision");
        }),
        check("remove deletes records with their parts and artifacts; unknown ids are ignored", async (store) => {
            await store.add(record("a"));
            await store.add(record("b"));
            await store.putPart("a", "file", 0, "x");
            const { artifactId } = await store.sealArtifact("a", "file", { name: "a.txt", mimeType: "text/plain" });
            await store.putPart("a", "other", 0, "left over");
            await store.remove(["a", "missing"]);
            equal((await store.list()).map((j) => j.id).join(), "b", "only the removed record is gone");
            equal(await store.readArtifact(artifactId), undefined, "its artifact is gone");
            const resealed = await store.sealArtifact("a", "other", { name: "o.txt", mimeType: "text/plain" });
            equal(resealed.size, 0, "its unsealed parts are gone");
        }),
        check("parts are idempotent by (key, seq) and sealed in order", async (store) => {
            await store.add(record("a"));
            await store.putPart("a", "file", 1, new Uint8Array([0x62]));
            await store.putPart("a", "file", 0, "a");
            await store.putPart("a", "file", 1, new Uint8Array([0x42])); // a re-run rewrites, never appends
            await store.putPart("a", "file", 2, "é");
            await store.putPart("a", "elsewhere", 0, "not mine");
            const sealed = await store.sealArtifact("a", "file", { name: "a.txt", mimeType: "text/plain" });
            equal(sealed.size, 4, "size is in bytes (utf-8 for strings)");
            const blob = await store.readArtifact(sealed.artifactId);
            equal(blob?.type, "text/plain", "the blob carries the mime type");
            equal(new TextDecoder().decode(await blob.arrayBuffer()), "aBé", "parts 0..n-1 in seq order");
        }),
        check("seal is idempotent by key", async (store) => {
            await store.add(record("a"));
            await store.putPart("a", "file", 0, "abc");
            const first = await store.sealArtifact("a", "file", { name: "a.txt", mimeType: "text/plain" });
            const again = await store.sealArtifact("a", "file", { name: "a.txt", mimeType: "text/plain" });
            equal(again.artifactId, first.artifactId, "the same artifact id");
            equal(again.size, first.size, "the same size");
            equal(new TextDecoder().decode(await (await store.readArtifact(first.artifactId)).arrayBuffer()), "abc", "the same bytes");
            equal(await store.readArtifact("missing"), undefined, "an unknown artifact is undefined");
        }),
        check("subscribe hears every write until unsubscribed", async (store) => {
            let heard = 0;
            const unsubscribe = store.subscribe(() => heard++);
            await store.add(record("a"));
            await settled(() => heard >= 1, "add notifies");
            await store.update("a", (job) => ({ ...job, revision: job.revision + 1 }));
            await settled(() => heard >= 2, "update notifies");
            await store.remove(["a"]);
            await settled(() => heard >= 3, "remove notifies");
            unsubscribe();
            const before = heard;
            await store.add(record("b"));
            await settled(() => true, "");
            equal(heard, before, "no notification after unsubscribe");
        }),
        check("meta is optional: both getMeta and putMeta, or neither", async (store) => {
            equal(typeof store.getMeta === "function", typeof store.putMeta === "function", "getMeta and putMeta come together");
        }),
        check("meta values round-trip by value, apart from the records", async (store) => {
            if (!store.getMeta || !store.putMeta)
                return; // a store without meta cannot hold the queue
            equal(await store.getMeta("missing"), undefined, "an unknown key reads undefined");
            const value = { held: true, at: "2026-01-01T00:00:00.000Z" };
            await store.putMeta("k", value);
            value.held = false;
            const read = (await store.getMeta("k"));
            equal(read?.held, true, "getMeta returns what was put, not a live reference");
            read.held = false;
            equal((await store.getMeta("k"))?.held, true, "a read value is a copy");
            await store.putMeta("k", false);
            equal(await store.getMeta("k"), false, "putMeta overwrites");
            await store.add(record("k"));
            await store.remove(["k"]);
            equal(await store.getMeta("k"), false, "removing records leaves meta alone");
            equal((await store.list()).length, 0, "meta values are not records");
        }),
        check("subscribe hears putMeta", async (store) => {
            if (!store.putMeta)
                return;
            let heard = 0;
            const unsubscribe = store.subscribe(() => heard++);
            await store.putMeta("k", true);
            await settled(() => heard >= 1, "putMeta notifies");
            unsubscribe();
        }),
    ];
}
function record(id) {
    const at = "2026-01-01T00:00:00.000Z";
    return {
        id,
        kind: "conformance",
        kindVersion: 1,
        lane: "default",
        priority: 0,
        title: `job ${id}`,
        subjects: [],
        status: "queued",
        phase: "plan",
        input: null,
        state: null,
        progress: { done: 0, total: 0 },
        pendingOutputs: [],
        outputs: [],
        attempts: [],
        maxAttempts: 1,
        history: [],
        revision: 0,
        createdAt: at,
        updatedAt: at,
    };
}
function equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
async function rejectsWithConflict(run, what) {
    try {
        await run();
    }
    catch (error) {
        equal(error?.code, "conflict", `${what} rejects with code "conflict"`);
        return;
    }
    throw new Error(`${what} should reject with a conflict`);
}
/** Notifications may be asynchronous (a microtask, an IndexedDB event): give them a few turns. */
async function settled(done, message) {
    for (let turn = 0; turn < 50; turn++) {
        if (done() && turn > 0)
            return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!done())
        throw new Error(message);
}
//# sourceMappingURL=conformance.js.map