# ChatGPT-driven Repository Onboarding Tools — Design

Date: 2026-08-19
Status: approved in chat; pending written-spec review
Scope: GrandeGPT Phase 5 S9 follow-up

## 1. Goal

Allow a Human Owner to initiate repository registration in ChatGPT, review a read-only readiness proposal, explicitly confirm the registration, and let GrandeGPT perform the controlled-plane write. The change removes the need to copy `grande repo add ... --apply` into a local terminal for the normal path while preserving the existing CLI as a fallback.

The authorization boundary does not move: repository contents may be discovered, but discovery never authorizes registration. `grande_task_open` must continue to reject unregistered repositories and must not auto-register them.

## 2. Non-goals

This change does not add repo creation/init/scaffolding, GitHub repo creation, dependency installation, remote push, automatic task creation, unregister/list lifecycle management, raw filesystem/Git/shell access, or arbitrary absolute-path execution input.

## 3. MCP surface

Add exactly two native tools.

### 3.1 `grande_repo_add_propose`

Input:

```json
{ "repoId": "grande-console" }
```

The tool accepts only `repoId`. It derives the candidate as `GRANDE_WORKSPACE/<repoId>` through the existing S9 path-security primitive. It does not accept an absolute path.

Annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

The handler reuses `inspectRepoOnboarding` and returns the existing S9 readiness facts: safe resolved path, Git repository state, HEAD, branch/detached state, canonical busy markers, package manager, proposed trusted profiles, remote/GitHub/CI/deploy/dependency hints, blockers, and `readyToRegister`.

It additionally returns `proposalDigest`, a deterministic `sha256:` identity that binds the proposal to both the candidate state and the relevant control-plane pre-state. The proposal remains zero-write.

### 3.2 `grande_repo_add_apply`

Input:

```json
{
  "repoId": "grande-console",
  "proposalDigest": "sha256:..."
}
```

Annotations:

- `readOnlyHint: false`
- `destructiveHint: false`
- `openWorldHint: false`

This tool is the explicit write action. ChatGPT/user approval of this separate tool invocation is the Human Owner authorization event; the model may not synthesize authorization by calling it immediately after discovery without the user's confirmation.

The handler must, before the first control-plane write:

1. resolve the candidate path again with existing path security;
2. re-run the shared Git/worktree readiness inspection;
3. re-read proposal-relevant repository discovery state;
4. re-read the relevant control-plane pre-state (`repos.yaml` / `profiles.yaml` presence and contents);
5. recompute `proposalDigest` and compare it with the supplied digest;
6. parse/shape-validate all intended config writes.

If readiness fails or the digest is stale, the handler fails before mutation. Staleness uses the existing `StateError("STALE_STATE", ...)` path so the public envelope remains within the established error taxonomy and is retryable by re-proposing; no new persistent state machine or error family is introduced.

After successful validation, the handler reuses the existing `applyRepoOnboarding` mutation path. Existing trusted profile entries must never be overwritten. A fresh propose/apply cycle on an already registered repository remains idempotent.

## 4. Proposal digest

The digest is deterministic and internal to the onboarding flow. It is calculated from a stable serialization of:

- `repoId` and resolved real path;
- Git readiness identity, including repository/head/head SHA/branch/detached/busy reasons/inspection error;
- discovered package manager and proposed profile argv/timeouts;
- remote/GitHub/CI/deploy/node_modules discovery fields;
- current registration record relevant to this `repoId`;
- raw-byte SHA-256 fingerprints (or explicit missing sentinels) for the trusted `repos.yaml` and `profiles.yaml` control-plane files.

Object keys and arrays with semantic set behavior are normalized before hashing. No secrets, remote credentials, or file contents are returned to the model; only the final digest is returned.

Because the digest includes control-plane pre-state, an unrelated trusted-config edit between proposal and apply intentionally makes the proposal stale. The user/model must re-propose before writing.

## 5. Data flow

