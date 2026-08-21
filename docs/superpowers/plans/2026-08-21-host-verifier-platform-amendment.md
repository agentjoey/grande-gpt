# GrandeGPT Host Verifier macOS Platform Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this amendment inline in the existing `task-reliability-hostverifier-20260821-001` worktree. This plan overrides only the conflicting Slice B/C steps in the original implementation plan.

**Goal:** Replace two macOS-impossible Host Verifier assumptions with a single outer-Seatbelt inheritance/non-escape proof and trusted exact loopback-port allocation, while keeping recursive-Seatbelt security cases as a predefined exact-SHA Human Gate.

**Architecture:** The running trusted Gateway parent constructs one default-deny verifier Seatbelt and allocates the exact loopback ports before launch. Candidate children inherit that boundary; they never need a successful second `sandbox_apply`. Host cases whose subject is itself a second Seatbelt boundary are explicitly manual-only and can never be counted toward an auto-safe receipt.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, macOS `sandbox-exec`, existing GrandeGPT manifest/job/receipt primitives.

**Spec:** Base design `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md` plus approved override `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-host-verifier-platform-amendment.md`. On conflict, the amendment wins.

## Global Constraints

- Preserve all original security constraints: no generic host exec, arbitrary argv/cwd, candidate-controlled profile/manifest/receipt, broad credential/network access, or background merge.
- `hostVerification.mode` remains `manual`; no production control/LaunchAgent changes.
- `HOST_VERIFIER_POLICY_VERSION` becomes exactly `2` in this amendment.
- No broad `localhost:*` allow. Only trusted parent allocated exact IPv4 loopback ports may be allowed.
- A recursive-Seatbelt host case can never be converted into a passing auto test by changing its assertion; it is `manualOnly` and remains a Human Gate when required.
- Every code change follows RED -> minimal GREEN -> `unit-selfhost` -> `typecheck` -> security review -> commit.

---

## Task B2R-1: Trusted host plan distinguishes auto-safe and manual-only cases

**Files:**
- Modify: `src/hostVerification.ts`
- Modify: `tests/hostVerification.test.ts`
- Modify: `tests/hostManifestContract.test.ts`

**Interfaces:**
- Extend trusted manifest semantics with `execution: "auto" | "manualOnly"` (or an equivalently explicit trusted field; do not infer this from candidate file contents).
- `tests/host/sandbox.host.test.ts` and any case whose subject requires starting a second Seatbelt boundary are `manualOnly`.
- Produce a trusted planning result that distinguishes required verification level from whether a manual-only host boundary is required. Keep the existing `none|smoke|full` level semantics; do not invent a public MCP level.
- Critical changes to `src/sandbox.ts`, `src/sbpl.ts`, verifier policy/profile, or a manual-only host test must fail closed to `full + manualOnlyRequired`.

- [ ] Write RED tests proving the existing manifest cannot express `manualOnly`, sandbox/SBPL changes require manual-only, ordinary production source remains auto-safe smoke, and a manual-only manifest entry can never appear in the auto file list.
- [ ] Run `unit-selfhost` and record the intended RED.
- [ ] Implement the smallest trusted manifest/planning extension. Do not move the decision into repo config or test metadata controlled outside trusted Gateway source.
- [ ] Re-run targeted host verification/manifest tests GREEN.

## Task B2R-2: Exact loopback-port verifier policy v2

**Files:**
- Modify: `src/hostVerifierSandbox.ts`
- Modify: `tests/hostVerifierSandbox.test.ts`

**Interfaces:**
- `HOST_VERIFIER_POLICY_VERSION = 2`.
- Replace broad localhost networking with trusted input `loopbackPorts: readonly number[]` (trusted internal construction only).
- Validate ports: integer `1..65535`, unique, bounded count, and none equals `productionPort`.
- Emit bind/inbound/outbound allow rules only for exact `127.0.0.1:<port>` values. No `localhost:*`, no range, no narrow production-port deny; deny-default protects all unlisted destinations.
- The sandbox builder still accepts no candidate argv/cwd/env/profile input.

- [ ] Add RED tests requiring policy version 2, exact allow rules, rejection of duplicate/invalid/production ports, and absence of `localhost:*`/broad network rules.
- [ ] Run `unit-selfhost` and record RED against the current broad-localhost policy.
- [ ] Implement minimal validation/profile changes; retain exact executable allowlist, `process-fork`, `sysctl-read`, sensitive path denies, scrubbed env, and job-temp-only writes.
- [ ] Re-run targeted tests GREEN.

## Task B2R-3: Real-host inheritance/non-escape and exact-port feasibility probes

