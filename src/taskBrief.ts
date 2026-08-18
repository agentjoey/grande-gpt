import type { DatabaseSync } from "node:sqlite";
import { err } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

export const TASK_SOURCE_TYPES = [
  "text",
  "github_issue",
  "markdown",
  "bug_report",
  "pr_feedback",
] as const;

export type TaskSourceType = typeof TASK_SOURCE_TYPES[number];

export interface TaskBrief {
  source: { type: TaskSourceType; ref?: string };
  request: string;
  findings: string[];
  plan: string[];
  acceptanceCriteria: string[];
}

function invalid(message: string): never {
  throw new StateError("INVALID_INPUT", `TaskBrief 不合法：${message}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} 必须是 object。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} 必须是 string。`);
  const normalized = value.trim();
  if (!normalized) invalid(`${field} 不能为空。`);
  return normalized;
}

function textList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value)) invalid(`${field} 必须是 string[]。`);
  if (!allowEmpty && value.length === 0) invalid(`${field} 至少要有一项。`);
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

/**
 * 把模型完成 repo 调研后形成的轻量 brief 规范化。
 *
 * 这不是 Requirement 对象：没有状态机、优先级、依赖或审批字段。它只是 Task 的
 * 附属上下文，让 Request → inspect → plan → acceptance criteria 能跨会话恢复。
 */
export function normalizeTaskBrief(value: unknown): TaskBrief {
  const input = record(value, "brief");
  const source = record(input.source, "source");
  const sourceType = text(source.type, "source.type");
  if (!TASK_SOURCE_TYPES.includes(sourceType as TaskSourceType)) {
    invalid(`source.type 只支持 ${TASK_SOURCE_TYPES.join(" / ")}，收到 ${sourceType}。`);
  }

  const ref = source.ref === undefined ? undefined : text(source.ref, "source.ref");
  return {
    source: { type: sourceType as TaskSourceType, ...(ref ? { ref } : {}) },
    request: text(input.request, "request"),
    findings: textList(input.findings, "findings", true),
    plan: textList(input.plan, "plan", false),
    acceptanceCriteria: textList(input.acceptanceCriteria, "acceptanceCriteria", false),
  };
}

export function saveTaskBrief(db: DatabaseSync, taskId: string, value: unknown): TaskBrief {
  const brief = normalizeTaskBrief(value);
  db.prepare(
    `INSERT INTO task_brief (taskId,briefJson,updatedAt) VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET briefJson=excluded.briefJson, updatedAt=excluded.updatedAt`,
  ).run(taskId, JSON.stringify(brief), Date.now());
  return brief;
}

export function getTaskBrief(db: DatabaseSync, taskId: string): TaskBrief | undefined {
  const row = db.prepare("SELECT briefJson FROM task_brief WHERE taskId = ?").get(taskId) as
    | { briefJson: string }
    | undefined;
  if (!row) return undefined;
  try {
    return normalizeTaskBrief(JSON.parse(row.briefJson));
  } catch (error) {
    throw new StateError(
      "INVALID_INPUT",
      `任务 ${taskId} 的 TaskBrief 无法读取：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function failedEnvelope(deps: ToolDeps, taskId: string | null, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

const BRIEF_SCHEMA = {
  type: "object",
  description:
    "可选：完成 repo 调研后形成的轻量 TaskBrief。它只是 Task 上下文，不是 Requirement 对象。" +
    "plan 与 acceptanceCriteria 至少各一项。",
  properties: {
    source: {
      type: "object",
      properties: {
        type: { type: "string", description: `入口类型：${TASK_SOURCE_TYPES.join(" / ")}` },
        ref: { type: "string", description: "可选来源引用，例如 GitHub Issue URL/#123" },
      },
      required: ["type"],
      additionalProperties: false,
    },
    request: { type: "string", description: "用户原始需求的简洁保真文本" },
    findings: { type: "array", items: { type: "string" }, description: "repo 调研后与本任务直接相关的事实" },
    plan: { type: "array", items: { type: "string" }, description: "最小实现步骤，至少一项" },
    acceptanceCriteria: { type: "array", items: { type: "string" }, description: "可验证 acceptance criteria，至少一项" },
  },
  required: ["source", "request", "findings", "plan", "acceptanceCriteria"],
  additionalProperties: false,
} as const;

/**
 * S4 不新增新工具：给现有 task_open / task_status 加一层轻量 brief 支持。
 * 这样 Task 仍是唯一核心对象，旧调用不传 brief 时行为完全不变。
 */
export function addTaskBriefSupport(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  const taskOpen = tools.find((tool) => tool.name === "grande_task_open");
  if (taskOpen) {
    taskOpen.inputSchema.properties.brief = BRIEF_SCHEMA;
    const inner = taskOpen.handler;
    taskOpen.handler = async (args) => {
      if (args.brief === undefined) return inner(args);

      let brief: TaskBrief;
      try {
        // 必须在 core task_open 之前校验：无 plan/AC 的输入不能先建 worktree 再报错。
        brief = normalizeTaskBrief(args.brief);
      } catch (error) {
        return failedEnvelope(deps, typeof args.taskId === "string" ? args.taskId : null, error);
      }

      const response = await inner(args);
      const envelope = response.structuredContent as {
        ok?: unknown;
        data?: Record<string, unknown>;
        hint?: string;
      };
      if (envelope.ok !== true || !envelope.data) return response;

      try {
        const saved = saveTaskBrief(deps.db, args.taskId as string, brief);
        envelope.data.brief = saved;
        envelope.hint = `${envelope.hint ?? ""} TaskBrief 已随任务保存，可通过 grande_task_status 恢复。`.trim();
      } catch (error) {
        // Task 已经成功创建；附属上下文写失败不能把成功动作伪装成“完全没发生”。
        envelope.data.briefPersisted = false;
        envelope.hint = `${envelope.hint ?? ""}；Task 已创建，但 TaskBrief 保存失败：` +
          `${redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot])}`;
      }
      return response;
    };
  }

  const taskStatus = tools.find((tool) => tool.name === "grande_task_status");
  if (taskStatus) {
    const inner = taskStatus.handler;
    taskStatus.handler = async (args) => {
      const response = await inner(args);
      const envelope = response.structuredContent as { ok?: unknown; data?: Record<string, unknown>; hint?: string };
      if (envelope.ok !== true || !envelope.data || typeof args.taskId !== "string") return response;
      try {
        const brief = getTaskBrief(deps.db, args.taskId);
        if (brief) envelope.data.brief = brief;
      } catch (error) {
        envelope.hint = `${envelope.hint ?? ""}；TaskBrief 无法恢复：` +
          `${redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot])}`;
      }
      return response;
    };
  }

  return tools;
}
