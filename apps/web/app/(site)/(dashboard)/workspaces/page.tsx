import type { ReactNode } from "react";
import { AutoRefresh } from "../_components/auto-refresh";
import { isBusyState } from "../_components/format";
import { WorkspaceList } from "../_components/workspace-list";
import { PageHeader } from "../_components/ui";
import { dashboardViewer, listWorkspaceViews } from "../data";
import { PublicRepoForm } from "../_components/public-repo-form";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage(): Promise<ReactNode> {
  await dashboardViewer();
  const workspaces = await listWorkspaceViews();
  const running = workspaces.filter((workspace) => workspace.state === "running").length;
  const busy = workspaces.some((workspace) => isBusyState(workspace.state));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Workspaces"
        description="A shared space to build. Your repo, a real terminal, and Zed in a browser tab."
      />
      <PublicRepoForm />
      <section className="space-y-4" aria-label="Workspace management">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="brand-label">Pick up where you left off</h2>
          <p className="text-xs text-muted">{running} / {env().ZS_MAX_RUNNING_WORKSPACES} sandboxes running</p>
        </div>
        <WorkspaceList workspaces={workspaces} />
      </section>
      <AutoRefresh enabled={busy} />
    </div>
  );
}