```text
Human: “注册 grande-console”
        |
        v
grande_repo_add_propose(repoId)
        |
        +-- existing S9 path security
        +-- existing canonical Git/worktree readiness
        +-- profile/discovery inspection
        +-- trusted control-plane fingerprints
        |
        v
read-only proposal + proposalDigest
        |
        v
Human explicitly confirms
        |
        v
grande_repo_add_apply(repoId, proposalDigest)
        |
        +-- repeat all security/readiness/discovery checks
        +-- compare current digest
        +-- validate intended writes
        |
   stale/blocked ----> fail, zero writes
        |
        v
existing applyRepoOnboarding
        |
        v
registered repo + missing trusted profiles only
```

A subsequent `grande_task_status` / `grande_task_open` is the lifecycle proof. Registration is never implicit in `grande_task_open`.

## 6. Tool assembly and compatibility identity

The two tools are added through the single production assembly path in `src/tools.ts` (prefer a focused `onboardingTools.ts` adapter rather than putting handlers into the CLI or duplicating S9 logic).

This is a real MCP contract release:

- tool count changes from 23 to 25;
- `TOOLSET_EPOCH` changes from 1 to 2;
- deterministic `toolsDigest` must change because names/schemas/annotations changed;
- `gatewayBuild` remains independent and follows the deployed checkout/build;
- the connector compatibility runbook/README baseline is updated to 25 tools / epoch 2 and requires Scan/Refresh Tools plus a new chat/read probe after deployment.

No third onboarding tool is added.

## 7. Error and safety semantics

- invalid/symlink/outside/direct-child path: existing path-security error, zero writes;
- invalid Git/no HEAD/detached/busy/inspection failure: not ready, zero writes;
- stale proposal digest: retryable stale-state error, zero writes;
- malformed trusted config: validation error, zero writes;
- already registered with a fresh matching proposal: success/idempotent; preserve existing profiles;
- unexpected disk I/O after the first write is not converted into a new transaction system in this task; the existing S9 validation-before-mutation guarantee remains the scope boundary.

All error messages continue through GrandeGPT redaction before they reach the MCP envelope.

## 8. Acceptance tests

1. `grande_repo_add_propose` is read-only, takes only `repoId`, and returns existing S9 readiness plus a deterministic `proposalDigest`.
2. Proposal causes byte-for-byte zero changes to `repos.yaml` and `profiles.yaml`.
3. Valid Git `main` + HEAD proposal reports ready; apply registers it and fills only missing common profiles.
4. Empty/no-HEAD, detached HEAD, each canonical busy marker, and invalid/symlink path fail closed with no control-plane mutations.
5. Changing HEAD/branch/busy state between proposal and apply makes apply fail stale/not-ready with zero writes.
6. Changing `repos.yaml` or `profiles.yaml` between proposal and apply makes the digest stale and causes zero writes.
7. A fresh second propose/apply is idempotent and preserves pre-existing trusted profile definitions.
8. After apply, `registeredIds` includes the repo and `openWorktree`/`grande_task_open` succeeds.
9. `grande_task_open` still rejects the same repo before registration and contains no auto-register fallback.
10. Tool definitions have exactly the approved annotations and schemas; tools/list is deterministic with 25 tools.
11. `TOOLSET_EPOCH === 2`; digest differs from the 23-tool epoch-1 contract and remains stable under descriptions/implementation-only changes.

## 9. Load-bearing proofs

A. Remove candidate HEAD/readiness enforcement: empty-repo acceptance must turn red.

B. Skip digest comparison: repository/control-plane stale-proposal tests must turn red.

C. Move the first registry/profile write before digest/readiness/config validation: failed-apply zero-write tests must turn red.

D. Bypass shared S9 inspection/path primitives in MCP proposal/apply: parity tests against CLI/openWorktree must turn red.

E. Remove the epoch bump or one onboarding tool from production assembly: toolset identity/count contract test must turn red.

## 10. Verification and release

Implementation acceptance uses `unit-selfhost` + `typecheck`, followed by the repository-required host `outer-test --run` before merge. After deployment, verify `gatewayBuild / toolsetEpoch=2 / toolsCount=25 / toolsDigest`, refresh the ChatGPT App tool snapshot, start a new chat, run a read probe, and only then use the new write tool against a real repository such as `grande-console`.
