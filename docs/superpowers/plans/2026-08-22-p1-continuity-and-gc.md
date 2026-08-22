# P1 Continuity and GC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close GG-BL-014 and GG-BL-005 without adding a daemon, workflow engine, second lifecycle state machine, or unsafe cleanup path.

**Architecture:** Extend the existing read-only `taskProgress` projection with derived liveness based only on persisted task/job/write-audit timestamps, and mark a task stalled only when it is READY, unblocked, has no non-terminal job, is not already complete/cleanup-pending, and exceeds a bounded inactivity window. Extend existing `worktreeGc` with a third reconciliation class for `CLOSED` rows whose expected task worktree still exists; cleanup remains explicit through `gc --apply`, repo-locked in Gateway mode, and idempotent.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, existing GrandeGPT task/job/audit/worktree/GC primitives.

**Spec:** `docs/BACKLOG.md` — GG-BL-014 and GG-BL-005.

## Global Constraints

- Keep `CREATING / READY / RUNNING / CLOSED`; do not add lifecycle states.
- Do not add a daemon, generic auto-executor, queue, new MCP tool, or Gateway bypass.
- Liveness is a read-only projection; no read call may write a heartbeat.
- Only successful write audits, task state timestamps, and job start/end timestamps count as meaningful progress.
- A non-terminal job prevents `stalled` regardless of age.
- GC default remains dry-run; destructive cleanup only occurs under the existing apply path.
- Active tasks must never be removed by the new CLOSED-residual reconciliation.

---

### Task 1: GG-BL-014 task liveness projection

**Files:**
- Modify: `src/taskProgress.ts`
- Modify: `src/localLoopTools.ts` only if the existing status hint does not surface stalled state clearly enough
- Test: `tests/taskProgress.test.ts`

**Interfaces:**
- Consumes: `TaskRow.updatedAt`, `listJobs(db, taskId)`, `listAudit(db, taskId)`, existing `TaskProgress.phase/blocker/nextAction`.
- Produces: `TaskProgress.liveness` with `state`, `progressAt`, `inactiveForMs`, `stallAfterMs`, `phase`, and `nextAction`; stalled projection preserves the existing workflow `nextAction` as the unique resume action.

- [ ] **Step 1: Write failing behavior tests**

Add deterministic tests using an injected `now` and threshold:

```ts
expect(progress.liveness).toMatchObject({
  state: "stalled",
  progressAt: 1_000,
  phase: "tests",
  nextAction: progress.nextAction,
});
expect(progress.blocker).toBeNull();
```

Also prove a running job is not stalled, and a recent successful write audit advances `progressAt` without any new persistence layer.

- [ ] **Step 2: Run targeted test and verify RED**

Run `pnpm vitest run tests/taskProgress.test.ts` and confirm failure is due to missing `liveness` semantics.

- [ ] **Step 3: Implement minimal derived liveness**

Add `now?: () => number` and `stallAfterMs?: number` test seams to `TaskProgressOptions`. Compute the latest meaningful progress timestamp as the maximum of task `updatedAt`, job `startedAt`/terminal `endedAt`, and `updatedAt` for successful task write audits. Mark `stalled` only for `task.state === "READY"`, no blocker, no non-terminal job, not completed, not cleanup-required, and inactivity at/above the threshold. Do not rewrite `blocker`; expose the existing `nextAction` as the resume action.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run `pnpm vitest run tests/taskProgress.test.ts`.

- [ ] **Step 5: Run status wiring regressions**

Run `pnpm vitest run tests/taskProgressWiring.test.ts tests/d3StatusSemantics.test.ts` and confirm response-only fields do not change the public input schema/tool count.

---

### Task 2: GG-BL-005 CLOSED residual worktree reconciliation

**Files:**
- Modify: `src/worktreeGc.ts`
- Modify: `src/cli.ts`
- Test: `tests/worktreeGc.test.ts`

**Interfaces:**
- Consumes: persisted CLOSED task rows, expected managed path `join(layout.worktreesRoot, repoId, taskId)`, existing `removeWorktree`, `safeGit`, and repo write lock.
- Produces: `GcPlan.closedResidualWorktrees` and `applyGc(...).reconciledClosedResiduals`, with explicit CLI dry-run/apply reporting.

- [ ] **Step 1: Write failing CLOSED-residual tests**

Create a real managed worktree + task row, set that row to CLOSED while leaving the worktree registered/on disk, then assert:

```ts
const plan = planGc(db, layout);
expect(plan.closedResidualWorktrees).toHaveLength(1);
expect(plan.orphanWorktrees).toEqual([]);
expect(plan.ghostTasks).toEqual([]);
```

After `applyGc`, assert the directory and git worktree registration are gone, the row remains CLOSED, the second plan is empty, and a READY task with an existing worktree is never included.

- [ ] **Step 2: Run targeted test and verify RED**

Run `pnpm vitest run tests/worktreeGc.test.ts` and confirm the new third reconciliation class is absent.

- [ ] **Step 3: Implement minimal third reconciliation class**

Query only CLOSED task rows. Include a row only when its worktree exists and its stored path exactly matches the expected managed task path. On apply, reuse `removeWorktree`; if worktree removal succeeds but branch deletion reports failure, count cleanup as successful only when the directory is actually gone, matching existing orphan accounting. Include the new repo IDs in `applyGcWithRepoWriteLocks`.

- [ ] **Step 4: Update CLI reporting**

Add a distinct `CLOSED task 残留 worktree` section to dry-run and apply summaries. Keep `--apply` as the only destructive switch and preserve existing orphan/ghost semantics.

- [ ] **Step 5: Run targeted tests and verify GREEN**

Run `pnpm vitest run tests/worktreeGc.test.ts`.

---

### Task 3: Closeout and backlog evidence

**Files:**
- Modify after verification: `docs/BACKLOG.md`

- [ ] **Step 1: Run full code gate**

Run `pnpm test` (unit-selfhost profile) and `pnpm typecheck` through GrandeGPT's controlled runner.

- [ ] **Step 2: Review diff for scope and safety**

Confirm no new tool, lifecycle state, daemon, queue, broad delete primitive, or changed annotation was introduced.

- [ ] **Step 3: Update backlog only with verified evidence**

Move GG-BL-014 and GG-BL-005 to Archive as DONE only if their `Done when` clauses are met by the new behavioral tests and full code gate; otherwise leave the item active with precise remaining evidence.
