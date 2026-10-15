// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useJob, useJobLive, useJobs } from "../src/react/index.js";
import { runUntilIdle } from "../src/testing/index.js";
import { countKind, sleep } from "./helpers/kinds.js";
import { enqueued, setup } from "./helpers/runtime.js";

describe("React hooks", () => {
  it("useJobs, useJob and useJobLive follow the runtime", async () => {
    const { runtime: probe, clock } = setup();
    void probe;
    const kind = countKind({
      onStep: async (state, ctx) => {
        ctx.live({ at: state.i });
        await sleep(clock, 100, ctx.signal);
      },
    });
    const { runtime } = setup({ kinds: [kind], clock });
    const jobs = renderHook(() => useJobs(runtime));
    let id = "";
    const one = renderHook(({ jobId }) => useJob(runtime, jobId), { initialProps: { jobId: "none" } });
    const live = renderHook(({ jobId }) => useJobLive(runtime, jobId), { initialProps: { jobId: "none" } });

    await act(async () => {
      await runUntilIdle(runtime);
    });
    expect(jobs.result.current).toEqual([]);
    expect(one.result.current).toBeUndefined();

    await act(async () => {
      id = await enqueued(runtime, "test.count", { steps: 2 });
      await runUntilIdle(runtime);
    });
    one.rerender({ jobId: id });
    live.rerender({ jobId: id });
    expect(jobs.result.current).toHaveLength(1);
    expect(one.result.current).toMatchObject({ id, status: "running" });
    expect(live.result.current).toEqual({ at: 0 });

    await act(async () => {
      await clock.advance(100);
      await clock.advance(100);
    });
    expect(one.result.current).toMatchObject({ status: "done" });
    expect(live.result.current).toBeUndefined();
    jobs.unmount();
    one.unmount();
    live.unmount();
  });

  it("useJobs is undefined until the first read lands", () => {
    const { runtime } = setup();
    void runtime.stop();
    const fresh = setup().runtime;
    const { result } = renderHook(() => useJobs(fresh));
    expect(result.current).toBeUndefined();
  });
});
