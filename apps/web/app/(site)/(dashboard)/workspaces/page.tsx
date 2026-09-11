import type { ReactNode } from "react";
import { AutoRefresh } from "../_components/auto-refresh";
import { isBusyState } from "../_components/format";
import { WorkspaceList } from "../_components/workspace-list";
import { PageHeader } from "../_components/ui";
import { dashboardViewer, listWorkspaceViews } from "../data";
import { PublicRepoForm } from "../_components/public-repo-form";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage(): Promise<ReactNode> {
  await dashboardViewer();
  const workspaces = await listWorkspaceViews();
  const running = workspaces.filter((workspace) => workspace.state === "running").length;
  const busy = workspaces.some((workspace) => isBusyState(workspace.state));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your workspaces"
        description={workspaces.length ? <span className="tabular-nums">{workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"} · {running} running</span> : "Ready when you are."}
        actions={<PublicRepoForm modal />}
      />
      <WorkspaceList workspaces={workspaces} />
      <AutoRefresh enabled={busy} />
    </div>
  );
}
