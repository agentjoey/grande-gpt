import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Node production TypeScript compatibility", () => {
  it("Node 24 默认 strip-only 模式可以直接导入生产 GitHub API 模块", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "--eval",
        "await import('./src/githubApi.ts')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });
});
