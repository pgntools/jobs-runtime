# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org/): a change to the public contract is a minor (or major)
bump, never a silent edit.

## [0.1.0] - Unreleased

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
