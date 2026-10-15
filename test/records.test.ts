import { describe, expect, it } from "vitest";
import type { JobRecord } from "../src/index.js";
import {
  applyControl,
  claim,
  commit,
  fail,
  normalise,
  releaseLease,
  renewLease,
  requestCancel,
  requestPause,
  requestResume,
  stall,
} from "../src/core/records.js";
import { countKind } from "./helpers/kinds.js";

const now = new Date("2026-03-01T12:00:00.000Z");
const worker = { owner: "me", now, leaseMs: 30_000 };
const kind = countKind();

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return normalise({ id: "j", kind: "test.count", status: "queued", createdAt: "2026-03-01T00:00:00.000Z", ...overrides })!;
}

describe("the normaliser", () => {
  it("refuses what is not a record", () => {
    for (const junk of [null, 1, "x", [], {}, { id: 3 }, { id: "" }]) expect(normalise(junk)).toBeUndefined();
  });

  it("fills every default and drops malformed parts", () => {
    const job = normalise({
      id: "j",
      kind: 7,
      status: "exploded",
      phase: "nowhere",
      subjects: [{ type: "game", id: "1" }, { type: 1 }],
      progress: { done: "x", total: 4, label: "half" },
      pendingOutputs: [{ key: "a" }, { nokey: 1 }],
      outputs: "nope",
      attempts: [{ n: 1, startedAt: "t" }, { n: "1" }],
      history: [...Array.from({ length: 120 }, (_, i) => ({ at: "t", type: `e${i}` })), { at: 1 }],
      revision: Number.NaN,
      control: "explode",
      lease: { owner: 1, expiresAt: "t" },
      error: { code: "x", retryable: "yes" },
      runAfter: 5,
      startedAt: "s",
      finishedAt: "f",
    })!;
    expect(job).toMatchObject({
      kind: "",
      status: "interrupted",
      phase: "plan",
      state: null,
      subjects: [{ type: "game", id: "1" }],
      progress: { done: 0, total: 4, label: "half" },
      pendingOutputs: [{ key: "a" }],
      outputs: [],
      attempts: [{ n: 1, startedAt: "t" }],
      maxAttempts: 1,
      revision: 0,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      error: { code: "x", retryable: false },
      startedAt: "s",
      finishedAt: "f",
    });
    expect(job.history).toHaveLength(100);
    expect(job.history[0]!.type).toBe("e20");
    expect(job.control).toBeUndefined();
    expect(job.lease).toBeUndefined();
    expect(job.runAfter).toBeUndefined();
    expect(normalise({ id: "k", error: "nope", progress: [] })!.error).toBeUndefined();
  });
});

describe("record transforms refuse what the table refuses", () => {
  it("claims only a free, due, uncontrolled queued job", () => {
    expect(claim(record({ status: "paused" }), worker)).toBeUndefined();
    expect(claim(record({ runAfter: "2026-03-02T00:00:00.000Z" }), worker)).toBeUndefined();
    expect(claim(record({ lease: { owner: "x", expiresAt: "2026-03-02T00:00:00.000Z" } }), worker)).toBeUndefined();
    expect(claim(record({ control: "pause" }), worker)).toBeUndefined();
    expect(claim(record({ lease: { owner: "x", expiresAt: "2026-03-01T00:00:00.000Z" } }), worker)?.lease?.owner).toBe("me");
  });

  it("writes nothing for a job this worker does not hold", () => {
    const theirs = record({ status: "running", lease: { owner: "them", expiresAt: "2026-03-02T00:00:00.000Z" } });
    expect(renewLease(theirs, worker)).toBeUndefined();
    expect(releaseLease(theirs, worker)).toBeUndefined();
    expect(applyControl({ ...theirs, control: "pause" }, worker)).toBeUndefined();
    expect(commit(theirs, worker, { moves: [], kindVersion: 1 })).toBeUndefined();
    expect(fail(theirs, worker, { code: "x", retryable: false }, kind.retry, Math.random)).toBeUndefined();
    const mine = { ...theirs, lease: { owner: "me", expiresAt: theirs.lease!.expiresAt } };
    expect(applyControl(mine, worker)).toBeUndefined(); // no request to act on
    expect(commit(mine, worker, { moves: ["ADVANCE", "ADVANCE", "ADVANCE", "ADVANCE"], kindVersion: 1 })).toBeUndefined();
  });

  it("stalls only a running job whose lease expired", () => {
    expect(stall(record(), now, kind)).toBeUndefined();
    const live = record({ status: "running", lease: { owner: "x", expiresAt: "2026-03-02T00:00:00.000Z" } });
    expect(stall(live, now, kind)).toBeUndefined();
    const dead = record({ status: "running", lease: { owner: "x", expiresAt: "2026-03-01T00:00:00.000Z" } });
    expect(stall(dead, now, kind)?.status).toBe("queued");
    expect(stall(dead, now, undefined)?.status).toBe("interrupted");
    expect(stall({ ...dead, control: "cancel" }, now, kind)?.status).toBe("cancelled");
    expect(stall({ ...dead, control: "pause" }, now, kind)?.status).toBe("paused");
  });

  it("refuses commands on finished jobs and repeated requests", () => {
    const running = record({ status: "running" });
    expect(requestPause({ ...running, control: "cancel" }, kind, now)).toEqual({ problem: "not-allowed" });
    expect(requestCancel({ ...running, control: "cancel" }, kind, now)).toEqual({ problem: "not-allowed" });
    expect(requestCancel({ ...running, control: "pause" }, kind, now)).toMatchObject({ next: { control: "cancel" } });
    expect(requestResume(running, kind, now)).toEqual({ problem: "not-allowed" });
    expect(requestPause(record({ status: "done" }), kind, now)).toEqual({ problem: "not-allowed" });
    expect(requestResume(record({ status: "interrupted" }), kind, now)).toMatchObject({ next: { status: "queued", maxAttempts: 1 } });
  });
});
