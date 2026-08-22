# GrandeGPT Phase 7 Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 7 Reliability Foundation for `GG-BL-007`, `GG-BL-017`, `GG-BL-018`, and `GG-BL-019` without changing the public 25-tool MCP contract.

**Architecture:** Keep the existing single Gateway, SQLite control plane, worktree isolation, Safe Git, Host Verifier, and exact-SHA gates. Add only narrow reliability primitives: ordered SQLite migrations plus verified pre-migration backup, one per-repo cross-process lock underneath the existing process-local mutex, a minimal independent CI gate, and one durable activation-evidence object. Do not add a workflow engine, ORM, external database, daemon, distributed lock, second state system, or second execution path.

**Tech Stack:** Node.js 24, TypeScript 5.9, `node:sqlite`, Vitest 4, pnpm 10, GitHub Actions, existing GrandeGPT controlled task/runner/Host Verifier.

**Spec:** `docs/BACKLOG.md` (`Phase 7 — Reliability Foundation`) and `docs/superpowers/specs/2026-08-22-grande-gpt-lightweight-architecture-and-development-flow-optimization-design.md`

**Final status:** DONE — implementation PR #22 merged 2026-08-23; canonical merge SHA `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`; production activation receipt persisted and read back successfully.

## Global Constraints

- Production public tool contract stays at 25 tools during Phase 7 and Phase 8; no tool additions/removals/renames and no toolset epoch bump.
- Keep SQLite; no ORM or external database.
- Keep the process-local repo mutex; add a narrow per-repo cross-process boundary below it.
- Different repos must remain independently writable in parallel.
- Host-only Seatbelt/loopback/LaunchAgent checks stay in the trusted Host Verifier, not ordinary GitHub CI.
- `.github/workflows/**` is intentionally read-only to candidate repo writes. The actual workflow file is a Human Gate and must not be written through a bypass path.
- Secrets are not part of ordinary control-plane backup.
- Every behavior change follows RED → verify RED → minimal GREEN → verify GREEN.

---

### Task 1: GG-BL-007 — ordered SQLite migration, backup, and restore

**Files:**
- Create: `src/dbMigrations.ts`
- Create: `src/controlBackup.ts`
- Modify: `src/db.ts`
- Modify: `src/layout.ts`
- Modify: `src/gatewayCli.ts`
- Test: `tests/db.test.ts`
- Create: `tests/dbMigrations.test.ts`
- Create: `tests/controlBackup.test.ts`
- Create: `tests/controlRestore.test.ts`
- Create: `tests/controlRestoreCli.test.ts`
- Modify: `tests/gatewayCli.test.ts`

**Interfaces:**
- `controlBackup.ts` produces `createStateDbBackup(layout, db, reason, expectedVersion)`, `inspectStateDbBackup(layout, backupPath)`, and `restoreStateDbBackup(layout, backupPath)` with fixed managed roots, integrity verification, atomic replacement, and no secret copying.
- `dbMigrations.ts` provides an ordered concrete migration list plus `canMigrate(fromVersion, toVersion)` / `migrateDb(db, fromVersion, toVersion)`; the first supported path is `5 -> 6`.
- `openDb()` detects on-disk schema before any disk-mutating pragma, rejects unsupported old/future versions, creates and verifies a backup before a supported old-version migration, runs migration steps in one transaction, and updates `PRAGMA user_version` only in that transaction.
- Human restore is exposed under the existing operations surface as `grande gateway restore-state <managed-backup-path> [--yes]`; it is dry-run by default.

- [x] **Step 1: Add failing migration tests**
  - Build a real version-5 fixture containing representative `task`, `audit`, OAuth, attestation, and receipt rows.
  - Assert `openDb()` upgrades it to version 6, preserves those rows, creates `audit_ack`, and leaves a verified backup.
  - Assert unsupported older/future versions still fail closed because only current-previous -> current is supported initially.

- [x] **Step 2: Verify RED**
  - Registered `unit-selfhost` runs failed on the missing migration/backup/restore behaviors before each implementation slice.

- [x] **Step 3: Implement minimal 5 -> 6 migration**
  - Add one explicit migration step creating `audit_ack`.
  - Use `BEGIN IMMEDIATE` / `COMMIT`; on any error issue `ROLLBACK` and leave `user_version=5`.
  - Do not create a general migration framework beyond an ordered list of concrete version-to-version steps.

- [x] **Step 4: Implement verified pre-migration backup**
  - Put state DB backups under a fixed `controlRoot/backups/state/` directory.
  - Use SQLite `VACUUM INTO` against a unique destination so the source is not edited merely to create the backup.
  - Open the resulting backup and require `PRAGMA integrity_check = ok` plus the expected pre-migration `user_version` before migration can start.
  - Keep a small deterministic retention count; never copy `controlRoot/secrets`.

