import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse } from "yaml";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import type { Layout } from "./layout.ts";
import { PolicyError } from "./policy.ts";
import { getTask } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

export type CapabilityKind = "native" | "mcp" | "plugin" | "skill";
export type CapabilityRisk = "read" | "write" | "destructive" | "production";

export interface CapabilityDetail {
  provider: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  inputSchema: unknown;
  risk: CapabilityRisk;
  annotations?: Record<string, unknown>;
}

interface ProviderBaseConfig {
  id: string;
  risk: CapabilityRisk;
  allowDestructive?: boolean;
  allowProduction?: boolean;
}

export interface McpProviderConfig extends ProviderBaseConfig {
  type: "mcp" | "plugin";
  url: string;
  tokenFile?: string;
}

export interface SkillProviderConfig extends ProviderBaseConfig {
  type: "skill";
  file: string;
}

export type CapabilityProviderConfig = McpProviderConfig | SkillProviderConfig;

export interface CapabilityProvider {
  readonly id: string;
  readonly kind: CapabilityKind;
  list(): Promise<CapabilityDetail[]>;
  inspect(name: string): Promise<CapabilityDetail>;
  assertAllowed(detail: CapabilityDetail): void;
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface McpConnection {
  listTools(cursor?: string): Promise<{ tools: RemoteTool[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type McpConnect = (config: McpProviderConfig, layout?: Layout) => Promise<McpConnection>;

const RISK_ORDER: Record<CapabilityRisk, number> = {
  read: 0,
  write: 1,
  destructive: 2,
  production: 3,
};

function maxRisk(a: CapabilityRisk, b: CapabilityRisk): CapabilityRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function mapping(value: unknown, field: string, file: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 必须是映射。`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string, file: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 包含未知字段 ${key}。`);
    }
  }
}

function stringValue(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 必须是非空字符串。`);
  }
  return value.trim();
}

function boolValue(value: unknown, field: string, file: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 必须是 boolean。`);
  }
  return value;
}

function riskValue(value: unknown, field: string, file: string): CapabilityRisk {
  const risk = stringValue(value, field, file) as CapabilityRisk;
  if (!Object.hasOwn(RISK_ORDER, risk)) {
    throw new PolicyError(
      "BAD_CONFIG",
      `${file} 的 ${field} 必须是 read / write / destructive / production 之一。`,
    );
  }
  return risk;
}

function validateEndpoint(raw: string, field: string, file: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 不是有效 URL。`);
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 不允许内嵌凭据、query 或 fragment。`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PolicyError(
      "BAD_CONFIG",
      `${file} 的 ${field} 必须使用 https；只有 127.0.0.1 / localhost / ::1 可使用 http loopback。`,
    );
  }
  return url.toString();
}

