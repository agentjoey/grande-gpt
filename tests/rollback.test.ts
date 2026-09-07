import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  approveAuthorization,
  createAuthorization,
  rotateAuthorizationChallenge,
  type AuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import type { DeploymentEvidence } from "../src/deliveryEvidence.ts";
import { createDeploymentTools, loadDeploymentSpec } from "../src/deployment.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDef, type ToolDeps } from "../src/tools.ts";

const TASK_ID = "task_rollback";
const sha = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

let root: string;
let layout: Layout;
let deps: ToolDeps;
let previousWorkspace: string | undefined;
let previousControl: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const result = await tool.handler(args);
  return result.structuredContent as Record<string, any>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grande-rollback-"));
  previousWorkspace = process.env.GRANDE_WORKSPACE;
  previousControl = process.env.GRANDE_CONTROL;
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspaceRoot;
  process.env.GRANDE_CONTROL = controlRoot;

  layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
  mkdirSync(worktreeRoot, { recursive: true });
  git(worktreeRoot, "init", "-q", "-b", "main");
  git(worktreeRoot, "config", "user.email", "rollback@example.com");
  git(worktreeRoot, "config", "user.name", "Rollback Test");
  writeFileSync(join(worktreeRoot, "a.txt"), "before\n", "utf8");
  git(worktreeRoot, "add", ".");
  git(worktreeRoot, "commit", "-q", "-m", "initial");
  const baseCommit = git(worktreeRoot, "rev-parse", "HEAD").trim();

  createTask(db, {
    taskId: TASK_ID,
    repoId: "demo",
    branch: "grande/rollback-test",
    baseCommit,
    worktreePath: worktreeRoot,
    state: "READY",
  });
  deps = { db, layout };
});