- [x] **Step 5: Add failure and restore tests**
  - Backup destination failure => source DB bytes/schema/user_version unchanged.
  - Migration failure => transaction rolls back and old DB remains readable as version 5.
  - Restore from a managed verified backup => restored DB byte-matches the backup and reopens/migrates with the current compatible binary.
  - Reject restore sources outside the managed backup root, invalid SQLite files, and restore while a live DB handle is in use.
  - Live-handle detection uses SQLite's WAL exclusive transition semantics rather than treating residual `-wal` / `-shm` files as proof of a live connection.

- [x] **Step 6: Add explicit Human CLI restore**
  - `grande gateway restore-state <managed-backup-path>` validates and prints exact path/schema/integrity without modifying state.
  - `--yes` is required for the atomic replacement.
  - No secrets are copied or printed.

- [x] **Step 7: Verify GREEN**
  - Fresh registered `unit-selfhost`: 102 files / 836 tests PASS.
  - `typecheck`: PASS.

### Task 2: GG-BL-018 — minimal independent CI

**Files:**
- Modify: `package.json` only if a stable CI script is needed.
- Create/modify tests for the CI contract in a normal writable test/docs location.
- Human Gate: `.github/workflows/ci.yml` because candidate writes to `.github/workflows/**` are intentionally denied by policy.

**Interfaces:**
- CI runs on pinned `macos-15`, Node 24 with pnpm 10.33.0, `pnpm install --frozen-lockfile`, the same selfhost-safe Vitest selection as the registered `unit-selfhost` profile, `pnpm typecheck`, and focused tool-contract identity tests.
- The macOS runner preserves existing GrandeGPT runtime assumptions used by the selfhost-safe suite (Darwin CLI semantics and `cp -Rc` clonefile behavior) without moving trusted host suites into CI.
- Ordinary CI never runs Seatbelt, LaunchAgent, loopback port ownership, or trusted Host Verifier suites.

- [x] **Step 1: Add a failing CI-contract test/documented command** proving the repository has one deterministic command for the selfhost-safe test selection plus tool-contract checks.
- [x] **Step 2: Verify RED**, then add the minimal package script/config needed to make that command stable outside local control-plane profiles.
- [x] **Step 3: Verify GREEN** on the task worktree.
  - After the runner correction contract was added, fresh registered `unit-selfhost`: 109 files / 859 tests PASS.
  - `typecheck`: PASS.
