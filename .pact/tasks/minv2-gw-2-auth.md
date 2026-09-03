# minv2-gw-2-auth

tier: L3
verify: pnpm exec vitest run tests/deliveryAuthorization.test.ts && pnpm typecheck

Implement only Task 2, "Durable delivery authorization and CAS", from
`docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 2 files. Preserve hashed-only nonce storage, canonical binding digest,
expiry, and forward-only CAS semantics. Do not implement HTTP routes, merge, or
deployment. Review is security-focused but bounded to Task 2 and its verify command.
