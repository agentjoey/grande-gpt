# GG-BL-026 / GG-BL-027 npm Compatibility Defect Fixes Design

## Goal

修复两个已经有真实复现证据的 GrandeGPT 缺陷，同时保持 verification integrity 与 Seatbelt least-privilege：

1. npm repo 的 verification/attestation 不得再读取 `pnpm-lock.yaml` 或把 npm 版本伪装成 pnpm；
2. npm `node_modules/.bin/*` symlink 的真实 target 在当前 worktree `node_modules` 内时，应能在 sandbox 中执行；target 越界时仍拒绝。

## Scope

- 支持 verification identity 的 `pnpm` 与 `npm` 两种 package manager。
- `yarn` / `bun` 继续 fail closed；本任务不扩展其 attestation 支持。
- 不改变 public MCP tool contract、tool count、toolset epoch 或 annotations。
- 不扩大整个 worktree 的 `process-exec`。
- 不改变网络、control-plane read、canonical `.git` write 等现有 sandbox deny 边界。

## GG-BL-026 design

### Root cause

`src/attestation.ts` 与 trusted Host Verifier 的 toolchain capture 都把 toolchain identity 写死为：

- `pnpm-lock.yaml`
- `pnpm --version`
- `{ node, pnpm, lockfileSha256 }`

但 onboarding 已接受 npm repo，并会生成 `npm run <profile>`。因此执行 profile 与 attestation identity 的 package manager 来源分叉。

### Package-manager resolution

新增窄 helper，只负责 verification identity：

1. 优先读取 `package.json#packageManager`；只接受 `pnpm@...` 或 `npm@...`。
2. 未声明时，通过 lockfile 唯一性检测：
   - 只有 `pnpm-lock.yaml` → pnpm
   - 只有 `package-lock.json` → npm
3. 同时存在两种 lockfile 且没有明确 `packageManager` → fail closed，禁止猜测。
4. 明确 `packageManager` 与对应 lockfile 缺失 → fail closed。
5. yarn/bun/未知 manager → fail closed，不用 pnpm 兜底。

### Toolchain identity shape

新的持久化 identity：

```ts
{
  node: string;
  packageManager: "pnpm" | "npm";
  packageManagerVersion: string;
  lockfile: "pnpm-lock.yaml" | "package-lock.json";
  lockfileSha256: string;
}
```

旧 receipt/attestation `{ node, pnpm, lockfileSha256 }` 继续被 parser/validator 接受，并规范化解释为 pnpm legacy identity。新 npm identity 绝不写 `pnpm` 字段。

SQLite 中该结构本来就是 JSON blob，因此不做 schema migration。

## GG-BL-027 design

### Root cause

当前 SBPL 仅允许：

```text
process-exec(worktree/node_modules/.bin/**)
```

pnpm fixture 的 `.bin` 是物理 shell shim，因此成立。npm 常见布局则是：

```text
node_modules/.bin/foo -> ../foo/bin/foo.js
```

macOS Seatbelt 在 `process-exec` 检查前解析 symlink；真实 target 已落在 `.bin` 外，于是被 deny default 拒绝。

### Minimal allow model

`runSandboxed()` 在生成 profile 前只读枚举当前 worktree 根部 `node_modules/.bin`：

- 物理文件继续由现有 `.bin` subpath allow 覆盖；
- 对 symlink，解析 `realpath`；
- 仅当 target 是文件且仍位于 `<worktree>/node_modules/` 内时，把该精确 target literal 加入本次 profile 的 `process-exec` allow；
- 指向 worktree 其他位置、worktree 外、control plane 或不存在目标的 symlink 不加入 allow；
- 不使用 `(subpath worktree/node_modules)`，避免把所有依赖包里的任意二进制都提升为可直接 exec。

这只把 npm 已经通过 `.bin` 暴露的入口对应真实 target 补齐，不把整个 worktree 或整个 `node_modules` 变成 executable root。

## Required tests

### Verification identity

- pnpm repo 产生 modern pnpm identity，并 hash `pnpm-lock.yaml`。
- npm repo 产生 modern npm identity，并 hash `package-lock.json`。
- npm identity 不含 legacy `pnpm` 字段。
- 双 lockfile、无明确 packageManager → fail closed。
- 明确 npm 但缺 `package-lock.json` → fail closed。
- legacy pnpm identity 仍被 receipt/attestation parser 接受。

### Sandbox

- npm 风格 `.bin` symlink → `node_modules/<pkg>/bin/cli.js` 在 sandbox 中真实执行成功。
- `.bin` symlink 指向当前 `node_modules` 外时执行失败。
- worktree 根部另一个可执行文件继续失败。
- 现有 pnpm/git/network/control-plane tests 保持绿色。

## Release / validation

这是 L3：verification-integrity + sandbox boundary。必须完成 RED → GREEN、fresh `unit-selfhost`、`typecheck`、independent CI、exact-SHA Host gate，再 merge。public tool identity 必须保持不变。