- [x] **Step 4: Stop at the real Human Gate for `.github/workflows/ci.yml`**. Do not use GitHub or filesystem bypasses to defeat the existing read-only-path policy.
- [x] **Step 5: Commit/push the Human-applied workflow, run the same commands locally, and require real exact-head GitHub CI before merge.**
  - PR #22 first produced a real GitHub Actions result rather than `CI=none`, but the initial `ubuntu-latest` runner failed 5 selfhost-safe tests because the suite contains deliberate Darwin runtime assumptions (`sandbox-exec`/LaunchAgent CLI behavior and Darwin `/bin/cp -Rc` clonefile semantics).
  - Added a RED CI-contract assertion requiring pinned `macos-15`; it failed exactly against the old workflow. Human changed only the protected runner line to `macos-15`.
  - The first macOS run then exposed one test-only portability assumption: `tests/sbpl.test.ts` unconditionally preferred `xcrun --find git`, while production `defaultExecRoots()` correctly uses `which git` and falls back to `xcrun` only for `/usr/bin/git` shim. The test was aligned with the runtime selection rule; production sandbox code was unchanged.
  - Final exact PR head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`: local `unit-selfhost` 109 files / 859 tests PASS, `typecheck` PASS, GitHub Actions run `32585178938` PASS.

### Task 3: GG-BL-017 — fail-closed per-repo cross-process write lock

**Files:**
- Create: `src/repoProcessLock.ts`
- Modify: `src/repoWriteLock.ts`
- Modify: `src/worktreeGc.ts`
- Modify: `src/cli.ts`
- Test: `tests/repoWriteLock.test.ts`
- Test: `tests/repoWriteLockIntegration.test.ts`
- Modify: `tests/worktreeGc.test.ts`

**Interfaces:**
- `acquireRepoProcessLock(layout, repoId)` creates one exclusive lock file under fixed `controlRoot/locks/repos/` using atomic create semantics and writes `{pid, repoId, acquiredAt, nonce}` metadata.
- A lock owned by a live PID is `busy` and fails closed without entering the Git/worktree critical section.
- A lock whose recorded PID no longer exists is stale; acquisition removes that one stale lock and retries once.
- Malformed/untrusted lock metadata is not auto-deleted; it fails closed for Human inspection.
- `withRepoWriteLock()` retains its existing in-process queue and acquires/releases the process lock only for the active critical section.

- [x] **Step 1: Add two-process failing tests** showing same-repo overlap is impossible while different repo IDs can enter concurrently.
- [x] **Step 2: Verify RED** against the current process-local-only implementation.
- [x] **Step 3: Implement the minimal lock primitive** with atomic exclusive create, live-PID detection, stale-dead-PID recovery, ownership token check on release, and fixed-root path validation.
- [x] **Step 4: Wire Gateway write paths through the existing `withRepoWriteLock()` without changing public tool handlers.**
- [x] **Step 5: Wire `gc --apply` and any other Git/worktree-writing CLI path to the same per-repo process lock.**
- [x] **Step 6: Add zero-side-effect busy tests**: no partial branch/worktree/canonical mutation after lock acquisition fails.
- [x] **Step 7: Verify GREEN** with targeted tests, fresh `unit-selfhost`, and `typecheck`.
  - Fresh registered `unit-selfhost`: 105 files / 845 tests PASS.
  - `typecheck`: PASS.

### Task 4: GG-BL-019 — durable production activation evidence

**Files:**
- Create: `src/activationReceipt.ts`
- Create: `src/gatewayActivation.ts`
- Modify: `src/gatewayCli.ts`
- Modify: `src/launchd.ts` only if needed to expose existing restart/readiness evidence cleanly.
- Modify: `src/selfcheck.ts` only if needed to reuse the trusted read probe result rather than duplicate it.
- Modify: `src/taskProgress.ts` / status projection only to expose the latest activation evidence; do not conflate it with merge/deploy receipts.
- Test: new `tests/activationReceipt.test.ts`
- Create: `tests/activationStatus.test.ts`
- Create: `tests/gatewayActivation.test.ts`
- Create: `tests/gatewayCliActivation.test.ts`

**Interfaces:**
- One durable activation receipt records `targetBuild`, `runtimeBuild`, `toolsetEpoch`, `toolsCount`, `toolsDigest`, `activatedAt`, restart/readiness evidence, and one successful trusted read probe.
- Receipt creation fails when target/runtime build or expected/runtime tool identity differs.
- A restart is not activation success until LaunchAgent is running, endpoint readiness has recovered, and the trusted read probe succeeds.
- Merge receipt, deploy receipt, and activation receipt remain separate evidence objects.

- [x] **Step 1: Add failing receipt eligibility tests** for exact build/tool identity, readiness, and read probe requirements.
- [x] **Step 2: Verify RED.**
- [x] **Step 3: Implement atomic durable receipt persistence under the trusted control root or an existing backward-compatible auxiliary table; do not introduce another status store.**
- [x] **Step 4: Reuse existing restart/readiness/selfcheck primitives to record the receipt only after successful activation.**
- [x] **Step 5: Expose latest activation evidence in status without changing public tool count/schema beyond additive result fields.**
- [x] **Step 6: Verify GREEN with local tests, trusted exact-SHA Host gate, production activation, and later-session readback evidence.**
  - Review found and corrected one evidence-timing bug: `activatedAt` was originally sampled before restart. A regression test failed RED on the old behavior, then GREEN after sampling only when the fully eligible receipt is persisted.
  - Final exact PR head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`: local `unit-selfhost` 109 files / 859 tests PASS; `typecheck` PASS; Host outer-test 10 files / 171 tests PASS; GitHub CI PASS.
  - PR #22 merged to canonical `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`.
  - Production `gateway restart` persisted an activation receipt after LaunchAgent running + endpoint readiness + trusted read probe. A subsequent independent `grande_task_status` readback returned `targetBuild = runtimeBuild = git:aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`, `toolsetEpoch=2`, `toolsCount=25`, `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`, `endpointReady=true`, and read probe HTTP 200.

## Phase 7 Closeout

- [x] Each backlog item meets its own `Done when` in `docs/BACKLOG.md`; `GG-BL-007`, `GG-BL-017`, `GG-BL-018`, and `GG-BL-019` moved to Archive/DONE on 2026-08-23.
- [x] Fresh `unit-selfhost` and `typecheck` pass on exact candidate SHA `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`: 109 files / 859 tests PASS; typecheck PASS.
- [x] Trusted Host verification passes for host-only boundaries on exact candidate SHA: manual-only outer-test 10 files / 171 tests PASS with exact-SHA receipt.
- [x] PR #22 has real independent CI on exact PR head, not `CI=none`: GitHub Actions run `32585178938` PASS.
- [x] PR #22 merged and canonical safely refreshed to merge SHA `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`.
- [x] Production activation receipt proves exact target/runtime build and toolset identity after restart/read probe; later `grande_task_status` readback confirms durable persistence.
- [x] Re-read `toolsCount/toolsetEpoch/toolsDigest`: `25 / 2 / sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`; Phase 7 did not change the public tool contract.
- [x] Phase 8 entry condition is satisfied. Phase 7 is closed.
