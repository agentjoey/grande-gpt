# GG-BL-010 C-macOS-App Supplemental Validation Evidence

Date: 2026-08-23
Client: ChatGPT macOS native app
ChatGPT app version: `not observed`
macOS version: `not observed`
Model: GPT-5.6 Sol
Runbook basis: `docs/chatgpt-connector-compatibility-runbook.md` §7.2, applied as supplemental validation
Verdict: **PASS**

## Scope and non-substitution rule

This run is supplemental client-coverage evidence for `GG-BL-010`. It is **not** a fourth member of the §7.2 formal matrix and does not alter, replace, override, or reinterpret the verdict of any formal run.

The formal matrix remains exactly:

1. `C-Web-1`
2. `C-iOS`
3. `C-Web-2`

A PASS or FAIL in this macOS App run cannot turn an already-complete formal matrix into a different verdict. In particular, this result cannot substitute for any missing C-Web-2 boundary evidence.

## Client capability evidence

During the fresh ChatGPT macOS native app conversation, GrandeGPT direct capabilities remained callable for the entire supplemental run.

Observed client metadata:

- ChatGPT app version: `not observed`
- macOS version: `not observed`
- model: `GPT-5.6 Sol`
- client-visible tool count: `not observed`
- GrandeGPT capability availability: continuously callable through the final probes

No unobserved client metadata is inferred.

## Frozen production identity

Before, during, and after the supplemental run, production identity remained stable:

- `gatewayBuild = git:1b9c620267137ac0af641b323c33183d3bdb13e0`
- `toolsetEpoch = 2`
- `toolsCount = 25`
- `toolsDigest = sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

No Gateway restart, contract change, or toolset identity drift was observed.

## Task A

Task A was an independent disposable development task and covered real repository inspection, capability inspection, bounded reads/searches, two real edits, intentional failing verification, passing verification, async job recovery, final task inspection, and cleanup.

Async jobs:

- RED: `job_04700fdc-a012-460d-bf0c-62a4b2cf5b0d`
- GREEN: `job_e759d731-02df-4587-9102-0a7b40db6a6c`

Each job received exactly one external `grande_run_result` call after reaching its terminal state. The RED job failed because of the intentional disposable test change. The GREEN job completed with **112 test files / 872 tests PASS**.

Task A budget:

- external GrandeGPT calls: **23 / 50**
- canonical delivered MCP output bytes: **74,158 bytes**

The disposable worktree and branch were removed after the task completed. No push, PR, or merge was performed.

## Task B

Task B was a second independent disposable development task started after Task A cleanup, with no reconnect, tool refresh, Gateway restart, contract change, or artificial long idle between tasks.

Async jobs:

- RED: `job_44766c83-0517-4257-936c-8f58e2fb869d`
- GREEN: `job_780292cf-5299-4c11-8ca7-22ff09da3879`

Each job received exactly one external `grande_run_result` call after reaching its terminal state. The RED job failed because of the intentional disposable test change. The GREEN job completed with **112 test files / 872 tests PASS**.

Task B budget:

- external GrandeGPT calls: **19 / 50**
- canonical delivered MCP output bytes: **56,701 bytes**

Task A → Task B gap: **11.937 seconds**, well below the 5-minute requirement.

The disposable worktree and branch were removed after the task completed. No push, PR, or merge was performed.

## MCP result budget reconciliation

Gateway telemetry used the canonical delivered MCP result size definition required by the runbook, i.e. the serialized MCP result corresponding to `JSON.stringify(toMcpTextResult(envelope))`.

Observed totals:

- Task A: **74,158 bytes**
- Task B: **56,701 bytes**
- Task A + Task B: **130,859 bytes** `< 1,048,576 bytes (1 MiB)`
- entire supplemental window: **49 calls / 179,858 bytes**
- maximum single result: **18,928 bytes** `< 32,768 bytes (32 KiB)`
- `outputBytes=unknown`: **0**

Both task call budgets remained below 50 external calls.

## Gateway boundary reconciliation

Host telemetry reconciled all **49** calls in the supplemental window. Every actual call that reached the server had the expected boundary evidence:

`[rpc] tools/call → POST /mcp → 200 → [tool]`

For all `[tool]` records in the window:

- `result=ok`
- `outputBytes` was numeric
- `correlation=none`
- no corresponding HTTP 401 was observed
- no SIGTERM or Gateway restart was observed
- no contract or identity change was observed

`correlation=none` is preserved as observed telemetry; no synthetic correlation is invented.

## Failure monitoring

Observed during the macOS App supplemental run:

- `The GrandeGPT tool has been disabled`: **0**
- `Resource not found`: **0**
- unexpected 401 / invalid bearer / auth failure on the supplemental call path: **0**
- Gateway restart: **0**
- toolset identity drift: **0**
- App/session binding failure: **0**

The final same-conversation probes both succeeded:

- final `grande_task_status`: **PASS**
- final `grande_repo_read`: **PASS**

## Supplemental gate decision

The C-macOS-App run satisfies the same operational budgets and boundary checks used by §7.2 for evidence quality:

- two independent disposable development tasks completed
- Task A `23 ≤ 50` calls
- Task B `19 ≤ 50` calls
- Task A + B `130,859 bytes ≤ 1 MiB`
- maximum single result `18,928 bytes ≤ 32 KiB`
- intentional failing → passing verification occurred in both tasks
- four async jobs used stable job IDs and each received exactly one external `grande_run_result`
- Task B began 11.937 seconds after Task A
- final `grande_task_status` and `grande_repo_read` succeeded
- no disabled / Resource not found / unexpected 401 / restart / identity drift occurred
- frozen production identity remained stable
- all 49 server-arriving calls were reconciled at the Gateway boundary

**C-macOS-App supplemental validation: PASS.**

This result is supplemental client-coverage evidence for `GG-BL-010`. It does not alter the composition or verdict of the §7.2 formal matrix.

At the time this evidence is recorded, no claim is made here that `C-Web-2` has independently completed its final boundary reconciliation. Therefore this document does not, by itself, establish `GG-BL-010 formal matrix = 3/3 PASS`.

Even after the independent formal matrix reaches 3/3 PASS, `GG-BL-010` remains `MITIGATED` until the runbook §7.3 seven-day ordinary-use observation is completed successfully; supplemental macOS App PASS does not permit an early transition to `DONE`.
