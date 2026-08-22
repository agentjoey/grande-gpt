import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Host-only adapters are executed through the trusted host manifest, never by the
    // default/selfhost suite. The existing trusted unit-selfhost profile still excludes
    // the five legacy anchor files during the manual-mode transition.
    exclude: ["tests/host/**/*.host.test.ts"],
    // node:sqlite 是 experimental，会打一条警告。精确屏蔽这一条，
    // 而不是全局关警告——其它警告仍应可见。
    env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  },
});
