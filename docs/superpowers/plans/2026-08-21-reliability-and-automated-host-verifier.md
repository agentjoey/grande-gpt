# GrandeGPT Reliability and Automated Host Verifier Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task. Do not delegate to subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved lightweight runtime reliability and restricted automated host verifier design in four independently reviewable slices while preserving exact-SHA gates, fail-closed Git behavior, and manual host-verification mode until Owner activation.

**Architecture:** Keep the existing single Gateway/SQLite/worktree/job model. Slice A centralizes safe Git execution and adds only an in-process repo write mutex; Slice B separates host-only tests and proves the trusted verifier sandbox is feasible on the real host; Slice C adds the same-Gateway asynchronous verifier and Receipt V2; Slice D adds reconciliation, retry/cleanup/status semantics, and activation-ready evidence without changing production control configuration.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Git CLI, macOS `sandbox-exec`, SQLite, existing GrandeGPT job/audit/worktree primitives.

**Spec:** `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md` (approved baseline `eb497ae8be04b5e25e5420ee5133bfdce5459d4a`)

## Global Constraints

- Do not add `host_exec`, `shell_exec`, arbitrary argv/cwd, unsandboxed candidate execution, candidate-controlled Seatbelt/manifest/receipt, a daemon, queue/DAG, distributed lock, remote runner, or production orchestration platform.
- Gateway main process never imports or executes candidate modules. Candidate code runs only in a one-shot, default-deny verifier child process against a fixed trusted plan.
- Bind local verification, PR head, verifier, receipt, and merge to one exact commit SHA. New commit, plan digest, policy version, or required-level change invalidates stale verification.
- Preserve existing branch guard, immutable-SHA push source, `core.hooksPath=/dev/null`, GitHub credential-helper clearing, external diff/textconv disable, log/path/token redaction, audit flow, and task/worktree boundaries.
- `hostVerification.mode` stays `manual`. This task may implement auto capability but must not modify trusted production control configuration or LaunchAgent settings.
- Every Slice follows RED test -> minimal implementation -> targeted tests -> slice gate -> diff/security review -> commit. Never weaken or skip a failing test to obtain green.
- Any real-host Slice B load-bearing probe that cannot prove the property, or only produces an outer-sandbox false negative, is a Human Gate. Commit safe Slice B split/classifier work and stop before Slice C.
- A repo write lock is process-local only and held only across the actual Git/control-plane write critical section, never while waiting for CI or verifier completion.

---

## Slice A — Safe Git and Repo Write Serialization

### Task A1: Central Safe Git executor

**Files:**
- Create: `src/gitExec.ts`
- Create: `tests/gitExec.test.ts`
- Modify: `src/commit.ts`
- Modify: `src/push.ts`
- Modify: `src/prOpen.ts`
- Modify: `src/canonicalGit.ts`
- Modify: `src/canonicalRefresh.ts`
- Modify: `src/syncBase.ts`
- Modify: `src/worktree.ts`
- Modify: `src/worktreeGc.ts`
- Modify only if directly reached by the migrated production path: `src/attestation.ts`, `src/baseStatus.ts`, `src/onboarding.ts`, `src/outerTestReceipt.ts`, `src/prLifecycle.ts`, `src/readiness.ts`, `src/taskProgress.ts`

**Interfaces:**
- Produce `safeGit.local(cwd, args, options?)`, `safeGit.github(cwd, args, token, options?)`, `safeGit.diff(cwd, args, options?)`, `safeGit.tryRelation(cwd, ancestor, descendant)`.
- Common options include bounded timeout/output and optional expected branch/HEAD assertions for a write operation; Git arguments remain arrays and never pass through a shell.
- `github` always installs `core.hooksPath=/dev/null`, empty `credential.helper`, `GIT_TERMINAL_PROMPT=0`, clean Git/SSH credential environment, and the trusted control-plane token header.
- `diff` always installs `--no-ext-diff --no-textconv` and treats `--no-index` exit 1 as a difference rather than an execution failure.

