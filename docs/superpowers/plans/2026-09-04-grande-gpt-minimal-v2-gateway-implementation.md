# GrandeGPT Minimal V2 Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the GrandeGPT-side half of Minimal V2: explicit delivery targets, durable one-time authorization, exact merge binding, hardened Console approval APIs, and reentrant exact-SHA deploy/verify/rollback enforcement.

**Architecture:** Extend the existing SQLite state, TaskProgress, PR lifecycle, deployment receipt, and Hono Console routes. Keep `grande_run` profile-only. The independent Next.js UI lives in the sibling `grande-console` repository and starts only after this plan produces an accepted API contract.

**Tech Stack:** TypeScript 5.9, Node 24, SQLite `DatabaseSync`, Hono, Vitest, existing Git/GitHub/deployment primitives.

**Spec:** `docs/superpowers/specs/2026-09-04-grande-gpt-minimal-v2-automatic-terminal-delivery-design.md`

## Global Constraints

- Worker: pactify-managed Kimi CLI. Work only in the isolated feature worktree.
- Do not add public `argv`, command, shell, cwd, env, network, PTY, scheduler, generic approval, RBAC, or workflow DSL.
- `grande_run` remains `{ taskId, profile }`; `deployment-host` remains inaccessible from it.
- Repository content is untrusted. Policy, profile, Access origin, target mapping, approver identity, and nonce generation come from the control plane/Gateway.
- All mutations validate before side effects and use forward-only CAS where state can race.
- Production uncertainty never auto-retries. Rollback requires a distinct rollback authorization.
- Use RED → observed RED → minimal GREEN → fresh GREEN for each task.
- Small-task review is bounded to that task's diff, listed acceptance criteria, and targeted tests. Do not run or request a repository-wide audit per task.
- Run `pnpm typecheck` only when the task changes exported types or wiring. Run the full suite only in Task 7 and the pactify feature hard gate.
- Do not push, change production configuration, bump a live Tool Epoch, refresh an App, or deploy from a worker task.
- Preserve unrelated files and existing accepted residual risks.

## File Structure

| File | Responsibility |
|---|---|
| `src/taskDeliveryTarget.ts` | Persist/resolve immutable explicit task target while preserving legacy projection for old tasks |
| `src/deliveryAuthorization.ts` | Binding types, canonical digest, nonce, persistence, expiry, and CAS state machine |
| `src/deliveryReadiness.ts` | Build/revalidate delivery and rollback proposals from exact trusted evidence |
| `src/deliveryMerge.ts` | Expected merge tree, merge receipt verification, and pinned release source |
| `src/deliveryEvidence.ts` | Parse and validate normalized deploy/verify evidence |
| `src/toolsCore.ts` | Add the only required public schema field: `grande_task_open.deliveryTarget` |
| `src/consoleAuth.ts` | Require a trusted exact Console origin |
| `src/consoleRoutes.ts` | Authenticated Origin/JSON/nonce/CAS approval and rejection routes |
| `src/prLifecycle.ts`, `src/prMergeD2.ts` | Consume delivery authorization before remote merge and reconcile exact merge evidence |
| `src/deployment.ts`, `src/deploymentHostRunner.ts` | Reentrant authorization stages and machine-readable source/artifact evidence |
| `src/taskProgress.ts`, `src/deliveryTarget.ts`, `src/flowSimplification.ts` | Project authorization state and one next action |
| `src/contract.ts`, `src/selfcheck.ts` | One intentional public schema/tool identity update at feature closeout |

---

### Task 1: Explicit immutable delivery target

**Review scope:** Small domain/schema task. Review only target validation, persistence, default compatibility, tool input, and listed tests.

**Files:**
- Create: `src/taskDeliveryTarget.ts`
- Modify: `src/db.ts`
- Modify: `src/toolsCore.ts`
- Modify: `src/deliveryTarget.ts`
- Test: `tests/taskDeliveryTarget.test.ts`
- Test: `tests/deliveryTarget.test.ts`
- Test: `tests/tools.test.ts`

**Interfaces:**
- Produces:

