# Phase 8 Flow Simplification — Closeout

Date: 2026-08-23

This document records Phase 8 closeout evidence. Current roadmap and backlog status remain authoritative in `docs/BACKLOG.md`.

## Scope

Phase 8 completed the no-tool-epoch portion of the owner-approved flow simplification design:

- internal `local | pr | deploy` delivery-target primitive and TaskProgress projection;
- bounded wait for `grande_run`, preserving stable async job/recovery semantics;
- PR/merge guidance that treats `grande_pr_status` as diagnosis-on-demand and allows the agent to re-enter the exact-SHA merge gate after verifier completion without another Human confirmation;
- formal L1/L2/L3 development-risk classification with fail-closed unknown classification.

Phase 8 deliberately did **not** add a public `TaskBrief.deliveryTarget` field, rename/remove public tools, or bump the toolset epoch. Public delivery-target schema and tool-surface convergence remain Phase 9 / `GG-BL-024` work.

## Implementation evidence

Implementation task: `task-p8-20260823-001`

Implementation PR: **#25**

Exact implementation head:

```text
e902877854e2513cfa1d6545ffb15b22cc8410f9
```

Canonical merge SHA:

```text
217a2dadc2887046decdeb9ab3c2813060ae7d97
```

Fresh candidate verification before merge:

- `unit-selfhost`: **112 files / 871 tests PASS**;
- `typecheck`: **PASS**;
- GitHub Actions exact-head CI: **PASS**;
- manual-only Host outer-test: **10 files / 172 tests PASS**;
- transitional manual Host receipt recorded for exact implementation head `e902877854e2513cfa1d6545ffb15b22cc8410f9`.

The Host suite included the real server/runner/tool/verifier boundaries. The stderr emitted by the unknown-task runner fixture was expected negative-test evidence; the corresponding test and the full suite passed.

## Dogfood evidence

The Phase 8 PR flow was itself used to exercise the simplified continuation model:

1. PR #25 was opened without a mandatory preflight `grande_pr_status` call.
2. The agent called `grande_pr_merge` directly.
3. The merge gate returned the actual blocker while CI was pending.
4. `grande_pr_status` was then used only for diagnosis.
5. After CI passed, the agent re-entered `grande_pr_merge`.
6. The merge gate required the exact-SHA manual-only Host receipt and stopped at a real Human Gate.
7. After the Human Owner ran the host suite and recorded the receipt, the same merge gate was re-entered and merged PR #25, re-reading the current PR head, CI, attestation and host receipt.

The verifier/runner never received merge authority.

The closeout task also dogfooded the development-risk classifier. Its initial five-file documentation-only diff unexpectedly projected `developmentRisk=L3`. Inspection showed a narrow classifier omission: root documentation explicitly included `README.md` but not `CLAUDE.md`, so `CLAUDE.md` fell through the intended unknown-path fail-closed rule. Because `CLAUDE.md` is a non-runtime root documentation file and the Phase 8 policy defines documentation as L1, the closeout task added the minimal regression fix: `CLAUDE.md` is now an explicit L1 root document and the classifier test covers it. No broader filename guessing was added.

That corrective source/test change makes the closeout task itself L2, which is appropriate: a real dogfood bug is verified as ordinary source/test work rather than pretending the task remained docs-only or escalating a known documentation path to L3 ceremony.

## Production activation evidence

After the Phase 8 implementation merge, the Human Owner activated canonical build `217a2dadc2887046decdeb9ab3c2813060ae7d97` through the guarded Gateway restart path. A subsequent `grande_task_status` call read the durable receipt back from the running production Gateway:

```text
targetBuild = git:217a2dadc2887046decdeb9ab3c2813060ae7d97
runtimeBuild = git:217a2dadc2887046decdeb9ab3c2813060ae7d97
toolsetEpoch = 2
toolsCount = 25
toolsDigest = sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815
restart.launchAgentRunning = true
restart.endpointReady = true
readProbe.ok = true
readProbe.httpStatus = 200
```

The running Host Verifier also reported `verifierBuild = git:217a2dadc2887046decdeb9ab3c2813060ae7d97`.

This proves that the Phase 8 implementation runtime behavior is active while the public MCP identity is unchanged. If the closeout classifier correction is merged, production must be activated once more before that correction is considered part of the running Gateway build; a docs-only canonical advance by itself would not require activation, but this closeout now contains a small runtime classifier fix.

## Contract freeze

Phase 8 kept production at:

- **25 public tools**;
- `toolsetEpoch=2`;
- `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`.

No Production App refresh is required for Phase 8 because the public schema/annotations/tool identity did not change.

## Phase 9 boundary

Phase 9 / `GG-BL-024` owns the one-time public Tool Epoch, including the public `TaskBrief.deliveryTarget` contract and the planned tool-surface convergence. Phase 9 must not start changing production `tools/list` until `GG-BL-010` reaches the release-ready stability gate defined in `docs/BACKLOG.md`.

Until that gate is satisfied, the production 25-tool contract remains frozen except for blocking security/reliability fixes.
