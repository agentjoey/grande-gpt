# Git and tool-call review hardening

## Goal

Fix repository-review findings that can make Git operations target the wrong ref, turn a recoverable tool error into an internal failure, leak tool payloads into logs, or admit unsafe Git states.

## Required behavior

1. Host outer-test path assertions compare canonical paths, matching `loadLayout()`.
2. A missing task always returns `TASK_NOT_FOUND`, even when another active task has a missing worktree.
3. Tool logs identify the selected tool and safe metadata without logging arbitrary argument values or file content.
4. `grande_task_open` rejects an already-known `taskId` before canonical refresh, audit creation, branch creation, or worktree creation.
5. Commit, push, PR inspection, and base sync reject a task worktree whose checked-out branch is detached or differs from `task.branch`.
6. Canonical admission treats revert/sequencer markers as busy.
7. Repository diff never executes external diff or textconv drivers.
8. Rejected GitHub remote URLs do not echo embedded credentials.
9. Every runtime MCP tool marked as a write operation appears in the shared audited-tool contract.
10. Tool annotations declare `grande_task_open` as open-world because it may fetch `origin`.
11. Worktree creation disables repository hooks, including `post-checkout`.

## Constraints

- Keep Git execution argv-based; do not introduce shell command strings.
- Preserve current taskId-to-repository derivation and audit forward-only semantics.
- Add a failing behavioral regression test before each production change.
- Run targeted tests, the full `pnpm test` gate outside the nested sandbox, and `pnpm typecheck`.