```ts
export type DeliveryTarget = "local" | "pr" | "deploy";
export function parseDeliveryTarget(value: unknown): DeliveryTarget;
export function saveExplicitDeliveryTarget(
  db: DatabaseSync,
  taskId: string,
  target: DeliveryTarget,
): void;
export function getExplicitDeliveryTarget(
  db: DatabaseSync,
  taskId: string,
): DeliveryTarget | undefined;
```

- `resolveDeliveryTarget()` consumes the explicit row first. Legacy tasks without a row keep the existing projection for status only, but cannot create a V2 authorization until recreated with explicit `deploy`.

- [ ] **Step 1: Write focused RED tests**

Add tests proving:

```ts
expect(parseDeliveryTarget("deploy")).toBe("deploy");
expect(() => parseDeliveryTarget("production")).toThrow(/deliveryTarget/i);
expect(getExplicitDeliveryTarget(db, taskId)).toBe("deploy");
expect(resolveDeliveryTarget(db, explicitLocalTask, { readOrigin: githubOrigin })).toBe("local");
expect(taskOpenTool.inputSchema.properties).toHaveProperty("deliveryTarget");
expect(taskOpenTool.inputSchema.required).not.toContain("deliveryTarget");
```

Also assert a duplicate write with a different target throws `STALE_STATE` and leaves the original value unchanged.

- [ ] **Step 2: Observe RED**

Run:

```bash
pnpm exec vitest run tests/taskDeliveryTarget.test.ts tests/deliveryTarget.test.ts tests/tools.test.ts
```

Expected: failures because the target table/helper and task-open field do not exist.

- [ ] **Step 3: Implement the minimal target store and schema field**

Add an attached table:

```sql
CREATE TABLE IF NOT EXISTS task_delivery_target (
  taskId TEXT PRIMARY KEY REFERENCES task(taskId),
  target TEXT NOT NULL CHECK (target IN ('local','pr','deploy')),
  createdAt INTEGER NOT NULL
);
```

Validate `deliveryTarget` before opening a worktree. After `createTask`, save the explicit target when supplied. Include it in the task-open audit input. Do not infer `deploy` from repo content.

- [ ] **Step 4: Verify GREEN**

Run the same focused test command and `pnpm typecheck`.

- [ ] **Step 5: Commit exact files**

```bash
git add src/taskDeliveryTarget.ts src/db.ts src/toolsCore.ts src/deliveryTarget.ts tests/taskDeliveryTarget.test.ts tests/deliveryTarget.test.ts tests/tools.test.ts
git commit -m "feat: persist explicit delivery targets"
```

---

### Task 2: Durable delivery authorization and CAS

**Depends on:** Task 1

**Review scope:** Focused security-domain review. Check canonical digest, nonce storage, state transition predicates, expiry, and concurrency tests; no unrelated repo audit.

**Files:**
- Create: `src/deliveryAuthorization.ts`
- Modify: `src/db.ts`
- Test: `tests/deliveryAuthorization.test.ts`

**Interfaces:**

