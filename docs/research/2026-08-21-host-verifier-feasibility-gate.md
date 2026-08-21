# Host Verifier Feasibility Gate — 2026-08-21

## Scope

This evidence belongs to `task-reliability-hostverifier-20260821-001`, Slice B2 of the approved Reliability & Automated Host Verifier plan. It records what has and has not been proven. It is intentionally not an activation record.

## Code-layer evidence

The restricted verifier policy builder and the trusted real-host probe suite are implemented. The builder has no argv/cwd/profile/environment escape hatch, separates readable toolchain roots from exact executable files, keeps candidate source/dependencies read-only, limits writes to per-job temp, constructs a fresh environment, allows loopback only, and explicitly denies the production Gateway port and real trusted roots.

TDD evidence for the current B2 work:

- RED: `job_a53078a0-7c05-444a-942e-66f957259849` — `unit-selfhost` failed because `src/hostVerifierSandbox.ts` did not yet exist.
- GREEN: `job_f50be8b6-5ea8-49de-981d-0e82e2a26ea0` — `unit-selfhost`, 78 files / 725 tests passed.
- GREEN: `job_debb6213-9237-4be1-ad54-bc52084755b1` — `typecheck` passed.

The trusted host manifest now includes `tests/host/verifier-sandbox.host.test.ts`. That file contains the required real-host probes:

1. nested Seatbelt: outer verifier policy allows both fixture files while an inner Seatbelt policy allows one and denies the other;
2. Git hook marker: a real pre-commit hook must execute under raw Git, then the same marker must not execute through `safeGit.local`;
3. network isolation: an ephemeral loopback listener/connect must succeed, a connection to this host's non-loopback LAN address must be denied, and `127.0.0.1:<production-port>` must be denied;
4. process-group cleanup: a sandboxed orphan child is created, timeout kills the detached process group, and the child PID must no longer exist.

The same host file also checks denial of the real control root, workspace root, canonical repository, current task worktree, state DB, another real workspace repository, at least one real SSH/keychain credential-store path, and inherited secret/proxy/SSH-agent state. Probe output is boolean/status-only; it does not print secrets or trusted absolute paths.

## Human Gate status

**REAL-HOST EVIDENCE: NOT YET PROVEN.**

The current ChatGPT/GrandeGPT connector exposes sandboxed `grande_run` profiles but no trusted-host `outer-test --run` execution capability. Running these probes through `unit-selfhost` would be invalid evidence because the outer sandbox can neutralize exactly the properties under test. No PASS is claimed for any of the four load-bearing real-host probes.

Per the approved plan, Slice C MUST NOT start until the real trusted host run passes all four load-bearing probes.

The unique Owner action is to run the following from the task worktree on the real host and return the complete bounded test summary:

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/.grande-work/worktrees/grande-gpt/task-reliability-hostverifier-20260821-001
GRANDE_WORKSPACE=/Users/xtation/AgentWorks/GPT_Workspace \
node --disable-warning=ExperimentalWarning src/cli.ts \
  outer-test --task task-reliability-hostverifier-20260821-001 --run
```

Required outcome: all trusted host files pass, including all cases in `tests/host/verifier-sandbox.host.test.ts`, and the CLI records a host outer-test receipt for the exact current task HEAD.

Until that evidence exists, `hostVerification.mode` remains manual and no Slice C/D automation or production activation is permitted.
