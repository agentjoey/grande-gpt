# minv2-gw-4-console-api

tier: L3
verify: pnpm exec vitest run tests/consoleAuth.test.ts tests/consoleDeliveryRoute.test.ts tests/server.test.ts && pnpm typecheck

Implement only Task 4, "Hardened Console approval API", from
`docs/superpowers/plans/2026-09-04-grande-gpt-minimal-v2-gateway-implementation.md`.
The governing design is
`docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`.

Follow the listed RED -> observed RED -> minimal GREEN steps and commit only the
exact Task 4 files. Reuse the existing verified Access identity; enforce exact
Origin, JSON shape, one-time nonce, CAS, bounded audit, and security headers. HTTP
handlers must not execute delivery. Do not edit Console UI or unrelated routes.
Review is security-focused but bounded to Task 4 and its verify command.