```ts
export const APPROVAL_TTL_MS = 15 * 60_000;
export const EXECUTION_TTL_MS = 60 * 60_000;
export type AuthorizationKind = "delivery" | "rollback";
export type AuthorizationStatus =
  | "READY" | "APPROVED" | "EXECUTING"
  | "REJECTED" | "REVOKED" | "STALE" | "EXPIRED"
  | "SUCCEEDED" | "FAILED" | "UNCERTAIN";
export type AuthorizationStageState = "pending" | "running" | "succeeded" | "failed" | "uncertain";
export interface AuthorizationStages {
  merge?: { state: AuthorizationStageState; receiptId?: string };
  deploy?: { state: AuthorizationStageState; receiptId?: string; jobId?: string };
  verify?: { state: AuthorizationStageState; receiptId?: string; jobId?: string };
  rollback?: { state: AuthorizationStageState; receiptId?: string; jobId?: string };
}
export interface AuthorizationCommonBinding {
  authorizationKind: AuthorizationKind;
  taskId: string;
  repoId: string;
  worktreeRealpath: string;
  deliveryTarget: "deploy";
  deployTarget: string;
  deploySpecDigest: string;
  policyDigest: string;
  runtimeBuild: string;
  toolsetEpoch: number;
  toolsDigest: string;
  createdAt: number;
  expiresAt: number;
}
export interface DeliveryAuthorizationBinding extends AuthorizationCommonBinding {
  authorizationKind: "delivery";
  prNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  mergeMethod: "merge";
  expectedMergeTree: string;
  deployRef: string;
  verifyRef: string;
}
export interface RollbackAuthorizationBinding extends AuthorizationCommonBinding {
  authorizationKind: "rollback";
  currentDeploymentId: string;
  currentSourceSha: string;
  rollbackDeploymentId: string;
  rollbackSourceSha: string;
  rollbackArtifactDigest?: string;
  rollbackRef: string;
}

export interface DeliveryAuthorizationRow {
  authorizationId: string;
  kind: AuthorizationKind;
  taskId: string;
  binding: DeliveryAuthorizationBinding | RollbackAuthorizationBinding;
  bindingDigest: string;
  status: AuthorizationStatus;
  stages: AuthorizationStages;
  expiresAt: number;
}

export interface CreateAuthorizationInput {
  kind: AuthorizationKind;
  taskId: string;
  binding: DeliveryAuthorizationBinding | RollbackAuthorizationBinding;
  stages: AuthorizationStages;
  now?: number;
}
export interface ApprovalIdentity { sub: string; email: string }
export interface ApprovalRequest {
  authorizationId: string;
  bindingDigest: string;
  approvalNonce: string;
  identity: ApprovalIdentity;
  now?: number;
}
export function createAuthorization(
  db: DatabaseSync,
  input: CreateAuthorizationInput,
): DeliveryAuthorizationRow;
export function rotateAuthorizationChallenge(
  db: DatabaseSync,
  authorizationId: string,
  bindingDigest: string,
  now?: number,
): { row: DeliveryAuthorizationRow; approvalNonce: string };
export function approveAuthorization(db: DatabaseSync, input: ApprovalRequest): DeliveryAuthorizationRow;
export function rejectAuthorization(db: DatabaseSync, input: ApprovalRequest): DeliveryAuthorizationRow;
export function beginAuthorizedExecution(
  db: DatabaseSync,
  authorizationId: string,
  kind: AuthorizationKind,
  bindingDigest: string,
  now?: number,
): DeliveryAuthorizationRow;
export function transitionAuthorization(
  db: DatabaseSync,
  authorizationId: string,
  from: AuthorizationStatus,
  to: AuthorizationStatus,
  stages: AuthorizationStages,
  reason?: string,
): DeliveryAuthorizationRow;
export function activeAuthorizationForTask(
  db: DatabaseSync,
  taskId: string,
): DeliveryAuthorizationRow | undefined;
```

- [ ] **Step 1: Write RED state-machine tests**

Cover canonical object-key ordering, SHA-256 digest stability, challenge-generated nonce of at least 256 bits, nonce digest-only persistence, challenge rotation, one active row per task, exact kind/digest matching, 15-minute approval expiry, 60-minute execution deadline, and terminal-state immutability.

Concurrency assertion:

```ts
const first = approveAuthorization(db, request);
expect(first.status).toBe("APPROVED");
const replay = approveAuthorization(db, request);
expect(replay.status).toBe("APPROVED");
const count = db.prepare("SELECT count(*) AS n FROM delivery_authorization WHERE authorizationId=?")
  .get(request.authorizationId) as { n: number };
expect(count.n).toBe(1);
expect(beginAuthorizedExecution(db, first.authorizationId, "delivery", digest).status)
  .toBe("EXECUTING");
expect(() => beginAuthorizedExecution(db, first.authorizationId, "delivery", digest))
  .toThrow(/state|CAS/i);
```

- [ ] **Step 2: Observe RED**

```bash
pnpm exec vitest run tests/deliveryAuthorization.test.ts
```

- [ ] **Step 3: Implement the table and forward-only helpers**

Use `BEGIN IMMEDIATE` around create/approve/reject/begin transitions. Store `bindingJson`, `bindingDigest`, `nonceDigest`, identity fields, `stageJson`, timestamps, and reason. Add the partial unique index from the Spec. Never accept approver identity inside a binding/request object intended to come from the browser.

