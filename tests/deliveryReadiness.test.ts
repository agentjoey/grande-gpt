import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  bindingDigestOf,
  createAuthorization,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import {
  prepareDeliveryAuthorization,
  revalidateDeliveryBinding,
  type DeliveryReadinessDeps,
} from "../src/deliveryReadiness.ts";
import { StateError } from "../src/errors.ts";
import { createGithubApi } from "../src/githubApi.ts";
import { buildHostVerifierStaticPlan } from "../src/hostVerifier.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { execFileSync } from "node:child_process";
import {
  getOuterTestReceipt,
  persistTrustedOuterTestPassV2,
  type OuterTestReceiptV2,
} from "../src/outerTestReceipt.ts";
import { trustedDeploymentProfileEvidence } from "../src/profiles.ts";
import { readDeliveryHostVerification } from "../src/prHostVerification.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask, getTask } from "../src/tasks.ts";

/**
 * Minimal V2 Task 3：exact readiness 与 immutable authorization binding。
 * 每个 blocker 变体都独立断言两件事：delivery_authorization 表保持为空，
 * 且账本里没有成功的 grande_delivery_prepare 记录（零副作用）。
 */

const TASK = "task_readiness";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const SPEC_DIGEST = `sha256:${"a".repeat(64)}`;
const POLICY_DIGEST = `sha256:${"b".repeat(64)}`;
const TOOLS_DIGEST = `sha256:${"c".repeat(64)}`;
const RUNTIME_BUILD = `git:${"e".repeat(40)}`;

let root: string;
let layout: Layout;
let db: DatabaseSync;

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-readiness-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId: TASK,
    repoId: "demo",
    branch: `grande/${TASK}`,
    baseCommit: BASE,
    worktreePath: join(root, "worktree"),
    state: "READY",
  });
  saveExplicitDeliveryTarget(db, TASK, "deploy");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<DeliveryReadinessDeps> = {}): DeliveryReadinessDeps {
  return {
    readPullRequest: async () => ({
      number: 7,
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      state: "open",
    }),
    readRequiredCi: async () => "success",
    readAttestation: () => ({ commit: HEAD, jobId: "job_att" }),
    readHostVerification: () => ({ commit: HEAD, jobId: "job_host", planDigest: `sha256:${"d".repeat(64)}` }),
    computeExpectedMergeTree: () => TREE,
    resolveDeployAction: () => ({
      deployTarget: "deployment-host:demo/deploy-prod",
      deployRef: "profile:deploy-prod",
      verifyRef: "profile:verify-prod",
      deploySpecDigest: SPEC_DIGEST,
      policyDigest: POLICY_DIGEST,
    }),
    readWorktreeState: () => ({ headSha: HEAD, clean: true, realpath: "/tmp/wt-real" }),
    readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 2, toolsDigest: TOOLS_DIGEST }),
    ...overrides,
  };
}

function authRows(): unknown[] {
  return db.prepare("SELECT * FROM delivery_authorization").all();
}

function auditRows() {
  return listAudit(db, TASK, 100);
}

/** blocker 的硬要求：authorization 表为空，且账本里没有任何 grande_delivery_prepare 记录。 */
async function expectBlocked(
  deps: DeliveryReadinessDeps,
  code: string,
  taskId = TASK,
): Promise<void> {
  await expect(prepareDeliveryAuthorization(db, taskId, deps)).rejects.toMatchObject({ code });
  expect(authRows()).toEqual([]);
  expect(auditRows().filter((row) => row.tool === "grande_delivery_prepare")).toEqual([]);
}

function canonicalSha256(value: unknown): string {
  const stable = JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
  return createHash("sha256").update(stable ?? "null", "utf8").digest("hex");
}

const EXPECTED_BINDING_KEYS = [
  "authorizationKind",
  "baseRef",
  "baseSha",
  "createdAt",
  "deliveryTarget",
  "deployRef",
  "deploySpecDigest",
  "deployTarget",
  "expectedMergeTree",
  "expiresAt",
  "headSha",
  "mergeMethod",
  "policyDigest",
  "prNumber",
  "repoId",
  "runtimeBuild",
  "taskId",
  "toolsDigest",
  "toolsetEpoch",
  "verifyRef",
  "worktreeRealpath",
].sort();

