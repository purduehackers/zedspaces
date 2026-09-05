import { dbReady } from "./db";
import { auditLog, type ActorType } from "./schema";

export type { ActorType } from "./schema";

/** One audit-log entry. */
export interface AuditEntry {
  actorType: ActorType;
  actorId: string;
  /** "workspace.create" | "workspace.stop" | "secret.put" | "git_token.issue" | "admin.stop" | … */
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Appends an entry to `audit_log`. Never include secret values in `metadata`. */
export async function audit(entry: AuditEntry): Promise<void> {
  const db = await dbReady();
  await db.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? null,
    ip: entry.ip ?? null,
  });
}