- [ ] **Step 4: Verify GREEN**

Run the focused test and `pnpm typecheck`.

- [ ] **Step 5: Commit exact files**

```bash
git add src/deliveryAuthorization.ts src/db.ts tests/deliveryAuthorization.test.ts
git commit -m "feat: add delivery authorization state machine"
```

---

### Task 3: Exact readiness and immutable authorization binding

**Depends on:** Tasks 1–2

**Review scope:** Review only readiness inputs, trusted-source provenance, digest coverage, zero-side-effect blockers, and targeted tests.

**Files:**
- Create: `src/deliveryReadiness.ts`
- Modify: `src/githubApi.ts`
- Modify: `src/profiles.ts`
- Modify: `src/prHostVerification.ts`
- Test: `tests/deliveryReadiness.test.ts`

**Interfaces:**

```ts
export interface DeliveryReadinessDeps {
  readPullRequest(taskId: string): Promise<{
    number: number;
    baseRef: string;
    baseSha: string;
    headSha: string;
    state: "open" | "closed";
  }>;
  readRequiredCi(taskId: string, headSha: string): Promise<"success" | "pending" | "failed">;
  readAttestation(taskId: string, headSha: string): { commit: string; jobId: string } | null;
  readHostVerification(taskId: string, headSha: string): { commit: string; jobId: string; planDigest: string } | null;
  computeExpectedMergeTree(repoId: string, baseSha: string, headSha: string): string;
  resolveDeployAction(taskId: string): {
    deployTarget: string;
    deployRef: string;
    verifyRef: string;
    deploySpecDigest: string;
    policyDigest: string;
  };
}

export async function prepareDeliveryAuthorization(
  db: DatabaseSync,
  taskId: string,
  deps: DeliveryReadinessDeps,
): Promise<{ state: "READY"; authorizationId: string; bindingDigest: string; expiresAt: number }>;

export async function revalidateDeliveryBinding(
  db: DatabaseSync,
  authorizationId: string,
  deps: DeliveryReadinessDeps,
): Promise<DeliveryAuthorizationBinding>;
```

- [ ] **Step 1: Write RED readiness matrix tests**

The happy path produces one `READY` proposal and one successful `grande_delivery_prepare` audit record. Independently vary worktree dirty/HEAD, explicit target, PR head, base, CI, attestation, Host receipt, deploy spec, action role, policy digest, runtime build, and tool identity. Every blocker must leave `delivery_authorization` empty and record no successful preparation.

Include a destructive proof that removing `baseSha` or `expectedMergeTree` from canonical digest changes the assertion from GREEN to RED, then restore it.

- [ ] **Step 2: Observe RED**

```bash
pnpm exec vitest run tests/deliveryReadiness.test.ts
```

- [ ] **Step 3: Implement readiness with injectable boundaries**

Build a canonical binding containing exactly the Spec fields. `deployTarget` must come from the trusted action resolver; free-form labels do not qualify. `policyDigest` covers only referenced trusted repo/profile/capability/deny/target records. Record proposal creation through the existing audit ledger without including nonce/plain binding JSON. Do not mutate GitHub, canonical, deployment, or worktree while preparing a proposal.

- [ ] **Step 4: Verify GREEN**

Run the focused test and `pnpm typecheck`.

- [ ] **Step 5: Commit exact files**

```bash
git add src/deliveryReadiness.ts src/githubApi.ts src/profiles.ts src/prHostVerification.ts tests/deliveryReadiness.test.ts
git commit -m "feat: prepare exact delivery authorizations"
```

---

### Task 4: Hardened Console approval API

**Depends on:** Tasks 2–3

**Review scope:** Security-sensitive but bounded to Access identity, exact Origin, JSON, nonce, CAS, headers, escaping-safe response shape, and route tests. Do not review unrelated Console operations.

**Files:**
- Modify: `src/consoleAuth.ts`
- Modify: `src/consoleRoutes.ts`
- Modify: `src/server.ts`
- Modify: `src/main.ts`
- Test: `tests/consoleAuth.test.ts`
- Test: `tests/consoleDeliveryRoute.test.ts`
- Test: `tests/server.test.ts`

