# GrandeGPT Phase 8 Flow Simplification Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with RED → GREEN → refactor. Phase 8 is L3 because it touches runner/merge/verification policy, so design evidence, exact-SHA gates, independent review, CI and host verification remain mandatory.

**Goal:** Complete GG-BL-020/021/022/023 while keeping the public 25-tool contract, `toolsetEpoch=2`, and current tools digest unchanged.

**Architecture:** Keep Task as the single lifecycle object. Add narrow server-side projection helpers for delivery target and development risk, reuse the existing bounded SQLite job wait for short runs, and change status/guidance so the agent follows the single `nextAction` without a new workflow engine. No tool names, input schemas, annotations, aliases, or public lifecycle states change in Phase 8.

**Tech Stack:** TypeScript, node:sqlite, Vitest, existing Safe Git / TaskProgress / Host Verification / MCP tool assembly.

**Specs:**
- `docs/superpowers/specs/2026-08-22-grande-gpt-capability-and-flow-simplification-proposal.md`
- `docs/superpowers/specs/2026-08-22-grande-gpt-lightweight-architecture-and-development-flow-optimization-design.md`
- `docs/BACKLOG.md` Phase 8 / GG-BL-020..023

## Global Constraints

- Public contract stays exactly 25 tools / `toolsetEpoch=2`; no tool add/remove/rename and no input-schema or annotation change.
- Do not add a workflow engine, second lifecycle state machine, background merge worker, or verifier merge authority.
- Exact PR head, CI, attestation, host receipt, Safe Git, repo lock, audit and production Human Gates remain unchanged.
- Unknown development risk defaults to L3/full rather than being downgraded by the agent.
- A short `grande_run` may wait only for a fixed bounded budget; long/recovery jobs still use `grande_run_result`.
- Phase 9 owns the future public TaskBrief `deliveryTarget` input/schema change. Phase 8 may only project target from existing trusted task evidence.

---

### Task 1: Formal L1/L2/L3 development risk classifier

**Files:**
- Create: `src/developmentRisk.ts`
- Modify: `src/hostVerification.ts`
- Modify: `src/localLoopTools.ts`
- Test: `tests/developmentRisk.test.ts`
- Test: `tests/hostVerification.test.ts`

**Interfaces:**
- Produce `type DevelopmentRiskLevel = "L1" | "L2" | "L3"`.
- Produce `classifyDevelopmentRisk(changedFiles: readonly string[]): DevelopmentRiskLevel`.
- Host verification maps L1 → none, L2 → smoke, L3 → full.
- `grande_task_status` response gains response-only `developmentRisk`; this is not an MCP input contract change.

- [ ] Write RED tests proving docs/assets are L1, ordinary source/tests are L2, security/runtime/unknown paths are L3, and an unknown path fails closed to L3.
- [ ] Run focused tests and confirm they fail because the classifier does not yet exist.
- [ ] Implement the minimal classifier and map `classifyHostVerification` through it without weakening manual-only rules.
- [ ] Run focused tests until green.
- [ ] Expose response-only risk in task detail status and add a regression that tools digest is unchanged.

### Task 2: Delivery-target projection without a tool epoch

**Files:**
- Create: `src/deliveryTarget.ts`
- Modify: `src/localLoopTools.ts`
- Modify: `src/cli.ts`
- Test: `tests/deliveryTarget.test.ts`
- Test: `tests/taskProgress.test.ts`

**Interfaces:**
- Produce `type DeliveryTarget = "local" | "pr" | "deploy"`.
- Produce `resolveDeliveryTarget(db, task, layout): DeliveryTarget` from existing evidence only:
  - any deployment receipt / successful deploy intent → `deploy`;
  - GitHub-origin or existing push/PR/merge evidence → `pr`;
  - otherwise → `local`.
- Produce `projectDeliveryTargetProgress(progress, target)` that masks irrelevant stages and recomputes `completed`, `cleanupRequired`, `phase`, `blocker`, `nextAction`, and liveness without creating a new lifecycle state.

- [ ] Write RED tests for local completion after tests/attestation with PR/CI/deploy all not-applicable.
- [ ] Write RED tests for PR completion after exact merge even when `.grande/deploy.yaml` exists.
- [ ] Write RED tests for deploy target continuing to require deploy + verify receipt.
- [ ] Implement deterministic target resolution and pure progress projection.
- [ ] Wire MCP task status and CLI status through the same projection.
- [ ] Verify status still returns one blocker and one nextAction.

### Task 3: `grande_run` bounded wait

**Files:**
- Modify: `src/toolsCore.ts`
- Modify: `src/localLoopTools.ts` only if verification-context recording needs response compatibility handling.
- Test: `tests/tools.test.ts`
- Test: `tests/jobWait.test.ts`

**Interfaces:**
- Add fixed internal `RUN_BOUNDED_WAIT_MS` below the existing 15s `grande_run_result` wait budget.
- On start, wait only up to that budget using existing `waitForTerminalJob`.
- If terminal inside the budget, `grande_run` returns the same jobId plus terminal report/summary in the first response.
- If still running, keep the existing jobId + pollAfterSeconds recovery contract.

- [ ] Replace the old “always immediate” expectation with two RED behaviors: short terminal job returns terminal result once; slow job returns running/jobId within the fixed budget.
- [ ] Verify RED against current immediate-return implementation.
- [ ] Implement bounded observation only; do not restart/kill/reparent jobs.
- [ ] Verify failed/timeout/RSS/artifact/network flags remain truthful and `grande_run_result` still works for recovery.

### Task 4: PR/verifier continuation semantics

**Files:**
- Modify: `src/taskProgress.ts` only if needed for nextAction ordering; otherwise keep server gate unchanged.
- Modify: `src/prLifecycle.ts` descriptions/hints only if necessary; no merge authority changes.
- Test: `tests/d3StatusSemantics.test.ts`
- Test: `tests/prLifecycle.test.ts` or existing merge-gate test file.

**Interfaces:**
- Normal flow may call `grande_pr_merge` directly after PR open; `grande_pr_status` is diagnostic, not mandatory ceremony.
- Running verifier nextAction is “re-enter merge gate after verifier terminal”, not a Human confirmation.
- Every re-entry still calls current `inspectLifecycle` and rechecks exact PR head, CI, attestation and host receipt.

- [ ] Add RED status assertions that unknown live CI does not force a preflight `pr_status`; nextAction prefers `grande_pr_merge` and lets the merge gate return a blocker.
- [ ] Add/retain regression proving second merge call after receipt rechecks current head/CI rather than trusting prior state.
- [ ] Make the smallest guidance/projection change needed; do not add polling workers or verifier-owned merge.
- [ ] Run focused PR lifecycle tests.

### Task 5: Phase 8 dogfood, contract freeze and closeout

**Files:**
- Modify: `docs/BACKLOG.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Create: `docs/research/2026-08-23-phase8-flow-simplification-closeout.md`

- [ ] Run `unit-selfhost` and `typecheck` on the exact candidate SHA after implementation.
- [ ] Assert toolsCount=25, toolsetEpoch=2 and digest remains `sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`.
- [ ] Dogfood Phase 8 on this task: use one-call short run where possible; push/open PR; call merge gate directly without preflight `pr_status`; if verifier is auto-safe, re-enter merge automatically after PASS.
- [ ] Because Phase 8 changes runner/verification policy, complete the required L3 independent review and host verification. Manual-only host boundaries remain a Human Gate if the classifier requires them.
- [ ] Only after all exact-SHA gates pass, mark GG-BL-020..023 DONE and close Phase 8; otherwise leave the precise blocker recorded without pretending completion.
