# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org/): a change to the public contract is a minor (or major)
bump, never a silent edit.

Add every change under `## [Unreleased]` as it lands on `development`; the Cut release workflow
turns that section into the release's own.

## [Unreleased]

### Added

- The queue hold (JBR-3), a contract amendment to CTA-216's v0.1 surface: `JobRuntime.hold()`,
  `release()` and `held()`. While held, no lane in any tab claims a queued job, and every running
  job's step is aborted and the job goes back to `queued` from its checkpoint (history `held`,
  attempt outcome `held`, no attempt spent). `release()` lets the queue go on in its usual order;
  paused jobs stay paused, and per-job commands keep working while held. The hold is durable and
  shared: it survives reloads and leader handovers, lease-only mode too. `subscribe()` also hears
  changes of `held()`.
- `JobStore.getMeta` / `putMeta` (optional, both or neither): runtime-wide values such as the hold.
  `memoryJobStore()` and `indexedDbJobStore()` implement them, and `jobStoreConformance()` checks
  them. A store without them cannot be held (`hold()` resolves `"not-allowed"`).

### Changed

- `JobAttempt.outcome` gains `"held"`; the job machine gains `HOLD` (running → queued).
- `indexedDbJobStore` opens its database at version 2, adding a `meta` object store; a version 1
  database is upgraded in place (tabs still on an older package version must reload).

## [0.2.1] - 2026-10-15

### Added

- Releases are published to npm as `@pgntools/jobs-runtime` (dist-tag `latest`) from GitHub
  Actions through npm trusted publishing (OIDC, no token), with provenance. Dev builds stay git
  tags only.

## [0.2.0] - 2026-10-15

### Added

- The Cut release workflow (`.github/workflows/cut-release.yml`): a manual dispatch that cuts
  `release/<X.Y.Z>` from `development` with the version bumped and this CHANGELOG rolled, and opens
  a draft PR into `main`. The release workflow now also merges `main` back into `development`
  and deletes the release branch.
- The Dev tag workflow (`.github/workflows/dev-tag.yml`): every merge into `development` is built
  and tagged `v<next>-dev.<N>` (the next minor after the latest release, N counting up), with
  `dist/` on the tagged commit so the app can install it as a git dependency.

## [0.1.0] - 2026-10-16

The first release: the frozen v0.1 contract of CTA-216.

### Added

- `createJobRuntime()`: durable, checkpointed, at-least-once job execution in the browser, with one
  leader per namespace (Web Locks, or lease-only mode without them), leases renewed at a third of
  `leaseMs`, optimistic concurrency (one revision compare-and-set write per durable change, a
  conflict retried), lanes with their own concurrency (priority, then createdAt, `runAfter`
  respected), retries with exponential backoff and jitter, step and heartbeat timeouts, the
  plan → steps → finalize → outputs phases with an outbox, resumable artifacts, live telemetry,
  bounded history, lenient record reading, `kindVersion` migration and retention.
- `@pgntools/jobs-runtime/browser`: `indexedDbJobStore({ name })`, `webLocksLeader()`,
  `broadcastBus({ name })`.
- `@pgntools/jobs-runtime/react`: `useJobs`, `useJob`, `useJobLive` (React an optional peer
  dependency).
- `@pgntools/jobs-runtime/testing`: `memoryJobStore()`, `manualClock()`, `memoryLock()`,
  `runUntilIdle(runtime)`, `jobStoreConformance(make)`.

### Dependencies

- Runtime: `xstate` ^5 — the whole runtime is modelled as XState actors (see ARCHITECTURE.md §
  Dependencies). This replaces CTA-216's "zero runtime dependencies" rule (owner decision,
  2026-10-15).
- Optional peer: `react` ^18 || ^19, for the `/react` subpath only.
