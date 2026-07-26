import { createHash } from "node:crypto";

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const PARSER_BUGGY = `export function parse(input: string): string[] {
  return input.split(",").map((s) => s.trim());
}
`;

const PARSER_TEST = `import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.ts";

describe("parser", () => {
  it("splits on comma", () => {
    expect(parse("a,b")).toEqual(["a", "b"]);
  });

  it("handles empty input", () => {
    expect(parse("")).toEqual([]);
  });
});
`;

const README = `# demo-app

一个用于 GrandeGPT POC 的最小示例项目。

\`src/parser.ts\` 有一个已知缺陷：空字符串输入时返回 \`[""]\` 而非 \`[]\`。
\`tests/parser.test.ts\` 中的 "handles empty input" 用例会因此失败。
`;

const PACKAGE_JSON = `{
  "name": "demo-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "vitest run", "lint": "eslint .", "typecheck": "tsc --noEmit" }
}
`;

/** 200 行 export const —— 使 "export const" 搜索命中数超过 50 条上限（P-5） */
function makeGeneratedConstants(): string {
  const lines: string[] = ["// 自动生成，请勿手工编辑", ""];
  for (let i = 1; i <= 200; i++) {
    lines.push(`export const SETTING_${String(i).padStart(3, "0")} = ${i};`);
  }
  return lines.join("\n") + "\n";
}

/** 约 100 KB —— 使单文件读取超过 64 KB 上限（P-5） */
function makeBigConfig(): string {
  const lines: string[] = ["// 大体积配置文件，用于验证读取截断", "export const CONFIG = {"];
  for (let i = 1; i <= 1400; i++) {
    lines.push(`  key_${String(i).padStart(4, "0")}: "value-${i}-padding-padding-padding-padding-padding",`);
  }
  lines.push("};", "");
  return lines.join("\n");
}

const BASE_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "README.md": README,
  "src/parser.ts": PARSER_BUGGY,
  "src/generated-constants.ts": makeGeneratedConstants(),
  "src/big-config.ts": makeBigConfig(),
  "tests/parser.test.ts": PARSER_TEST,
};

export class FakeRepo {
  readonly repoId: string;
  #files: Map<string, string>;
  #changed: Set<string>;

  constructor(repoId: string) {
    this.repoId = repoId;
    this.#files = new Map(Object.entries(BASE_FILES));
    this.#changed = new Set();
  }

  reset(): void {
    this.#files = new Map(Object.entries(BASE_FILES));
    this.#changed = new Set();
  }

  listPaths(): string[] {
    return [...this.#files.keys()].sort();
  }

  readFile(path: string): { content: string; sha256: string } | undefined {
    const content = this.#files.get(path);
    if (content === undefined) return undefined;
    return { content, sha256: sha256(content) };
  }

  writeFile(path: string, content: string): void {
    this.#files.set(path, content);
    this.#changed.add(path);
  }

  changedPaths(): string[] {
    return [...this.#changed].sort();
  }

  /** 判定「缺陷是否已修复」——修复的标志是 parser 里出现了空输入判断 */
  isFixed(): boolean {
    const parser = this.#files.get("src/parser.ts") ?? "";
    return /length\s*===\s*0|!input\b|input\s*===\s*""/.test(parser);
  }

  search(query: string): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const path of this.listPaths()) {
      const lines = (this.#files.get(path) ?? "").split("\n");
      lines.forEach((text, idx) => {
        if (text.includes(query)) hits.push({ path, line: idx + 1, text });
      });
    }
    return hits;
  }

  diff(): string[] {
    const out: string[] = [];
    for (const path of this.changedPaths()) {
      const base = BASE_FILES[path] ?? "";
      const now = this.#files.get(path) ?? "";
      out.push(`--- a/${path}`, `+++ b/${path}`);
      for (const line of base.split("\n")) if (line) out.push(`-${line}`);
      for (const line of now.split("\n")) if (line) out.push(`+${line}`);
    }
    return out;
  }
}

export const REPO_IDS = ["demo-app"] as const;

const repos = new Map<string, FakeRepo>();

export function getRepo(repoId: string): FakeRepo | undefined {
  if (!(REPO_IDS as readonly string[]).includes(repoId)) return undefined;
  let repo = repos.get(repoId);
  if (!repo) {
    repo = new FakeRepo(repoId);
    repos.set(repoId, repo);
  }
  return repo;
}