describe("prepareDeliveryAuthorization", () => {
  it("happy path：恰好一条 READY proposal 与一条成功的 grande_delivery_prepare 审计", async () => {
    const result = await prepareDeliveryAuthorization(db, TASK, makeDeps());
    expect(result.state).toBe("READY");
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    const rows = authRows() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.authorizationId).toBe(result.authorizationId);
    expect(row.status).toBe("READY");
    expect(row.nonceDigest).toBeNull(); // preparation 不创建可审批 nonce

    const binding = JSON.parse(row.bindingJson as string) as DeliveryAuthorizationBinding;
    expect(Object.keys(binding).sort()).toEqual(EXPECTED_BINDING_KEYS);
    expect(binding).toMatchObject({
      authorizationKind: "delivery",
      taskId: TASK,
      repoId: "demo",
      worktreeRealpath: "/tmp/wt-real",
      deliveryTarget: "deploy",
      deployTarget: "deployment-host:demo/deploy-prod",
      deploySpecDigest: SPEC_DIGEST,
      policyDigest: POLICY_DIGEST,
      runtimeBuild: RUNTIME_BUILD,
      toolsetEpoch: 2,
      toolsDigest: TOOLS_DIGEST,
      prNumber: 7,
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      mergeMethod: "merge",
      expectedMergeTree: TREE,
      deployRef: "profile:deploy-prod",
      verifyRef: "profile:verify-prod",
    });
    expect(binding.expiresAt).toBe(binding.createdAt + APPROVAL_TTL_MS);
    expect(result.bindingDigest).toBe(bindingDigestOf(binding));
    expect(row.bindingDigest).toBe(result.bindingDigest);

    const audits = auditRows().filter((entry) => entry.tool === "grande_delivery_prepare");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision).toBe("ALLOWED");
    expect(audits[0]!.state).toBe("SUCCEEDED");
    expect(audits[0]!.pathsTouched).toEqual([]); // preparation 无文件系统副作用
    // 审计 input 只含 {bindingDigest, taskId} 的摘要——不含 nonce、不含明文 binding JSON。
    expect(audits[0]!.inputDigest).toBe(
      canonicalSha256({ taskId: TASK, bindingDigest: result.bindingDigest }),
    );
  });

  it("任务不存在是 blocker（TASK_NOT_FOUND），零副作用", async () => {
    await expectBlocked(makeDeps(), "TASK_NOT_FOUND", "task_missing");
  });

  it("没有显式 deliveryTarget=deploy 是 blocker", async () => {
    db.prepare("DELETE FROM task_delivery_target WHERE taskId=?").run(TASK);
    await expectBlocked(makeDeps(), "POLICY_DENIED");
  });

  it("显式 deliveryTarget=pr 不能升级成 deploy authorization", async () => {
    db.prepare("DELETE FROM task_delivery_target WHERE taskId=?").run(TASK);
    saveExplicitDeliveryTarget(db, TASK, "pr");
    await expectBlocked(makeDeps(), "POLICY_DENIED");
  });

  it("worktree dirty 是 blocker", async () => {
    await expectBlocked(
      makeDeps({ readWorktreeState: () => ({ headSha: HEAD, clean: false, realpath: "/tmp/wt-real" }) }),
      "WORKTREE_DIRTY",
    );
  });

  it("worktree HEAD 与 PR head 不一致是 blocker（旧 SHA 的证据不背书新 SHA）", async () => {
    await expectBlocked(
      makeDeps({ readWorktreeState: () => ({ headSha: "f".repeat(40), clean: true, realpath: "/tmp/wt-real" }) }),
      "STALE_STATE",
    );
  });

  it("PR 已关闭是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        readPullRequest: async () => ({ number: 7, baseRef: "main", baseSha: BASE, headSha: HEAD, state: "closed" }),
      }),
      "INVALID_INPUT",
    );
  });

  it("PR 缺少精确 baseSha 是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        readPullRequest: async () => ({ number: 7, baseRef: "main", baseSha: "not-a-sha", headSha: HEAD, state: "open" }),
      }),
      "INVALID_INPUT",
    );
  });

  it("CI pending 是 blocker", async () => {
    await expectBlocked(makeDeps({ readRequiredCi: async () => "pending" }), "STALE_STATE");
  });

  it("CI failed 是 blocker", async () => {
    await expectBlocked(makeDeps({ readRequiredCi: async () => "failed" }), "INVALID_INPUT");
  });

  it("没有绑定 current head 的 attestation 是 blocker", async () => {
    await expectBlocked(makeDeps({ readAttestation: () => null }), "POLICY_DENIED");
  });

  it("attestation 绑定的是旧 SHA 是 blocker", async () => {
    await expectBlocked(
      makeDeps({ readAttestation: () => ({ commit: "0".repeat(40), jobId: "job_att" }) }),
      "POLICY_DENIED",
    );
  });

  it("没有绑定 current head 的 Host verification receipt 是 blocker", async () => {
    await expectBlocked(makeDeps({ readHostVerification: () => null }), "POLICY_DENIED");
  });

  it("Host verification receipt 绑定的是旧 SHA 是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        readHostVerification: () => ({ commit: "0".repeat(40), jobId: "job_host", planDigest: `sha256:${"d".repeat(64)}` }),
      }),
      "POLICY_DENIED",
    );
  });

  it("deploy spec 无法解析/角色不匹配时（resolver 抛错）是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        resolveDeployAction: () => {
          throw new StateError("POLICY_DENIED", "deploy.profile=test 不是 deploy/deploy-*。");
        },
      }),
      "POLICY_DENIED",
    );
  });

  it("deployTarget 为空/自由文本形状不合法是 blocker——target 必须来自可信 resolver", async () => {
    await expectBlocked(
      makeDeps({
        resolveDeployAction: () => ({
          deployTarget: "  ",
          deployRef: "profile:deploy-prod",
          verifyRef: "profile:verify-prod",
          deploySpecDigest: SPEC_DIGEST,
          policyDigest: POLICY_DIGEST,
        }),
      }),
      "POLICY_DENIED",
    );
  });

  it("policyDigest 形状不合法是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        resolveDeployAction: () => ({
          deployTarget: "deployment-host:demo/deploy-prod",
          deployRef: "profile:deploy-prod",
          verifyRef: "profile:verify-prod",
          deploySpecDigest: SPEC_DIGEST,
          policyDigest: "not-a-digest",
        }),
      }),
      "POLICY_DENIED",
    );
  });

  it("deploySpecDigest 形状不合法是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        resolveDeployAction: () => ({
          deployTarget: "deployment-host:demo/deploy-prod",
          deployRef: "profile:deploy-prod",
          verifyRef: "profile:verify-prod",
          deploySpecDigest: "sha256:short",
          policyDigest: POLICY_DIGEST,
        }),
      }),
      "POLICY_DENIED",
    );
  });

  it("runtime build 缺失是 blocker", async () => {
    await expectBlocked(
      makeDeps({ readRuntimeIdentity: () => ({ runtimeBuild: "", toolsetEpoch: 2, toolsDigest: TOOLS_DIGEST }) }),
      "INVALID_INPUT",
    );
  });

  it("toolset identity 不合法是 blocker", async () => {
    await expectBlocked(
      makeDeps({ readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 0, toolsDigest: TOOLS_DIGEST }) }),
      "INVALID_INPUT",
    );
    await expectBlocked(
      makeDeps({ readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 2, toolsDigest: "bad" }) }),
      "INVALID_INPUT",
    );
  });

  it("有 running job 时是 blocker", async () => {
    createJob(db, { jobId: "job_running", taskId: TASK, profile: "unit-selfhost", argv: [], pgid: 1234 });
    await expectBlocked(makeDeps(), "JOB_RUNNING");
  });

  it("已存在同 task 的活跃 authorization 时是 blocker", async () => {
    await prepareDeliveryAuthorization(db, TASK, makeDeps());
    // 第二次 prepare 被 STALE_STATE 挡住：不新增行、不新增 prepare 审计记录。
    await expect(prepareDeliveryAuthorization(db, TASK, makeDeps())).rejects.toMatchObject({ code: "STALE_STATE" });
    // 第一次的 proposal 仍在，且只有一条；prepare 审计记录也只有第一次那一条。
    expect(authRows()).toHaveLength(1);
    expect(auditRows().filter((row) => row.tool === "grande_delivery_prepare")).toHaveLength(1);
  });

  it("merge-tree 计算失败（canonical 不可安全 refresh/冲突）是 blocker", async () => {
    await expectBlocked(
      makeDeps({
        computeExpectedMergeTree: () => {
          throw new StateError("CANONICAL_DIRTY", "canonical checkout 有未提交改动。");
        },
      }),
      "CANONICAL_DIRTY",
    );
  });

  it("merge-tree 产出不是合法 tree SHA 是 blocker", async () => {
    await expectBlocked(makeDeps({ computeExpectedMergeTree: () => "garbage" }), "INVALID_INPUT");
  });

  it("CI/attestation/host 都按 current head 查询，而不是按旧 SHA", async () => {
    const seen: string[] = [];
    await prepareDeliveryAuthorization(db, TASK, makeDeps({
      readRequiredCi: async (_taskId, headSha) => { seen.push(`ci:${headSha}`); return "success"; },
      readAttestation: (_taskId, headSha) => { seen.push(`att:${headSha}`); return { commit: headSha, jobId: "j1" }; },
      readHostVerification: (_taskId, headSha) => {
        seen.push(`host:${headSha}`);
        return { commit: headSha, jobId: "j2", planDigest: `sha256:${"d".repeat(64)}` };
      },
    }));
    expect(seen).toEqual([`ci:${HEAD}`, `att:${HEAD}`, `host:${HEAD}`]);
  });
});

