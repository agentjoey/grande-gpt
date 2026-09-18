import { pathToFileURL } from "node:url";
import { openDb } from "./db.ts";
import { rotateStoppedGatewayLogs } from "./gatewayLogRotation.ts";
import { loadLayout } from "./layout.ts";
import { planResourceRetention, applyResourceRetention } from "./resourceRetention.ts";

/** Fixed semantic maintenance operations only. No arbitrary filesystem paths or process commands. */
export async function runResourceMaintenance(args: string[], out: (line: string) => void): Promise<number> {
  const [action, second, third] = args;
  const cursor = action === "plan" ? second : third;
  const validCursor = cursor === undefined || (cursor.startsWith("retention1:") && cursor.length <= 1024);
  if (!validCursor || !((action === "plan" && args.length >= 1 && args.length <= 2)
      || (action === "apply" && args.length >= 2 && args.length <= 3 && /^sha256:[0-9a-f]{64}$/u.test(second ?? ""))
      || (action === "rotate-logs" && args.length === 1))) {
    out("用法：node src/resourceMaintenanceCli.ts plan [cursor] | apply <plan-digest> [cursor] | rotate-logs");
    return 1;
  }
  let db;
  try {
    const layout = loadLayout();
    db = openDb(layout);
    if (action === "rotate-logs") {
      out(JSON.stringify(rotateStoppedGatewayLogs(db, layout)));
      out("轮转完成；用现有 gateway restart 执行 readiness/activation，并重新打开日志写入句柄。");
      return 0;
    }
    const plan = planResourceRetention(db, layout, { cursor });
    if (action === "plan") { out(JSON.stringify(plan)); return 0; }
    if (plan.digest !== second) { out("保留计划已经变化；请重新 plan 后核对，不执行旧计划。"); return 1; }
    const result = applyResourceRetention(db, layout, plan);
    out(JSON.stringify(result));
    return result.skipped.length ? 1 : 0;
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 1;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runResourceMaintenance(process.argv.slice(2), console.log);
}
