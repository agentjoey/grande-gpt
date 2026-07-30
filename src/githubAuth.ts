import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";

export interface GithubCredential {
  token: string;
}

export class GithubAuthError extends Error {
  readonly code: "MISSING_TOKEN";

  constructor(code: "MISSING_TOKEN", message: string) {
    super(message);
    this.name = `GithubAuthError [${code}]`;
    this.code = code;
  }
}

/**
 * 从控制平面读取 GrandeGPT 专用 PAT。权限过宽（如 0644）目前不做硬拒绝：
 * 文件权限是可修复的宿主配置问题，且某些文件系统不能可靠表达 POSIX mode；
 * 真正的安全边界是只从 controlRoot 读取、缺失/空白即 fail closed，绝不回退到
 * 环境变量、宿主 credential helper 或 gh keyring。
 */
export function loadGithubToken(layout: Layout): GithubCredential {
  const path = join(layout.controlRoot, "secrets", "github-token");
  if (!existsSync(path)) {
    throw new GithubAuthError(
      "MISSING_TOKEN",
      `缺少 GitHub PAT：请在控制平面配置 ${path}（建议权限 0600）。GrandeGPT 不会回退到宿主凭据。`,
    );
  }

  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new GithubAuthError(
      "MISSING_TOKEN",
      `无法读取 GitHub PAT ${path}：${error instanceof Error ? error.message : String(error)}。` +
        `请修复控制平面凭据文件；GrandeGPT 不会回退到宿主凭据。`,
    );
  }
  if (!token) {
    throw new GithubAuthError(
      "MISSING_TOKEN",
      `GitHub PAT 文件 ${path} 为空。请写入专用 fine-grained PAT；GrandeGPT 不会回退到宿主凭据。`,
    );
  }
  return { token };
}

/**
 * git-over-HTTPS 的 Basic 凭据（`base64("x-access-token:<token>")`）。
 *
 * ⚠️ **不要改成 `Authorization: Bearer`。** 2026-07-30 实测判决（单变量隔离）：
 * 同一个 fine-grained PAT，REST API 用 Bearer 返回 200，
 * 而 `git ls-remote` 用 Bearer 一律 `Authentication failed`、用 Basic 成功。
 * GitHub 的 REST API 与 git 智能 HTTP 端点接受的认证方式**不是同一套**。
 *
 * S3 最初实现用的是 Bearer，`grande_push` 因此从未真正推成功过一次；
 * 而全部测试都推向**本地 bare 仓库**（无需认证、`Authorization` 头被忽略），
 * 所以 606 个测试全绿也没能发现。教训写在 `tests/push.test.ts` 顶部。
 */
export function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

/**
 * 脱敏完整 token，以及 GitHub 上游可能回显的 token 前缀。
 * 只处理长度至少 20 的前缀，避免把过短、可能自然出现的普通文本误抹掉。
 *
 * ⚠️ **必须同时抹掉 `basicCredential()` 的 base64 形态。** 那是与原始 token
 * 完全不同的字符串——只抹原文的话，凡是回显了 `http.extraHeader` 的输出
 * （git 的部分报错、`GIT_TRACE`、`GIT_CURL_VERBOSE`）都会把凭据整条漏出去，
 * 而它 base64 解一次就还原成明文 PAT。前缀也要抹：base64 是按 3 字节
 * 一组编码的，截断的前缀依然能解出 token 的前半段。
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  let result = text;
  for (const secret of [token, basicCredential(token)]) {
    result = result.replaceAll(secret, "<redacted>");
    for (let length = secret.length - 1; length >= 20; length--) {
      result = result.replaceAll(secret.slice(0, length), "<redacted>");
    }
  }
  return result;
}
