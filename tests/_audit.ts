import type { DatabaseSync } from "node:sqlite";
import { beginAudit, type AuditHandle } from "../src/audit.ts";

export function allowedHandle(db: DatabaseSync, tool: string): AuditHandle {
  const h = beginAudit(db, { taskId: null, tool, input: {} });
  h.allowed();
  return h;
}
