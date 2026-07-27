<!-- pact:begin (managed by pactify — edit outside this block) -->
# grande-gpt — Pact Charter (protocol_version: 1)

This repo uses the **pact protocol** (v1). Any agent that can read files + run git can participate.

## Roles
- **orchestrator** — split spec→tasks; assign; merge; maintain charter
- **worker** — implement; at checkpoint set awaiting_review + write evidence
- **reviewer** — verify diff+evidence → accept / changes_requested
- **human** — start button + final authority

## The two rules (the pact)
1. A worker cannot self-accept. Only a task's reviewer may accept it (owner != reviewer), and only when awaiting_review.
2. A feature cannot merge until all its tasks are accepted.

## Seats
- `orch` — roles: orchestrator — entry: CLAUDE.md
- `w1` — roles: worker — entry: AGENTS.md
- `w2` — roles: worker — entry: AGENTS.md
- `rev` — roles: reviewer — entry: CLAUDE.md

## Commands
Run `pactify help` for the verb reference.
<!-- pact:end -->
