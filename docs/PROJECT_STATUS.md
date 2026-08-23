# GrandeGPT Project Status

> Current operational snapshot only. Backlog priority/status and roadmap state remain authoritative in [`docs/BACKLOG.md`](BACKLOG.md). Historical specs, plans and research retain their original timeline semantics.

Last synchronized: **2026-08-23**

## Executive status

GrandeGPT has completed:

- S0–S3 foundation;
- Phase 4 (S4–S7) end-to-end development loop;
- Phase 5 (S8–S10) real-world hardening, onboarding and daily operations;
- Phase 5.5 reliability gates;
- Reliability & Automated Host Verifier activation;
- Phase 6 Post-Activation Hardening;
- Phase 7 Reliability Foundation;
- **Phase 8 Flow Simplification**.

**Next planned development stage: Phase 9 — Tool Surface Convergence.** Phase 9 has not entered public contract change yet. `GG-BL-010` remains the release gate, so production stays on the current 25-tool / epoch-2 contract until that gate is satisfied.

## Current canonical state

- Phase 8 implementation PR: **#25**
- Phase 8 exact implementation head: `e902877854e2513cfa1d6545ffb15b22cc8410f9`
- Phase 8 implementation merge SHA / activated runtime source: `217a2dadc2887046decdeb9ab3c2813060ae7d97`
- Phase 8 closeout task: `task-p8-closeout-20260823-001`

Earlier Phase 7 implementation PR #22 merged at `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`; its project-management closeout PR #23 later advanced canonical to `f796b47dcaa6649b4ae9869e35cea07466ceaf09` before subsequent work.

Documentation-only commits after the Phase 8 activation may advance canonical without requiring another production Gateway activation. Do not infer runtime build from canonical HEAD alone.

## Production identity

The Phase 8 production activation receipt was persisted and then independently read back through the running Gateway:

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

The running Host Verifier reports `verifierBuild = git:217a2dadc2887046decdeb9ab3c2813060ae7d97`.

This proves production activation for the Phase 8 implementation merge. It is deliberately separate from merge evidence and from any deploy receipt.

## Public MCP contract

Current production tool contract:

