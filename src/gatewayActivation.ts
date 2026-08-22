import type { DatabaseSync } from "node:sqlite";
import {
  recordActivationReceipt,
  type ActivationReceipt,
} from "./activationReceipt.ts";
import type { GatewayLaunchdCommandResult } from "./launchd.ts";
import type { SelfCheckResult } from "./selfcheck.ts";
import type { ToolsetIdentity } from "./toolsetIdentity.ts";

export interface GatewayActivationRuntime {
  restart: () => GatewayLaunchdCommandResult;
  status: () => GatewayLaunchdCommandResult;
  readProbe: () => Promise<SelfCheckResult>;
}

export interface GatewayActivationResult {
  code: number;
  lines: string[];
  receipt: ActivationReceipt | null;
}

function failed(lines: string[], detail: string): GatewayActivationResult {
  return { code: 1, lines: [...lines, detail], receipt: null };
}

/**
 * Production activation is deliberately narrower than deploy/merge state: it only proves that
 * the requested Gateway build was restarted, is running and endpoint-ready, then answers a
 * trusted read probe with the exact expected tool identity. No step is retried here and no
 * receipt is persisted until every prerequisite has succeeded.
 */
export async function runProductionGatewayActivation(
  db: DatabaseSync,
  target: ToolsetIdentity,
  runtime: GatewayActivationRuntime,
  activatedAt = Date.now(),
): Promise<GatewayActivationResult> {
  const lines: string[] = [];

  const restarted = runtime.restart();
  lines.push(...restarted.lines);
  if (restarted.code !== 0) {
    return failed(lines, "Production activation 未完成：Gateway restart/readiness 失败，未记录 receipt。");
  }

  const status = runtime.status();
  lines.push(...status.lines);
  const running = status.code === 0 && status.lines.some((line) => /\bstate=running\b/u.test(line));
  if (!running) {
    return failed(lines, "Production activation 未完成：LaunchAgent 未证明 state=running，未记录 receipt。");
  }

  let probe: SelfCheckResult;
  try {
    probe = await runtime.readProbe();
  } catch (error) {
    return failed(
      lines,
      `Production activation 未完成：trusted read probe 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    probe.httpStatus !== 200
    || probe.gatewayBuild === null
    || probe.toolsetEpoch === null
    || probe.toolsDigest === null
    || probe.identityError !== undefined
  ) {
    const detail = probe.identityError ?? `HTTP ${probe.httpStatus} / incomplete runtime identity`;
    return failed(lines, `Production activation 未完成：trusted read probe/identity 不完整：${detail}`);
  }

  try {
    const receipt = recordActivationReceipt(db, {
      targetBuild: target.gatewayBuild,
      runtimeBuild: probe.gatewayBuild,
      expectedToolset: {
        toolsetEpoch: target.toolsetEpoch,
        toolsCount: target.toolsCount,
        toolsDigest: target.toolsDigest,
      },
      runtimeToolset: {
        toolsetEpoch: probe.toolsetEpoch,
        toolsCount: probe.toolsCount,
        toolsDigest: probe.toolsDigest,
      },
      restart: {
        launchAgentRunning: true,
        endpointReady: true,
      },
      readProbe: {
        ok: true,
        httpStatus: probe.httpStatus,
      },
    }, activatedAt);
    lines.push(
      `Production activation receipt 已记录：build=${receipt.runtimeBuild} `
      + `epoch=${receipt.toolsetEpoch} tools=${receipt.toolsCount} digest=${receipt.toolsDigest}`,
    );
    return { code: 0, lines, receipt };
  } catch (error) {
    return failed(
      lines,
      `Production activation 未完成：build/tool identity mismatch：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
