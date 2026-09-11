import { and, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { ApiError } from "./api";
import type { DbLike } from "./db";
import { env } from "./env";
import { workspaces } from "./schema";

export const ACTIVE_WORKSPACE_STATES = ["creating", "running", "stopping", "rebuilding"] as const;

/** Call inside the same write transaction that reserves a create or resume. */
export async function assertWorkspaceCapacity(db: DbLike, excludeId?: string): Promise<void> {
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(workspaces).where(and(
    isNull(workspaces.deletedAt), excludeId ? ne(workspaces.id, excludeId) : undefined,
    or(inArray(workspaces.state, [...ACTIVE_WORKSPACE_STATES]), isNotNull(workspaces.workflowRunId)),
  ));
  if (count >= env().ZS_MAX_RUNNING_WORKSPACES) throw new ApiError(429, "workspace_limit",
    "All workshop sandboxes are in use. Try again shortly or ask your organizer for help.", { maxWorkspaces: env().ZS_MAX_RUNNING_WORKSPACES });
}