describe("revalidateDeliveryBinding", () => {
  async function prepare(): Promise<{ authorizationId: string; bindingDigest: string }> {
    const result = await prepareDeliveryAuthorization(db, TASK, makeDeps());
    return { authorizationId: result.authorizationId, bindingDigest: result.bindingDigest };
  }

  it("证据未漂移时返回 durable binding，状态保持 READY", async () => {
    const { authorizationId } = await prepare();
    const binding = await revalidateDeliveryBinding(db, authorizationId, makeDeps());
    expect(binding.headSha).toBe(HEAD);
    expect(binding.baseSha).toBe(BASE);
    const row = db.prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
      .get(authorizationId) as { status: string };
    expect(row.status).toBe("READY");
  });

  it("authorization 不存在抛 AUTH_NOT_FOUND", async () => {
    await expect(revalidateDeliveryBinding(db, "authz_missing", makeDeps()))
      .rejects.toMatchObject({ code: "AUTH_NOT_FOUND" });
  });

  // 规格 §14.2：每个 binding 维度的漂移都必须使旧 authorization 失效（STALE）且零执行。
  const drifts: Array<[string, () => Partial<DeliveryReadinessDeps>]> = [
    ["headSha", () => ({ readPullRequest: async () => ({ number: 7, baseRef: "main", baseSha: BASE, headSha: "1".repeat(40), state: "open" as const }) })],
    ["baseSha", () => ({ readPullRequest: async () => ({ number: 7, baseRef: "main", baseSha: "2".repeat(40), headSha: HEAD, state: "open" as const }) })],
    ["baseRef", () => ({ readPullRequest: async () => ({ number: 7, baseRef: "release", baseSha: BASE, headSha: HEAD, state: "open" as const }) })],
    ["prNumber", () => ({ readPullRequest: async () => ({ number: 8, baseRef: "main", baseSha: BASE, headSha: HEAD, state: "open" as const }) })],
    ["expectedMergeTree", () => ({ computeExpectedMergeTree: () => "3".repeat(40) })],
    ["worktreeRealpath", () => ({ readWorktreeState: () => ({ headSha: HEAD, clean: true, realpath: "/tmp/wt-other" }) })],
    ["deployTarget", () => ({ resolveDeployAction: () => ({ deployTarget: "deployment-host:demo/deploy-staging", deployRef: "profile:deploy-prod", verifyRef: "profile:verify-prod", deploySpecDigest: SPEC_DIGEST, policyDigest: POLICY_DIGEST }) })],
    ["deployRef", () => ({ resolveDeployAction: () => ({ deployTarget: "deployment-host:demo/deploy-prod", deployRef: "profile:deploy-other", verifyRef: "profile:verify-prod", deploySpecDigest: SPEC_DIGEST, policyDigest: POLICY_DIGEST }) })],
    ["verifyRef", () => ({ resolveDeployAction: () => ({ deployTarget: "deployment-host:demo/deploy-prod", deployRef: "profile:deploy-prod", verifyRef: "profile:verify-other", deploySpecDigest: SPEC_DIGEST, policyDigest: POLICY_DIGEST }) })],
    ["deploySpecDigest", () => ({ resolveDeployAction: () => ({ deployTarget: "deployment-host:demo/deploy-prod", deployRef: "profile:deploy-prod", verifyRef: "profile:verify-prod", deploySpecDigest: `sha256:${"4".repeat(64)}`, policyDigest: POLICY_DIGEST }) })],
    ["policyDigest", () => ({ resolveDeployAction: () => ({ deployTarget: "deployment-host:demo/deploy-prod", deployRef: "profile:deploy-prod", verifyRef: "profile:verify-prod", deploySpecDigest: SPEC_DIGEST, policyDigest: `sha256:${"5".repeat(64)}` }) })],
    ["runtimeBuild", () => ({ readRuntimeIdentity: () => ({ runtimeBuild: `git:${"6".repeat(40)}`, toolsetEpoch: 2, toolsDigest: TOOLS_DIGEST }) })],
    ["toolsetEpoch", () => ({ readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 3, toolsDigest: TOOLS_DIGEST }) })],
    ["toolsDigest", () => ({ readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 2, toolsDigest: `sha256:${"7".repeat(64)}` }) })],
  ];

  for (const [field, mutate] of drifts) {
    it(`${field} 漂移 → authorization 置为 STALE 且本次请求零执行`, async () => {
      const { authorizationId, bindingDigest } = await prepare();
      await expect(revalidateDeliveryBinding(db, authorizationId, makeDeps(mutate())))
        .rejects.toMatchObject({ code: "STALE_STATE" });
      const row = db.prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
        .get(authorizationId) as { status: string };
      expect(row.status).toBe("STALE");
      // 规格 §13：stale 事件进审计账本，绑定 authorizationId/bindingDigest，不含 nonce。
      const audits = auditRows().filter((entry) => entry.tool === "grande_delivery_revalidate");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.state).toBe("SUCCEEDED");
      expect(audits[0]!.inputDigest).toBe(
        canonicalSha256({ authorizationId, bindingDigest, outcome: "STALE", taskId: TASK }),
      );
    });
  }

  it("过期的 authorization 置为 EXPIRED 并拒绝", async () => {
    const past = 1_000_000_000_000;
    const binding: DeliveryAuthorizationBinding = {
      authorizationKind: "delivery",
      taskId: TASK,
      repoId: "demo",
      worktreeRealpath: "/tmp/wt-real",
      deliveryTarget: "deploy",
      deployTarget: "deployment-host:demo/deploy-prod",
      deploySpecDigest: SPEC_DIGEST,
      policyDigest: POLICY_DIGEST,
      runtimeBuild: RUNTIME_BUILD,
      toolsetEpoch: 2,
      toolsDigest: TOOLS_DIGEST,
      createdAt: past,
      expiresAt: past + APPROVAL_TTL_MS,
      prNumber: 7,
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      mergeMethod: "merge",
      expectedMergeTree: TREE,
      deployRef: "profile:deploy-prod",
      verifyRef: "profile:verify-prod",
    };
    const row = createAuthorization(db, { kind: "delivery", taskId: TASK, binding, stages: {}, now: past });
    await expect(revalidateDeliveryBinding(db, row.authorizationId, makeDeps()))
      .rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const stored = db.prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
      .get(row.authorizationId) as { status: string };
    expect(stored.status).toBe("EXPIRED");
    const audits = auditRows().filter((entry) => entry.tool === "grande_delivery_revalidate");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.inputDigest).toBe(
      canonicalSha256({ authorizationId: row.authorizationId, bindingDigest: row.bindingDigest, outcome: "EXPIRED", taskId: TASK }),
    );
  });

  it("终态 authorization 不能再 revalidate", async () => {
    const { authorizationId } = await prepare();
    // 先制造一次漂移把它推进 STALE 终态
    await expect(
      revalidateDeliveryBinding(db, authorizationId, makeDeps({ computeExpectedMergeTree: () => "3".repeat(40) })),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    await expect(revalidateDeliveryBinding(db, authorizationId, makeDeps()))
      .rejects.toMatchObject({ code: "STALE_STATE" });
  });

  it("rollback authorization 不走 delivery readiness 复核", async () => {
    const now = Date.now();
    const binding = {
      authorizationKind: "rollback" as const,
      taskId: TASK,
      repoId: "demo",
      worktreeRealpath: "/tmp/wt-real",
      deliveryTarget: "deploy" as const,
      deployTarget: "deployment-host:demo/deploy-prod",
      deploySpecDigest: SPEC_DIGEST,
      policyDigest: POLICY_DIGEST,
      runtimeBuild: RUNTIME_BUILD,
      toolsetEpoch: 2,
      toolsDigest: TOOLS_DIGEST,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      currentDeploymentId: "dep-1",
      currentSourceSha: "8".repeat(40),
      rollbackDeploymentId: "dep-0",
      rollbackSourceSha: "9".repeat(40),
      rollbackRef: "profile:rollback-prod",
    };
    const row = createAuthorization(db, { kind: "rollback", taskId: TASK, binding, stages: {} });
    await expect(revalidateDeliveryBinding(db, row.authorizationId, makeDeps()))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("trustedDeploymentProfileEvidence（profiles.ts 可信注册证据）", () => {
  function writeProfiles(body: string): void {
    writeFileSync(join(layout.configDir, "profiles.yaml"), body, "utf8");
  }

  const baseProfiles = `
repos:
  demo:
    deploy-prod:
      argv: ["/usr/bin/true"]
      timeoutSeconds: 60
      execution: deployment-host
    verify-prod:
      argv: ["/usr/bin/true"]
      timeoutSeconds: 60
      execution: deployment-host
    test:
      argv: ["/usr/bin/true"]
      timeoutSeconds: 60
`;

  it("只覆盖被引用的 profile：无关 profile 变化不制造 stale", () => {
    writeProfiles(baseProfiles);
    const before = trustedDeploymentProfileEvidence(layout, "demo", [
      { role: "deploy", profile: "deploy-prod" },
      { role: "verify", profile: "verify-prod" },
    ]);
    expect(before.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    writeProfiles(baseProfiles + `    lint:\n      argv: ["/usr/bin/true"]\n      timeoutSeconds: 30\n`);
    const after = trustedDeploymentProfileEvidence(layout, "demo", [
      { role: "deploy", profile: "deploy-prod" },
      { role: "verify", profile: "verify-prod" },
    ]);
    expect(after.digest).toBe(before.digest);
  });

  it("被引用 profile 的记录变化会改变 digest", () => {
    writeProfiles(baseProfiles);
    const before = trustedDeploymentProfileEvidence(layout, "demo", [
      { role: "deploy", profile: "deploy-prod" },
    ]);
    writeProfiles(baseProfiles.replace('"/usr/bin/true"', '"/usr/bin/false"'));
    const after = trustedDeploymentProfileEvidence(layout, "demo", [
      { role: "deploy", profile: "deploy-prod" },
    ]);
    expect(after.digest).not.toBe(before.digest);
  });

  it("deploy 角色拒绝非 deploy-* 的 profile（角色必须匹配可信注册）", () => {
    writeProfiles(baseProfiles);
    expect(() => trustedDeploymentProfileEvidence(layout, "demo", [{ role: "deploy", profile: "test" }]))
      .toThrowError(/deploy/);
  });

  it("rollback 角色拒绝非 rollback-* 的 profile", () => {
    writeProfiles(baseProfiles);
    expect(() => trustedDeploymentProfileEvidence(layout, "demo", [{ role: "rollback", profile: "deploy-prod" }]))
      .toThrowError(/rollback/);
  });

  it("未注册的 profile 是 PROFILE_NOT_FOUND", () => {
    writeProfiles(baseProfiles);
    expect(() => trustedDeploymentProfileEvidence(layout, "demo", [{ role: "deploy", profile: "deploy-missing" }]))
      .toThrowError(/没有名为/);
  });
});

describe("readDeliveryHostVerification（prHostVerification.ts readiness reader）", () => {
  let head: string;

  beforeEach(() => {
    // 与 tests/prHostVerification.test.ts 相同的可信 V2 receipt 配方：
    // trusted host-verifier job（passed）+ persistTrustedOuterTestPassV2。
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    git(worktree, "init", "-q", "-b", `grande/${TASK}`);
    git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "--allow-empty", "-q", "-m", "base");
    const base = git(worktree, "rev-parse", "HEAD");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "feature.ts"), "export const x = 1;\n", "utf8");
    git(worktree, "add", "src/feature.ts");
    git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "feature");
    head = git(worktree, "rev-parse", "HEAD");
    db.prepare("UPDATE task SET repoId=?, baseCommit=? WHERE taskId=?").run("grande-gpt", base, TASK);
  });

  function writeTrustedReceipt(): { jobId: string; receipt: OuterTestReceiptV2 } {
    const plan = buildHostVerifierStaticPlan("smoke");
    const jobId = "job_host_receipt";
    createJob(db, { jobId, taskId: TASK, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 9876 });
    finishJob(db, jobId, {
      state: "passed",
      exitCode: 0,
      artifactPath: null,
      summary: {
        kind: "host-verifier-v2",
        mode: "auto",
        repoId: "grande-gpt",
        commit: head,
        level: "smoke",
        files: plan.files,
        policyVersion: plan.policyVersion,
        resourceLimits: plan.resourceLimits,
        loopbackPorts: [49173],
        hostToolchain: { node: "v24.14.0", pnpm: "10.33.0", lockfileSha256: "c".repeat(64) },
      },
    });
    persistTrustedOuterTestPassV2(db, TASK, jobId);
    return { jobId, receipt: getOuterTestReceipt(db, TASK) as OuterTestReceiptV2 };
  }

  it("eligible V2 receipt 精确绑定 headSha 时返回 {commit, jobId, planDigest}", () => {
    const { jobId, receipt } = writeTrustedReceipt();
    const task = getTask(db, TASK)!;
    const result = readDeliveryHostVerification(db, task, head);
    expect(result).toEqual({ commit: head, jobId, planDigest: receipt.planDigest });
    expect(result!.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("没有 receipt 时返回 null（readiness blocked）", () => {
    const task = getTask(db, TASK)!;
    expect(readDeliveryHostVerification(db, task, head)).toBeNull();
  });

  it("receipt 绑定旧 SHA 时返回 null——旧证据不背书新 head", () => {
    writeTrustedReceipt();
    const task = getTask(db, TASK)!;
    expect(readDeliveryHostVerification(db, task, "0".repeat(40))).toBeNull();
  });

  it("receipt planDigest 被篡改时不作数（integrity failure → null）", () => {
    const { receipt } = writeTrustedReceipt();
    db.prepare("UPDATE outer_test_receipt SET receiptJson=?, updatedAt=? WHERE taskId=?")
      .run(JSON.stringify({ ...receipt, planDigest: `sha256:${"0".repeat(64)}` }), Date.now(), TASK);
    const task = getTask(db, TASK)!;
    expect(readDeliveryHostVerification(db, task, head)).toBeNull();
  });
});

describe("githubApi PR detail 携带 baseSha（readiness 的精确 base 证据）", () => {
  function fetchReturning(payload: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  }

  const prPayload = {
    number: 7,
    html_url: "https://github.com/fake/repo/pull/7",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    head: { sha: HEAD, ref: "grande/task" },
    base: { sha: BASE, ref: "main" },
  };

  it("getPullRequest 解析 PR base 的精确 SHA", async () => {
    const api = createGithubApi("token", fetchReturning(prPayload));
    const detail = await api.getPullRequest("fake", "repo", 7);
    expect(detail.baseSha).toBe(BASE);
    expect(detail.baseRef).toBe("main");
  });
});