- [ ] Add real temporary-repository behavior tests proving repository hooks cannot execute through local mode; Git credential helper fallback cannot run through github mode; an external diff/textconv helper cannot execute through diff mode; stdout/stderr are bounded; unique token/path markers are redacted from thrown errors; nonzero local Git failures are returned once and not retried.
- [ ] Run `pnpm vitest run tests/gitExec.test.ts` and record RED because `src/gitExec.ts` does not exist.
- [ ] Implement only the fixed modes above with finite timeout and bounded capture. Do not add a generic mode enum/command policy DSL.
- [ ] Re-run `pnpm vitest run tests/gitExec.test.ts` and record GREEN.
- [ ] Migrate each touched production Git call without deleting its existing branch/SHA/business guard. For push, keep the verified immutable SHA as source and `task.branch` as destination.
- [ ] Run targeted Git regression files: `pnpm vitest run tests/commit.test.ts tests/push.test.ts tests/prOpen.test.ts tests/syncBase.test.ts tests/worktree.test.ts` plus `tests/gitExec.test.ts`.

**Rollback point:** reverting A1 restores per-module Git helpers; no database/config schema changes are introduced.

### Task A2: In-process per-repo write mutex

**Files:**
- Create: `src/repoWriteLock.ts`
- Create: `tests/repoWriteLock.test.ts`
- Modify: `src/tools.ts`
- Modify: Git write tool assembly/call sites for task open, commit, sync-base, push, merge refresh/cleanup, task close/GC apply, deploy activation/rollback only where those operations are already implemented.

**Interfaces:**
- Produce `withRepoWriteLock<T>(repoId: string, operation: () => Promise<T> | T): Promise<T>`.
- Lock state is an in-memory map only; same repo FIFO-serializes critical sections; different repo IDs can overlap; rejection releases the lock.

- [ ] Add behavior tests using controllable promises proving same-repo write critical sections never overlap, different repos do overlap, a failing operation releases the lock, and no automatic retry occurs.
- [ ] Run `pnpm vitest run tests/repoWriteLock.test.ts` and record RED.
- [ ] Implement the minimal promise-chain mutex and wire the existing write operations at the narrow wrapper/assembly boundary.
- [ ] Add an integration regression where two same-repo write tool calls reach a test-controlled side-effect boundary and are serialized, while two different repo calls can overlap.
- [ ] Re-run targeted tests and record GREEN.

### Slice A gate and commit

- [ ] Run `grande_run unit-selfhost` for this task and wait for terminal PASS.
- [ ] Run `grande_run typecheck` and wait for terminal PASS.
- [ ] Run the project current full test gate available through the approved profiles; if a required host-only test cannot execute inside selfhost, do not claim it here and leave it for Slice B host evidence.
- [ ] Review `grande_diff`: no new shell strings, no arbitrary argv/cwd API, no credential fallback, no removal of hook/diff/branch/SHA protections, no control paths/tokens in messages, and no lock held across CI/verifier waits.
- [ ] Commit as a dedicated Slice A commit. Record commit SHA, commands/results, residual risks, and next Slice in task/audit evidence.

---

## Slice B — Host Suite Split and Feasibility Gate

### Task B1: Trusted host manifest and classifier

**Files:**
- Create: `src/hostVerification.ts`
- Create: `tests/hostVerification.test.ts`
- Modify: `src/outerTest.ts`
- Add directory: `tests/host/`
- Move/split host-only cases out of `tests/sandbox.test.ts`, `tests/runner.test.ts`, `tests/server.test.ts`, `tests/tools.test.ts`, `tests/e2e.test.ts` into clearly named `tests/host/*.host.test.ts` files; keep pure logic cases in normal test files.

**Interfaces:**
- Trusted manifest entry: `{ file: string; reason: string; levels: ("smoke"|"full")[] }` stored in running Gateway source, not candidate config.
- Produce `classifyHostVerification(changedFiles: string[]): "none" | "smoke" | "full"` and manifest validation helpers.
- Classification: docs-only/non-runtime assets -> `none`; ordinary production source/tests/schema text -> `smoke`; sandbox/runner/Git/auth/server lifecycle/host verifier/receipt/merge/trusted policy-profile changes or unknown production paths -> `full`; host manifest/classifier/verifier changes always `full`. No import graph.

