# minv2-gw-5-merge

tier: L3
verify: pnpm exec vitest run tests/deliveryMerge.test.ts tests/prLifecycle.test.ts tests/d2Deployment.test.ts && pnpm typecheck

Implement only Task 5, "Authorization-gated exact merge and pinned release source",
from `docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 5 files. Revalidate and consume authorization before remote mutation;
bind base/head/expected tree and release from the verified immutable merge SHA.
Never deploy moving canonical main. Do not implement deploy execution. Review is
high-risk but bounded to Task 5 destructive ordering and its verify command.
