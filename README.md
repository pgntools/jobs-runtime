# @pgntools/jobs-runtime

Durable background jobs for the browser. Every unit of work ends in one IndexedDB checkpoint, one
tab per namespace runs the jobs under leases, and pause, cancel, resume and delete are plain store
writes that any tab can make. Generic: no chess, no app entities, React only on an optional subpath.

- **At-least-once, checkpointed**: a crash replays at most the step in flight.
- **Multi-tab**: one leader per namespace (Web Locks), lease-only mode where Web Locks are missing.
- **Retries** with exponential backoff and jitter, **step and heartbeat timeouts**.
- **An outbox** for outputs (idempotent by key) and **resumable artifacts** (file parts sealed into a Blob).
- **Live telemetry**: throttled, broadcast to every tab, never stored.
- **SSR-safe**: nothing touches IndexedDB, locks, channels or timers until `start()` or a call.

The design and its guarantees are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Install

From npm:

```sh
yarn add @pgntools/jobs-runtime   # or: npm i @pgntools/jobs-runtime
```

Releases are published to npm (dist-tag `latest`) from GitHub Actions through npm trusted
publishing, with a provenance attestation linking each version to its source commit. Dev builds
are not published to npm; they are git tags only (see *Dev builds* below).

Every release and dev tag in git also carries the built `dist/`, so a git tag dependency works too:

```json
"@pgntools/jobs-runtime": "github:pgntools/jobs-runtime#v0.2.0"
```

