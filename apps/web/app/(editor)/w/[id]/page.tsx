import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireViewer, requireWorkspaceAccess, type Viewer } from "@/lib/auth";
import { refusesTestClientBuild } from "@/lib/env";
import { canDeferUpgrade, currentRelease } from "@/lib/release";
import { assertWorkspaceId } from "@/lib/route-context";
import { repoOf, toShellWorkspace, workspacePathsFor } from "@/lib/shell";
import type { Workspace } from "@/lib/schema";
import { EditorShell } from "./editor-shell";

/**
 * Public editor document. The shell requests its short-lived VM token from
 * `POST /connect`; signing keys never reach the browser.
 */
export const dynamic = "force-dynamic";

async function loadWorkspace(viewer: Viewer, id: string): Promise<Workspace | null> {
  try {
    return await requireWorkspaceAccess(viewer, assertWorkspaceId(id));
  } catch {
    return null;
  }
}

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }): Promise<ReactNode> {
  const { id } = await params;
  const viewer = await requireViewer();

  const workspace = await loadWorkspace(viewer, id);
  if (!workspace) notFound();
  // A test-hooks bundle installs `window.__zs_test` (openFile, save, terminalInput, …) over the
  // live session, so a production deployment must not serve one whatever stamped the row.
  const clientBuild = canDeferUpgrade(workspace.clientBuild) && !workspace.previousSandboxName
    ? workspace.clientBuild : currentRelease().clientBuild;
  if (refusesTestClientBuild(clientBuild)) notFound();

  const repo = await repoOf(workspace);
  return (
    <EditorShell
      workspaceId={workspace.id}
      build={clientBuild}
      initial={toShellWorkspace(workspace, repo)}
      paths={repo ? workspacePathsFor(workspace, repo) : []}
      settingsUrl={`/api/workspaces/${workspace.id}/settings`}
      keymapUrl={`/api/workspaces/${workspace.id}/keymap`}
    />
  );
}
