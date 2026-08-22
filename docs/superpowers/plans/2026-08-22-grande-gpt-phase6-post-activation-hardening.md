# GrandeGPT Phase 6 Post-Activation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the already-activated Automated Host Verifier with trusted operational visibility, explicit bounded failure escalation, residue cleanup, and a closeout that preserves the ChatGPT binding boundary.

**Architecture:** Keep the current single Gateway/SQLite/job/Receipt V2 model. Add a pure operational projector over existing trusted state, extend verifier failure summaries/inspection with candidate/infrastructure/integrity classification, and wire both into existing task status/merge-gate paths without adding a new tool, table, worker, or execution capability. Operational cleanup uses existing task/worktree lifecycle only.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, existing GrandeGPT sandbox/job/receipt/PR lifecycle.

**Spec:** `docs/superpowers/specs/2026-08-22-grande-gpt-phase6-post-activation-hardening-design.md`

## Global Constraints

- No generic `host_exec`, `shell_exec`, arbitrary host argv/cwd/env, or generic unsandboxed profile.
- No workflow engine, multi-agent orchestration, metrics/observability platform, new CI/CD platform, or second connector bypass.
- Do not weaken `readOnlyHint`, `destructiveHint`, Gateway policy, exact-SHA gates, Receipt V2 binding, or tool annotations.
- `hostVerification.grande-gpt.mode` remains trusted control-plane configuration; candidate repo content cannot activate it.
- Same Gateway concurrency remains exactly one verifier; no new queue is introduced.
- Existing bounded policy remains one infrastructure retry for the same exact SHA, then Human escalation.
- Candidate and integrity failures receive zero automatic retry.
- Each behavior-changing task ends with `unit-selfhost` and `typecheck` green before proceeding.

---

### Task 1: S19 trusted operational status

**Files:**
- Create: `src/hostVerifierStatus.ts`
- Create: `tests/hostVerifierStatus.test.ts`
- Modify: `src/localLoopTools.ts`
- Modify: `tests/taskProgressWiring.test.ts` or the nearest existing task-status wiring test

**Interfaces:**
- Consumes: `listJobs(db)`, `HostVerificationMode`, current Gateway build identity, `HOST_VERIFIER_POLICY_VERSION`.
- Produces: `projectHostVerifierOperationalStatus(db, { mode, verifierBuild, currentSha? }): HostVerifierOperationalStatus`.

- [ ] **Step 1: Write failing status projection tests**

Cover PASS, candidate failure, running job, blocked state, and old-SHA history. The target shape is:

```ts
expect(projectHostVerifierOperationalStatus(db, {
  mode: "auto",
  verifierBuild: "git:" + "a".repeat(40),
  currentSha: sha,
})).toMatchObject({
  mode: "auto",
  enabled: true,
  state: "idle",
  lastAttemptSha: sha,
  lastResult: "passed",
  lastSuccessSha: sha,
  activeJobId: null,
  queueDepth: 0,
});
```

For an old successful SHA with a different `currentSha`, assert the historical `lastAttemptSha` remains explicit and the current-SHA result is `null`, never `passed`.

- [ ] **Step 2: Run the targeted test and require RED for missing projector/status fields**

Run through the repository unit profile after adding the test file. Expected RED: unresolved `hostVerifierStatus` module or missing `hostVerifier` response field, not an unrelated fixture failure.

- [ ] **Step 3: Implement the pure projector**

Use only `job.profile === "host-verifier"`, trusted summary fields, persisted timestamps, and terminal state. Do not read artifacts to derive the state. Derive duration from `endedAt - startedAt`. Report current runtime build/version separately from historical job identity. `queueDepth` is a literal `0` because the coordinator has no queue.

- [ ] **Step 4: Wire the snapshot into existing `grande_task_status`**

Add `data.hostVerifier` on overview and task detail responses in the existing status wrapper. On task detail, pass `progress.taskHead` as `currentSha` when available. Response-only fields must not alter tool input schema or annotations.

- [ ] **Step 5: Run full S19 gates**

Run `unit-selfhost`, then `typecheck`. Both must pass before S20.

---

### Task 2: S20 explicit failure classes and zero-retry integrity escalation

**Files:**
- Modify: `src/hostVerification.ts` for the shared failure-class type if that remains the smallest non-cyclic boundary
- Modify: `src/hostVerifierRuntime.ts`
- Modify: `src/hostVerifierRecovery.ts`
- Modify: `src/prHostVerification.ts`
- Modify: `src/taskProgress.ts`
- Modify: `src/prLifecycle.ts`
- Modify: `src/hostVerifierStatus.ts`
- Modify: `tests/prLifecycleHostVerifier.test.ts`
- Modify/Create: focused verifier-runtime / receipt-binding tests as dictated by existing test organization

**Interfaces:**
- Produces: `HostVerifierFailureClass = "candidate" | "infrastructure" | "integrity"` and a stable `reason` string on trusted failure projections.
- Extends: `HostVerifierAttempt` with explicit failure class/reason while retaining bounded artifacts.
- Extends: host-verification progress with an integrity-failure state that always maps to a Human blocker.

- [ ] **Step 1: Write the five load-bearing RED tests**

Prove:

```text
candidate RED -> coordinator.start count stays 0 -> merge blocked
first infra RED -> exactly one retry dispatch -> retry PASS can later satisfy receipt
second consecutive infra RED -> coordinator.start count stays 0 -> Human escalation
integrity RED -> coordinator.start count stays 0 -> fail-closed Human escalation
new exact SHA -> old candidate/infra/integrity attempt is not reused
```

At least one integrity test must use a trusted binding condition such as receipt/result identity mismatch or verifier SHA drift rather than only a mocked label.

- [ ] **Step 2: Run targeted tests and inspect RED reason**

