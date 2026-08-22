
## Slice C2 real-host one-shot verifier gate — PASS

The Owner executed the full trusted-host outer-test against exact clean commit:

`ab15a9ea1adf9e9e33997e424a7483ecbf486c0c`

Result:

- Test Files: **9 passed / 9**
- Tests: **170 passed / 170**
- outer-test exit: **0**
- the restricted one-shot runtime probe passed its real auto-safe full suite and issued Receipt V2 for the exact SHA;
- wall-timeout and RSS-limit probes each terminated the detached verifier process group with no residual orphan;
- cleanup removed only the disposable verifier resources and preserved the real task worktree;
- the legacy/manual-only host suites remained green.

The real-host iterations also established the final macOS runtime details without broadening the verifier boundary:

- system Git config is disabled with fixed trusted `GIT_CONFIG_NOSYSTEM=1` instead of granting reads to host Git configuration;
- trusted Vitest runs single-worker `threads` rather than requiring fork-worker signal permissions;
- the Git hook fixture creates its own `.git/hooks` directory under trusted job temp;
- macOS `/bin/sh` requires exact `/bin/bash` as its shell variant, so both are exact executable literals; no `/bin` process-exec subpath was granted;
- exact loopback/network and sensitive-path denies remain unchanged.

**Slice C2 host gate: PASS.** C3 merge-gate/manual-fallback integration is unblocked. `hostVerification.mode` remains `manual`; this evidence does not activate automatic production mode.

## Slice C3 real-host merge-gate/manual-fallback gate — PASS

The Owner executed the trusted manual outer-test path against exact clean C3 commit:

`3dbc0bb74eb4eae430aa55ee4bf2d10b42b9c725`

Result:

- Test Files: **9 passed / 9**
- Tests: **170 passed / 170**
- outer-test exit: **0**
- `tests/host/verifier-runtime.host.test.ts`: **3 / 3 PASS**, including the real auto-safe full suite at exact SHA and detached process-group timeout/RSS cleanup;
- `tests/host/runner.host.test.ts`: **28 / 28 PASS**;
- `tests/host/tools.host.test.ts`: **52 / 52 PASS**;
- the trusted manual path recorded a transitional exact-SHA host receipt for `3dbc0bb74eb4eae430aa55ee4bf2d10b42b9c725`;
- no background merge and no production auto-mode activation occurred.

**Slice C3 host gate: PASS.** Slice D recovery/reconciliation work is unblocked. `hostVerification.mode` remains `manual` pending the approved activation/soak gate.

## Slice D1 real-host startup recovery gate — PASS

The Owner executed the full trusted-host outer-test against exact clean D1 follow-up commit:

`8bcd0386c395fd6d5dd573fab273f72b9938bbe1`

Result:

- Test Files: **10 passed / 10**
- Tests: **171 passed / 171**
- outer-test exit: **0**
- `tests/host/verifier-recovery.host.test.ts` passed the real detached-process-group restart recovery probe: the recorded verifier process group was terminated, its canonical disposable root was removed, and the real task worktree was preserved;
- `tests/host/verifier-runtime.host.test.ts`: **3 / 3 PASS**, including exact-SHA auto-safe execution plus timeout/RSS whole-group cleanup;
- `tests/host/runner.host.test.ts`: **28 / 28 PASS**;
- `tests/host/tools.host.test.ts`: **52 / 52 PASS**;
- the trusted manual path recorded a transitional exact-SHA host receipt for `8bcd0386c395fd6d5dd573fab273f72b9938bbe1`.

The first D1 host attempt exposed only a fixture mismatch: the probe stored macOS `/var/...` before canonicalization while production stores `realpathSync(...)` (`/private/var/...`). The production cleanup guard correctly rejected the alias. The fixture was changed to mirror the production writer, and a unit regression now preserves fail-closed behavior for genuine symlink/non-canonical summary paths. Production recovery permissions were not broadened.

**Slice D1 host gate: PASS.** D2 observe-before-retry and post-merge cleanup work is unblocked. `hostVerification.mode` remains `manual`.

## Slice D2 real-host observe-before-retry / merge-reconciliation gate — PASS

The Owner executed the full trusted-host outer-test against exact clean D2 implementation commit:

`d20c63c2c6c2af8262f3aed77561b9d865ac25f6`

Result:

- Test Files: **10 passed / 10**
- Tests: **171 passed / 171**
- outer-test exit: **0**
- `tests/host/verifier-runtime.host.test.ts`: **3 / 3 PASS**, including exact-SHA auto-safe execution and timeout/RSS whole-process-group cleanup;
- `tests/host/runner.host.test.ts`: **28 / 28 PASS**;
- `tests/host/tools.host.test.ts`: **52 / 52 PASS**;
- the trusted manual path recorded a transitional exact-SHA host receipt for `d20c63c2c6c2af8262f3aed77561b9d865ac25f6`;
- D2 introduced no second merge write entry point: production `mergePullRequest` remains owned by `src/prLifecycle.ts`; the D2 wrapper only observes ambiguous outcomes and reconciles confirmed remote merge state;
- post-merge automatic cleanup remains fail-closed: clean task worktree + exact confirmed PR head are required before cleanup; otherwise status is `merged-but-local-stale` and the worktree is preserved;
- production-capability deploy response loss remains `uncertain` and is not blindly reinvoked.

**Slice D2 host gate: PASS.** D3 status/activation-ready closeout is unblocked. `hostVerification.mode` remains `manual`.