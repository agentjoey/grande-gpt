# ChatGPT Binding Budget Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to execute this plan task-by-task. Keep every production change behind RED-GREEN evidence and do not claim the incident fixed until the real ChatGPT acceptance matrix passes.

**Goal:** Prevent a healthy GrandeGPT Gateway from becoming unusable at the second or later user task in one ChatGPT conversation by reducing duplicated tool-result context, lowering polling and whole-file traffic, and making the remaining host/client boundary measurable.

**Architecture:** Treat the observed disablement as a conversation-lifecycle failure at the ChatGPT/App boundary, not as a proven fixed call quota. First ship a contract-preserving Release A: classify every request at the Gateway boundary, encode each logical result once, wait briefly inside `grande_run_result`, and enforce bounded read/search responses. Only if the real two-task gate still fails, ship one contract-changing Release B with compact edit operations and one toolset epoch bump. The server remains authoritative for worktree safety; no second execution channel, reconnect loop, or client-side bypass is introduced.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Hono, MCP SDK 1.x, SQLite, existing GrandeGPT CLI/LaunchAgent tooling.

**Spec:** `docs/BACKLOG.md` — `GG-BL-010`, together with `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md`

## Corrected root-cause boundary

The available evidence does **not** establish a universal “256 tool calls per conversation” limit or a five-hour/daily limit:

- one failed conversation stopped after 89 Gateway tool calls: 76 in task A and 13 in task B;
- another reached exactly 256 calls before the next call was disabled;
- in both samples the final disabled call never reached `/mcp`, `[rpc]`, or `[tool]` on the Gateway;
- neither sample coincided with a Gateway restart, OAuth 401, token expiry, handler exception, or server-side rate limiter;
- the same user-visible message has also appeared in a distinct first-call discovery/binding failure, so the text alone does not identify one mechanism.

The working hypothesis is therefore cumulative conversation pressure plus a task-boundary/client-binding transition: number of tool call/result items, serialized result bytes, repeated polls, duplicated result representation, and conversation compaction may combine to make ChatGPT disable or lose the tool binding. This plan reduces every server-controlled contributor and requires a real ChatGPT two-task test to distinguish mitigation from cure.

## Global Constraints

- Do not describe 256 as a documented or confirmed quota.
- Do not lower `readOnlyHint`, `destructiveHint`, or `openWorldHint` to make calls easier to dispatch.
- Do not add a direct host shell, alternate MCP endpoint, hidden reconnect path, or automatic app recreation.
- Do not log file contents, edit bodies, tokens, Authorization headers, or raw MCP session identifiers.
- Release A must not change tool names, input schemas, required fields, or annotations; `TOOLSET_EPOCH` stays `2`.
- Release B may change the contract only once; all accepted Release B schema changes land together with `TOOLSET_EPOCH` `2 → 3` and one deliberate ChatGPT “Refresh Tools”.
- A passing unit/e2e suite is necessary but insufficient. `GG-BL-010` remains OPEN until the real ChatGPT acceptance matrix passes.
- No database migration is required by either release.

---

### Task 1: Reopen the incident and correct the reliability contract

**Files:**
- Modify: `docs/BACKLOG.md`
- Modify: `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md`
- Modify: `tests/guidance.test.ts`

**Interfaces:**
- `GG-BL-010` becomes the authoritative P0 record.
- The reliability design gains a “conversation budget” invariant without turning async jobs into long synchronous MCP calls.

- [ ] In `tests/guidance.test.ts`, add a documentation contract test that loads both files and asserts:
  - `GG-BL-010` has `Status: OPEN` and `Priority: P0`;
  - the Done condition contains a same-conversation, two-user-task ChatGPT gate;
  - the design states that asynchronous jobs remain asynchronous but status polling is bounded/coalesced;
  - neither current document calls 256 a confirmed quota.
- [ ] Run `pnpm exec vitest run tests/guidance.test.ts` and confirm the new assertions fail because the backlog currently says `MITIGATED` and the design encourages unconstrained status/result polling.
- [ ] Rewrite `GG-BL-010` evidence with the two distinct observed samples (89 calls and 256 calls), their last-Gateway-request boundary, and the absence of restart/401 evidence.
- [ ] Replace the current “binding regression passed” Next/Done text with the release and acceptance gates from this plan.
- [ ] Amend design §2.5 and the target runtime model: jobs still return promptly, but the client should make one result request after the hint and the result handler may wait for a short bounded interval before returning `running` again.
- [ ] Add explicit output-budget principles: paginate source/search/diff data, avoid whole-file rewrites when a compact operation is available, and never return the same logical payload in both MCP `content` and `structuredContent`.
- [ ] Re-run `pnpm exec vitest run tests/guidance.test.ts` and confirm it passes.
- [ ] Commit only the documentation/test correction before changing runtime behavior so later incident claims can be audited independently.