- [ ] Add RED contract tests for exact docs-only/smoke/full examples and unknown-path fail-safe `full`.
- [ ] Add RED manifest contract tests: every `tests/host/*.host.test.ts` is registered with a nonempty capability reason; every manifest file exists; unit-selfhost excluded set and host manifest cannot silently leave a project test outside both sets; only explicit smoke duplication may overlap.
- [ ] Split pure logic assertions back into normal tests and host-only behavior into the manifest files; keep test semantics unchanged.
- [ ] Run targeted contract/classifier tests and record GREEN.
- [ ] Run `grande_run unit-selfhost`; it must now execute the migrated pure logic assertions.

**Rollback point:** host split/classifier can be reverted independently; old manual outer-test remains the safety fallback until C.

### Task B2: Throwaway verifier sandbox feasibility probes

**Files:**
- Create: `src/hostVerifierSandbox.ts`
- Create: `tests/host/verifier-sandbox.host.test.ts`
- Modify narrowly as required: `src/sbpl.ts`, `src/sandbox.ts`
- Reuse existing process-group behavior in `src/runner.ts`/`src/jobs.ts`; do not redesign it in this slice.

**Interfaces:**
- Produce trusted verifier sandbox construction primitives with default-deny paths/network/environment and no candidate-supplied argv/cwd/profile.
- Allowed: exact verifier worktree/toolchain read paths; job-temp HOME/TMP/cache/artifacts write paths; ephemeral loopback; nested `sandbox-exec`; fixture `/bin/sh` hook marker.
- Denied: real control root/secrets/SSH/credential store/other repos/canonical/real task worktree/DB/other job temp, non-loopback/external network, production Gateway port, signals to unrelated processes, package install/security CLI, inherited credentials/proxies/DYLD/Git/SSH agent state.

- [ ] Add the four load-bearing host probes: nested Seatbelt produces a true inner allow/deny result; Git hook marker really executes without hooks override and is blocked by Safe Git override; loopback listener/connect succeeds while LAN/non-loopback access is denied; runner timeout/process-group cleanup kills an orphan child with no residual process.
- [ ] Add negative path/env probes for real control root, SSH/credential store, other repo, canonical/task worktree/DB, production port, and inherited secret marker.
- [ ] Run the host files on the **real trusted host layer** using the existing approved manual host path. Save bounded logs/artifacts with no secrets or absolute control paths.
- [ ] If any of the four load-bearing probes lacks real evidence, is neutralized by the outer sandbox, or needs broader permissions, classify as Human Gate: keep mode manual, commit B1/B2 safe work, report the exact probe/artifact and stop before C.
- [ ] If all four probes prove the required behavior, run full Slice B host suite plus `unit-selfhost` and `typecheck` and commit Slice B.

---

## Slice C — Asynchronous Verifier, Receipt V2, Merge Gate

**Dependency:** Slice B real-host feasibility gate must PASS.

### Task C1: Receipt V2 and plan identity

**Files:**
- Modify: `src/outerTestReceipt.ts`
- Modify/Create tests: `tests/outerTestReceipt.test.ts`, `tests/hostVerification.test.ts`

**Interfaces:**
- `OuterTestReceiptV2` fields exactly: `version`, `mode`, `taskId`, `repoId`, `commit`, `level`, `profile`, `files`, `planDigest`, `jobId`, `startedAt`, `endedAt`, `hostToolchain`.
- `planDigest` hashes sorted files, level, trusted verifier policy version, and key resource limits.
- Eligibility requires exact task/repo/SHA/plan and sufficient level; `full` satisfies `smoke`, never the reverse. Unknown/corrupt receipt fails closed. V1 remains readable only as manual-transition compatibility per spec.

