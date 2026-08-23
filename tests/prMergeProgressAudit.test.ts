import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function hostVerificationDispatchBlock(): string {
  const source = readFileSync(join(process.cwd(), "src", "prLifecycle.ts"), "utf8");
  const start = source.indexOf("const verificationAudit = beginAudit");
  const end = source.indexOf("audit = beginAudit", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("PR merge progress audit semantics", () => {
  it("host verifier dispatch uses a distinct audit tool and cannot masquerade as a completed merge", () => {
    const block = hostVerificationDispatchBlock();
    expect(block).toContain('tool: "grande_pr_merge_host_verification"');
    expect(block).not.toContain('tool: "grande_pr_merge",');
  });
});
