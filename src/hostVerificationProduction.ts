import type { DatabaseSync } from "node:sqlite";
import { createGithubApi, type GithubLifecycleApi } from "./githubApi.ts";
import { loadGithubToken } from "./githubAuth.ts";
import { HostVerifierCoordinator, type HostVerifierRequest } from "./hostVerifier.ts";
import {
  createDefaultHostVerifierRuntimeAdapter,
  createHostVerifierLauncher,
} from "./hostVerifierRuntime.ts";
import type { HostVerificationConfig } from "./hostVerificationConfig.ts";
import type { Layout } from "./layout.ts";
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
import { getTask } from "./tasks.ts";
import type { BuildToolsOptions } from "./tools.ts";

export interface ProductionHostVerificationDeps {
  db: DatabaseSync;
  layout: Layout;
}

export interface TrustedPrHeadReaderOptions {
  apiFactory?: (token: string) => GithubLifecycleApi;
  readRemoteUrl?: (worktreePath: string, token: string) => string;
}

export interface ProductionHostVerificationOptions extends TrustedPrHeadReaderOptions {
  coordinatorFactory?: (
    launcher: ConstructorParameters<typeof HostVerifierCoordinator>[0],
  ) => HostVerifierCoordinator;
  /** Host-only test/soak injection. Production startup never supplies this. */
  readPrHead?: (request: HostVerifierRequest) => Promise<string | null>;
}

/**
 * Build the trusted PR-head observer used after an auto verifier finishes.
 * All authority comes from the existing task row, control-plane PAT and validated
 * GitHub HTTPS origin; candidate repository files and verifier output never select
 * a PR, branch, token or remote.
 */
export function createTrustedPrHeadReader(
  deps: ProductionHostVerificationDeps,
  options: TrustedPrHeadReaderOptions = {},
): (request: HostVerifierRequest) => Promise<string | null> {
  const apiFactory = options.apiFactory ?? createGithubApi;
  const readRemote = options.readRemoteUrl ?? readGithubRemoteUrl;

  return async (request) => {
    if (request.repoId !== "grande-gpt") return null;
    const task = getTask(deps.db, request.taskId);
    if (!task || task.repoId !== request.repoId) return null;

    const token = loadGithubToken(deps.layout).token;
    const { owner, repo } = parseGithubRemote(readRemote(task.worktreePath, token));
    if (repo !== "grande-gpt") return null;
    const api = apiFactory(token);
    const found = await api.findPullRequest(owner, repo, task.branch, "all");
    if (!found) return null;
    const pr = await api.getPullRequest(owner, repo, found.number);
    if (pr.headRef !== task.branch) return null;
    return pr.headSha;
  };
}

/**
 * Construct at most one HostVerifierCoordinator for the Gateway process. Manual
 * mode is deliberately inert. Auto mode reuses the existing restricted runtime;
 * the launcher receives no new argv/cwd/env inputs and retains exact-SHA + PR-head
 * receipt binding. The returned object is passed unchanged to every buildTools()
 * call so all MCP requests share the same coordinator/concurrency boundary.
 */
export function createProductionHostVerification(
  deps: ProductionHostVerificationDeps,
  config: HostVerificationConfig,
  options: ProductionHostVerificationOptions = {},
): BuildToolsOptions {
  if (config.mode === "manual") {
    return { hostVerificationMode: "manual", hostVerifierCoordinator: undefined };
  }

  const readPrHead = options.readPrHead ?? createTrustedPrHeadReader(deps, options);
  const adapter = createDefaultHostVerifierRuntimeAdapter(deps, { readPrHead });
  const launcher = createHostVerifierLauncher(
    deps,
    adapter,
    { receiptMode: "auto", requirePrHead: true },
  );
  const coordinator = (options.coordinatorFactory ?? ((trustedLauncher) => new HostVerifierCoordinator(trustedLauncher)))(launcher);
  return { hostVerificationMode: "auto", hostVerifierCoordinator: coordinator };
}
