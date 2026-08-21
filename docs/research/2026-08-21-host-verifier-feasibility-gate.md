
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
