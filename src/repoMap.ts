import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export class MapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `MapError [${code}]`;
    this.code = code;
  }
}

export interface MapEntry {
  path: string;
  kind: "file" | "dir";
  bytes: number | null;
}

export interface MapResult {
  // 顺序即序列化顺序：ChatGPT 会静默截断超大响应，这两个字段排在 entries 之后
  // 就可能永远看不到（POC 实测曾落在第 73,896 字节）
  truncated: boolean;
  nextCursor: string | null;
  entries: MapEntry[];
  keyFiles: string[];
}

/** 不铺开的目录。`.git` 无意义且巨大，`node_modules` 会淹没一切，`.grande-work` 是派生数据 */
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);

const KEY_FILE_NAMES = new Set([
  "package.json", "pnpm-lock.yaml", "tsconfig.json", "Cargo.toml",
  "go.mod", "pyproject.toml", "requirements.txt", "Makefile", "README.md",
]);
const KEY_ENTRY_PATHS = ["src/index.ts", "src/main.ts", "src/index.js", "main.py", "src/lib.rs"];
const KEY_DIR_NAMES = new Set(["tests", "test", "__tests__", "spec"]);

function walk(root: string, dir: string, out: MapEntry[]): void {
  // readdirSync 的顺序不是保证的——显式排序，否则同一棵树两次调用可能给出不同顺序。
  // 读取失败必须分两种：根目录读不到是调用方的错，要报出来；子目录读不到
  // （权限/竞态删除）不该让整棵树失败——下面 statSync 的 catch 只覆盖单个条目。
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    if (dir === root) {
      throw new MapError("INVALID_INPUT", `无法读取仓库根 ${root}：${(e as Error).message}`);
    }
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue; // 连目录项本身都不列：与 repoSearch 的 listFiles 一致
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join("/");
    let st;
    try {
      // C2：用 lstatSync（不跟随符号链接）而不是 statSync。statSync 会跟随符号
      // 链接，对一个指向仓库外的链接（如 repo/vendor -> /outside）会把外部目录
      // 当成普通目录递归进去列出来；对一个把 .git 起了别名的链接（如
      // repo/gitalias -> repo/.git）同样会照单全收——SKIP_DIRS 只按目录项
      // **名字**过滤，`gitalias` 这个名字不在集合里，从未被拦下。这两条路径的
      // 后果都是 repoMap 把仓库外/`.git` 内的文件路径原样返回给 ChatGPT。
      st = lstatSync(abs);
    } catch {
      continue; // 竞态删除或对该条目的权限问题：跳过而不是整棵树失败
    }
    // 不跟随、直接跳过：这是两种可选修复里更简单、且失败方向更安全的一种
    // （fail closed——该放行的合法内部符号链接被跳过，好过该拒绝的越权链接被
    // 放行）。代价是仓库内指向仓库内普通文件的符号链接也不会被列出；权衡说明
    // 见 tests/repoMap.test.ts 里 C2 那几条用例的注释。
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push({ path: rel, kind: "dir", bytes: null });
      walk(root, abs, out);
    } else if (st.isFile()) {
      out.push({ path: rel, kind: "file", bytes: st.size });
    }
  }
}

/**
 * 列出仓库结构。`root` 必须已是可信的绝对路径（由 `resolveRepoPath` 或
 * `task.worktreePath` 提供）—— 本函数不做路径安全校验，那是 `paths.ts` 的职责。
 *
 * `cursor` 是上一次返回的 `nextCursor`，即「已经给过多少条」的十进制偏移量。
 * 用偏移量而非「最后一条的路径」是因为条目已全局排序，偏移量在同一棵**未变化**
 * 的树上可复现——它不是稳定标识符：两次调用之间如果仓库内容变了（文件增删），
 * 同一个偏移量可能对应不同的条目。调用方在续取页之间不应该修改仓库。
 */
export function repoMap(
  root: string,
  opts?: { maxEntries?: number; cursor?: string | null },
): MapResult {
  const maxEntries = opts?.maxEntries ?? 500;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MapError("INVALID_INPUT", `cursor 必须是非负整数，收到：${opts?.cursor}`);
  }

  const all: MapEntry[] = [];
  walk(root, root, all);
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const slice = all.slice(offset, offset + maxEntries);
  const consumed = offset + slice.length;
  const truncated = consumed < all.length;

  // keyFiles 描述的是【整棵树】的关键文件，与本页无关；只在首页（无 cursor）给一次，
  // 翻页时重复发送同一份数据纯粹浪费 ChatGPT 那个会静默截断的响应预算。
  let keyFiles: string[] = [];
  if (!opts?.cursor) {
    const paths = new Set(all.map((e) => e.path));
    keyFiles = [
      ...all.filter((e) => e.kind === "file" && KEY_FILE_NAMES.has(e.path.split("/").pop()!) && !e.path.includes("/")).map((e) => e.path),
      ...KEY_ENTRY_PATHS.filter((p) => paths.has(p)),
      ...all.filter((e) => e.kind === "dir" && KEY_DIR_NAMES.has(e.path)).map((e) => e.path),
    ].sort();
    keyFiles = [...new Set(keyFiles)];
  }

  return {
    truncated,
    nextCursor: truncated ? String(consumed) : null,
    entries: slice,
    keyFiles,
  };
}
