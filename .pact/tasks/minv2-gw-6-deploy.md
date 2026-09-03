# minv2-gw-6-deploy

tier: L3
verify: pnpm exec vitest run tests/deliveryEvidence.test.ts tests/deployment.test.ts tests/deploymentRetry.test.ts tests/rollback.test.ts tests/taskProgress.test.ts && pnpm typecheck

Implement only Task 6, "Reentrant deploy/verify evidence and separately authorized
rollback", from
`docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 6 files. Require machine-readable source/artifact evidence, keep stages
reentrant, never auto-retry uncertainty, and require a distinct rollback authorization.
Do not change production or run a real deployment. Review is high-risk but bounded
to Task 6 state/evidence semantics and its verify command.