- [ ] Add RED tests for SHA drift, plan drift, policy-version drift, level upgrade, full->smoke acceptance, smoke->full rejection, corrupt/forged fields, and caller-supplied stdout/artifact/env being unable to create a receipt.
- [ ] Implement parser/eligibility/digest and a parent-only receipt signing function that accepts a finalized trusted job record rather than caller receipt fields.
- [ ] Run targeted receipt tests GREEN.

### Task C2: One-shot verifier orchestrator and disposable exact-SHA worktree

**Files:**
- Modify/Create: `src/hostVerification.ts`, `src/hostVerifierSandbox.ts`
- Modify: `src/worktree.ts`, `src/worktreeGc.ts`, `src/runner.ts`, `src/jobs.ts`
- Create: focused tests such as `tests/hostVerifier.test.ts` and host resource-limit cases under `tests/host/`.

**Interfaces:**
- Internal input is only `{ taskId, repoId, commit, level }`; no argv/path/cwd/env/Seatbelt/receipt parameters.
- Create detached exact-SHA temporary verifier worktree; make source/dependencies read-only; write only job temp HOME/TMP/cache/artifact; fixed trusted Node/Vitest entry and manifest.
- At most one verifier globally and one matching `(taskId, commit, planDigest)` job; verifier job runs in a detached process group with wall timeout/RSS/output bounds.
- Parent re-reads task and PR SHA before issuing receipt; SHA drift retains job result but produces no receipt.

- [ ] Add RED tests that duplicate same-SHA requests coalesce to one job, different stale plan cannot reuse it, verifier runs asynchronously while a status/read handler remains responsive, timeout/RSS kills the whole process group, and cleanup never removes the real task worktree.
- [ ] Implement minimal orchestrator by reusing existing job/artifact/CAS primitives and trusted manifest.
- [ ] Run targeted unit tests and real-host process/resource probes GREEN.

### Task C3: Merge gate and manual CLI fallback

**Files:**
- Modify: `src/prLifecycle.ts`
- Modify: `src/cli.ts`, `src/outerTest.ts`
- Modify/Create: `tests/prLifecycle.test.ts`, `tests/outerTest.test.ts`, CLI tests.

**Interfaces:**
- `grande_pr_merge` input schema and annotations do not change.
- Missing matching receipt creates or observes the verifier and returns `merged:false`, verification state/jobId; verifier PASS never auto-merges.
- A later merge invocation re-fetches PR/CI/mergeability/branch/local SHA before destructive merge.
- Manual `grande outer-test --task <id> --run` calls the same restricted orchestrator; it must not directly spawn candidate Vitest under host user permissions.

- [ ] Add RED tests for create/observe verification, no duplicate same-SHA job, pass-then-new-merge-call, SHA drift rejection, CI/mergeability recheck after pass, infrastructure-vs-test-failure distinction, and manual CLI path identity.
- [ ] Implement minimal merge/CLI integration without changing MCP input contract or toolset epoch.
- [ ] Run Slice C targeted tests, `unit-selfhost`, `typecheck`, and full host suite; review security boundary and commit Slice C.

**Rollback point:** trusted mode remains manual; reverting C returns to manual receipt gate without DB migration because V2 reuses the existing JSON column.

---

## Slice D — Reconciliation, Continuous Tasks, Activation Closeout

### Task D1: Startup verifier reconciliation and bounded infrastructure retry

**Files:**
- Modify: `src/jobs.ts`, `src/runner.ts`, `src/server.ts`, `src/hostVerification.ts`
- Modify/Create focused recovery tests.

**Interfaces:**
- On Gateway startup, reconcile running verifier jobs: kill only their recorded process group, CAS-finish as `interrupted_by_gateway_restart`, clean disposable resources, and make status finite.
- Same SHA gets at most one automatic infrastructure retry; second consecutive infrastructure failure is a Human Gate. Code test failure is never treated as retryable infrastructure.

- [ ] Add RED recovery tests for orphan job/group convergence, one retry, second failure blocker, test-failure no retry, and no permanent `running`.
- [ ] Implement reconciliation at startup before write tools are exposed.
- [ ] Run targeted and host recovery tests GREEN.

