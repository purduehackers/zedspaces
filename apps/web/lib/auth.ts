import "server-only";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ApiError } from "./api";
import { dbReady } from "./db";
import { login } from "./login";
import { repos, users, workspaces, type User, type Workspace, type WorkspaceState } from "./schema";

export interface Viewer {
  userId: string;
  flaggedAt: Date | null;
  name: string;
  image: string | null;
}

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const incoming = await headers();
  if (!incoming.get("cookie")?.includes("zedspaces.session_token=")) return null;
  const session = await (await login()).api.getSession({ headers: incoming, query: { disableRefresh: true } });
  if (!session) return null;
  const [user] = await (await dbReady()).select().from(users).where(eq(users.id, session.user.id)).limit(1);
  if (!user || user.deletedAt) return null;
  return { userId: user.id, flaggedAt: user.flaggedAt, name: user.name, image: user.image };
});

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new ApiError(401, "sign_in_required", "Sign in with GitHub to continue");
  return viewer;
}

export async function requirePageViewer(returnTo = "/workspaces"): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return viewer;
}

export function assertNotFlagged(viewer: Viewer): void {
  if (viewer.flaggedAt) throw new ApiError(403, "account_flagged", "Your account is disabled by the abuse guard. Ask a workshop organizer for help.");
}

export async function ensureUser(viewer: Viewer): Promise<User> {
  const db = await dbReady();
  const [row] = await db.select().from(users).where(eq(users.id, viewer.userId)).limit(1);
  if (!row || row.deletedAt) throw new ApiError(401, "sign_in_required", "Sign in with GitHub to continue");
  return row;
}

export async function requireWorkspaceAccess(
  viewer: Viewer,
  workspaceId: string,
  opts?: { allowStates?: WorkspaceState[]; control?: boolean },
): Promise<Workspace> {
  const db = await dbReady();
  const [workspace] = await db.select().from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, viewer.userId))).limit(1);
  if (!workspace) throw new ApiError(404, "not_found", "Workspace not found");
  if (workspace.deletedAt) throw new ApiError(410, "workspace_deleted", "Workspace was deleted");
  if (opts?.allowStates && !opts.allowStates.includes(workspace.state)) {
    throw new ApiError(423, "workspace_busy", `Workspace is ${workspace.state}`, { state: workspace.state });
  }
  return workspace;
}

export async function requireRepoAccess(_viewer: Viewer, repoId: string) {
  const db = await dbReady();
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.private) throw new ApiError(404, "not_found", "Public repository not found");
  return repo;
}
