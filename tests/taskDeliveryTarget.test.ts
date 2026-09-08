import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { resolveDeliveryTarget } from "../src/deliveryTarget.ts";
import { StateError } from "../src/errors.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import {
  getExplicitDeliveryTarget,
  parseDeliveryTarget,
  saveExplicitDeliveryTarget,
} from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "task-target-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "task-target-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("parseDeliveryTarget", () => {
  it("接受 local/pr/deploy 三个精确取值", () => {
    expect(parseDeliveryTarget("local")).toBe("local");
    expect(parseDeliveryTarget("pr")).toBe("pr");
    expect(parseDeliveryTarget("deploy")).toBe("deploy");
  });

  it("拒绝自由文本与同义词——deploy 必须显式给出，不能从别的词升级", () => {
    expect(() => parseDeliveryTarget("production")).toThrow(/deliveryTarget/i);
    expect(() => parseDeliveryTarget("PROD")).toThrow(/deliveryTarget/i);
    expect(() => parseDeliveryTarget("")).toThrow(/deliveryTarget/i);
    expect(() => parseDeliveryTarget(undefined)).toThrow(/deliveryTarget/i);
    expect(() => parseDeliveryTarget(42)).toThrow(/deliveryTarget/i);
  });
});

describe("explicit delivery target persistence", () => {
  it("保存后能按 taskId 读回；未保存的 task 返回 undefined（走 legacy 投影）", () => {
    const db = openDb(loadLayout());
    createTask(db, {
      taskId: "task-target",
      repoId: "demo",
      branch: "grande/target-0001",
      baseCommit: "base",
      worktreePath: join(ws, "task"),
      state: "READY",
    });

    expect(getExplicitDeliveryTarget(db, "task-target")).toBeUndefined();
    saveExplicitDeliveryTarget(db, "task-target", "deploy");
    expect(getExplicitDeliveryTarget(db, "task-target")).toBe("deploy");
    db.close();
  });

  it("target 不可变：不同取值的重复写入抛 STALE_STATE，且原值不变", () => {
    const db = openDb(loadLayout());
    createTask(db, {
      taskId: "task-immutable",
      repoId: "demo",
      branch: "grande/immutable-0001",
      baseCommit: "base",
      worktreePath: join(ws, "task"),
      state: "READY",
    });
    saveExplicitDeliveryTarget(db, "task-immutable", "pr");
    let caught: unknown;
    try {
      saveExplicitDeliveryTarget(db, "task-immutable", "deploy");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as StateError).code).toBe("STALE_STATE");
    expect(getExplicitDeliveryTarget(db, "task-immutable")).toBe("pr");
    db.close();
  });

  it("相同取值的重复写入是幂等 no-op（重试/重入不产生 STALE_STATE）", () => {
    const db = openDb(loadLayout());
    createTask(db, {
      taskId: "task-idem",
      repoId: "demo",
      branch: "grande/idem-0001",
      baseCommit: "base",
      worktreePath: join(ws, "task"),
      state: "READY",
    });
    saveExplicitDeliveryTarget(db, "task-idem", "local");
    expect(() => saveExplicitDeliveryTarget(db, "task-idem", "local")).not.toThrow();
    expect(getExplicitDeliveryTarget(db, "task-idem")).toBe("local");
    db.close();
  });

  it("外键约束生效：不存在的 task 不能挂 target 行", () => {
    const db = openDb(loadLayout());
    expect(() => saveExplicitDeliveryTarget(db, "task-ghost", "deploy")).toThrow();
    db.close();
  });
});

describe("resolveDeliveryTarget explicit-first", () => {
  it("显式行优先于 legacy 投影：GitHub origin 的 task 显式 local 仍解析为 local", () => {
    const db = openDb(loadLayout());
    const task = createTask(db, {
      taskId: "task-explicit-local",
      repoId: "demo",
      branch: "grande/explicit-0001",
      baseCommit: "base",
      worktreePath: join(ws, "task"),
      state: "READY",
    });
    saveExplicitDeliveryTarget(db, task.taskId, "local");
    expect(
      resolveDeliveryTarget(db, task, { readOrigin: () => "https://github.com/acme/demo.git" }),
    ).toBe("local");
    db.close();
  });

  it("显式 deploy 不依赖任何已有 production evidence（receipt 只服务 legacy 投影）", () => {
    const db = openDb(loadLayout());
    const task = createTask(db, {
      taskId: "task-explicit-deploy",
      repoId: "demo",
      branch: "grande/explicit-0002",
      baseCommit: "base",
      worktreePath: join(ws, "task"),
      state: "READY",
    });
    saveExplicitDeliveryTarget(db, task.taskId, "deploy");
    expect(resolveDeliveryTarget(db, task, { readOrigin: () => null })).toBe("deploy");
    db.close();
  });
});