**Interfaces:**

```ts
export interface ConsoleAccessConfig extends AccessConfig {
  origin: string;
}

type ApprovalBody = {
  bindingDigest: string;
  approvalNonce: string;
};
type ChallengeBody = { bindingDigest: string };
```

Routes:

```text
POST /console/delivery/:authorizationId/challenge
POST /console/delivery/:authorizationId/approve
POST /console/delivery/:authorizationId/reject
```

- [ ] **Step 1: Write RED route tests**

Assert 403 for missing/wrong JWT, missing/wrong/`null` Origin, non-JSON, missing nonce, wrong digest, expired authorization, and wrong audience. Assert challenge rotates the stored nonce digest, returns the bounded binding summary plus a fresh nonce exactly once, and never stores/logs plaintext. Assert verified JWT `sub/email` are persisted even if spoofed approver fields appear in JSON. Assert response headers contain CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff, and no-referrer.

Add a concurrent/double-submit test proving at most one state transition and no execution occurs inside the HTTP handler. Assert challenge, approve, reject, and revoke outcomes leave bounded audit records containing authorizationId/bindingDigest but not nonce/JWT.

- [ ] **Step 2: Observe RED**

```bash
pnpm exec vitest run tests/consoleAuth.test.ts tests/consoleDeliveryRoute.test.ts tests/server.test.ts
```

- [ ] **Step 3: Implement the narrow routes**

Extend only Console config with a normalized HTTPS `origin`. Retain the existing gate identity `{ email, sub }` and pass it to handlers. Reject before body parsing when authentication/origin fails. Parse an exact two-field JSON object; call Task 2 helpers; return a bounded summary without PR/log HTML.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and `pnpm typecheck`.

- [ ] **Step 5: Commit exact files**

```bash
git add src/consoleAuth.ts src/consoleRoutes.ts src/server.ts src/main.ts tests/consoleAuth.test.ts tests/consoleDeliveryRoute.test.ts tests/server.test.ts
git commit -m "feat: add hardened delivery approval routes"
```

---

### Task 5: Authorization-gated exact merge and pinned release source

**Depends on:** Tasks 2–3

**Review scope:** Focused high-risk review of pre-mutation ordering, exact Git evidence, uncertain reconciliation, and destructive tests only.

**Files:**
- Create: `src/deliveryMerge.ts`
- Modify: `src/githubApi.ts`
- Modify: `src/prLifecycle.ts`
- Modify: `src/prMergeD2.ts`
- Modify: `src/mergeReconcile.ts`
- Modify: `src/worktree.ts`
- Test: `tests/deliveryMerge.test.ts`
- Test: `tests/prLifecycle.test.ts`
- Test: `tests/d2Deployment.test.ts`

**Interfaces:**

```ts
export interface ExactMergeReceipt {
  authorizationId: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  mergeTree: string;
  releaseSourceRealpath: string;
}

export function computeExpectedMergeTree(repoPath: string, baseSha: string, headSha: string): string;
export function verifyMergedCommit(input: {
  repoPath: string;
  authorizationId: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  expectedMergeTree: string;
}): Omit<ExactMergeReceipt, "releaseSourceRealpath">;
export function ensurePinnedReleaseSource(input: {
  layout: Layout;
  repoId: string;
  authorizationId: string;
  mergeSha: string;
  expectedTree: string;
}): { realpath: string; headSha: string; tree: string };
```

- [ ] **Step 1: Write RED exactness tests**

Cover: no approved authorization means no GitHub call; head/base/tree drift means no GitHub call; approved CAS happens before the call; API receives `sha=headSha` and `merge_method=merge`; unexpected parents/tree prevent deploy; lost response reconciles before any second merge; canonical after refresh equals returned merge SHA; pinned release source stays on merge SHA if canonical advances.

- [ ] **Step 2: Observe RED**

```bash
pnpm exec vitest run tests/deliveryMerge.test.ts tests/prLifecycle.test.ts tests/d2Deployment.test.ts
```