**Files:**
- Modify: `tests/host/verifier-sandbox.host.test.ts`
- Modify: `docs/research/2026-08-21-host-verifier-feasibility-gate.md`

**Interfaces:**
- Trusted host fixture allocates an exact loopback test port before profile construction and passes only that port to `buildHostVerifierSandboxPlan`.
- Replace the recursive nominal allow/deny probe with a child Node process under the one outer verifier Seatbelt. The child must prove allowed fixture access succeeds and real sensitive/LAN access is permission-denied.
- If a negative attempt to re-apply `sandbox-exec` is retained, exit 71/permission denied is expected non-escape evidence, never a requirement for inner success.
- Network probe binds/connects the trusted exact port; LAN peer and production port must return a sandbox permission error. It must not use `server.listen(0)` inside a profile that has no exact port allowance.

- [ ] Rewrite the two previously impossible host assertions; do not weaken the sensitive-path, Git-hook, LAN, production-port, or process-group assertions.
- [ ] Run `unit-selfhost` and `typecheck`; both must pass before producing a clean exact SHA.
- [ ] Commit B2R changes with an attestation-bound validation run.
- [ ] Human Owner runs the existing trusted manual `outer-test --task task-reliability-hostverifier-20260821-001 --run` against that clean SHA.
- [ ] Gate PASS requires: child inheritance/non-escape PASS; raw-hook/Safe-Git PASS; exact loopback PASS + LAN DENY + production-port DENY; sensitive path/env PASS; process-group cleanup PASS; manual-only manifest contract PASS.
- [ ] If any required property still fails, stop before Slice C with the exact real-host evidence. Do not add wider permissions.

---

## Task C1 Amendment: Static plan identity + runtime execution-plan identity

**Files:**
- Modify when C starts: `src/hostVerification.ts`, `src/outerTestReceipt.ts`
- Test: `tests/hostVerification.test.ts`, `tests/outerTestReceipt.test.ts`

**Interfaces:**
- Internal `staticPlanDigest` covers sorted auto-safe files, level, policy version, and key resource limits; it is used to coalesce requests before runtime port allocation.
- Final Receipt V2 `planDigest` covers the static plan plus sorted trusted exact loopback ports actually used by the finalized job.
- Trusted job metadata persists enough execution-plan data to recompute both digests. Candidate stdout/artifact/env cannot provide it.
- Receipt eligibility loads the trusted finalized job named by `jobId`, recomputes final `planDigest`, verifies current static plan still matches, and then applies existing task/repo/SHA/level rules. It never allocates fresh random ports to validate an old receipt.

- [ ] Add RED tests for runtime-port tamper, production-port injection, static-plan drift, jobId mismatch, final planDigest mismatch, and same-static-request coalescing.
- [ ] Implement without adding MCP arguments or candidate-controlled receipt fields.

## Task C2/C3 Amendment: Predefined manual-only Human Gate

**Files:**
- Modify when C starts: `src/hostVerification.ts`, `src/prLifecycle.ts`, `src/cli.ts`, `src/outerTest.ts`
- Test: focused unit/CLI/merge-gate tests.

**Interfaces:**
- Auto-safe tasks use the restricted one-shot verifier orchestrator.
- If the trusted plan says `manualOnlyRequired`, `grande_pr_merge` must not start an auto verifier that pretends to cover the missing recursive-Seatbelt case. It returns a predefined Human Gate/next action.
- The manual-only exception is Human Owner initiated, exact-SHA, and limited to the existing trusted manual host path. It is never exposed as MCP host-exec and never auto-triggered by Gateway.
- A manual-only exact-SHA receipt can satisfy the gate only if its trusted suite/plan includes the required manual-only files; an auto-safe receipt cannot.

- [ ] Add RED tests proving an auto receipt cannot satisfy a manual-only plan and that ordinary smoke/full auto-safe tasks remain zero-extra-confirmation.
- [ ] Keep the existing destructive merge recheck and no-background-merge semantics unchanged.

---

## Amendment Gate Before Resuming Original Slice C

- [ ] Approved amendment spec exists and contains no TBD/TODO/conflict with the Owner decision.
- [ ] B2R targeted tests GREEN.
- [ ] Full `unit-selfhost` GREEN.
- [ ] `typecheck` GREEN.
- [ ] Security diff confirms: no broad localhost; no arbitrary exec/cwd/env; no new credential access; exact executable allowlist retained; production port absent from allowed ports; manual-only cannot be counted by auto receipt.
- [ ] Real trusted-host B gate GREEN on a clean exact SHA.
- [ ] Only after all above PASS, resume original Slice C using the amended C1/C2/C3 semantics.