/** 薄 provider 注册表：没有 capability graph、依赖、ranking 或 marketplace 字段。 */
export function loadCapabilityProviderConfigs(layout: Layout): CapabilityProviderConfig[] {
  const file = join(layout.configDir, "capabilities.yaml");
  if (!existsSync(file)) return [];

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PolicyError(
      "BAD_CONFIG",
      `无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || parsed === undefined) return [];
  const root = mapping(parsed, "顶层", file);
  onlyKeys(root, ["providers"], "顶层", file);
  if (root.providers === undefined) return [];
  const providers = mapping(root.providers, "providers", file);

  const result: CapabilityProviderConfig[] = [];
  for (const [id, raw] of Object.entries(providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) {
      throw new PolicyError("BAD_CONFIG", `${file} 的 provider id ${id} 不合法。`);
    }
    const value = mapping(raw, `providers.${id}`, file);
    const type = stringValue(value.type, `providers.${id}.type`, file);
    const risk = riskValue(value.risk, `providers.${id}.risk`, file);
    const allowDestructive = boolValue(value.allowDestructive, `providers.${id}.allowDestructive`, file);
    const allowProduction = boolValue(value.allowProduction, `providers.${id}.allowProduction`, file);

    if (type === "mcp" || type === "plugin") {
      onlyKeys(
        value,
        ["type", "url", "risk", "tokenFile", "allowDestructive", "allowProduction"],
        `providers.${id}`,
        file,
      );
      const url = validateEndpoint(stringValue(value.url, `providers.${id}.url`, file), `providers.${id}.url`, file);
      const tokenFile = value.tokenFile === undefined
        ? undefined
        : stringValue(value.tokenFile, `providers.${id}.tokenFile`, file);
      if (tokenFile && (tokenFile.includes("/") || tokenFile.includes("\\") || tokenFile === "." || tokenFile === "..")) {
        throw new PolicyError("BAD_CONFIG", `${file} 的 providers.${id}.tokenFile 只能是 secrets/ 下的文件名。`);
      }
      result.push({
        id,
        type,
        url,
        risk,
        ...(tokenFile ? { tokenFile } : {}),
        ...(allowDestructive !== undefined ? { allowDestructive } : {}),
        ...(allowProduction !== undefined ? { allowProduction } : {}),
      });
      continue;
    }

    if (type === "skill") {
      onlyKeys(
        value,
        ["type", "file", "risk", "allowDestructive", "allowProduction"],
        `providers.${id}`,
        file,
      );
      const skillFile = stringValue(value.file, `providers.${id}.file`, file);
      if (isAbsolute(skillFile)) {
        throw new PolicyError("BAD_CONFIG", `${file} 的 providers.${id}.file 必须相对 controlRoot/skills。`);
      }
      result.push({
        id,
        type: "skill",
        file: skillFile,
        risk,
        ...(allowDestructive !== undefined ? { allowDestructive } : {}),
        ...(allowProduction !== undefined ? { allowProduction } : {}),
      });
      continue;
    }

    throw new PolicyError("BAD_CONFIG", `${file} 的 providers.${id}.type 只支持 mcp / plugin / skill。`);
  }
  return result;
}

function annotationsRisk(annotations: Record<string, unknown> | undefined): CapabilityRisk {
  if (annotations?.destructiveHint === true) return "destructive";
  if (annotations?.readOnlyHint === true) return "read";
  return "write";
}

function assertConfiguredAllowed(config: ProviderBaseConfig, risk: CapabilityRisk): void {
  if (risk === "production" && config.allowProduction !== true) {
    throw new PolicyError(
      "POLICY_DENIED",
      `capability provider ${config.id} 被标记为 production，但控制平面没有 allowProduction: true。`,
    );
  }
  if (risk === "destructive" && config.allowDestructive !== true) {
    throw new PolicyError(
      "POLICY_DENIED",
      `capability provider ${config.id} 包含 destructive 操作，但控制平面没有 allowDestructive: true。`,
    );
  }
}

function loadCapabilityToken(layout: Layout, tokenFile: string | undefined): string | undefined {
  if (!tokenFile) return undefined;
  const path = join(layout.controlRoot, "secrets", tokenFile);
  if (!existsSync(path)) {
    throw new StateError("INVALID_INPUT", `capability token 缺失：请在控制平面配置 ${path}。不会回退到环境变量。`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new StateError("INVALID_INPUT", `capability token 文件 ${path} 为空。`);
  return token;
}

function redactProviderError(error: unknown, layout: Layout | undefined, config: McpProviderConfig): StateError {
  let message = error instanceof Error ? error.message : String(error);
  if (layout && config.tokenFile) {
    try {
      const token = loadCapabilityToken(layout, config.tokenFile);
      if (token) message = message.replaceAll(token, "<redacted>");
    } catch {
      // 读取凭据本身失败时，原错误里不应有一个从未成功读取的 token。
    }
  }
  return new StateError("INVALID_INPUT", `capability provider ${config.id} 调用失败：${message}`);
}

async function connectMcp(config: McpProviderConfig, layout?: Layout): Promise<McpConnection> {
  if (!layout) throw new StateError("INVALID_INPUT", `MCP provider ${config.id} 缺少 Layout。`);
  const token = loadCapabilityToken(layout, config.tokenFile);
  const client = new Client({ name: "grande-gpt", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL(config.url),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
  try {
    await client.connect(transport);
  } catch (error) {
    throw redactProviderError(error, layout, config);
  }
  return {
    async listTools(cursor) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      return {
        tools: result.tools as RemoteTool[],
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      await client.close();
    },
  };
}

export class McpCapabilityProvider implements CapabilityProvider {
  readonly id: string;
  readonly kind: "mcp" | "plugin";

  private readonly config: McpProviderConfig;
  private readonly connect: McpConnect;
  private readonly layout?: Layout;

  constructor(
    config: McpProviderConfig,
    connect: McpConnect = connectMcp,
    layout?: Layout,
  ) {
    this.config = config;
    this.connect = connect;
    this.layout = layout;
    this.id = config.id;
    this.kind = config.type;
  }

  private async withConnection<T>(fn: (connection: McpConnection) => Promise<T>): Promise<T> {
    let connection: McpConnection | undefined;
    try {
      connection = await this.connect(this.config, this.layout);
      return await fn(connection);
    } catch (error) {
      if (error instanceof StateError || error instanceof PolicyError) throw error;
      throw redactProviderError(error, this.layout, this.config);
    } finally {
      if (connection) {
        try { await connection.close(); } catch { /* close failure does not replace the primary result */ }
      }
    }
  }

  private async tools(connection: McpConnection): Promise<RemoteTool[]> {
    const result: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.listTools(cursor);
      result.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }

  private detail(tool: RemoteTool): CapabilityDetail {
    const remoteRisk = annotationsRisk(tool.annotations);
    return {
      provider: this.id,
      kind: this.kind,
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      risk: maxRisk(this.config.risk, remoteRisk),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    };
  }

  async list(): Promise<CapabilityDetail[]> {
    return this.withConnection(async (connection) => (await this.tools(connection)).map((tool) => this.detail(tool)));
  }

  async inspect(name: string): Promise<CapabilityDetail> {
    return this.withConnection(async (connection) => {
      const found = (await this.tools(connection)).find((tool) => tool.name === name);
      if (!found) throw new StateError("INVALID_INPUT", `provider ${this.id} 没有 capability ${name}。`);
      return this.detail(found);
    });
  }

  assertAllowed(detail: CapabilityDetail): void {
    assertConfiguredAllowed(this.config, detail.risk);
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withConnection(async (connection) => {
      const found = (await this.tools(connection)).find((tool) => tool.name === name);
      if (!found) throw new StateError("INVALID_INPUT", `provider ${this.id} 没有 capability ${name}。`);
      const detail = this.detail(found);
      this.assertAllowed(detail);
      return connection.callTool(name, args);
    });
  }
}

class SkillCapabilityProvider implements CapabilityProvider {
  readonly id: string;
  readonly kind = "skill" as const;

  private readonly layout: Layout;
  private readonly config: SkillProviderConfig;

  constructor(layout: Layout, config: SkillProviderConfig) {
    this.layout = layout;
    this.config = config;
    this.id = config.id;
  }

  private detail(): CapabilityDetail {
    return {
      provider: this.id,
      kind: "skill",
      name: this.id,
      description: `Activate trusted skill instructions from ${this.config.file}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: this.config.risk,
    };
  }

  private readInstructions(): string {
    const root = resolve(this.layout.controlRoot, "skills");
    const candidate = resolve(root, this.config.file);
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new PolicyError("POLICY_DENIED", `skill ${this.id} 的 file 逃出了 controlRoot/skills。`);
    }
    if (!existsSync(candidate)) {
      throw new StateError("INVALID_INPUT", `skill ${this.id} 文件不存在：${candidate}`);
    }
    const actual = realpathSync(candidate);
    const actualRel = relative(root, actual);
    if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) {
      throw new PolicyError("POLICY_DENIED", `skill ${this.id} 的符号链接逃出了 controlRoot/skills。`);
    }
    return readFileSync(actual, "utf8");
  }

  async list(): Promise<CapabilityDetail[]> {
    return [this.detail()];
  }

  async inspect(name: string): Promise<CapabilityDetail> {
    if (name !== this.id) throw new StateError("INVALID_INPUT", `provider ${this.id} 没有 capability ${name}。`);
    return this.detail();
  }

  assertAllowed(detail: CapabilityDetail): void {
    assertConfiguredAllowed(this.config, detail.risk);
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const detail = await this.inspect(name);
    this.assertAllowed(detail);
    return {
      mode: "instructions",
      provider: this.id,
      skill: name,
      arguments: args,
      instructions: this.readInstructions(),
    };
  }
}

