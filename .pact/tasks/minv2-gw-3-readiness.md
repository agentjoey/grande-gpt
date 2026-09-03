# minv2-gw-3-readiness

tier: L2
verify: pnpm exec vitest run tests/deliveryReadiness.test.ts && pnpm typecheck

Implement only Task 3, "Exact readiness and immutable authorization binding",
from `docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 3 files. Trusted evidence must come from existing control-plane readers;
preparation has no remote or filesystem mutation. Do not implement approval routes,
merge, or deployment. Review is limited to Task 3 and its verify command.
