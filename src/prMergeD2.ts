import type { ToolDef, ToolDeps } from "./toolsCore.ts";
import { readTaskPrReceipt, recordTaskPrMerged } from "./taskPrReceipt.ts";
import { getTask } from "./tasks.ts";
import {
  wrapPrMergeToolD2 as wrapCorePrMergeToolD2,
  type PrMergeD2Options,
} from "./prMergeD2Core.ts";

export type { PrMergeD2Options } from "./prMergeD2Core.ts";

const SHA_RE = /^[0-9a-f]{40}$/u;

/**
 * Persist the exact merge milestone even when the base merge path already performed
 * safe cleanup and CLOSED the task before D2 gets control back. This is evidence-only:
 * the core wrapper is skipped for CLOSED tasks so cleanup/reconciliation cannot run twice.
 */
export function wrapPrMergeToolD2(
  deps: ToolDeps,
  base: ToolDef,
  options: PrMergeD2Options = {},
): ToolDef {
  const core = wrapCorePrMergeToolD2(deps, base, options);
  return {
    ...core,
    handler: async (args) => {
      const response = await base.handler(args);
      const envelope = response.structuredContent as {
        ok?: unknown;
        data?: Record<string, unknown>;
      };
      const taskId = args.taskId as string;
      const task = getTask(deps.db, taskId);
      if (envelope.ok === true && envelope.data?.merged === true && task?.state === "CLOSED") {
        const receipt = readTaskPrReceipt(deps.db, taskId);
        const headSha = typeof envelope.data.headSha === "string" && SHA_RE.test(envelope.data.headSha)
          ? envelope.data.headSha : null;
        const mergeSha = typeof envelope.data.mergeSha === "string" && SHA_RE.test(envelope.data.mergeSha)
          ? envelope.data.mergeSha : null;
        const refresh = envelope.data.canonicalRefresh as { branch?: unknown } | undefined;
        if (receipt && headSha && mergeSha && typeof refresh?.branch === "string"
            && receipt.prNumber === envelope.data.prNumber
            && receipt.headSha === headSha
            && receipt.baseRef === refresh.branch) {
          recordTaskPrMerged(deps.db, {
            taskId,
            prNumber: receipt.prNumber,
            prUrl: receipt.prUrl,
            headSha: receipt.headSha,
            baseRef: receipt.baseRef,
            baseSha: receipt.baseSha,
            mergeSha,
          });
        }
        return response;
      }
      // The core wrapper owns all non-CLOSED behavior. Its base handler must return the
      // already-observed response so no remote merge mutation can be issued twice.
      return wrapCorePrMergeToolD2(deps, { ...base, handler: async () => response }, options).handler(args);
    },
  };
}

export function addPrMergeD2Reconciliation(
  deps: ToolDeps,
  tools: ToolDef[],
  options: PrMergeD2Options = {},
): ToolDef[] {
  return tools.map((tool) => tool.name === "grande_pr_merge" ? wrapPrMergeToolD2(deps, tool, options) : tool);
}