Expected RED is the absence of explicit integrity classification/escalation or missing failure metadata. If a test instead exposes an actual merge-ready integrity bypass, classify that as a new safety P0 and stop under the Owner rule.

- [ ] **Step 3: Standardize runtime summaries**

For executed verifier test RED, write `failureClass: "candidate", reason: "test_failed"`. For restart/process/runner/resource failures, write `failureClass: "infrastructure"` with bounded reason names. For trusted SHA/result/binding mismatch, write or project `failureClass: "integrity"` and never sign a receipt.

- [ ] **Step 4: Extend inspection without weakening exact-SHA semantics**

`latestMatchingAttempt` must continue filtering by the current exact SHA. Parse current explicit failure metadata and legacy summaries safely. Current-SHA trusted receipt/result binding mismatch becomes an integrity attempt; a receipt from an older SHA is merely stale history and does not escalate the new SHA.

- [ ] **Step 5: Enforce merge/status escalation**

Candidate -> no retry, code-fix next action. Infrastructure failure count 1 -> retain the existing single bounded re-dispatch. Count >=2 -> Human. Integrity -> zero retry immediately, fail closed, bounded diagnostic reason, Human escalation. No failure path may set receipt eligibility or merge readiness.

- [ ] **Step 6: Run full S20 gates**

Run `unit-selfhost`, then `typecheck`. Both must pass before residue cleanup.

---

### Task 3: S21 activation residue reconciliation and cleanup

**Files:**
- Read/operate through existing task/worktree lifecycle; do not add a cleanup subsystem.
- Modify: `docs/research/2026-08-22-phase6-post-activation-hardening-closeout.md` later with evidence.
- Modify `docs/BACKLOG.md` only if `GG-BL-005` receives new systemic evidence.

**Interfaces:**
- Consumes existing `grande_task_status`, `grande_task_close`, current active-task inventory, and known Phase 5.5 / Reliability task IDs.
- Produces no new runtime API.

- [ ] **Step 1: Reconcile known completed tasks**

Inspect Phase 5.5 implementation/closeout and Reliability/Verifier task IDs plus current active-task overview. Distinguish `CLOSED + worktree missing` (clean) from a real residual. Do not infer filesystem state from chat history.

- [ ] **Step 2: Remove only safely identifiable residue**

If a completed activation/migration task is still safely closeable through the existing lifecycle, close it. Do not delete trusted receipts, audits, current production config, active tasks, or formal closeout documents.

- [ ] **Step 3: Repeat the reconciliation**

The second pass must make no additional destructive change. If `CLOSED + residual worktree` is observed and existing lifecycle cannot safely reconcile it, append evidence to `GG-BL-005`; do not build GC in this phase.

- [ ] **Step 4: Run regression gates**

Run existing cleanup/task-close tests through `unit-selfhost`, then `typecheck`.

---

### Task 4: S22 closeout, exact-SHA host proof, PR and merge

**Files:**
- Modify: `docs/BACKLOG.md`
- Create: `docs/research/2026-08-22-phase6-post-activation-hardening-closeout.md`

**Interfaces:**
- Consumes final S19/S20/S21 evidence and the existing automatic exact-SHA merge gate.
- Produces Phase 6 closeout and archived `GG-BL-015` / `GG-BL-016` only after their Done criteria are met.

- [ ] **Step 1: Write closeout with the two-plane reliability boundary**

The document must state that the verification execution plane is automated while ChatGPT conversation/App binding remains `GG-BL-010`. It must not call a successful verifier run proof that GG-BL-010 is fixed.

- [ ] **Step 2: Reconcile backlog final state**

Keep `GG-BL-001/002/003/004/013` archived. Mark Host Verifier activation COMPLETE as the Phase 6 baseline. Move 015/016 to Archive only if tests and exact-SHA host proof satisfy their Done criteria. Keep 010 MITIGATED/OPEN/BLOCKED according to its own evidence, never force DONE.

- [ ] **Step 3: Run final unit gates**

Run fresh `unit-selfhost` and `typecheck` on the final worktree HEAD.

- [ ] **Step 4: Commit, push, and open/update PR**

Use GrandeGPT controlled commit/push/PR tools. The final candidate SHA must have current attestation and no uncommitted changes.

- [ ] **Step 5: Exercise the production automatic host gate**

Invoke `grande_pr_merge`. Expected first missing-receipt behavior in activated auto mode is `verification.state=running` with a verifier `jobId`, not `manual_required`. Observe the job through existing status/result surfaces. A `manual_required` response is a material contradiction with the Phase 6 activation baseline and triggers the Owner stop condition.

- [ ] **Step 6: Prove exact-SHA PASS and merge**

After the verifier reaches PASS and Receipt V2 binds the current PR head, call `grande_pr_merge` again so PR/CI/mergeability/SHA are re-read. Require merge success; never background-merge based on stale state.

- [ ] **Step 7: Verify post-merge reconciliation and close task**

Confirm canonical/local reconciliation, cleanup state, and preserved evidence. Close the task through the existing lifecycle when safe.

## Self-review

- Spec coverage: S19 fields, S20 three-class retry/escalation, S21 narrow cleanup, S22 two-plane boundary, exact-SHA automatic gate, and all non-goals are mapped to tasks above.
- Placeholder scan: no TBD/TODO/implement-later placeholders; every behavior change names a testable result and implementation boundary.
- Type consistency: one shared `HostVerifierFailureClass`; operational state is only `idle | running | blocked`; task exact-SHA filtering remains in `inspectCurrentHostVerification` and is not replaced by the global snapshot.
- Execution choice: Human Owner explicitly requested one implementation agent to continue autonomously, so this plan will be executed inline with `superpowers:executing-plans`; no additional execution-choice prompt is required.