afterEach(() => {
  deps.db.close();
  if (previousWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = previousWorkspace;
  if (previousControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = previousControl;
  rmSync(root, { recursive: true, force: true });
});

describe("grande_rollback", () => {
  it("repo_edit 后 rollback：每个受影响路径恢复到 edit 前，create 文件进入 Trash", async () => {
    const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
    const original = readFileSync(join(worktreeRoot, "a.txt"));
    const edit = await callTool("grande_repo_edit", {
      taskId: TASK_ID,
      ops: [
        { op: "modify", path: "a.txt", content: "after\n", expectedSha256: sha("before\n") },
        { op: "create", path: "created.txt", content: "created\n" },
      ],
    });
    expect(edit.ok).toBe(true);

    const rollback = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
    });

    expect(rollback.ok).toBe(true);
    expect(rollback.data).toEqual({
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
      restoredPaths: ["a.txt", "created.txt"],
    });
    expect(readFileSync(join(worktreeRoot, "a.txt"))).toEqual(original);
    expect(existsSync(join(worktreeRoot, "created.txt"))).toBe(false);

    const trashRoot = join(layout.controlRoot, "trash", TASK_ID);
    const createdCopy = readdirSync(trashRoot)
      .map((batch) => join(trashRoot, batch, "created.txt"))
      .find((path) => existsSync(path));
    expect(createdCopy).toBeDefined();
    expect(readFileSync(createdCopy!, "utf8")).toBe("created\n");
  });

  it("修改已有文件后 rollback：改动后的内容在 Trash 中逐字节保留", async () => {
    const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
    const original = readFileSync(join(worktreeRoot, "a.txt"));
    const changed = Buffer.from("after\r\n第二版\n", "utf8");
    const edit = await callTool("grande_repo_edit", {
      taskId: TASK_ID,
      ops: [
        {
          op: "modify",
          path: "a.txt",
          content: changed.toString("utf8"),
          expectedSha256: sha("before\n"),
        },
      ],
    });
    expect(edit.ok).toBe(true);

    const rollback = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
    });

    expect(rollback.ok).toBe(true);
    expect(readFileSync(join(worktreeRoot, "a.txt"))).toEqual(original);
    const trashRoot = join(layout.controlRoot, "trash", TASK_ID);
    expect(existsSync(trashRoot)).toBe(true);
    const changedCopies = readdirSync(trashRoot)
      .map((batch) => join(trashRoot, batch, "a.txt"))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path));
    expect(changedCopies.some((bytes) => bytes.equals(changed))).toBe(true);
  });

  it("未知 checkpointId 返回明确错误，worktree 逐字节不变，审计落到 FAILED", async () => {
    const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
    const before = readFileSync(join(worktreeRoot, "a.txt"));

    const result = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: "missing-checkpoint",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(readFileSync(join(worktreeRoot, "a.txt"))).toEqual(before);
    const audit = listAudit(deps.db, TASK_ID).find((row) => row.tool === "grande_rollback");
    expect(audit?.decision).toBe("ALLOWED");
    expect(audit?.state).toBe("FAILED");
  });

  it("未知 taskId 返回 TASK_NOT_FOUND，且不创建 rollback 审计记录", async () => {
    const result = await callTool("grande_rollback", {
      taskId: "task_does_not_exist",
      checkpointId: "anything",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TASK_NOT_FOUND");
    expect(listAudit(deps.db, "task_does_not_exist")).toEqual([]);
  });

  it("成功回滚写入 ALLOWED/SUCCEEDED 审计，并记录实际恢复路径", async () => {
    const edit = await callTool("grande_repo_edit", {
      taskId: TASK_ID,
      ops: [{ op: "modify", path: "a.txt", content: "after\n", expectedSha256: sha("before\n") }],
    });
    expect(edit.ok).toBe(true);

    const result = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
    });
    expect(result.ok).toBe(true);

    const audit = listAudit(deps.db, TASK_ID).find((row) => row.tool === "grande_rollback");
    expect(audit?.decision).toBe("ALLOWED");
    expect(audit?.state).toBe("SUCCEEDED");
    expect(audit?.pathsTouched).toEqual(["a.txt"]);
  });

  it("注册为工具，参数必填且 destructiveHint 保持 false", () => {
    const tools = buildTools(deps);
    const rollback = tools.find((tool) => tool.name === "grande_rollback");

    expect(rollback).toBeDefined();
    expect(rollback!.inputSchema.required).toEqual(expect.arrayContaining(["taskId", "checkpointId"]));
    expect(rollback!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

describe("V2 rollback (explicit deliveryTarget=deploy)", () => {
  const CUR_SHA = "a".repeat(40);
  const ROLLBACK_SHA = "b".repeat(40);
  const DEPLOY_EVIDENCE: DeploymentEvidence = {
    target: "production",
    deploymentId: "cur-1",
    sourceSha: CUR_SHA,
  };
  const ROLLBACK_EVIDENCE: DeploymentEvidence = {
    target: "production",
    deploymentId: "prev-1",
    sourceSha: ROLLBACK_SHA,
  };

  function worktreePath(): string {
    return join(layout.worktreesRoot, "demo", TASK_ID);
  }

  function writeV2Spec(): void {
    mkdirSync(join(worktreePath(), ".grande"), { recursive: true });
    writeFileSync(
      join(worktreePath(), ".grande", "deploy.yaml"),
      "deploy:\n  capability:\n    provider: platform\n    name: deploy\n" +
      "verify:\n  capability:\n    provider: platform\n    name: verify\n" +
      "rollback:\n  capability:\n    provider: platform\n    name: rollback\n",
      "utf8",
    );
  }

  function seedReceipt(): void {
    const spec = loadDeploymentSpec(worktreePath());
    const receipt = {
      taskId: TASK_ID,
      specDigest: createHash("sha256").update(JSON.stringify(spec), "utf8").digest("hex"),
      deployRef: "capability:platform/deploy",
      verifyRef: "capability:platform/verify",
      rollbackRef: "capability:platform/rollback",
      deployComplete: true,
      verifyComplete: true,
      authorizationId: "authz_00000000-0000-4000-8000-000000000000",
      deployEvidence: DEPLOY_EVIDENCE,
      stages: { deploy: "succeeded", verify: "succeeded" },
    };
    deps.db.prepare(
      "INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)",
    ).run(TASK_ID, JSON.stringify(receipt), Date.now());
  }

  function bindingBase(): Omit<AuthorizationBinding, "authorizationKind"> {
    const createdAt = Date.now();
    return {
      taskId: TASK_ID,
      repoId: "demo",
      worktreeRealpath: worktreePath(),
      deliveryTarget: "deploy",
      deployTarget: "production",
      deploySpecDigest: `sha256:${"0".repeat(64)}`,
      policyDigest: `sha256:${"0".repeat(64)}`,
      runtimeBuild: "test",
      toolsetEpoch: 1,
      toolsDigest: `sha256:${"0".repeat(64)}`,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
    } as Omit<AuthorizationBinding, "authorizationKind">;
  }

  function createApprovedAuth(binding: AuthorizationBinding): string {
    const auth = createAuthorization(deps.db, { kind: binding.authorizationKind, taskId: TASK_ID, binding, stages: {} });
    const { approvalNonce } = rotateAuthorizationChallenge(deps.db, auth.authorizationId, auth.bindingDigest);
    approveAuthorization(deps.db, {
      authorizationId: auth.authorizationId,
      bindingDigest: auth.bindingDigest,
      approvalNonce,
      identity: { sub: "owner", email: "owner@example.com" },
    });
    return auth.authorizationId;
  }

  function rollbackBinding(overrides: Record<string, unknown> = {}): AuthorizationBinding {
    return {
      ...bindingBase(),
      authorizationKind: "rollback",
      currentDeploymentId: "cur-1",
      currentSourceSha: CUR_SHA,
      rollbackDeploymentId: "prev-1",
      rollbackSourceSha: ROLLBACK_SHA,
      rollbackRef: "capability:platform/rollback",
      ...overrides,
    } as AuthorizationBinding;
  }

  function deliveryBinding(): AuthorizationBinding {
    return {
      ...bindingBase(),
      authorizationKind: "delivery",
      prNumber: 1,
      baseRef: "main",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      mergeMethod: "merge",
      expectedMergeTree: "3".repeat(40),
      deployRef: "capability:platform/deploy",
      verifyRef: "capability:platform/verify",
    } as AuthorizationBinding;
  }

  function expireActiveAuth(): void {
    deps.db.prepare("UPDATE delivery_authorization SET status='EXPIRED' WHERE taskId=? AND status IN ('READY','APPROVED','EXECUTING')")
      .run(TASK_ID);
  }

  function authStatus(authorizationId: string): string {
    const row = deps.db
      .prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
      .get(authorizationId) as { status: string };
    return row.status;
  }

  function capabilityTools(calls: string[], result: unknown): ToolDef[] {
    return [
      {
        name: "grande_capability_inspect",
        description: "inspect",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) => ({
          structuredContent: {
            ok: true,
            data: { capability: { provider: args.provider, name: args.name, risk: args.name === "verify" ? "read" : "production" } },
          },
        }),
      },
      {
        name: "grande_capability_invoke",
        description: "invoke",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) => {
          calls.push(String(args.name));
          return { structuredContent: { ok: true, data: { result } } };
        },
      },
    ];
  }

  function setup(): { calls: string[]; tools: ToolDef[] } {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, TASK_ID, "deploy");
    seedReceipt();
    const calls: string[] = [];
    return { calls, tools: createDeploymentTools(deps, capabilityTools(calls, ROLLBACK_EVIDENCE)) };
  }

  async function callRollback(tools: ToolDef[]): Promise<Record<string, any>> {
    const tool = tools.find((candidate) => candidate.name === "grande_deploy_rollback")!;
    return (await tool.handler({ taskId: TASK_ID })).structuredContent as Record<string, any>;
  }

  it("没有活跃 rollback authorization 时拒绝，零 side effect", async () => {
    const { calls, tools } = setup();
    const envelope = await callRollback(tools);
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("delivery kind 的活跃 authorization 被明确拒绝（不得复用 delivery 授权）", async () => {
    const { calls, tools } = setup();
    createApprovedAuth(deliveryBinding());
    const envelope = await callRollback(tools);
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/delivery kind/);
    expect(calls).toEqual([]);
  });

  it("rollbackDeploymentId/rollbackSourceSha 的相对别名在 invoke 前被拒绝", async () => {
    const { calls, tools } = setup();
    createApprovedAuth(rollbackBinding({ rollbackDeploymentId: "previous" }));
    const first = await callRollback(tools);
    expect(first.ok).toBe(false);
    expect(JSON.stringify(first)).toMatch(/别名|alias/i);
    expect(calls).toEqual([]);

    expireActiveAuth();
    createApprovedAuth(rollbackBinding({ rollbackSourceSha: "head" }));
    const second = await callRollback(tools);
    expect(second.ok).toBe(false);
    expect(JSON.stringify(second)).toMatch(/别名|alias|40/i);
    expect(calls).toEqual([]);
  });

  it("binding.current 与 durable deployEvidence 不一致时拒绝，零 side effect", async () => {
    const { calls, tools } = setup();
    createApprovedAuth(rollbackBinding({ currentDeploymentId: "someone-else" }));
    const envelope = await callRollback(tools);
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);

    expireActiveAuth();
    createApprovedAuth(rollbackBinding({ currentSourceSha: "f".repeat(40) }));
    const second = await callRollback(tools);
    expect(second.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("binding.rollbackRef 与当前 spec rollback ref 不一致时拒绝", async () => {
    const { calls, tools } = setup();
    createApprovedAuth(rollbackBinding({ rollbackRef: "capability:platform/other" }));
    const envelope = await callRollback(tools);
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("happy path：APPROVED→EXECUTING→SUCCEEDED，恰好一次 invoke，重入幂等", async () => {
    const { calls, tools } = setup();
    const authorizationId = createApprovedAuth(rollbackBinding());
    expect(authStatus(authorizationId)).toBe("APPROVED");

    const envelope = await callRollback(tools);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.state).toBe("rolled-back");
    expect(envelope.data.rollbackAuthorizationId).toBe(authorizationId);
    expect(calls).toEqual(["rollback"]);
    expect(authStatus(authorizationId)).toBe("SUCCEEDED");

    const row = deps.db
      .prepare("SELECT receiptJson FROM deployment_receipt WHERE taskId=?")
      .get(TASK_ID) as { receiptJson: string };
    const receipt = JSON.parse(row.receiptJson);
    expect(receipt.rollbackAuthorizationId).toBe(authorizationId);
    expect(receipt.stages.rollback).toBe("succeeded");

    const again = await callRollback(tools);
    expect(again.ok).toBe(true);
    expect(again.data.existing).toBe(true);
    expect(calls).toEqual(["rollback"]);
    expect(authStatus(authorizationId)).toBe("SUCCEEDED");
  });

  it("capability 结果缺失/有歧义（无证据）→ UNCERTAIN 且绝不重试", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, TASK_ID, "deploy");
    seedReceipt();
    const calls: string[] = [];
    const tools = createDeploymentTools(deps, capabilityTools(calls, { unexpected: true }));
    const authorizationId = createApprovedAuth(rollbackBinding());

    const envelope = await callRollback(tools);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.state).toBe("uncertain");
    expect(envelope.data.retryable).toBe(false);
    expect(calls).toEqual(["rollback"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");

    const again = await callRollback(tools);
    expect(again.ok).toBe(true);
    expect(again.data.state).toBe("uncertain");
    expect(again.data.existing).toBe(true);
    expect(calls).toEqual(["rollback"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
  });
});