- [ ] **Step 3: Implement exact merge flow**

For explicit deploy tasks only, consume Task 2 authorization before remote mutation. Verify merge commit parents and tree with safe Git argv calls and hooks disabled. Create an internal detached release worktree keyed by authorizationId/mergeSha; verify realpath, clean state, HEAD, and tree. Do not deploy from moving canonical `main`.

- [ ] **Step 4: Verify GREEN and destructive proof**

Run focused tests. Temporarily weaken one parent/tree assertion and demonstrate the corresponding test fails; restore it and rerun GREEN. Run `pnpm typecheck`.

- [ ] **Step 5: Commit exact files**

```bash
git add src/deliveryMerge.ts src/githubApi.ts src/prLifecycle.ts src/prMergeD2.ts src/mergeReconcile.ts src/worktree.ts tests/deliveryMerge.test.ts tests/prLifecycle.test.ts tests/d2Deployment.test.ts
git commit -m "feat: bind delivery merge to exact git evidence"
```

---

### Task 6: Reentrant deploy/verify evidence and separately authorized rollback

**Depends on:** Tasks 2, 3, and 5

**Review scope:** Focus only on authorization kind/stage checks, idempotency, exact source/target evidence, uncertainty, and rollback separation.

**Files:**
- Create: `src/deliveryEvidence.ts`
- Modify: `src/deployment.ts`
- Modify: `src/deploymentHostRunner.ts`
- Modify: `src/taskProgress.ts`
- Modify: `src/deliveryTarget.ts`
- Test: `tests/deliveryEvidence.test.ts`
- Test: `tests/deployment.test.ts`
- Test: `tests/deploymentRetry.test.ts`
- Test: `tests/rollback.test.ts`
- Test: `tests/taskProgress.test.ts`

**Interfaces:**

```ts
export interface DeploymentEvidence {
  target: string;
  deploymentId: string;
  sourceSha: string;
  artifactDigest?: string;
}

export function parseDeploymentEvidence(value: unknown): DeploymentEvidence;
export function readProfileDeliveryEvidence(path: string, maxBytes?: number): DeploymentEvidence;
export function assertEvidenceMatchesAuthorization(
  evidence: DeploymentEvidence,
  expected: { target: string; sourceSha: string; artifactDigest?: string },
): void;
```

- [ ] **Step 1: Write RED evidence/state tests**

Assert deploy refuses before exact merge; first call starts one action; repeated calls observe the same receipt/job; verify uses the same deploymentId/target/sourceSha; wrong identity is `FAILED`; missing/ambiguous identity is `UNCERTAIN`; neither state retries. Assert deployment-host gets a per-job `GRANDE_DELIVERY_EVIDENCE_FILE` path and free-form stdout is ignored.

Assert `grande_deploy_rollback` rejects delivery authorization, requires `authorizationKind=rollback`, binds exact current and rollback deployment/source identity, and cannot use aliases such as `previous`.

- [ ] **Step 2: Observe RED**

```bash
pnpm exec vitest run tests/deliveryEvidence.test.ts tests/deployment.test.ts tests/deploymentRetry.test.ts tests/rollback.test.ts tests/taskProgress.test.ts
```

- [ ] **Step 3: Implement minimal reentrant stage handling**

Reuse the existing deployment receipt; extend it with authorizationId, merge receipt, exact evidence, and stage state. Before each new side effect, compare current trusted inputs to the binding and check the execution deadline. Capability evidence comes from structured results; profile evidence comes only from bounded JSON at the injected path. Keep existing uncertainty-first persistence around capability calls.

- [ ] **Step 4: Verify GREEN and destructive proof**

Run focused tests. Remove the authorization-kind check once and confirm the rollback test fails, restore it, then rerun GREEN. Run `pnpm typecheck`.

- [ ] **Step 5: Commit exact files**

```bash
git add src/deliveryEvidence.ts src/deployment.ts src/deploymentHostRunner.ts src/taskProgress.ts src/deliveryTarget.ts tests/deliveryEvidence.test.ts tests/deployment.test.ts tests/deploymentRetry.test.ts tests/rollback.test.ts tests/taskProgress.test.ts
git commit -m "feat: enforce authorized delivery evidence"
```

