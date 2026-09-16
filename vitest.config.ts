import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/host/**/*.host.test.ts"],
    env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  },
});
