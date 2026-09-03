# minv2-gw-7-integration

tier: L2
verify: pnpm test:selfhost-safe && pnpm typecheck && pnpm test:tool-contract

Implement only Task 7, "Gateway integration, contract gate, and Console handoff",
from `docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 7 files. Keep approval out of the public MCP tool surface, update only
the intentional contract identity, and produce the exact cross-repo API handoff.
Do not edit the sibling Console repository, deploy, push, or refresh the App. This
is the single feature-level verification; review is limited to the integrated V2
flow, public contract delta, and the verify command above.