### Task D2: Observe-before-retry external writes and merge cleanup

**Files:**
- Modify as needed: `src/push.ts`, `src/prOpen.ts`, `src/prLifecycle.ts`, deployment code, `src/canonicalRefresh.ts`, `src/worktree.ts`, `src/worktreeGc.ts`, `src/repoWriteLock.ts`.
- Modify/Create integration tests.

**Interfaces:**
- Push/PR/merge/deploy timeout first queries external state; no blind write retry.
- After confirmed merge, under repo write lock: validate canonical base/clean state, fixed-origin fetch, ff-only refresh, verify remote/base SHA, mark merged/completed, remove task worktree/branch. Cleanup failure records `merged-but-local-stale`/reconcilable state rather than pretending merge failed.

- [ ] Add RED tests for response-loss observation preventing duplicate push/PR/merge, canonical dirty/local-ahead/diverged fail-close, successful post-merge refresh + cleanup, and cleanup failure status.
- [ ] Implement minimal observation/reconciliation logic using existing API/audit/task state rather than adding an operation/event table.
- [ ] Run targeted integration tests GREEN.

### Task D3: Status semantics and activation-ready evidence

**Files:**
- Modify: `src/taskProgress.ts`, status tool code in `src/toolsCore.ts`/`src/tools.ts`, gateway readiness/selfcheck code only where needed for reporting.
- Modify/Create status/contract tests and closeout documentation under `docs/research/`.

**Interfaces:**
- Status shows current phase, blocker, unique next action, task HEAD, required verification level, verifier state/retry count, and completed-but-not-cleaned-up state.
- Activation evidence is observational only: restart/readiness/gatewayBuild/toolset identity/read probe. This task does not modify LaunchAgent or production control config.

- [ ] Add RED status tests covering running/failed/retry-exhausted/merged-local-stale/completed states and exact unique next action.
- [ ] Implement concise bounded status data without leaking paths/tokens/environment.
- [ ] Run complete project regression: `unit-selfhost`, `typecheck`, full host suite, contract/e2e gates, restart/readiness/toolset/read probes at the trusted host layer.
- [ ] Do **not** run a production restart if doing so requires changing LaunchAgent/config; if an existing approved restart action itself is a production Human Gate, report activation-ready evidence and stop that path.
- [ ] Record whether the Owner-required 20-run selfhost soak exists. Without fresh 20-run evidence and explicit Owner approval, leave `hostVerification.mode=manual` and state exactly: “功能实现完成，自动 mode 尚未获 Owner 激活”.
- [ ] Review final diff, secrets/artifacts, rollback behavior, and exact-SHA receipt/merge semantics. Commit Slice D.

---

## PR / Delivery Closeout

- [ ] Push only the task branch using `grande_push`.
- [ ] Open or update the task PR using existing GrandeGPT PR tools.
- [ ] Read live PR/CI status for the exact current head SHA.
- [ ] If merge gate starts verification, observe its bounded job state; after PASS invoke merge again so CI/PR/branch/SHA are freshly checked. Never background merge.
- [ ] If mode is still manual, use the same restricted manual verifier path for the exact PR head receipt; never revert to unsandboxed candidate execution.
- [ ] Merge only when all current-SHA gates pass and no Human Gate remains. Do not activate production or switch mode as part of merge.

## Plan Self-Review

- Spec coverage: Safe Git, repo mutex, host split/classifier, four host feasibility probes, verifier sandbox, async job, Receipt V2, merge semantics, manual fallback, restart reconciliation, bounded retry, observe-before-retry, canonical cleanup/status, activation evidence, rollback, and manual-mode gate are all mapped above.
- Placeholder scan: no unresolved implementation placeholders; every stop is an explicit approved Human Gate.
- Type/contract check: verifier request is fixed `{taskId, repoId, commit, level}`; receipt level uses `smoke|full`; classifier alone may return `none`; merge input remains `{taskId}`; repo lock remains process-local.