---

### Task 2: Add privacy-safe MCP call telemetry

**Files:**
- Create: `src/mcpTelemetry.ts`
- Create: `tests/mcpTelemetry.test.ts`
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**

```ts
export interface McpCallMetrics {
  correlation: string;
  inputBytes: number;
  outputBytes: number;
}

export function jsonByteLength(value: unknown): number;
export function requestCorrelation(headers: Headers): string;
```

`requestCorrelation()` returns `none` when `Mcp-Session-Id` is absent; otherwise it returns a stable `mcp:<12 hex>` digest. It must never inspect or hash `Authorization`.

- [ ] Write `tests/mcpTelemetry.test.ts` cases for UTF-8 byte length, stable session digest, missing session header, and a request containing unique bearer/file-content markers.
- [ ] Add an integration assertion in `tests/server.test.ts`: one authenticated `tools/call` produces a `[tool]` line containing `correlation`, `inputBytes`, `outputBytes`, duration, result status, and sorted argument keys, but none of the marker values.
- [ ] Add a no-session case and assert the log says `correlation=none` without inventing a conversation id.
- [ ] Run `pnpm exec vitest run tests/mcpTelemetry.test.ts tests/server.test.ts` and confirm RED.
- [ ] Implement the pure helpers, then update the `registerTool` callback in `src/server.ts` to compute sizes from the parsed arguments and serialized logical envelope.
- [ ] Log exactly one line per executed tool using safe metadata. Preserve the existing `[rpc]` and `[gw]` layers so the diagnosis remains:
  - no `POST /mcp`: pre-Gateway/client binding;
  - `/mcp` without `[rpc]`: auth/protocol/transport;
  - `[rpc] tools/call` without `[tool]`: dispatch/SDK;
  - `[tool]`: handler executed.
- [ ] Re-run the targeted tests and confirm GREEN.

---

### Task 3: Encode each logical MCP result once

**Files:**
- Create: `src/mcpToolResult.ts`
- Create: `tests/mcpToolResult.test.ts`
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/selfcheck.test.ts`

**Interfaces:**

```ts
export function toMcpTextResult(envelope: unknown): {
  content: [{ type: "text"; text: string }];
};
```

GrandeGPT has no MCP widget that needs a separate `structuredContent` payload. The canonical model-visible result remains the existing JSON envelope, serialized once into text content.

- [ ] Add a unit test with a unique nested marker and assert the helper output contains exactly one serialized copy, has no `structuredContent` property, and parses back to the original envelope.
- [ ] Add a server integration test for a real `tools/call` response and count the marker across the decoded JSON-RPC result; it must occur once.
- [ ] Add a compatibility test proving `grande selfcheck` can read the canonical text-content envelope when `structuredContent` is absent. Keep parsing support for an older Gateway that still returns `structuredContent` during rollback/mixed-build diagnosis.
- [ ] Run `pnpm exec vitest run tests/mcpToolResult.test.ts tests/server.test.ts tests/selfcheck.test.ts` and confirm RED: current `src/server.ts` returns the full envelope in both fields and selfcheck only reads `structuredContent`.
- [ ] Implement `toMcpTextResult()` and use it only at the MCP server boundary. Do not change internal `ToolDef.handler()` results: internal composition in `tools.ts`, deployment, capability, task-brief, and tests continues to use `{ structuredContent }`.
- [ ] Update selfcheck response extraction to prefer text `content`, fall back to legacy `structuredContent`, and fail closed on malformed or non-envelope text.
- [ ] Confirm `src/toolsetIdentity.ts` remains unchanged: this is response encoding, not a tool name/schema/annotation change.
- [ ] Re-run the targeted tests and confirm GREEN.

---

### Task 4: Coalesce job-result polling without changing the schema

**Files:**
- Create: `src/jobWait.ts`
- Create: `tests/jobWait.test.ts`
- Modify: `src/toolsCore.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/e2e.test.ts`

**Interfaces:**

```ts
export const JOB_RESULT_WAIT_MS = 15_000;

