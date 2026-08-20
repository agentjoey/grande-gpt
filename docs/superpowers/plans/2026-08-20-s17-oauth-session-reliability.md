# S17 OAuth Session Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ChatGPT OAuth sessions from becoming unusable after access-token expiry and make a gateway restart fail closed until its HTTP endpoint is ready.

**Architecture:** The OAuth authorization record retains the requested supported scopes in memory long enough to mint a token response, and only an `offline_access` grant mints a persisted refresh token. Discovery documents advertise that grant. Gateway lifecycle restart uses launchd's in-place restart plus an injected/default readiness probe so a command cannot report success before the endpoint is reachable.

**Tech Stack:** TypeScript, Vitest, SQLite, OAuth 2.1/PKCE, macOS launchd.

**Spec:** User-reported S17 incident and the established OAuth contract in `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`.

## Global Constraints

- Preserve PKCE, resource/audience validation, and strict refresh-token replay revocation.
- Do not log bearer tokens, authorization codes, refresh tokens, or client secrets.
- Do not deploy or recreate the ChatGPT app without owner authorization.
- Keep the existing P55 worktree untouched.

---

### Task 1: OAuth offline session contract and diagnostics

**Files:**
- Modify: `src/oauth.ts`, `src/server.ts`
- Test: `tests/oauth.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Produces: metadata with `grande:workspace` and `offline_access`; authorization-code responses issue a refresh token only after an `offline_access` grant.

- [ ] **Step 1: Write failing behavioral tests** for discovery, an online-only authorization, an offline authorization, and a refresh after restart.
- [ ] **Step 2: Run the focused OAuth tests** and verify current metadata/behavior fails the offline-session contract.
- [ ] **Step 3: Implement the smallest scope parsing, response shaping, and sanitized denial logging changes.**
- [ ] **Step 4: Run focused OAuth/server tests** and verify all behaviors pass.

### Task 2: Gateway restart readiness

**Files:**
- Modify: `src/launchd.ts`, `src/gatewayCli.ts`
- Test: `tests/launchd.test.ts`

**Interfaces:**
- Produces: `restart` uses `launchctl kickstart -k`, then requires a bounded HTTP readiness result before returning success.

- [ ] **Step 1: Write a failing lifecycle test** showing a loaded service cannot be reported restarted before readiness succeeds.
- [ ] **Step 2: Run the focused launchd test** and verify it fails against the existing bootout/bootstrap sequence.
- [ ] **Step 3: Implement bounded readiness probing and inject issuer only at the CLI boundary.**
- [ ] **Step 4: Run focused launchd tests** and verify successful, failed, and timeout-like probes have the expected command results.

### Task 3: Verification and release handoff

**Files:**
- Review: changed files only.

- [ ] **Step 1: Run focused tests and typecheck.**
- [ ] **Step 2: Run the full suite in the authorized host environment and record any unrelated baseline failure.**
- [ ] **Step 3: Inspect the final diff and prepare Pact review evidence; do not merge or deploy.**
