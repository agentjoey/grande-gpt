# Git and Tool-Call Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Git and MCP tool execution fail closed on ref drift and unsafe repository state while keeping errors useful and logs free of caller payloads.

**Architecture:** Add narrow guards at the boundaries that already own task/Git identity, and keep the MCP envelope behavior unchanged. Harden Git diff argv directly, sanitize operational logging at the server boundary, and repair tests whose expected paths bypass layout canonicalization.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Git CLI, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-08-21-git-tool-call-review.md`

**Execution status (2026-08-21):** Tasks 1–6 and the additional contract/annotation/worktree-hook findings discovered during the final audit were completed with RED-GREEN regression evidence. Final repository gates are recorded in the review handoff.

## Global Constraints

- Git stays argv-based through `execFileSync`; no shell interpolation.
- Every production fix follows RED-GREEN with a real Git repository or real built tool handler.
- No network call is required for targeted tests.
- No commit, push, deployment, or remote configuration change is part of this review handoff.

---

### Task 1: Canonical-path test contract

**Files:**
- Modify: `tests/outerTest.test.ts`

**Interfaces:**
- Consumes: `loadLayout(): Layout`, which canonicalizes workspace roots with `realpathSync`.
- Produces: a stable assertion for `resolveOuterTestCwd()` on macOS `/var` aliases.

- [ ] Run `pnpm vitest run tests/outerTest.test.ts` and confirm the raw `ws` expectation fails as `/var` versus `/private/var`.
- [ ] Change the expected canonical checkout to `join(layout.workspaceRoot, "grande-gpt")`.
- [ ] Re-run the targeted test and confirm all cases pass.

### Task 2: Tool error and logging boundaries

**Files:**
- Modify: `tests/tools.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `src/toolsCore.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `wrap()` error envelopes and `ToolDef.handler(args)`.
- Produces: `TASK_NOT_FOUND` envelopes independent of ghost tasks; safe `[tool]` log metadata containing tool name, optional taskId, and sorted argument keys only.

- [ ] Add a real ghost-task fixture, call a read tool with an unknown taskId, and assert `TASK_NOT_FOUND` rather than a rejected promise.
- [ ] Add an MCP `tools/call` request carrying a unique secret marker and assert no `[tool]` log line contains it.
- [ ] Run both targeted tests and confirm both new assertions fail for the expected reasons.
- [ ] Make active-task enrichment tolerate an unreadable worktree and summarize log arguments without values.
- [ ] Re-run both targeted files and confirm they pass.

### Task 3: Task-open side-effect ordering

**Files:**
- Modify: `tests/taskOpenRefresh.test.ts`
- Modify: `src/tools.ts`
- Modify: `src/toolsCore.ts`

**Interfaces:**
- Consumes: `getTask(db, taskId)` and the wrapped `grande_task_open` handler.
- Produces: duplicate task rejection before refresh, audit, Git branch, or worktree mutation.

- [ ] Add a closed existing task, remove its worktree/branch, call `grande_task_open` with the same id, and assert canonical HEAD, audit count, branch list, and worktree absence are unchanged.
- [ ] Run the targeted test and confirm current code performs a side effect or fails with an internal error.
- [ ] Add the duplicate-id preflight before refresh and retain the same guard in the core handler for direct composition safety.
- [ ] Re-run the targeted test and confirm it passes.

### Task 4: Task branch identity

**Files:**
- Modify: `tests/commit.test.ts`
- Modify: `tests/push.test.ts`
- Modify: `tests/prOpen.test.ts`
- Modify: `tests/syncBase.test.ts`
- Modify: `src/commit.ts`
- Modify: `src/push.ts`
- Modify: `src/prOpen.ts`
- Modify: `src/syncBase.ts`

**Interfaces:**
- Produces: `assertTaskBranch(worktreePath: string, expectedBranch: string): string`, returning HEAD only when `symbolic-ref --short HEAD` equals the database branch.
- Consumers: commit, push, PR remote-state inspection, and sync-base entry points.

- [ ] For each tool boundary, switch or detach the worktree and assert it fails before commit, network Git, API creation, or merge.
- [ ] Run targeted files and confirm the branch-drift cases fail on current code.
- [ ] Implement one shared branch guard and wire it before side effects; ensure push reports the verified task-branch HEAD.
- [ ] Re-run targeted files and confirm they pass.

### Task 5: Git execution hardening

**Files:**
- Modify: `tests/worktree.test.ts`
- Modify: `src/canonicalGit.ts`
- Modify: `src/worktree.ts`

**Interfaces:**
- Consumes: Git repository markers and `repoDiff()`.
- Produces: busy markers covering `REVERT_HEAD` and `sequencer`; diff argv including `--no-ext-diff` and `--no-textconv`.

- [ ] Add a revert-conflict repository and assert `openWorktree()` returns `CANONICAL_BUSY` without creating a branch/worktree.
- [ ] Configure an executable external diff marker, call `repoDiff()`, and assert the marker is never executed while ordinary hunks are returned.
- [ ] Run the targeted tests and confirm both protections fail on current code.
- [ ] Extend busy-marker detection and harden both tracked/untracked diff commands.
- [ ] Re-run targeted tests and confirm they pass.

### Task 6: Remote credential redaction and final gate

**Files:**
- Modify: `tests/prOpen.test.ts`
- Modify: `src/prOpen.ts`

**Interfaces:**
- Consumes: `parseGithubRemote(remote: string)`.
- Produces: validation errors that identify an invalid remote without reproducing username/password values.

- [ ] Add a remote URL containing unique username/password markers and assert neither appears in the error message.
- [ ] Run the targeted test and confirm current code leaks both markers.
- [ ] Redact URL userinfo before constructing validation errors.
- [ ] Run all targeted files, then `pnpm test` outside the nested sandbox and `pnpm typecheck`.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the complete final diff; report any residual risks separately.

### Additional findings from final audit

**Files:**
- Modify: `src/contract.ts`, `../grande-console/src/lib/contract.ts`
- Modify: `src/toolsCore.ts`, annotation contract tests
- Modify: `src/worktree.ts`, `tests/worktree.test.ts`

- [x] Make the audited write-tool contract exactly match runtime non-read-only tool definitions and synchronize its console copy.
- [x] Mark `grande_task_open` open-world because its wrapper can fetch `origin`.
- [x] Prove `git worktree add` executes a configured `post-checkout` hook, then disable hooks in the shared worktree Git helper.
