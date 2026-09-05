import { eq, sql } from "drizzle-orm";
import { ApiError, bearer } from "./api";
import { dbReady } from "./db";
import { newSandboxToken, sha256Hex, timingSafeEqualHex } from "./ids";
import { workspaces, type Workspace } from "./schema";

export interface SandboxPrincipal {
  kind: "workspace";
  workspace: Workspace;
  sandboxName: string;
  tokenGeneration: number;
}

export function principalSubjectId(principal: SandboxPrincipal): string {
  return principal.workspace.id;
}

// Internal VM credentials remain required even though the dashboard is public.
export async function requireSandbox(
  req: Request,
  sandboxName: string,
): Promise<SandboxPrincipal> {
  const token = bearer(req);
  if (!token?.startsWith("zsb_")) throw new ApiError(401, "sandbox_unauthorized", "Invalid sandbox token");
  if (!/^sb-[a-z0-9-]{1,60}$/.test(sandboxName)) {
    throw new ApiError(400, "invalid_sandbox_name", "Invalid workspace sandbox name");
  }
  const db = await dbReady();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.sandboxName, sandboxName)).limit(1);
  if (!row?.sandboxTokenHash || !timingSafeEqualHex(sha256Hex(token), row.sandboxTokenHash)) {
    throw new ApiError(401, "sandbox_unauthorized", "Invalid sandbox token");
  }
  if (row.deletedAt) throw new ApiError(410, "sandbox_retired", "Workspace was deleted");
  return { kind: "workspace", workspace: row, sandboxName, tokenGeneration: row.sandboxTokenGeneration };
}

// Rotate on every supervisor start. Only the hash reaches the database.
export async function rotateSandboxToken(target: {
  kind: "workspace";
  id: string;
}): Promise<{ token: string; generation: number }> {
  const db = await dbReady();
  const { token, hash } = newSandboxToken();
  const [row] = await db.update(workspaces).set({
    sandboxTokenHash: hash,
    sandboxTokenGeneration: sql`${workspaces.sandboxTokenGeneration} + 1`,
    updatedAt: new Date(),
  }).where(eq(workspaces.id, target.id)).returning();
  if (!row) throw new ApiError(404, "not_found", "Workspace not found");
  return { token, generation: row.sandboxTokenGeneration };
}