class NativeCapabilityProvider implements CapabilityProvider {
  readonly id = "native";
  readonly kind = "native" as const;

  private readonly tools: ToolDef[];

  constructor(tools: ToolDef[]) {
    this.tools = tools;
  }

  private detail(tool: ToolDef): CapabilityDetail {
    const risk: CapabilityRisk = tool.annotations.destructiveHint
      ? "destructive"
      : tool.annotations.readOnlyHint ? "read" : "write";
    return {
      provider: "native",
      kind: "native",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      risk,
      annotations: { ...tool.annotations },
    };
  }

  async list(): Promise<CapabilityDetail[]> {
    return this.tools.map((tool) => this.detail(tool));
  }

  async inspect(name: string): Promise<CapabilityDetail> {
    const found = this.tools.find((tool) => tool.name === name);
    if (!found) throw new StateError("INVALID_INPUT", `native 没有 capability ${name}。`);
    return this.detail(found);
  }

  assertAllowed(_detail: CapabilityDetail): void {}

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const found = this.tools.find((tool) => tool.name === name);
    if (!found) throw new StateError("INVALID_INPUT", `native 没有 capability ${name}。`);
    return (await found.handler(args)).structuredContent;
  }
}

function providersFor(deps: ToolDeps, nativeTools: ToolDef[]): CapabilityProvider[] {
  const providers: CapabilityProvider[] = [new NativeCapabilityProvider(nativeTools)];
  for (const config of loadCapabilityProviderConfigs(deps.layout)) {
    if (config.type === "skill") providers.push(new SkillCapabilityProvider(deps.layout, config));
    else providers.push(new McpCapabilityProvider(config, connectMcp, deps.layout));
  }
  return providers;
}