---

### Task 7: Gateway integration, contract gate, and Console handoff

**Depends on:** Tasks 1–6

**Review scope:** Integration-only review. Verify wiring, public identity, end-to-end behavior, and documentation. This is the only task that runs the full relevant suite before the pactify hard gate.

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/flowSimplification.ts`
- Modify: `src/contract.ts`
- Modify: `src/selfcheck.ts`
- Modify: `docs/BACKLOG.md`
- Create: `docs/contracts/2026-09-04-minimal-v2-console-api.md`
- Test: `tests/minimalV2Delivery.e2e.test.ts`
- Test: `tests/flowSimplification.test.ts`
- Test: `tests/toolsetIdentity.test.ts`
- Test: `tests/selfcheck.test.ts`

**Interfaces:**

Task projection must expose one of:

```ts
type DeliveryAuthorizationProjection =
  | { state: "READY_FOR_DELIVERY_APPROVAL"; authorizationId: string; bindingDigest: string; expiresAt: number }
  | { state: "DELIVERY_APPROVED"; authorizationId: string }
  | { state: "DELIVERY_EXECUTING"; authorizationId: string; stage: "merge" | "deploy" | "verify" | "rollback" }
  | { state: "DELIVERY_FAILED" | "DELIVERY_UNCERTAIN"; authorizationId: string; detail: string }
  | { state: "DELIVERY_DONE"; authorizationId: string; sourceSha: string; target: string; deploymentId: string };
```

- [ ] **Step 1: Write RED integration tests**

Build one real local Git/SQLite fixture that exercises:

```text
task_open(deliveryTarget=deploy)
→ profile-only verification evidence
→ READY_FOR_DELIVERY_APPROVAL
→ approved row fixture using the same domain helper as Console
→ exact merge
→ reentrant deploy
→ verify readback
→ DELIVERY_DONE
```

Assert one merge call, one deploy call, exact source SHA, stable receipt recovery, and no public argv/approval tool. Update expected tool digest/epoch exactly once.

- [ ] **Step 2: Observe RED**

```bash
pnpm exec vitest run tests/minimalV2Delivery.e2e.test.ts tests/flowSimplification.test.ts tests/toolsetIdentity.test.ts tests/selfcheck.test.ts
```

- [ ] **Step 3: Wire the feature and write the cross-repo API contract**

Mount the new projection without adding a public approval tool. The Console API document must include exact route, method, Origin requirement, request/response JSON, error codes, security headers, and bounded display fields. Update only the relevant `GG-BL-024` status/evidence; do not rewrite unrelated backlog history.

For `repoId=grande-gpt`, require the existing activation receipt/readback before projecting `DELIVERY_DONE`; other repositories use the normalized deployment/verify receipt.

- [ ] **Step 4: Run focused integration GREEN**

Run the Step 2 command and `pnpm typecheck`.

- [ ] **Step 5: Run the single feature-level suite**

```bash
pnpm test:selfhost-safe
pnpm typecheck
pnpm test:tool-contract
```

Do not add another repo-wide review after this. Pactify's independent feature hard gate remains the final code gate.

- [ ] **Step 6: Commit exact files**

```bash
git add src/tools.ts src/flowSimplification.ts src/contract.ts src/selfcheck.ts docs/BACKLOG.md docs/contracts/2026-09-04-minimal-v2-console-api.md tests/minimalV2Delivery.e2e.test.ts tests/flowSimplification.test.ts tests/toolsetIdentity.test.ts tests/selfcheck.test.ts
git commit -m "feat: integrate minimal v2 delivery flow"
```

## Feature completion boundary

This Gateway feature is complete when all seven pact tasks are accepted and the pactify hard gate passes. It is not production-deployed yet.

Next, create a separate pact feature in `/Users/xtation/AgentWorks/GPT_Workspace/grande-console` from `docs/contracts/2026-09-04-minimal-v2-console-api.md`. That plan owns the T3 UI, rendered mockup approval, focused component tests, browser verification, and final screenshots. Do not let a Gateway worker edit the Console repository.
