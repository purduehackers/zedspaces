import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "../_components/auto-refresh";
import { isBusyState } from "../_components/format";
import { WorkspaceList } from "../_components/workspace-list";
import { buttonClass, PageHeader } from "../_components/ui";
import { dashboardViewer, listWorkspaceViews } from "../data";
import { PublicRepoForm } from "../_components/public-repo-form";
import { env } from "@/lib/env";

/** The workspace list (BUILD-SPEC §7.7): state, repo, branch, machine, last active, cost. */
export const dynamic = "force-dynamic";

export default async function WorkspacesPage(): Promise<ReactNode> {
  await dashboardViewer();
  const workspaces = await listWorkspaceViews();
  const running = workspaces.filter((workspace) => workspace.state === "running").length;
  const busy = workspaces.some((workspace) => isBusyState(workspace.state));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description={`${running} of ${env().ZS_MAX_RUNNING_WORKSPACES} running in this shared space.`}
        actions={
          <Link href="/workspaces/new" className={buttonClass("primary")}>
            New workspace
          </Link>
        }
      />
      <PublicRepoForm />
      <WorkspaceList workspaces={workspaces} />
      <AutoRefresh enabled={busy} />
    </div>
  );
}