Runtime dependencies: [`xstate`](https://github.com/statelyai/xstate) (v5) — see
[ARCHITECTURE.md § Dependencies](ARCHITECTURE.md#dependencies). `react` (18 or 19) is an optional
peer dependency, needed only for `@pgntools/jobs-runtime/react`.

## Quick start

### 1. A kind

A kind is a job type: how to plan, how to do one step, what it produces.

```ts
import type { JobKind } from "@pgntools/jobs-runtime";

type Input = { gameIds: string[] };
type State = { next: number; found: number };

export const exportGames: JobKind<Input, State> = {
  id: "games.export",
  version: 1, // bump when State changes shape; parseState migrates
  lane: "cpu",
  appliesTo: ["collection"],
  resumable: true, // resume from the checkpoint (false: re-plan from scratch)
  autoResume: true, // after a crash or tab close: re-queue (cheap) rather than interrupt
  retry: { maxAttempts: 3, backoff: { initialMs: 1_000, factor: 2, maxMs: 30_000, jitter: true } },
  timeouts: { heartbeatMs: 10_000 },

  parseInput: (value) => (Array.isArray((value as Input)?.gameIds) ? (value as Input) : undefined),
  parseState: (value) => (typeof (value as State)?.next === "number" ? (value as State) : undefined),
  title: (input) => `Export ${input.gameIds.length} games`,
  subjects: () => [{ type: "collection", id: "main" }],

  plan: async (input) => ({ state: { next: 0, found: 0 }, progress: { done: 0, total: input.gameIds.length } }),

  // One step = one checkpoint. At-least-once: safe to re-run from the same state.
  step: async (state, input, ctx) => {
    const pgn = await loadPgn(input.gameIds[state.next]!, ctx.signal);
    await ctx.artifacts.writePart("export", state.next, pgn); // idempotent by (key, seq)
    ctx.live({ current: input.gameIds[state.next] }); // ephemeral, every tab sees it
    const next = state.next + 1;
    return { state: { next, found: state.found + 1 }, progress: { done: next, total: input.gameIds.length }, done: next === input.gameIds.length };
  },

  // Decides the outputs (the outbox); may seal artifacts; writes nothing else.
  finalize: async (state, _input, ctx) => {
    const file = await ctx.artifacts.seal("export", { name: "games.pgn", mimeType: "application/x-chess-pgn" });
    return [{ key: "file", ...file }, { key: "summary", found: state.found }];
  },

  // Applies one output; idempotent by plan.key.
  applyOutput: async (plan) =>
    plan.key === "file"
      ? { key: "file", kind: "artifact", artifactId: plan.artifactId as string, name: "games.pgn", mimeType: "application/x-chess-pgn", size: plan.size as number }
      : { key: "summary", kind: "data", schema: "export-summary", value: { found: plan.found } },

  classifyError: (error) => ({ code: "export-failed", message: String(error), retryable: true }),
};
```

### 2. A runtime

Create one per tab, over the same namespace and database; start it when the app mounts.

```ts
import { createJobRuntime } from "@pgntools/jobs-runtime";
import { broadcastBus, indexedDbJobStore, webLocksLeader } from "@pgntools/jobs-runtime/browser";

const namespace = "chessapp.backgroundJobs";

export const jobs = createJobRuntime({
  namespace,
  kinds: [exportGames],
  lanes: { engine: { concurrency: 1 }, cpu: { concurrency: 1 } },
  store: indexedDbJobStore({ name: namespace }),
  lock: webLocksLeader(), // falls back to lease-only mode where Web Locks are missing
  bus: broadcastBus({ name: `${namespace}.bus` }),
  retention: { maxJobs: 200 },
});

jobs.start(); // never at import: SSR-safe
```

### 3. Enqueue and control

```ts
const result = await jobs.enqueue("games.export", { gameIds }, { priority: 1 });
if ("problem" in result) showError(result.problem); // "unknown-kind" | "invalid" | "storage" | "too-many"

await jobs.pause(id); // a running step is aborted; its checkpoint kept
await jobs.resume(id); // paused, interrupted or failed → queued, from the checkpoint
await jobs.cancel(id);
await jobs.remove([id]); // any status; a running one is aborted first
await jobs.removeUnfinishedOf([{ type: "collection", id: "main" }]); // an entity was deleted

const blob = await jobs.readArtifact(artifactId);
```

Every command answers `undefined` on success, or `"missing" | "not-allowed" | "storage"`.

### 4. React

```tsx
import { useJob, useJobLive, useJobs } from "@pgntools/jobs-runtime/react";

function JobsList() {
  const all = useJobs(jobs); // undefined until the first read lands
  if (!all) return <Spinner />;
  return all.map((job) => <JobRow key={job.id} id={job.id} />);
}

function JobRow({ id }: { id: string }) {
  const job = useJob(jobs, id);
  const live = useJobLive(jobs, id) as { current?: string } | undefined;
  if (!job) return null;
  return <div>{job.title}: {job.status} {job.progress.done}/{job.progress.total} {live?.current}</div>;
}
```

## Testing your kinds

`@pgntools/jobs-runtime/testing` runs the real runtime deterministically:

```ts
import { manualClock, memoryJobStore, memoryLock, runUntilIdle, jobStoreConformance } from "@pgntools/jobs-runtime/testing";

const clock = manualClock();
const runtime = createJobRuntime({ namespace: "t", kinds: [exportGames], lanes: { cpu: { concurrency: 1 } }, store: memoryJobStore(), lock: memoryLock(), clock });
runtime.start();
await runtime.enqueue("games.export", { gameIds: ["a", "b"] });
await runUntilIdle(runtime); // everything that can happen without time moving
await clock.advance(30_000); // fires backoffs, timeouts, lease expiry in order

// A custom JobStore adapter: run the contract checks in any test framework.
for (const check of jobStoreConformance(() => myStore())) it(check.name, check.run);
```

## Development

Node 22 (see `.nvmrc`).

| task | command |
| -- | -- |
| install | `npm ci` |
| lint | `npm run lint` |
| typecheck (sources, tests, the contract type test) | `npm run typecheck` |
| the whole suite | `npm test` |
| the suite with the 90 % coverage gate | `npm run test:coverage` |
| one file | `npx vitest run test/retries.test.ts` |
| one test | `npx vitest run test/retries.test.ts -t "bounds jitter"` |
| build `dist/` | `npm run build` |

CI runs lint, typecheck, test (with coverage) and build on every pull request.

### Releasing

Record every change under `## [Unreleased]` in `CHANGELOG.md` as it lands on `development`.

1. **Cut**: run the *Cut release* workflow (Actions → Cut release → Run workflow) and pick the bump:
   `patch`, `minor` (default) or `major`. It computes the next version from the latest `vX.Y.Z`
   tag, branches `release/<X.Y.Z>` off `development` with `package.json` bumped and the
   Unreleased section dated as `## [X.Y.Z] - <today>`, and opens a draft PR into `main`. It
   refuses an empty Unreleased section.
2. **Check**: fix anything on the release branch with PRs into `release/<X.Y.Z>`.
3. **Ship**: mark the draft PR ready and merge it into `main`. The *Release* workflow builds,
   commits `dist/` on a release commit, tags `vX.Y.Z`, publishes the GitHub release with the
   CHANGELOG section, merges `main` back into `development` (or opens a PR when that conflicts)
   and deletes the release branch.

### Dev builds

Every merge into `development` is built and tagged `v<next>-dev.<N>` by the *Dev tag* workflow:
`<next>` is the minor after the latest release (`v0.2.0-dev.1`, `v0.2.0-dev.2`, … after `v0.1.0`)
and `<N>` starts again at 1 after each release. Like a release tag, a dev tag carries the built
`dist/`, so the app can try unreleased work with
`"@pgntools/jobs-runtime": "github:pgntools/jobs-runtime#v0.3.0-dev.2"`. Dev builds are not
published to npm and get no GitHub release.

### Publishing to npm

Only releases are published. `release.yml` publishes each one (dist-tag `latest`) through npm
trusted publishing: GitHub's OIDC token, no npm token stored anywhere. It is registered as the
trusted publisher of `@pgntools/jobs-runtime` on npmjs.com (organization `pgntools`, repository
`jobs-runtime`, workflow `release.yml`). A version is published before its git tag is pushed, so a
failed publish leaves no tag behind and a re-run retries; a version already on npm is not
published again.

The cut workflow needs the repository setting *Allow GitHub Actions to create and approve pull
requests* to be on.

## License

MIT
