# ChatGPT Repository Onboarding Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Human Owner review a read-only repository onboarding proposal in ChatGPT and explicitly authorize GrandeGPT to apply registration safely, without terminal copy/paste.

**Architecture:** Reuse the existing S9 `inspectRepoOnboarding` / `applyRepoOnboarding` path and canonical Git readiness logic. Add a focused `onboardingTools.ts` adapter that computes a deterministic proposal digest from repository discovery plus trusted control-plane pre-state, exposes one read tool and one write tool, and wires them through the existing production tool assembly. Keep the CLI path unchanged as fallback.

**Tech Stack:** TypeScript, Node.js built-ins (`crypto`, `fs`), Vitest, YAML control-plane config, existing GrandeGPT ToolDef/envelope/error helpers.

**Spec:** `docs/superpowers/specs/2026-08-19-chatgpt-repo-onboarding-tools-design.md`

## Global Constraints

- Add exactly two MCP tools: `grande_repo_add_propose` and `grande_repo_add_apply`.
- Both tools accept `repoId`; apply additionally requires `proposalDigest`; neither accepts arbitrary absolute paths.
- Proposal is read-only and byte-for-byte zero-write to trusted control-plane files.
- Apply re-inspects path/Git/discovery/control-plane state and compares a deterministic digest before the first mutation.
- Stale proposal uses existing `StateError("STALE_STATE", ...)`; no new persistent state machine or error family.
- Existing trusted profiles are preserved; repeated fresh propose/apply is idempotent.
- `grande_task_open` remains registration-gated and never auto-registers.
- Tool contract release is intentional: tools 23 → 25, `TOOLSET_EPOCH` 1 → 2, digest changes.
- No repo init/scaffold/GitHub create/install/push/task auto-create/unregister/raw Git/fs/shell capability.

---

### Task 1: Deterministic onboarding proposal identity

**Files:**
- Modify: `src/onboarding.ts`
- Test: `tests/onboarding.test.ts`

**Interfaces:**
- Consumes: existing `inspectRepoOnboarding(layout, repoId)` and `RepoOnboardingProposal`.
- Produces: `inspectRepoOnboardingWithDigest(layout, repoId)` returning `{ proposal, proposalDigest }`, plus `assertFreshRepoOnboardingProposal(layout, repoId, proposalDigest)` returning the current proposal when the digest matches.

- [ ] **Step 1: Write failing digest tests**

Add tests that create a valid Git repo and assert:

```ts
const first = inspectRepoOnboardingWithDigest(layout, "demo");
const second = inspectRepoOnboardingWithDigest(layout, "demo");
expect(first.proposalDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
expect(second.proposalDigest).toBe(first.proposalDigest);
```

Then mutate `HEAD`, `profiles.yaml`, and `repos.yaml` one at a time and assert a fresh digest differs. Snapshot `repos.yaml` / `profiles.yaml` before proposal and assert proposal leaves both byte-identical.

- [ ] **Step 2: Run `unit-selfhost` and verify RED**

Run the trusted `unit-selfhost` profile. Expected: failures because the new digest helpers do not exist.

- [ ] **Step 3: Implement minimal digest helper**

In `src/onboarding.ts`, add stable hashing using `createHash("sha256")`. Bind the digest to:

```ts
{
  proposal: {
    repoId,
    repoPath,
    alreadyRegistered,
    packageManager,
    profiles,
    remoteConfigured,
    githubRepo,
    ciConfigured,
    deployConfigured,
    cloneNodeModules,
    git,
    readyToRegister,
    blockingReasons,
  },
  controlPlane: {
    reposConfigSha256: fileFingerprint(layout.reposConfig),
    profilesConfigSha256: fileFingerprint(join(layout.configDir, "profiles.yaml")),
  }
}
```

Use a recursive stable JSON normalization that sorts object keys while preserving profile/busy-reason array order as produced by existing deterministic inspection. Missing files use an explicit sentinel such as `"missing"`.

