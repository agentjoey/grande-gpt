# npm Compatibility Defect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:systematic-debugging. Execute in this isolated GrandeGPT task worktree.

**Goal:** 修复 GG-BL-026 与 GG-BL-027，同时保持 attestation 向后兼容和 Seatbelt least-privilege。

**Architecture:** 新增一个窄的 verification package-manager identity helper，让 attestation 与 trusted verifier 共用同一解析/哈希逻辑；sandbox 在运行前仅为 npm `.bin` symlink 的 in-`node_modules` 精确真实 target 生成 literal exec allow。既不改 public MCP contract，也不引入通用 package-manager framework。

**Tech Stack:** TypeScript, Vitest, Node 24, macOS Seatbelt `sandbox-exec`.

**Spec:** `docs/superpowers/specs/2026-08-24-npm-compatibility-defect-fixes-design.md`

## Global Constraints

- RED test 必须先失败且失败原因与缺陷一致。
- 不允许整个 worktree `process-exec`。
- 不允许整个 `node_modules` `process-exec`。
- npm `.bin` symlink target 只有在当前 worktree `node_modules` 内才可生成 exact allow。
- 新 identity 支持 npm/pnpm；yarn/bun/冲突状态 fail closed。
- legacy `{node,pnpm,lockfileSha256}` receipt/attestation 可继续读取。
- public tools/list identity 不变化。

---

### Task 1: Verification package-manager identity

**Files:**
- Create: `src/packageManagerIdentity.ts`
- Modify: `src/attestation.ts`
- Modify: `src/hostVerifierRuntime.ts`
- Modify: `src/outerTestReceipt.ts`
- Test: `tests/attestation.test.ts`
- Test: `tests/outerTestReceiptV2.test.ts`

**Interfaces:**
- Produce `capturePackageManagerIdentity(repoRoot)` returning modern npm/pnpm identity.
- Produce parser/normalizer accepting modern identity or legacy pnpm identity.

- [ ] Add npm/pnpm/conflict RED behavior tests.
- [ ] Run focused tests and verify expected RED.
- [ ] Implement minimal package-manager detection + lockfile/version capture.
- [ ] Wire attestation and trusted Host Verifier to shared helper.
- [ ] Make receipt validation accept modern shape plus legacy pnpm shape.
- [ ] Run focused tests to GREEN.

### Task 2: npm `.bin` symlink exact-target sandbox execution

**Files:**
- Modify: `src/sbpl.ts`
- Modify: `src/sandbox.ts`
- Test: `tests/sandbox.test.ts`
- Test: `tests/sbpl.test.ts`

**Interfaces:**
- Extend `SandboxPaths` with an optional exact worktree executable target list generated only by `runSandboxed()`.
- `buildProfile()` emits literal `process-exec` allows for those exact targets in addition to existing `.bin` subpath allow.

- [ ] Build a local npm-style `.bin` symlink fixture and add RED behavior test proving current `Operation not permitted` failure.
- [ ] Add negative target-outside-`node_modules` and ordinary-worktree-executable tests.
- [ ] Run focused sandbox tests and verify RED/negative baseline.
- [ ] Implement symlink enumeration, containment validation, and exact-target literal allow.
- [ ] Run focused sandbox/SBPL tests to GREEN.
- [ ] Perform load-bearing reverse proof: remove/disable exact-target allow and confirm npm test turns RED while negative tests stay GREEN; restore implementation.

### Task 3: Backlog and full L3 verification

**Files:**
- Modify: `docs/BACKLOG.md`

- [ ] Add GG-BL-026 and GG-BL-027 with evidence, priority, fix scope and Done when.
- [ ] Run `unit-selfhost` fresh.
- [ ] Run `typecheck` fresh.
- [ ] Review final diff against spec; no tool-contract change.
- [ ] Commit exact candidate, push/open ready PR, satisfy independent CI and Host gate, then merge using expected SHA.
