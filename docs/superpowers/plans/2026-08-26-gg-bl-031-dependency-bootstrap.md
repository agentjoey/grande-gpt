# GG-BL-031 Fresh Worktree Dependency Bootstrap Implementation Plan

## Goal

Remove the hidden prerequisite that a canonical checkout already has `node_modules`. A fresh task or exact-SHA verifier must either consume a matching prepared dependency cache or launch a controlled npm/pnpm bootstrap, without asking the Human Owner to run install commands.

## Root cause

1. `openWorktree()` only clones `depDirs` that already exist in the canonical checkout; missing `node_modules` is silently skipped.
2. `grande_run` starts the requested product profile without checking whether the task dependency tree matches the current package-manager/lockfile/runtime identity.
3. The default Host Verifier also clones dependencies from canonical and fails if canonical `node_modules` is absent.
4. Existing package-manager identity already binds npm/pnpm, manager version and lockfile SHA, but that identity is not used to prepare or invalidate task dependencies.

## Implementation boundary

### Task 1: RED for dependency identity/cache and sandbox mode
- Create `tests/dependencyBootstrap.test.ts`.
- Require a cache key that includes repoId, package-manager identity, Node version, platform and architecture.
- Require fixed npm/pnpm install argv and a bootstrap timeout longer than ordinary profile windows.
- Require copy-on-write materialization from a per-repo cache and stale-identity rejection.
- Require ordinary SBPL to keep `deny network*`, with network allowed only under an explicit internal package-manager-bootstrap mode.

### Task 2: GREEN internal primitive
- Create `src/dependencyBootstrap.ts`.
- Reuse `capturePackageManagerIdentity()`; do not add another package-manager detector.
- Store prepared trees below `.grande-work/dependency-cache/<repoId>/<identity-key>/node_modules`.
- Put the identity marker inside ignored `node_modules`, never in tracked repo paths.
- On cache miss run only fixed `npm ci --ignore-scripts --no-audit --no-fund` or `pnpm install --frozen-lockfile --ignore-scripts` through the existing Seatbelt runner.
- Bootstrap Seatbelt may use network, but keeps existing filesystem/control-plane/worktree isolation and fixed exec roots. No arbitrary argv/env/shell input is accepted.
- Publish cache atomically after a successful install; remove partial task dependencies after failure.

### Task 3: wire task execution
- `openWorktree()` should materialize a matching cache when available instead of trusting arbitrary canonical `node_modules`.
- On a cache miss, `grande_run` launches/reuses a `dependency-bootstrap` prerequisite job and returns that job instead of launching the requested product profile against missing dependencies.
- After bootstrap passes, a retry of the same `grande_run` launches the real profile normally.
- Bootstrap job summary must include repoId, manager, lockfile digest and dependency identity key, and failure must be labeled as bootstrap infrastructure/preparation rather than product-test failure.

### Task 4: wire exact-SHA Host Verifier
- Replace canonical dependency cloning with the same prepared-cache/bootstrap primitive in the disposable verifier source tree.
- Keep V2 host-toolchain evidence captured from the exact source tree after dependency preparation, so receipt evidence remains bound to the same manager/lockfile identity.

### Task 5: verification
- Focused RED/GREEN tests.
- Full unit + typecheck.
- Fresh worktree regression proving cache hit works without canonical `node_modules`.
- Fresh controlled cache-miss bootstrap probe proving a prerequisite job is returned and product tests are not misreported.
- Host verifier adapter regression with canonical `node_modules` absent.
- Review diff, commit, PR, merge.

## Non-goals

- No public MCP tool or input-schema addition.
- No generic trusted-host shell or install argv.
- No mutable `node_modules` shared between repos/tasks.
- No change to package-manager attestation semantics beyond reusing the existing identity.
- No work on GG-BL-028 or GG-BL-029 in this task/PR.
