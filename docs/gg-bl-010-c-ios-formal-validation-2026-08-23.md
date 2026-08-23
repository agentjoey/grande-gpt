# GG-BL-010 C-iOS Formal Validation Evidence

Date: 2026-08-23
Client: ChatGPT iOS native
ChatGPT app: 1.2026.224
OS: iOS 26.6
Model: GPT-5.6 Sol
Runbook: `docs/chatgpt-connector-compatibility-runbook.md` §7.2
Verdict: **PASS**

## Scope and run boundary

This is the independent C-iOS formal matrix run. It does not reuse the C-Web-1 disposable tasks or runtime evidence.

Exact Gateway telemetry window for the C-iOS run:

- first formal read probe result: `11:42:35.817 grande_task_status`
- final required read result: `11:47:22.627 grande_repo_read`
- all calls in this window that reached Gateway have matching `tools/call`, `POST /mcp → 200`, and `[tool]` telemetry.

Two setup/read-only calls before Task A are kept outside the per-task budgets: initial `grande_task_status` and runbook `grande_repo_read`.

## Frozen identity

Before and after the formal run the production identity was unchanged:

- `gatewayBuild = git:1b9c620267137ac0af641b323c33183d3bdb13e0`
- `toolsetEpoch = 2`
- `toolsCount = 25`
- `toolsDigest = sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

No Gateway restart or toolset identity drift was observed in the exact run window.

## Task A

Disposable task: `task-ggbl010-cios-a-20260823`

Coverage:

- native capability inspect: `grande_capability_inspect`
- disposable task open
- real repo map / line-range read
- two real edit calls
- real async `unit-selfhost` verification
- deliberate failing verification followed by passing verification
- final task-scoped read and status
- task/worktree/branch cleanup

Verification:

- failing job `job_bc03ea73-254e-48ff-997f-deebfe8e51c9`: `1 failed | 112 passed` files, `1 failed | 871 passed` tests
- passing job `job_ec179072-4b14-4056-a426-160e130e8afa`: `113 passed` files, `872 passed` tests
- each job reached terminal state through `grande_task_status`, then received exactly one external `grande_run_result` call

One initial `grande_task_open` request failed with a normal `INVALID_INPUT` because the optional TaskBrief supplied by the client omitted the server-required `source` member. It reached Gateway, was counted in calls and bytes, created no task, and did not cause an auth/binding failure.

Task A budget, assigning the pre-open capability inspect to Task A conservatively:

- external GrandeGPT calls: **16**
- canonical delivered MCP output bytes: **38,625 bytes**
- largest single Task A result: **7,514 bytes**

## Task B

Disposable task: `task-ggbl010-cios-b-20260823`

Coverage:

- independent task open after Task A cleanup
- real paginated repo search
- two real edit calls
- real async `unit-selfhost` verification
- deliberate failing verification followed by passing verification
- task-scoped read plus bounded repo inspection used to determine whether Gateway telemetry was directly exposed through the tool surface
- task/worktree/branch cleanup
- required final `grande_task_status` and final `grande_repo_read` both succeeded after Task B

Verification:

- failing job `job_383b32cd-2c66-4950-86a6-e8c9eb7e1ae4`: `1 failed | 112 passed` files, `1 failed | 871 passed` tests
- passing job `job_de8431fa-0b53-4fdb-9c8a-a1a2734675ef`: `113 passed` files, `872 passed` tests
- each job reached terminal state through `grande_task_status`, then received exactly one external `grande_run_result` call

Task B budget, including the required final status/read probes:

- external GrandeGPT calls: **20**
- canonical delivered MCP output bytes: **47,637 bytes**
- largest single Task B result: **6,620 bytes**

Task A closed at `[tool] 11:44:52.183`. Task B's opening request reached `[rpc] tools/call` at `11:44:57.499`, a gap of approximately **5.3 seconds**, safely below the 5-minute requirement. No reconnect, Refresh/Scan Tools, Gateway restart, contract change, or artificial long idle occurred between tasks.

## MCP result budget reconciliation

Gateway telemetry records `outputBytes` using the canonical delivered MCP result definition required by the runbook: `JSON.stringify(toMcpTextResult(envelope))`.

Per-task totals:

- Task A: `38,625 bytes`
- Task B: `47,637 bytes`
- Task A + Task B: **86,262 bytes** `< 1,048,576 bytes (1 MiB)`

For completeness, the two run-level setup/read-only results add `27,046 bytes`, making the entire C-iOS window **113,308 bytes**.

Largest single result in the entire C-iOS window: **20,426 bytes** `< 32,768 bytes (32 KiB)`.

All C-iOS `[tool]` lines reported a numeric `outputBytes`; there were zero `outputBytes=unknown` results in the formal window.

## Boundary and failure monitoring

Observed in the C-iOS client during the formal run:

- `The GrandeGPT tool has been disabled`: **none**
- `Resource not found`: **none**
- App/tool binding failure: **none**
- auth failure / invalid bearer on the formal call path: **none**
- Gateway restart: **none**
- toolset identity drift: **none**

Every C-iOS tool call shown in the exact stdout window has `POST /mcp → 200`. The separately tailed stderr contains repeated untimestamped `[auth] /mcp denied reason=missing_bearer` lines, but they cannot be correlated to the C-iOS formal calls and no corresponding HTTP 401 occurs in the exact C-iOS stdout window. They are therefore not counted as an unexpected C-iOS 401. No attempt is made to infer their source.

All formal calls have `correlation=none`, consistent with the current telemetry behavior when no safe session correlation value is available. No synthetic correlation was invented.

## Formal gate decision

C-iOS satisfies the §7.2 hard pass criteria:

- both disposable development tasks completed and were cleaned up
- Task A `16 ≤ 50` calls
- Task B `20 ≤ 50` calls
- Task A + B `86,262 bytes ≤ 1 MiB`
- maximum single result `20,426 bytes ≤ 32 KiB`
- real failing → passing verification occurred in both tasks
- async jobs used stable `jobId` values and each terminal job received only one external `grande_run_result`
- Task B began about 5.3 seconds after Task A cleanup
- final `grande_task_status` and `grande_repo_read` succeeded
- no tool-disabled / Resource-not-found / unexpected formal-path 401 / restart / identity drift was observed
- frozen production identity remained unchanged

**C-iOS formal validation: PASS.**

This does not close `GG-BL-010`. With C-Web-1 already independently PASS, the formal matrix is now 2/3 complete and still requires independent C-Web-2. After all three formal runs pass, the backlog remains `MITIGATED` until the runbook §7.3 seven-day ordinary-use observation also completes.
