import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // node:sqlite 是 experimental，会打一条警告。精确屏蔽这一条，
    // 而不是全局关警告——其它警告仍应可见。
    env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  },
});