export async function waitForTerminalJob(
  db: DatabaseSync,
  jobId: string,
  options?: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void>;
```

The helper returns immediately when the job is missing or terminal, otherwise waits at most 15 seconds and polls SQLite internally. It does not kill, mutate, or re-run jobs.

- [ ] In `tests/jobWait.test.ts`, use an injected sleeper—never real 15-second sleeps—to cover terminal-at-entry, transition to terminal, deadline reached, and missing job.
- [ ] In `tests/tools.test.ts`, call `grande_run_result` for a running fixture and assert the handler waits through an injected state transition and returns the terminal envelope in one external call.
- [ ] In `tests/e2e.test.ts`, add a fast real job case that proves `grande_run → one grande_run_result` reaches terminal without a tight external polling loop.
- [ ] Run the three targeted files and confirm RED.
- [ ] Implement the helper and update only the `grande_run_result` handler:
  1. look up `jobId`;
  2. when present and non-terminal, await the bounded helper;
  3. call the existing `wrap()`/`jobReport()` path to preserve all current envelopes and error mapping.
- [ ] Update the running hint to say the call already waited 15 seconds and the caller should wait for `pollAfterSeconds` before trying again; do not tell the model to loop immediately.
- [ ] Keep the input schema exactly `{ jobId }`, so Release A does not bump `TOOLSET_EPOCH`.
- [ ] Re-run the targeted tests and confirm GREEN.

---

### Task 5: Bound repository read and search result volume

**Files:**
- Modify: `src/repoFile.ts`
- Modify: `src/repoSearch.ts`
- Modify: `src/toolsCore.ts`
- Modify: `tests/repoFile.test.ts`
- Modify: `tests/repoSearch.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/e2e.test.ts`

**Interfaces and limits:**

```ts
export const DEFAULT_REPO_READ_BYTES = 16 * 1024;
export const MAX_REPO_READ_BYTES = 24 * 1024;
export const DEFAULT_SEARCH_MATCHES = 20;
export const MAX_SEARCH_MATCHES = 25;
export const MAX_SEARCH_RESULT_BYTES = 16 * 1024;
```

- [ ] Add `repoRead()` tests that 16 KiB is the default, 24 KiB is accepted, values above 24 KiB return `INVALID_INPUT`, and truncated content preserves full-file `sha256`, `bytes`, `totalLines`, and a usable continuation hint.
- [ ] Add `repoSearch()` tests for a maximum of 25 requested matches and a 16 KiB serialized result budget. Assert `truncated=true` and a stable `nextCursor` whenever either cap stops the response.
- [ ] Add tool/e2e tests that the schema descriptions state the hard limits and that callers can retrieve the next page without duplicate or skipped matches.
- [ ] Run `pnpm exec vitest run tests/repoFile.test.ts tests/repoSearch.test.ts tests/tools.test.ts tests/e2e.test.ts` and confirm RED.
- [ ] Implement strict numeric validation. Reject non-integers, non-positive values, and over-limit values; do not silently clamp caller intent.
- [ ] Apply the byte budget after assembling search matches. Remove trailing matches until the serialized result fits, then compute `nextCursor` from the actual number returned.
- [ ] Keep line-range reads and pagination as the recovery path; the hint must show the exact next call, not merely say “truncated”.
- [ ] These are validation/behavior limits on existing numeric fields, not schema shape changes; keep epoch `2`, but record the behavior in connector compatibility documentation.
- [ ] Re-run the targeted tests and confirm GREEN.

---

### Task 6: Release A full regression and staging A/B

**Files:**
- Modify: `docs/chatgpt-connector-compatibility-runbook.md`
- Modify: `docs/BACKLOG.md`
- Test: all `tests/*.test.ts`

**Release A composition:** Tasks 1–5 only. No app recreation and no “Refresh Tools”; Gateway restart is sufficient because the externally visible tool contract remains epoch `2`.

- [ ] Add a runbook section that records a baseline and candidate table with: platform, ChatGPT model, app version/tool count, Gateway build, toolset epoch/digest, task A calls/bytes, task B calls/bytes, disabled timestamp, last matching Gateway correlation, and any 401/restart.
- [ ] Add an automated regression that serializes representative `repo_read`, `repo_search`, `run_result`, and error envelopes and asserts:
  - each individual result is at most 32 KiB;
  - the same sequence is materially smaller than the legacy duplicated wire encoding;
  - no test depends on a magic total-call cutoff.
- [ ] Run targeted tests:

```bash
pnpm exec vitest run \
  tests/mcpTelemetry.test.ts \
  tests/mcpToolResult.test.ts \
  tests/jobWait.test.ts \
  tests/server.test.ts \
  tests/selfcheck.test.ts \
  tests/repoFile.test.ts \
  tests/repoSearch.test.ts \
  tests/tools.test.ts \
  tests/e2e.test.ts \
  tests/guidance.test.ts
```

- [ ] Run repository gates:

```bash
pnpm typecheck
pnpm test
```

- [ ] Run the existing host-only verification against the exact clean task commit:

```bash
GRANDE_WORKSPACE=/Users/xtation/AgentWorks/GPT_Workspace \
node --disable-warning=ExperimentalWarning src/cli.ts \
  outer-test --task <release-a-task-id> --run
```

- [ ] Deploy Release A to staging/production through the existing guarded Gateway workflow and record the exact `gatewayBuild`, `toolsetEpoch=2`, `toolsCount`, and `toolsDigest` from `grande selfcheck`.
- [ ] Perform the real acceptance matrix in Task 7. Do not mark `GG-BL-010` MITIGATED or FIXED based on automated tests alone.

---

### Task 7: Real ChatGPT two-task release gate

**Files:**
- Modify: `docs/chatgpt-connector-compatibility-runbook.md`
- Modify: `docs/BACKLOG.md`

**Test setup:** Use a newly created ChatGPT conversation with the already configured GrandeGPT app. Do not reconnect, refresh tools, recreate the app, restart the Gateway, or open a new conversation between task A and task B.

**Task A — representative development loop:**

1. `grande_task_open` a disposable task.
2. Inspect using map/search/ranged reads.
3. Make at least two edits.
4. Run one failing approved profile, inspect the result, fix it, and run to pass.
5. Inspect diff, checkpoint/rollback once, re-apply the correction, commit, and query status.

**Boundary condition:** After task A completes, immediately send a new user message that begins a distinct task B; task B must start within five minutes. Do not add an artificial idle period. The release gate is testing the new user turn/task transition under normal continuous use, not elapsed wall-clock time. Long-idle and OAuth-refresh behavior remains a separate observation and cannot block this two-task gate.

**Task B — second independent task in the same conversation:**

1. Open another disposable task from the current canonical base.
2. Inspect at least five source/test/doc files through pagination or line ranges.
3. Make at least two edits and run failing-then-passing verification.
4. Query final `grande_task_status` and perform one final `grande_repo_read` after the task is otherwise complete.

**Hard pass criteria:**

- zero `The GrandeGPT tool has been disabled` messages;
- every ChatGPT-dispatched call has matching `/mcp → [rpc] tools/call → [tool]` evidence;
- no unexpected 401, Gateway restart, or toolset identity change;
- task B begins within five minutes of task A completion, with no reconnect, refresh, app recreation, or forced idle;
- task A uses at most 50 external GrandeGPT calls and task B at most 50;
- combined serialized tool-result bytes are at most 1 MiB;
- no individual tool result exceeds 32 KiB;
- at least one real job reaches terminal with one external `grande_run_result` call;
- the final status and read calls succeed after the second task boundary.

**Matrix:**

- [ ] Run the full sequence once in ChatGPT Web.
- [ ] Run the full sequence once in the current iOS ChatGPT app.
- [ ] Repeat the Web sequence in a second fresh conversation to rule out a one-off session.
- [ ] Separately, outside the release-blocking two-task matrix, keep one low-volume session alive across an access-token refresh window and prove post-refresh calls reach the Gateway; record this as non-blocking auth evidence, not as part of the conversation-budget claim.
- [ ] Attach exact timestamps and redacted Gateway log slices for every run to the runbook.

**Decision:**

- All three two-task runs pass: set `GG-BL-010` to `MITIGATED`, not `FIXED`, and monitor seven days of ordinary use before closure.
- Any run fails before Gateway: keep `GG-BL-010` OPEN, retain Release A telemetry, and proceed to Task 8 only if its call/byte evidence shows the conversation is still dominated by edit payloads or multi-step status flows.
- A request reaches Gateway and fails at auth/protocol/handler: stop; diagnose that concrete server boundary before Task 8 because it is a different failure class.

---

### Task 8: Conditional Release B — compact edits with one contract refresh

Execute this task only when Task 7 fails pre-Gateway **and** Release A telemetry shows full-file modify bodies or repeated read-before-write calls are a dominant remaining contributor. The condition is evidence-based and fully defined; absence of that evidence means Release B is not authorized by this plan.

**Files:**
- Modify: `src/repoFile.ts`
- Modify: `src/toolsCore.ts`
- Modify: `src/toolsetIdentity.ts`
- Modify: `tests/repoFile.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/toolsetIdentity.test.ts`
- Modify: `tests/e2e.test.ts`
- Modify: `tests/connectorCompatibilityDocs.test.ts`
- Modify: `docs/chatgpt-connector-compatibility-runbook.md`

**New edit operation:**

```ts
type ReplaceEditOp = {
  op: "replace";
  path: string;
  oldText: string;
  newText: string;
  expectedSha256: string;
  expectedOccurrences: 1;
};
```

- [ ] Add RED tests proving replace rejects stale hashes, binary files, zero matches, multiple matches, non-`1` occurrence expectations, duplicate paths in one batch, deny-rule paths, and any failed batch without leaving partial writes.
- [ ] Add checkpoint/restore and audit assertions identical to existing `modify` semantics.
- [ ] Add an e2e test showing a small edit no longer sends the untouched rest of a large file and still produces the expected exact bytes.
- [ ] Add schema/digest tests first, then extend `grande_repo_edit` input documentation and parser with the new operation.
- [ ] Implement replace using exact string matching after existing path, UTF-8, staleness, and policy validation; apply it inside the existing checkpointed atomic batch.
- [ ] Bump `TOOLSET_EPOCH` from `2` to `3` in the same commit. Update compatibility docs and expected identity tests.
- [ ] Run:

```bash
pnpm exec vitest run \
  tests/repoFile.test.ts \
  tests/tools.test.ts \
  tests/toolsetIdentity.test.ts \
  tests/e2e.test.ts \
  tests/connectorCompatibilityDocs.test.ts
pnpm typecheck
pnpm test
```

- [ ] Run the exact-SHA host outer-test, deploy, verify the new build/digest, then perform one deliberate “Refresh Tools”. Do not recreate the app unless ChatGPT fails to acquire epoch `3` after the documented refresh procedure.
- [ ] Repeat Task 7 in fresh Web and iOS conversations. The same hard pass criteria apply.

---

### Task 9: Closeout, monitoring, and rollback

**Files:**
- Modify: `docs/BACKLOG.md`
- Modify: `docs/chatgpt-connector-compatibility-runbook.md`

- [ ] Preserve seven days of summarized, redacted counters only: successful calls per conversation correlation, cumulative input/output bytes, tool distribution, auth failures, Gateway restarts, and pre-Gateway disable reports. Do not retain content bodies or tokens.
- [ ] During monitoring, require at least five ordinary conversations that complete two or more user tasks; Web and iOS must both be represented.
- [ ] Move `GG-BL-010` from `MITIGATED` to `DONE` only when the seven-day window has no unexplained disablement and all hard gates remain satisfied.
- [ ] If disablement recurs before Gateway despite Release B and under the defined budgets, mark the item `BLOCKED — ChatGPT platform boundary` only after attaching repeatable evidence: timestamps, client/platform/model, app/toolset identity, last successful correlation, missing next Gateway request, and a minimal reproduction. Do not silently close it.

**Release A rollback:**

1. Stop rollout and restore the previous known-good Gateway commit through the existing guarded deployment path.
2. Restart/activate once and verify build identity and health.
3. No app refresh or database rollback is needed because epoch remains `2` and there is no migration.
4. Re-run one status/read probe in a fresh ChatGPT conversation and record the rollback build.

**Release B rollback:**

1. Restore the Release A Gateway commit.
2. Verify the server reports epoch `2` and the Release A digest.
3. Perform one deliberate ChatGPT tool refresh back to epoch `2`; do not leave mixed epoch expectations unrecorded.
4. Confirm `grande_task_status` and `grande_repo_read` in a fresh conversation.

## Completion definition

Implementation is complete only when:

1. Tasks 1–6 are GREEN and Release A is deployed with exact build evidence.
2. Task 7 passes three real same-conversation two-task runs under the call/byte budgets.
3. If and only if the Task 8 condition is met, Release B is implemented, epoch-bumped once, refreshed once, and Task 7 is repeated successfully.
4. Seven-day monitoring satisfies Task 9 before `GG-BL-010` is closed.

Until then, the accurate status is: **server-controlled risk reduced; root platform trigger not proven; P0 remains open or mitigated according to the gates above.**
