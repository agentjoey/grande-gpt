# Phase 7 GG-BL-018 — GitHub CI Human Gate

Date: 2026-08-22
Task: `task-p7-20260822-001`
Backlog: `GG-BL-018`

## Why this is a Human Gate

GrandeGPT deliberately treats `.github/workflows/**` as a trusted read-only path for candidate writes. A workflow executes outside the candidate sandbox and therefore must not be created or changed through `grande_repo_edit`, GitHub API bypasses, or another write channel merely to make CI convenient.

The task branch now provides deterministic repository-owned commands:

- `pnpm test:selfhost-safe`
- `pnpm typecheck`
- `pnpm test:tool-contract`
- `pnpm ci:verify` (runs the three checks above in order)

`test:selfhost-safe` matches the trusted selfhost boundary: the normal Vitest config excludes `tests/host/**/*.host.test.ts`, and the command additionally excludes the five legacy host anchors (`sandbox`, `runner`, `server`, `tools`, `e2e`). The focused tool-contract check runs `tests/toolsetIdentity.test.ts` and `tests/onboardingTools.test.ts`, including the current 25-tool / toolset-epoch-2 invariant.

## Human-applied workflow

Create `.github/workflows/ci.yml` on the Phase 7 task branch with exactly this minimal workflow (or an equivalent reviewed variant that preserves the same commands and versions):

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm ci:verify
```

## Acceptance after the Human commit lands

1. Re-read the task HEAD and confirm the workflow commit is on this exact branch.
2. Re-run `unit-selfhost` and `typecheck` locally on the new exact HEAD.
3. Push/open the PR through the existing GrandeGPT GitHub loop.
4. Require a real GitHub CI result for the exact PR head. `CI=none` is not acceptable for GG-BL-018 closeout.
5. Do not move Seatbelt, LaunchAgent, loopback ownership, or trusted Host Verifier suites into Linux CI. Those remain separate host evidence.
