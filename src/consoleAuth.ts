import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { AccessConfigError, type AccessConfig } from "./accessGate.ts";
import type { Layout } from "./layout.ts";

/**
 * 控制台的 Access 配置（`access-console.yaml`），与 `/mcp` 的那份**分开**。
 *
 * ## 为什么必须是两份
 *
 * `teamDomain` 相同（同一个 Zero Trust 组织），**只有 `aud` 不同**——而 `aud` 是
 * 唯一防止「拿 `/mcp` 的 Access 令牌访问控制台写端点」的检查。两者相同就等于没隔离。
 *
 * 这与 D18 里 OAuth 令牌 `aud` 的作用完全同源：同一个组织下的两个应用，
 * 凭据能互换就等于只有一个应用。
 *
 * ## 两个应用的实际范围也不同（2026-08-03 配置并实测）
 *
 * | | aud | Access 罩住的范围 |
 * |---|---|---|
 * | `/mcp` | `749f9a93…` | **只有 `/authorize`** —— `/mcp` 要给 ChatGPT 用 bearer，不能被 Access 挡 |
 * | 控制台 | `1280de9f…` | **整站** —— 控制台没有机器访问的路径 |
 */
export function loadConsoleAccessConfig(layout: Layout): AccessConfig {
  const file = join(layout.configDir, "access-console.yaml");
  if (!existsSync(file)) {
    throw new AccessConfigError(
      "MISSING_CONFIG",
      `缺少控制台 Access 配置 ${file}。控制台的写端点必须有独立于 /mcp 的 aud——` +
        `缺失的含义是「门禁从未安装」，不是「不适用」，因此拒绝启动而不是悄悄放行（铁律三）。`,
    );
  }
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new AccessConfigError("BAD_CONFIG", `无法解析 ${file}：${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new AccessConfigError("BAD_CONFIG", `${file} 必须是一个映射`);
  }
  const { teamDomain, aud } = doc as Record<string, unknown>;
  if (typeof teamDomain !== "string" || teamDomain.length === 0) {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 teamDomain 必须是非空字符串`);
  }
  try {
    new URL(teamDomain);
  } catch {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 teamDomain 必须是绝对 URL，实际是 ${JSON.stringify(teamDomain)}`);
  }
  if (typeof aud !== "string" || !/^[0-9a-f]{64}$/i.test(aud)) {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 aud 必须是 64 位十六进制字符串，实际是 ${JSON.stringify(aud)}`);
  }
  return { teamDomain, aud };
}

/**
 * **两个 aud 必须不同，否则拒绝启动。**
 *
 * 这不是洁癖检查。如果有人（包括将来的我）图省事把控制台的 aud 填成 `/mcp` 的那个，
 * 隔离就静默失效了——**而且一切看起来都正常工作**：控制台能登录、写端点能调用、
 * 测试全绿。唯一的区别是「拿 `/mcp` 的令牌也能调写端点」，而那正是要防的事。
 *
 * 静默失效的安全检查比没有检查更糟，因为它让人以为有保护。所以在启动时就断言。
 */
export function assertDistinctAudience(mcp: AccessConfig, console_: AccessConfig): void {
  if (mcp.aud === console_.aud) {
    throw new AccessConfigError(
      "BAD_CONFIG",
      `控制台与 /mcp 的 Access aud 相同（${mcp.aud.slice(0, 12)}…）。` +
        `aud 是唯一防止「拿 /mcp 的令牌访问控制台写端点」的检查，相同即等于没有隔离。` +
        `请在 Cloudflare Zero Trust 里为控制台建【独立的 Access 应用】，用它自己的 Application Audience Tag。`,
    );
  }
}
