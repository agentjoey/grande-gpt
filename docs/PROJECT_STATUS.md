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
- **Phase 7 Reliability Foundation**.

**Current development stage: Phase 8 — Flow Simplification.** Its entry condition is satisfied. Phase 8 must keep the current public MCP tool contract frozen.

## Current canonical state

- Phase 7 implementation PR: **#22**
- Phase 7 final implementation head: `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`
- Phase 7 implementation merge SHA: `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`
- Phase 7 project-management closeout PR: **#23**
- Canonical after Phase 7 closeout: `f796b47dcaa6649b4ae9869e35cea07466ceaf09`

Later documentation-only commits may advance canonical without requiring a production Gateway activation. Do not infer runtime build from canonical HEAD alone.

## Production identity

The most recent Phase 7 production activation receipt was persisted and later read back through the running Gateway:

```text
targetBuild = git:aec10bbdd8ce01ef7cfc1eada18cb52d692bb162
runtimeBuild = git:aec10bbdd8ce01ef7cfc1eada18cb52d692bb162
toolsetEpoch = 2
toolsCount = 25
toolsDigest = sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815
restart.launchAgentRunning = true
restart.endpointReady = true
readProbe.ok = true
readProbe.httpStatus = 200
```

This proves production activation for the Phase 7 implementation merge. It is deliberately separate from merge evidence and from any deploy receipt.

## Public MCP contract

Current production tool contract:

- **25 tools**
- `toolsetEpoch=2`
- `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

Phase 7 did not add/remove/rename public tools and did not bump the epoch.

Phase 8 also keeps the 25-tool contract frozen. Public surface convergence is reserved for Phase 9 / `GG-BL-024`, after Phase 8 completes and `GG-BL-010` reaches the roadmap's release-ready stability gate.

## Reliability baseline after Phase 7

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

### Independent CI

GrandeGPT PRs now have a real GitHub Actions baseline rather than relying on `CI=none`:

- runner: pinned `macos-15`;
- Node 24;
- pnpm 10.33.0;
- `pnpm install --frozen-lockfile`;
- selfhost-safe Vitest selection;
- TypeScript typecheck;
- focused tool-contract checks.

Host-sensitive Seatbelt/LaunchAgent/loopback/real-host boundaries remain with the trusted Host Verifier and are not moved into ordinary CI.

### Production activation evidence

A restart is not considered successful activation until:

1. LaunchAgent is running;
2. endpoint readiness has recovered;
3. trusted read probe succeeds;
4. target/runtime build match;
5. expected/runtime tool identity match;
6. the durable activation receipt is persisted.

A later session can read that receipt instead of reconstructing activation from chat history.

## Final Phase 7 verification evidence

Final exact implementation candidate `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`:

- local `unit-selfhost`: **109 files / 859 tests PASS**;
- `typecheck`: **PASS**;
- GitHub Actions exact-head CI: **PASS** (run `32585178938`);
- manual-only Host outer-test: **10 files / 171 tests PASS**;
- exact-SHA host receipt: recorded;
- PR #22: merged;
- canonical refresh: succeeded;
- production activation receipt: persisted and later read back.

Phase 7 documentation closeout also passed fresh `unit-selfhost` 109/859 + typecheck and GitHub CI before PR #23 merged.

## Current backlog / roadmap

The following Phase 7 items are **DONE / archived**:

- `GG-BL-007` — control-plane backup / SQLite migration / restore;
- `GG-BL-017` — cross-process repo write lock;
- `GG-BL-018` — independent GitHub CI;
- `GG-BL-019` — durable production activation receipt.

Current planned Phase 8 scope:

- `GG-BL-020` — `deliveryTarget = local | pr | deploy`;
- `GG-BL-021` — bounded wait for short `grande_run` jobs;
- `GG-BL-022` — reduce unnecessary PR/verifier round trips;
- `GG-BL-023` — formal L1/L2/L3 development risk levels.

Important maintenance/release gate that remains independent:

- `GG-BL-010` — ChatGPT App/session binding drift remains **P0 / MITIGATED** and is a Phase 9 release gate, not a Phase 8 blocker.

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
2. run fresh `unit-selfhost + typecheck`;
3. require real independent GitHub CI on the exact PR head;
4. require exact-SHA Host verification when the classifier says the change touches host-only boundaries;
5. merge only when all current-head gates agree;
6. refresh canonical safely;
7. if production activation is required, restart through the guarded Gateway flow and persist/read back activation evidence.

Do not substitute old-SHA receipts, a previous CI run, or chat statements for current exact-SHA evidence.

## Documentation authority

Use these documents by purpose:

- **Current product / operator entry:** [`../README.md`](../README.md)
- **Current project snapshot:** this file
- **Current backlog / roadmap status:** [`BACKLOG.md`](BACKLOG.md)
- **Coding-agent hard constraints:** [`../CLAUDE.md`](../CLAUDE.md)
- **ChatGPT connector release/recovery:** [`chatgpt-connector-compatibility-runbook.md`](chatgpt-connector-compatibility-runbook.md)
- **Historical evidence / incident timeline:** `docs/research/**`
- **Historical design/implementation plans:** `docs/superpowers/specs/**` and `docs/superpowers/plans/**`

If a historical document disagrees with current status, do not rewrite history. Use the current authority above and treat the older text as a dated snapshot.
