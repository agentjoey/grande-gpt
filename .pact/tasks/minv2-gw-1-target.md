# minv2-gw-1-target

tier: L1
verify: pnpm exec vitest run tests/taskDeliveryTarget.test.ts tests/deliveryTarget.test.ts tests/tools.test.ts && pnpm typecheck

Implement only Task 1, "Explicit immutable delivery target", from
`docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 1 files. Do not begin Task 2, alter the public terminal profile model,
or edit the sibling Console repository. Review is limited to Task 1 acceptance
criteria, its diff, and the verify command above.
