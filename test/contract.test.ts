import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as main from "../src/index.js";
import * as browser from "../src/browser/index.js";
import * as react from "../src/react/index.js";
import * as testing from "../src/testing/index.js";
import type * as Lib from "../src/index.js";
import type * as Spec from "./contract/spec.js";

/** Every export name (values and types) of an entry point, as the compiler sees it. */
function exportsOf(entry: string): string[] {
  const file = new URL(`../src/${entry}`, import.meta.url).pathname;
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
  return checker.getExportsOfModule(module).map((symbol) => symbol.name).sort();
}

describe("the public surface is exactly the v0.1 contract", () => {
  it("pins every export of every entry point", () => {
    expect(exportsOf("index.ts")).toEqual(
      [
        "ArtifactWriter", "ControlProblem", "EnqueueProblem", "EntityRef", "EventBus", "JobAttempt", "JobError",
        "JobEvent", "JobKind", "JobOutput", "JobPhase", "JobProgress", "JobRecord", "JobRuntime", "JobStatus",
        "JobStore", "LeaderLock", "OutputPlan", "RetryPolicy", "StepContext", "StepResult", "createJobRuntime",
      ].sort(),
    );
    expect(exportsOf("browser/index.ts")).toEqual(["broadcastBus", "indexedDbJobStore", "webLocksLeader"]);
    expect(exportsOf("react/index.ts")).toEqual(["useJob", "useJobLive", "useJobs"]);
    expect(exportsOf("testing/index.ts")).toEqual(["jobStoreConformance", "manualClock", "memoryJobStore", "memoryLock", "runUntilIdle"]);
  }, 60_000);

  it("exports exactly those values at runtime", () => {
    expect(Object.keys(main).sort()).toEqual(["createJobRuntime"]);
    expect(Object.keys(browser).sort()).toEqual(["broadcastBus", "indexedDbJobStore", "webLocksLeader"]);
    expect(Object.keys(react).sort()).toEqual(["useJob", "useJobLive", "useJobs"]);
    expect(Object.keys(testing).sort()).toEqual(["jobStoreConformance", "manualClock", "memoryJobStore", "memoryLock", "runUntilIdle"]);
  });

  it("matches the specification's types exactly", () => {
    type I = { input: true };
    type S = { state: true };
    type P = { key: string; extra: number };
    expectTypeOf<Lib.EntityRef>().toEqualTypeOf<Spec.EntityRef>();
    expectTypeOf<Lib.JobStatus>().toEqualTypeOf<Spec.JobStatus>();
    expectTypeOf<Lib.JobPhase>().toEqualTypeOf<Spec.JobPhase>();
    expectTypeOf<Lib.JobError>().toEqualTypeOf<Spec.JobError>();
    expectTypeOf<Lib.JobProgress>().toEqualTypeOf<Spec.JobProgress>();
    expectTypeOf<Lib.JobOutput>().toEqualTypeOf<Spec.JobOutput>();
    expectTypeOf<Lib.OutputPlan>().toEqualTypeOf<Spec.OutputPlan>();
    expectTypeOf<Lib.JobAttempt>().toEqualTypeOf<Spec.JobAttempt>();
    expectTypeOf<Lib.JobEvent>().toEqualTypeOf<Spec.JobEvent>();
    expectTypeOf<Lib.JobRecord>().toEqualTypeOf<Spec.JobRecord>();
    expectTypeOf<Lib.JobRecord<I, S>>().toEqualTypeOf<Spec.JobRecord<I, S>>();
    expectTypeOf<Lib.StepContext>().toEqualTypeOf<Spec.StepContext>();
    expectTypeOf<Lib.ArtifactWriter>().toEqualTypeOf<Spec.ArtifactWriter>();
    expectTypeOf<Lib.StepResult<S>>().toEqualTypeOf<Spec.StepResult<S>>();
    expectTypeOf<Lib.RetryPolicy>().toEqualTypeOf<Spec.RetryPolicy>();
    expectTypeOf<Lib.JobKind<I, S>>().toEqualTypeOf<Spec.JobKind<I, S>>();
    expectTypeOf<Lib.JobKind<I, S, P>>().toEqualTypeOf<Spec.JobKind<I, S, P>>();
    expectTypeOf<Lib.JobStore>().toEqualTypeOf<Spec.JobStore>();
    expectTypeOf<Lib.LeaderLock>().toEqualTypeOf<Spec.LeaderLock>();
    expectTypeOf<Lib.EventBus>().toEqualTypeOf<Spec.EventBus>();
    expectTypeOf<Lib.EnqueueProblem>().toEqualTypeOf<Spec.EnqueueProblem>();
    expectTypeOf<Lib.ControlProblem>().toEqualTypeOf<Spec.ControlProblem>();
    expectTypeOf<Lib.JobRuntime>().toEqualTypeOf<Spec.JobRuntime>();
    expectTypeOf(main.createJobRuntime).toEqualTypeOf<typeof Spec.createJobRuntime>();
  });

  it("types the subpaths as the contract describes them", () => {
    expectTypeOf(browser.indexedDbJobStore).toEqualTypeOf<(options: { name: string }) => Lib.JobStore>();
    expectTypeOf(browser.webLocksLeader).toEqualTypeOf<() => Lib.LeaderLock>();
    expectTypeOf(browser.broadcastBus).toEqualTypeOf<(options: { name: string }) => Lib.EventBus>();
    expectTypeOf(react.useJobs).toEqualTypeOf<(runtime: Lib.JobRuntime) => readonly Lib.JobRecord[] | undefined>();
    expectTypeOf(react.useJob).toEqualTypeOf<(runtime: Lib.JobRuntime, id: string) => Lib.JobRecord | undefined>();
    expectTypeOf(react.useJobLive).toEqualTypeOf<(runtime: Lib.JobRuntime, id: string) => unknown>();
    expectTypeOf(testing.memoryJobStore).toEqualTypeOf<() => Lib.JobStore>();
    expectTypeOf(testing.memoryLock).toEqualTypeOf<() => Lib.LeaderLock>();
    expectTypeOf(testing.runUntilIdle).toEqualTypeOf<(runtime: Lib.JobRuntime) => Promise<void>>();
    expectTypeOf(testing.jobStoreConformance).parameter(0).toEqualTypeOf<() => Lib.JobStore | Promise<Lib.JobStore>>();
    // manualClock() is a valid runtime clock.
    expectTypeOf(testing.manualClock()).toExtend<NonNullable<Parameters<typeof main.createJobRuntime>[0]["clock"]>>();
  });
});
