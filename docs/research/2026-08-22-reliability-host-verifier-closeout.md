# GrandeGPT Reliability & Automated Host Verifier — D3 / Delivery Closeout

Date: 2026-08-22

Task: `task-reliability-hostverifier-20260821-001`

## Scope delivered

The approved Reliability & Automated Host Verifier design has been implemented through Slice D3 while preserving the manual production activation boundary.

Implemented behavior includes:

- Safe Git and repo-write serialization foundations.
- Trusted host manifest/classifier with explicit auto-safe vs manual-only host cases.
- Restricted one-shot verifier with exact executable allowlist, exact trusted loopback ports, bounded wall/RSS/output limits, process-group termination, disposable-root cleanup, and Receipt V2 exact-SHA binding.
- Merge gate semantics: missing receipt creates/observes a verifier when auto is permitted, verifier PASS never background-merges, and every subsequent merge attempt re-reads PR/CI/mergeability/branch/SHA.
- Manual fallback routed through the restricted verifier for auto-safe cases; predefined manual-only host suites remain an explicit Human Gate.
- Gateway startup reconciliation for interrupted verifier jobs, bounded infrastructure retry, and fail-closed cleanup.
- Observe-before-retry for push/PR/merge/deploy ambiguity; confirmed remote merge is never retried blindly.
- Post-merge canonical reconciliation and guarded task cleanup. Dirty or SHA-drifted worktrees are preserved as `merged-but-local-stale` instead of being force-deleted.
- D3 task status projection now exposes current phase, exact task HEAD, required host-verification level, verifier state/job/retry count, blocker, a unique next action, and completed-vs-local-stale state without adding a new lifecycle table.

## D3 internal verification

Before the final trusted-host gate, the synced task branch passed:

- `unit-selfhost`: **92 files / 791 tests PASS**
- `typecheck`: **PASS**

D3 status tests cover:

- verifier `running`;
- verifier test failure;
- retryable infrastructure failure;
- retry exhaustion after two consecutive infrastructure failures;
- valid receipt / passed state;
- manual-required state;
- remote-merged/local-stale state with reconciliation as the only next action;
- fully completed/cleaned state;
- MCP `grande_task_status` wiring for phase/HEAD/verifier fields;
- no workspace/control path, token/credential, or environment leakage from the progress projection.

The final exact-SHA trusted-host receipt is intentionally not written into this document after the gate, because changing this file after a host PASS would create a new SHA and invalidate the exact-SHA receipt. The authoritative final host evidence is the trusted `outer_test_receipt` written by the host gate itself.

## Canonical synchronization

The task branch had diverged from the local canonical branch before final closeout. `grande_sync_base` was run only after D3 implementation was committed and the worktree was clean.

- pre-sync task HEAD: `bcbef413fce55c5fea9ea122c82b274300fc0bf7`
- canonical HEAD observed by the trusted sync operation: `83a4bb701d221840e4e60b77ae9d7f94f98f3828`
- sync result before this closeout commit: `ce378fb3c92ba6a6af1543fb250c3180979d5647`
- relation: `diverged`
- action: task-side merge only; canonical was not modified or fetched by `grande_sync_base`.

Fresh unit/typecheck gates were rerun after the sync and passed.

## Production activation evidence

This implementation task does **not** modify LaunchAgent configuration or production control configuration.

The current production read probe during development reported:

- `gatewayBuild=git:0e85b1840467bac0a148fff382c5665dbd00aac6`
- `toolsetEpoch=2`
- `toolsCount=25`
- `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

That probe proves the existing production Gateway is reachable and its server-side toolset identity is observable. It is **not** evidence that this task's final build has been activated, because the reported production build predates this task.

After merge, production activation must remain an observational Human Gate: use the already-approved restart mechanism without changing LaunchAgent/config, then confirm readiness, the target `gatewayBuild`, unchanged/expected toolset identity, and a fresh `grande_task_status` read probe. Merge itself must not be reported as activation.

## 20-run soak / auto-mode decision

Repository evidence contains the requirement for a fresh Owner-required 20-run selfhost soak, but contains **no fresh 20-run soak result** for this implementation.

Therefore:

- `hostVerification.mode` remains `manual`;
- this task does not write or activate production `auto` mode;
- a future auto activation requires fresh 20-run evidence plus explicit Human Owner approval after production target-build/readiness/read-probe evidence exists.

Activation conclusion: **功能实现完成，自动 mode 尚未获 Owner 激活**.

## Rollback boundary

Rollback remains bounded and does not require a database downgrade:

- trusted production mode can remain or be returned to `manual`;
- Receipt V2 remains in the existing JSON receipt column and unknown/corrupt receipts fail closed;
- Safe Git, repo mutex, status projection, exact-SHA merge checks, and credential/path protections are independent hardening and should not be reverted merely to disable auto scheduling;
- no unsandboxed candidate fallback is introduced;
- no generic host-exec / arbitrary argv / arbitrary cwd interface exists.

## Remaining delivery gates

Before merge:

1. run the final trusted manual outer-test against the exact closeout commit and require the full host manifest to pass;
2. use the receipt from that exact SHA only;
3. push the task branch and open/update the PR;
4. read live PR/CI status for the exact current PR head;
5. invoke merge only when attestation, CI/mergeability, branch identity, and host receipt all match the same SHA;
6. if merge starts/observes verification, do not background merge: observe bounded state and invoke merge again only after PASS so all live gates are re-read.

Production auto activation is explicitly outside these merge steps.
