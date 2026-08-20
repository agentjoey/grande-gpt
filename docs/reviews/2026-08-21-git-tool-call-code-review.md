# Git and Tool-Call Code Review — 2026-08-21

## Scope

Detailed bug review of Git execution, MCP tool composition, audit behavior, tool metadata, error envelopes, and log/credential redaction. The review used behavior-first regression tests against real temporary Git repositories wherever Git state or hook behavior mattered.

## Fixed findings

| Severity | Finding | Fix and regression evidence |
|---|---|---|
| P0 | `git worktree add` inherited `core.hooksPath` and executed `post-checkout` with Gateway host privileges. | All `worktree.ts` Git calls now override `core.hooksPath=/dev/null`; a real marker hook proves the exploit and protection. |
| P0 | Commit, push, PR open/status/merge, and sync-base trusted the stored worktree path without proving its checked-out branch still matched `task.branch`. A switched or detached worktree could act on the wrong ref. | Added one shared branch/HEAD guard at every task Git boundary, before audit/network/mutation. Tests switch the real worktree branch and assert zero downstream side effects. |
| P1 | Push read one HEAD but pushed the mutable branch ref, allowing the pushed commit and returned commit to disagree during a race. | Push now sends the already-verified immutable SHA to the fixed task branch destination. |
| P1 | MCP `[tool]` logs serialized arbitrary argument values, including complete file bodies, paths, PR text, deployment data, or accidentally supplied credentials. | Logs retain tool name, result, duration, and sorted argument key names only. A unique secret-marker test proves values are absent. |
| P1 | Reusing a closed `taskId` entered canonical refresh/audit/Git before the duplicate was rejected; missing old worktrees could turn this into an internal error. | Duplicate IDs are rejected in wrapper preflight and core composition before refresh, audit, branch, or worktree changes. |
| P1 | `TASK_NOT_FOUND` enrichment inspected every active worktree. One stale/missing worktree replaced the intended error with an uncaught Git failure. | Active-task summaries tolerate unreadable worktrees and report `filesChanged: null`, preserving the original structured error. |
| P1 | Canonical admission missed in-progress revert and sequencer states. | Added `REVERT_HEAD` and `sequencer` busy markers, including a real revert-conflict test. |
| P1 | Repository diff could execute configured external diff/textconv programs outside the runner sandbox. | Both tracked and untracked diff paths now pass `--no-ext-diff --no-textconv`; a marker helper proves it is not executed. |
| P1 | Invalid GitHub remote errors echoed the full URL, including embedded username/password. | Validation errors no longer reproduce caller-supplied remote values; marker credentials are regression-tested. |
| P2 | The shared audited write-tool contract omitted six runtime write tools, so console filtering/types could silently drift. | Contract now exactly matches runtime non-read-only tool definitions and its required `grande-console` copy is synchronized. |
| P2 | `grande_task_open` was declared `openWorldHint: false` even though its wrapper can fetch `origin`. | Annotation and capability-contract expectations now truthfully mark it open-world. |
| P2 | Canonical-refresh audit rows used the invented tool name `grande_task_open:canonical_refresh`, outside the shared contract. | Audit rows use `grande_task_open` with `phase: canonical_refresh` in structured input. |
| P3 | The outer-test path assertion compared a non-canonical macOS `/var` path against layout's `/private/var` canonical path. | The assertion now uses `layout.workspaceRoot`, matching production canonicalization. |

## Verification

- `pnpm test` outside the nested sandbox: 74 files passed, 799 tests passed.
- `pnpm typecheck`: passed.
- `git diff --check`: passed in `grande-gpt` and in the synchronized `grande-console` contract copy.
- Targeted RED-GREEN tests cover each fixed behavior; Git-sensitive cases use real temporary repositories, refs, hooks, remotes, and conflict markers.

## Residual risks and recommended follow-up

1. `refreshCanonical()` fetches through ambient Git transport/credential configuration. For private or hostile remotes this can consume host credentials or wait for an interactive credential prompt. A follow-up should define one policy for generic remotes versus GitHub PAT-backed remotes, then set non-interactive credential behavior explicitly.
2. Disabling hooks does not disable checkout clean/smudge/process filters configured in repository Git config. `worktree add` can therefore still execute a configured filter while populating a new checkout. If registered repositories are not fully trusted, registration/admission needs an explicit filter policy or a stronger isolation boundary.
3. Branch validation closes stale-state bugs but is not a cross-process lock. Push uses an immutable verified SHA; other local operations can still race with a human or second process mutating the same task worktree. A per-task operation mutex is the durable follow-up if concurrent writers are in scope.
4. The shared contract remains a synchronized-copy architecture. The drift test catches divergence only when both sibling repositories are present, so both repository changes must land together.