function failedEnvelope(deps: ToolDeps, taskId: string | null, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

function argsObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateError("INVALID_INPUT", "capability arguments 必须是 object。 ");
  }
  return value as Record<string, unknown>;
}

function providerById(providers: CapabilityProvider[], id: string): CapabilityProvider {
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) {
    throw new StateError(
      "INVALID_INPUT",
      `未知 capability provider ${id}。可用：${providers.map((candidate) => candidate.id).join("、")}。`,
    );
  }
  return provider;
}

/** S5 P0：discover/list、inspect、invoke。没有 marketplace、依赖系统或 capability graph。 */
export function addCapabilityTools(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  // 快照只包含已有原生工具，避免 capability_invoke 把自己递归暴露成 native capability。
  const nativeTools = [...tools];

  const listTool: ToolDef = {
    name: "grande_capability_list",
    description: "列出 native 与控制平面注册的 MCP/plugin/skill capability。可按 provider 过滤。",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", description: "可选 provider id；native 表示 GrandeGPT 自身工具" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async (args) => {
      try {
        const providers = providersFor(deps, nativeTools);
        const selected = typeof args.provider === "string"
          ? [providerById(providers, args.provider)]
          : providers;
        const capabilities: CapabilityDetail[] = [];
        const errors: Array<{ provider: string; message: string }> = [];
        for (const provider of selected) {
          try {
            capabilities.push(...await provider.list());
          } catch (error) {
            errors.push({ provider: provider.id, message: redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot]) });
          }
        }
        return {
          structuredContent: ok({
            data: { capabilities, errors },
            hint: `发现 ${capabilities.length} 个 capability${errors.length ? `；${errors.length} 个 provider 查询失败` : ""}。`,
          }),
        };
      } catch (error) {
        return failedEnvelope(deps, null, error);
      }
    },
  };

  const inspectTool: ToolDef = {
    name: "grande_capability_inspect",
    description: "查看单个 capability 的 schema、来源与风险，不执行它。",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "provider id" },
        name: { type: "string", description: "capability 名称" },
      },
      required: ["provider", "name"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async (args) => {
      try {
        const provider = providerById(providersFor(deps, nativeTools), args.provider as string);
        const capability = await provider.inspect(args.name as string);
        return { structuredContent: ok({ data: { capability }, hint: `${provider.id}/${capability.name} 风险：${capability.risk}。` }) };
      } catch (error) {
        return failedEnvelope(deps, null, error);
      }
    },
  };

  const invokeTool: ToolDef = {
    name: "grande_capability_invoke",
    description:
      "调用一个已 inspect 的 capability。read 可在 Task 外使用；write/destructive/production 必须绑定真实 taskId。" +
      "destructive/production 还必须由控制平面显式放行。",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "provider id" },
        name: { type: "string", description: "capability 名称" },
        arguments: { type: "object", description: "按 inspect 返回的 inputSchema 传入" },
        taskId: { type: "string", description: "write/destructive/production 必填；read 可省略" },
      },
      required: ["provider", "name", "arguments"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const taskId = typeof args.taskId === "string" ? args.taskId : null;
      let audit: AuditHandle | undefined;
      try {
        const provider = providerById(providersFor(deps, nativeTools), args.provider as string);
        const detail = await provider.inspect(args.name as string);
        // 先做 provider 的硬门禁，再检查 taskId；这样未放行的 production capability
        // 即使调用者伪造/漏传 taskId，也稳定返回 POLICY_DENIED，不泄露更多状态。
        provider.assertAllowed(detail);

        if (detail.risk !== "read") {
          if (!taskId) {
            throw new StateError("INVALID_INPUT", `${detail.risk} capability 必须提供 taskId。`);
          }
          if (!getTask(deps.db, taskId)) {
            throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
          }
          audit = beginAudit(deps.db, {
            taskId,
            tool: "grande_capability_invoke",
            input: { provider: provider.id, name: detail.name, arguments: args.arguments },
          });
          audit.allowed();
          if (!audit.executing()) {
            throw new StateError("STALE_STATE", `任务 ${taskId} 的 capability 审计句柄无法推进到 EXECUTING。`);
          }
        }

        const result = await provider.invoke(detail.name, argsObject(args.arguments));
        audit?.succeeded([]);
        return {
          structuredContent: ok({
            taskId,
            data: { capability: detail, result },
            hint: `${provider.id}/${detail.name} 已完成调用（risk: ${detail.risk}）。`,
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };

  return [...tools, listTool, inspectTool, invokeTool];
}