Add:

```ts
export interface RepoOnboardingWithDigest {
  proposal: RepoOnboardingProposal;
  proposalDigest: string;
}

export function inspectRepoOnboardingWithDigest(layout: Layout, repoId: string): RepoOnboardingWithDigest;
export function assertFreshRepoOnboardingProposal(layout: Layout, repoId: string, proposalDigest: string): RepoOnboardingProposal;
```

`assertFresh...` recomputes current state and throws `StateError("STALE_STATE", "Repository onboarding proposal is stale; run propose again.")` when the digest differs.

- [ ] **Step 4: Run `unit-selfhost` and verify GREEN**

Expected: existing onboarding tests plus new digest tests pass.

---

### Task 2: MCP proposal/apply wrappers and lifecycle proof

**Files:**
- Create: `src/onboardingTools.ts`
- Modify: `src/tools.ts`
- Create: `tests/onboardingTools.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/capabilityWiring.test.ts`

**Interfaces:**
- Consumes: Task 1 digest helpers; existing `applyRepoOnboarding`.
- Produces: `addOnboardingTools(deps: ToolDeps, tools: ToolDef[]): ToolDef[]`.

- [ ] **Step 1: Write failing tool contract and behavior tests**

Create `tests/onboardingTools.test.ts` with real Git fixtures. Assert the production tool list contains:

```ts
const propose = tools.find(t => t.name === "grande_repo_add_propose")!;
expect(propose.inputSchema.required).toEqual(["repoId"]);
expect(Object.keys(propose.inputSchema.properties)).toEqual(["repoId"]);
expect(propose.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

const apply = tools.find(t => t.name === "grande_repo_add_apply")!;
expect(apply.inputSchema.required?.sort()).toEqual(["proposalDigest", "repoId"]);
expect(Object.keys(apply.inputSchema.properties).sort()).toEqual(["proposalDigest", "repoId"]);
expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
```

Behavior tests:
- propose returns S9 readiness + `proposalDigest` and zero writes;
- apply with the matching digest registers the repo and preserves existing profile definitions;
- apply after HEAD/control-plane changes returns an error envelope and leaves trusted files unchanged;
- no-HEAD/detached/busy/symlink-invalid candidate fails closed;
- before apply, `grande_task_open` rejects the repo; after apply, `grande_task_open` succeeds and the probe task can be closed.

Update manifest tests to expect 25 tools, 10 read-only, 15 write, still 10 open-world and 5 destructive. Add the proposal tool to READ_ONLY and both onboarding names to the exact manifest.

- [ ] **Step 2: Run `unit-selfhost` and verify RED**

Expected: missing tool names / count mismatch / behavior failures.

- [ ] **Step 3: Implement `src/onboardingTools.ts`**

Define two `ToolDef`s. Both handlers should return standard `ok/err` envelopes and redact paths using existing `toToolError` / `redact` behavior. `propose` calls `inspectRepoOnboardingWithDigest`; `apply` calls `assertFreshRepoOnboardingProposal`, verifies `proposal.readyToRegister`, then calls the existing `applyRepoOnboarding`.

The adapter must not accept `taskId`, path, command, argv, or profile definitions from the model.

- [ ] **Step 4: Wire through `src/tools.ts`**

Insert `addOnboardingTools` once in the production assembly before toolset identity is calculated. Do not fork the capability framework and do not add the tools through CLI code.

- [ ] **Step 5: Run `unit-selfhost` and verify GREEN**

Expected: all tool behavior/manifest tests pass except the intentional epoch assertions introduced by Task 3.

---

### Task 3: Toolset epoch/digest release identity and docs

**Files:**
- Modify: `src/toolsetIdentity.ts`
- Modify: `tests/toolsetIdentity.test.ts`
- Modify: `README.md`
- Modify: `docs/chatgpt-connector-compatibility-runbook.md`
- Test: `tests/connectorCompatibilityDocs.test.ts`

