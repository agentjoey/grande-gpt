import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRepo } from "../src/fixtures.ts";
import { getJobStatus, JOB_DURATION_MS, lastJobStateForTask, resetJobs, startJob } from "../src/jobs.ts";

describe("job 状态机", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJobs();
    getRepo("demo-app")!.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startJob 立即返回 jobId", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    expect(jobId).toMatch(/^job_/);
  });

  it("未到时长时状态为 running", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS - 1000);
    expect(getJobStatus(jobId)!.state).toBe("running");
  });

  it("running 时 exitCode 为 null", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    expect(getJobStatus(jobId)!.exitCode).toBeNull();
  });

  it("未修复时到时长后为 failed 并给出失败用例名", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.state).toBe("failed");
    expect(s.exitCode).toBe(1);
    expect(s.failedTests).toEqual(["parser > handles empty input"]);
    expect(s.tail.join("\n")).toContain("handles empty input");
  });

  it("已修复时到时长后为 passed", () => {
    getRepo("demo-app")!.writeFile(
      "src/parser.ts",
      "export function parse(input: string) {\n  if (input.length === 0) return [];\n  return input.split(',');\n}\n",
    );
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.state).toBe("passed");
    expect(s.exitCode).toBe(0);
    expect(s.failedTests).toEqual([]);
  });

  it("结果在 job 启动时刻定格，之后改文件不影响已启动的 job", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    getRepo("demo-app")!.writeFile("src/parser.ts", "if (input.length === 0) return [];");
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    expect(getJobStatus(jobId)!.state).toBe("failed");
  });

  it("未知 jobId 返回 undefined", () => {
    expect(getJobStatus("job_nope")).toBeUndefined();
  });

  it("lastJobStateForTask 返回该 task 最近一个 job 的状态", () => {
    expect(lastJobStateForTask("task_1")).toBeNull();
    startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    expect(lastJobStateForTask("task_1")).toBe("running");
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    expect(lastJobStateForTask("task_1")).toBe("failed");
  });

  it("artifactId 稳定且与 jobId 关联", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    const a = getJobStatus(jobId)!.artifactId;
    expect(a).toBe(getJobStatus(jobId)!.artifactId);
    expect(a).toContain(jobId.replace("job_", ""));
  });
});

describe("profile 决定输出（第一轮实测发现：lint/typecheck 曾都返回 vitest 输出）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJobs();
    getRepo("demo-app")!.reset();
  });
  afterEach(() => vi.useRealTimers());

  it("lint 返回 eslint 输出，不是 vitest", () => {
    const { jobId } = startJob({ taskId: "t", repoId: "demo-app", profile: "lint" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.tail.join("\n")).toContain("eslint");
    expect(s.tail.join("\n")).not.toContain("vitest");
  });

  it("typecheck 返回 tsc 输出，不是 vitest", () => {
    const { jobId } = startJob({ taskId: "t", repoId: "demo-app", profile: "typecheck" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.tail.join("\n")).toContain("tsc --noEmit");
    expect(s.tail.join("\n")).not.toContain("vitest");
  });

  it("lint/typecheck 不受 parser 缺陷影响，未修复时也通过", () => {
    expect(getRepo("demo-app")!.isFixed()).toBe(false);
    for (const profile of ["lint", "typecheck"]) {
      const { jobId } = startJob({ taskId: "t", repoId: "demo-app", profile });
      vi.advanceTimersByTime(JOB_DURATION_MS + 1);
      expect(getJobStatus(jobId)!.state, profile).toBe("passed");
    }
  });

  it("unit 仍与 parser 缺陷绑定：未修复时失败", () => {
    const { jobId } = startJob({ taskId: "t", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.state).toBe("failed");
    expect(s.tail.join("\n")).toContain("vitest");
  });
});
