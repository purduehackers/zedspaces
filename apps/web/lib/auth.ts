import { eq } from "drizzle-orm";
import { ApiError } from "./api";
import { dbReady } from "./db";
import { PUBLIC_USER_ID, PUBLIC_INSTALLATION_ID } from "./public-space";
import { ensureLocalInstallation, localBackendEnabled } from "./sandbox-local";
import { githubInstallations, repos, users, workspaces, type User, type Workspace, type WorkspaceState } from "./schema";

export interface Viewer {
  userId: string;
  flaggedAt: Date | null;
}

// One shared space, deliberately without login. The legacy installation row
// is a local foreign-key anchor, not a GitHub App installation.
export async function requireViewer(): Promise<Viewer> {
  const db = await dbReady();
  await db.insert(users).values({ id: PUBLIC_USER_ID, email: null, plan: "pro" }).onConflictDoNothing();
  await db.insert(githubInstallations).values({
    installationId: PUBLIC_INSTALLATION_ID, accountId: 0, accountLogin: "public",
    accountType: "User", repositorySelection: "all", ownerUserId: PUBLIC_USER_ID,
  }).onConflictDoNothing();
  if (localBackendEnabled()) await ensureLocalInstallation(PUBLIC_USER_ID);
  const [account] = await db.select().from(users).where(eq(users.id, PUBLIC_USER_ID)).limit(1);
  if (account.deletedAt) throw new ApiError(403, "account_deleted", "The shared space is disabled");
  return { userId: PUBLIC_USER_ID, flaggedAt: account.flaggedAt };
}

export function assertNotFlagged(viewer: Viewer): void {
  if (viewer.flaggedAt) throw new ApiError(403, "account_flagged", "The shared space is disabled by the abuse guard");
}

export async function ensureUser(viewer: Viewer): Promise<User> {
  const db = await dbReady();
  await db.insert(users).values({ id: viewer.userId }).onConflictDoNothing();
  const [row] = await db.select().from(users).where(eq(users.id, viewer.userId)).limit(1);
  return row;
}

export async function requireWorkspaceAccess(
  _viewer: Viewer,
  workspaceId: string,
  opts?: { allowStates?: WorkspaceState[]; control?: boolean },
): Promise<Workspace> {
  const db = await dbReady();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
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
