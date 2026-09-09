# GrandeGPT Project Status

> Current operational snapshot only. Backlog priority/status and roadmap state remain authoritative in [`docs/BACKLOG.md`](BACKLOG.md). Historical specs, plans and research retain their original timeline semantics.

Last synchronized: **2026-09-09**

## Executive status

GrandeGPT has completed:

- S0–S3 foundation;
- Phase 4 (S4–S7) end-to-end development loop;
- Phase 5 (S8–S10) real-world hardening, onboarding and daily operations;
- Phase 5.5 reliability gates;
- Reliability & Automated Host Verifier activation;
- Phase 6 Post-Activation Hardening;
- Phase 7 Reliability Foundation;
- **Phase 8 Flow Simplification**;
- **Phase 9 Minimal V2 delivery slice**: explicit delivery target, durable one-time delivery authorization, hardened Console approval routes, exact merge binding, pinned release source, and reentrant deploy/verify/rollback enforcement.

**Current development stage: Phase 9 — Tool Surface Convergence (in progress).** The Minimal V2 slice is implemented and production-activated. Broader public-tool consolidation remains open under `GG-BL-024`; this closeout does not claim that the whole phase is complete.

## Current canonical state

- canonical branch / remote: `main` / `origin/main`
- Minimal V2 Pactify feature: `minv2-gw`, seven tasks accepted and feature shipped
- Minimal V2 merge commit: `7ab13d5`
- Minimal V2 production Gateway build / pre-docs-closeout canonical HEAD: `311d55f4a1651f7a560ca4c7f80371a74121b0bb`
- shared contract mirror in `grande-console`: `3a4038be8eef8fe28f3f24aa2e69df4c3e1a9977`

Phase 7/8 SHAs remain historical evidence in their closeout documents. Documentation-only commits after this activation may advance canonical without requiring another production Gateway activation; do not infer runtime build from canonical HEAD alone.

## Production identity

The Minimal V2 production activation receipt was persisted and independently read back through the running Gateway and a fresh ChatGPT conversation:

```text
targetBuild = git:311d55f4a1651f7a560ca4c7f80371a74121b0bb
runtimeBuild = git:311d55f4a1651f7a560ca4c7f80371a74121b0bb
toolsetEpoch = 3
toolsCount = 25
toolsDigest = sha256:d5243888a58a440b05147d8e5baeb3713e92833720c5dd403901493ff555b496
restart.launchAgentRunning = true
restart.endpointReady = true
readProbe.ok = true
readProbe.httpStatus = 200
```

The fresh-conversation probe called only `grande_task_status`; it observed epoch 3 / 25 tools and performed no write action. Activation evidence remains deliberately separate from merge and deploy receipts.

## Public MCP contract

Current production tool contract:

- **25 tools**
- `toolsetEpoch=3`
- `toolsDigest=sha256:d5243888a58a440b05147d8e5baeb3713e92833720c5dd403901493ff555b496`

Epoch 3 keeps the 25-tool surface and intentionally changes only the public `grande_task_open.deliveryTarget` schema. It adds no public approval, nonce, argv, shell, cwd, env, network, PTY, or scheduler input.

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

### Phase 8 flow simplification and Minimal V2 delivery

- an internal `local | pr | deploy` delivery-target primitive projects only the stages relevant to the current target;
- Phase 8 originally kept `TaskBrief.deliveryTarget` internal; Minimal V2 now exposes the immutable optional `local | pr | deploy` choice in epoch 3, with `deploy` requiring explicit selection;
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

### Minimal V2 delivery boundary

- daily terminal automation still uses only trusted `task-sandbox` profiles through `grande_run`;
- readiness binds the current PR head/base, expected merge tree, CI, attestation, Host receipt, deploy spec, trusted policy, runtime build and tool identity;
- one protected Console approval authorizes the exact `merge → deploy → verify` chain;
- any binding drift makes the authorization stale before side effects;
- deploy/verify recover from durable job/receipt state without repeating an external side effect;
- uncertainty never auto-retries, and rollback requires a separate authorization.

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

## Minimal V2 closeout evidence

- focused integration: **8 files / 101 tests PASS**;
- `pnpm test:selfhost-safe`: **138 files / 1172 tests PASS**;
- `pnpm typecheck`: **PASS**;
- `pnpm test:tool-contract`: **2 files / 15 tests PASS**;
- exact-SHA Host gate: **11 files / 195 tests PASS**;
- production Gateway/Console restart, public Access smoke, Production App refresh and fresh-conversation read probe: **PASS**.

## Current backlog / roadmap

The following Phase 8 items are **DONE / archived**:

- `GG-BL-020` — internal delivery-target primitive / TaskProgress projection for the no-tool-epoch phase;
- `GG-BL-021` — bounded wait for short `grande_run` jobs;
- `GG-BL-022` — reduce unnecessary PR/verifier round trips while retaining exact-SHA merge authority;
- `GG-BL-023` — formal L1/L2/L3 development risk levels.

Current roadmap state:

- `GG-BL-024` remains **in progress**: Minimal V2 and public `deliveryTarget` are delivered; repo registration consolidation, capability-list consolidation, deploy-verify consolidation, normal task-close internalization and the remaining rollback/release requirements are not claimed complete.
- `GG-BL-010` is **DONE by Human Owner residual-risk acceptance** as of 2026-08-30. A future unexplained App/session binding failure must reopen it or create a related incident; this closeout does not claim the platform root cause was proven closed.

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
- **Minimal V2 design / implementation closeout:** [`superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`](superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md) and [`superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`](superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md)
- **Historical evidence / incident timeline:** `docs/research/**`
- **Historical design/implementation plans:** `docs/superpowers/specs/**` and `docs/superpowers/plans/**`

If a historical document disagrees with current status, do not rewrite history. Use the current authority above and treat the older text as a dated snapshot.
