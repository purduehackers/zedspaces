import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { dbReady } from "./db";
import { localBackendEnabled, localSandboxDir } from "./sandbox-local";
import { repos, type Repo, type Workspace } from "./schema";
import type { ShellWorkspace } from "./types";

/** Row → props conversions for the editor shell (b9 §3.26). */

/** The absolute path of the clone inside the sandbox (`manifest.workspaceDir`). */
export function workspaceDir(repo: Pick<Repo, "name">): string {
  return `/workspaces/${repo.name}`;
}

/** The `ZsBootConfig.workspace.paths` the client opens on boot. */
export function workspacePaths(repo: Pick<Repo, "name">): string[] {
  return [workspaceDir(repo)];
}

/**
 * {@link workspacePaths} for one workspace. On the local backend
 * (`ZS_SANDBOX_BACKEND=local`) the supervisor relocates `/workspaces/<repo>`
 * under `<sandbox dir>/workspaces` (`relocate_workspace_dir`), and the server's
 * `AddWorktree` canonicalises the path the client sends on this machine's
 * filesystem — so the client must be handed the relocated path, not the
 * sandbox one, and in its canonical form: the client keys its persisted
 * layout (and the D6 unsaved-buffer snapshot under it) on the worktree's
 * absolute path, so a path that still goes through a symlink (`/var` →
 * `/private/var` for macOS's `$TMPDIR`) would never match the row the
 * previous session wrote and every boot would start from an empty layout.
 */
export function workspacePathsFor(workspace: Pick<Workspace, "sandboxName">, repo: Pick<Repo, "name">): string[] {
  if (localBackendEnabled()) {
    const relocated = path.join(localSandboxDir(workspace.sandboxName), "workspaces", repo.name);
    return [canonicalPath(relocated)];
  }
  return workspacePaths(repo);
}

/** `realpath` of a path that exists on this machine; the path itself while it does not yet. */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The workspace summary the editor page hands the shell (b9 §3.26). */
export function toShellWorkspace(workspace: Workspace, repo: Pick<Repo, "owner" | "name"> | null): ShellWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    repo: repo ? `${repo.owner}/${repo.name}` : workspace.name,
    branch: workspace.branch,
    machine: workspace.machine,
    region: workspace.region,
    state: workspace.state,
    stateReason: workspace.stateReason,
    idleMinutes: workspace.idleMinutes,
    serverBuild: workspace.serverBuild,
    clientBuild: workspace.clientBuild,
  };
}

/** The repository row of a workspace, or `null` when it was deleted underneath it. */
export async function repoOf(workspace: Workspace): Promise<Repo | null> {
  const db = await dbReady();
  const [row] = await db.select().from(repos).where(eq(repos.id, workspace.repoId)).limit(1);
  return row ?? null;
}