- **25 tools**
- `toolsetEpoch=2`
- `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

Phase 7 and Phase 8 did not add/remove/rename public tools and did not bump the epoch. Phase 8 changed flow behavior behind the existing public contract.

Public surface convergence is reserved for Phase 9 / `GG-BL-024`. That one-time Tool Epoch must not start until `GG-BL-010` reaches the roadmap's release-ready stability gate.

## Reliability baseline after Phase 8

### State migration / recovery

- explicit ordered SQLite migration, currently including 5 → 6;
- verified pre-migration state DB backup under the managed control-root backup area;
- migration rollback on failure;
- backup failure leaves source state unchanged;
- explicit Human restore flow, dry-run by default and `--yes` for replacement;
- restore source restricted to managed backup root;
- ordinary backup excludes `secrets/`.

### Cross-process write safety

- existing in-process per-repo FIFO mutex retained;
- narrow per-repo cross-process lock added underneath it;
- same-repo writers cannot enter the critical section concurrently;
- different repos remain independently writable;
- stale-dead-PID recovery is bounded;
- malformed lock metadata fails closed;
- ownership/nonce checked on release;
- Gateway write paths and Git/worktree-writing CLI paths share the same boundary.

### Independent CI / Host verification

GrandeGPT PRs use a real GitHub Actions baseline rather than relying on `CI=none`:

- runner: pinned `macos-15`;
- Node 24;
- pnpm 10.33.0;
- `pnpm install --frozen-lockfile`;
- selfhost-safe Vitest selection;
- TypeScript typecheck;
- focused tool-contract checks.

Host-sensitive Seatbelt/LaunchAgent/loopback/real-host boundaries remain with the trusted Host Verifier and are not moved into ordinary CI.

### Phase 8 flow simplification

- an internal `local | pr | deploy` delivery-target primitive projects only the stages relevant to the current target;
- Phase 8 intentionally does not expose a public `TaskBrief.deliveryTarget` schema; that public contract belongs to Phase 9;
- `grande_run` observes a newly created job for a fixed short bounded-wait budget and returns a terminal result when it finishes in-budget; long/recovery jobs retain stable `jobId + grande_run_result` semantics;
- normal PR flow can enter `grande_pr_merge` directly; `grande_pr_status` is diagnosis-on-demand rather than mandatory preflight;
- after verifier completion, the agent may re-enter the merge gate under the same task authorization, but every merge call still re-reads current PR head, CI, attestation and Host receipt;
- verifier/runner never receives merge authority;
- development risk is formally classified L1/L2/L3, with unknown paths failing closed to L3.

### Production activation evidence

A restart is not considered successful activation until:

1. LaunchAgent is running;
2. endpoint readiness has recovered;
3. trusted read probe succeeds;
4. target/runtime build match;
5. expected/runtime tool identity match;
6. the durable activation receipt is persisted.

A later session can read that receipt instead of reconstructing activation from chat history.

## Final Phase 8 verification evidence

Final exact implementation candidate `e902877854e2513cfa1d6545ffb15b22cc8410f9`:

- local `unit-selfhost`: **112 files / 871 tests PASS**;
- `typecheck`: **PASS**;
- GitHub Actions exact-head CI: **PASS**;
- manual-only Host outer-test: **10 files / 172 tests PASS**;
- exact-SHA transitional manual Host receipt: recorded;
- PR #25: merged;
- canonical refresh: succeeded to `217a2dadc2887046decdeb9ab3c2813060ae7d97`;
- production activation receipt: persisted and later read back;
- public tool identity: unchanged at **25 / epoch 2 / `sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`**.

The Phase 8 PR itself dogfooded the simplified PR continuation path: direct merge first, status only after a real CI blocker, then merge re-entry after CI and again after the real manual-only Host Gate.

## Current backlog / roadmap

The following Phase 8 items are **DONE / archived**:

- `GG-BL-020` — internal delivery-target primitive / TaskProgress projection for the no-tool-epoch phase;
- `GG-BL-021` — bounded wait for short `grande_run` jobs;
- `GG-BL-022` — reduce unnecessary PR/verifier round trips while retaining exact-SHA merge authority;
- `GG-BL-023` — formal L1/L2/L3 development risk levels.

The public `TaskBrief.deliveryTarget` schema is **not** claimed as Phase 8 work. It is part of Phase 9 / `GG-BL-024` together with the one-time public tool-surface convergence.

Next planned roadmap item:

- `GG-BL-024` — Phase 9 Tool Surface Convergence, currently gated before public contract change by `GG-BL-010` release readiness.

Important maintenance/release gate that remains independent:

- `GG-BL-010` — ChatGPT App/session binding drift remains **P0 / MITIGATED**. It no longer blocks Phase 8 because Phase 8 is complete, but it still blocks Phase 9's public Tool Epoch.

For all live priority/status changes, use [`docs/BACKLOG.md`](BACKLOG.md), not this snapshot.

## Current production topology

```text
ChatGPT
  → https://grande.agentjoey.ai/mcp
  → Cloudflare Tunnel
  → 127.0.0.1:8787
  → ai.agentjoey.grande-gateway (LaunchAgent)
  → GrandeGPT Gateway / SQLite control plane / worktrees / trusted capabilities
```

Control plane: `~/.grande-control/`.

The control plane remains outside the code workspace so sandboxed/untrusted repository content cannot own trusted state, audit, credentials, receipts or policy.

## Verification / release discipline

For GrandeGPT self-hosting changes:

1. use a task worktree;
2. classify development risk before choosing ceremony: L1 docs/non-runtime resources use lightweight checks, L2 ordinary source/bug changes use behavior tests and bounded ordinary review, L3 critical execution/security boundaries require the full design/review/Host gates; unknown classification fails closed to L3;
3. for code changes, run the profiles required by the task/risk level and keep attestation bound to the exact commit;
4. require real independent GitHub CI on the exact PR head for PR delivery;
5. require exact-SHA Host verification when the classifier says the change touches host-only boundaries;
6. merge only when all current-head gates agree, and re-read them on every merge call;
7. refresh canonical safely;
8. if production activation is required, restart through the guarded Gateway flow and persist/read back activation evidence.

Do not substitute old-SHA receipts, a previous CI run, or chat statements for current exact-SHA evidence.

## Documentation authority

Use these documents by purpose:

- **Current product / operator entry:** [`../README.md`](../README.md)
- **Current project snapshot:** this file
- **Current backlog / roadmap status:** [`BACKLOG.md`](BACKLOG.md)
- **Coding-agent hard constraints:** [`../CLAUDE.md`](../CLAUDE.md)
- **ChatGPT connector release/recovery:** [`chatgpt-connector-compatibility-runbook.md`](chatgpt-connector-compatibility-runbook.md)
- **Phase 8 closeout evidence:** [`research/2026-08-23-phase8-flow-simplification-closeout.md`](research/2026-08-23-phase8-flow-simplification-closeout.md)
- **Historical evidence / incident timeline:** `docs/research/**`
- **Historical design/implementation plans:** `docs/superpowers/specs/**` and `docs/superpowers/plans/**`

If a historical document disagrees with current status, do not rewrite history. Use the current authority above and treat the older text as a dated snapshot.