**Interfaces:**
- Consumes: final 25-tool production list from Task 2.
- Produces: `TOOLSET_EPOCH = 2`; stable 25-tool digest exposed through existing `grande_task_status` / doctor/selfcheck path.

- [ ] **Step 1: Write failing epoch/release tests**

Add assertions:

```ts
expect(toolsModule.TOOLSET_EPOCH).toBe(2);
```

In a fixture using real `buildTools`, assert `toolsCount === 25`, digest matches `^sha256:`, and the digest is not the epoch-1 23-tool baseline `sha256:55b20104f7a00770cd6ea0f33ec948fcabd602ce397ec534f5a7699e912e287a`.

Update compatibility docs tests to require baseline `25` and epoch `2` plus Scan/Refresh/new-chat read-probe instructions.

- [ ] **Step 2: Run `unit-selfhost` and verify RED**

Expected: epoch remains 1 and docs still name 23 tools.

- [ ] **Step 3: Bump epoch and update docs**

Change only:

```ts
export const TOOLSET_EPOCH = 2;
```

Update README/runbook to state this release intentionally changes the tool contract from 23 to 25 and requires App Scan/Refresh Tools followed by a new-chat `grande_task_status` read probe before using the write tool.

- [ ] **Step 4: Run `unit-selfhost` and verify GREEN**

Expected: all selfhost tests pass with deterministic 25-tool identity.

---

### Task 4: Final verification, load-bearing proofs, review, and release gate

**Files:**
- Review all changed files only.
- No new production behavior unless a failing proof exposes a defect.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: evidence suitable for commit/PR and post-deploy real `grande-console` onboarding.

- [ ] **Step 1: Run final trusted verification**

Run `unit-selfhost` and `typecheck`; both must pass on the final tree.

- [ ] **Step 2: Execute load-bearing proof A**

Temporarily remove HEAD/readiness enforcement from the MCP path. Expected: empty/no-HEAD acceptance turns red. Roll back mutation.

- [ ] **Step 3: Execute load-bearing proof B**

Temporarily skip digest comparison. Expected: stale HEAD/control-plane tests turn red. Roll back mutation.

- [ ] **Step 4: Execute load-bearing proof C**

Temporarily place a registry write before validation. Expected: failed-apply zero-write test turns red. Roll back mutation.

- [ ] **Step 5: Execute load-bearing proof D**

Temporarily bypass shared S9 inspection/path semantics in MCP onboarding. Expected: CLI/openWorktree parity test turns red. Roll back mutation.

- [ ] **Step 6: Execute load-bearing proof E**

Temporarily revert epoch to 1 or omit one onboarding tool from assembly. Expected: manifest/toolset identity test turns red. Roll back mutation.

- [ ] **Step 7: Bounded diff review**

Confirm: no arbitrary path input, no auto-register in task_open, no new init/scaffold/install/push behavior, no destructive annotation expansion, no second capability/registry framework, and no secrets in proposal output/digest inputs.

- [ ] **Step 8: Fresh verification after review fixes**

Re-run `unit-selfhost` and `typecheck` on the exact final tree. Do not claim completion from earlier runs.

- [ ] **Step 9: Commit/push/PR**

Commit with Grande attestation, push task branch, open ready PR, and check live PR status.

- [ ] **Step 10: Host outer-test gate**

Before merge, Human Owner runs:

```bash
GRANDE_WORKSPACE=/Users/xtation/AgentWorks/GPT_Workspace \
node --disable-warning=ExperimentalWarning src/cli.ts \
  outer-test --task task-onboarding-mcp-20260819-001 --run
```

Require all host outer tests green before merge.

- [ ] **Step 11: Post-deploy connector contract verification**

After merge/deploy, verify `toolsetEpoch=2`, `toolsCount=25`, and a new digest. Refresh the ChatGPT App tool snapshot, start a new chat, run `grande_task_status`, then use the new propose/apply tools to register the real `grande-console` repo and prove `grande_task_open` succeeds.
