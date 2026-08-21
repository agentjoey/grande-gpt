import { defineConfig } from "vitest/config";

// Transitional manual host-suite config. Automated verification does not trust this
// candidate-owned file; Slice C builds its plan from the running Gateway manifest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/host/**/*.host.test.ts"],
    env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  },
});
