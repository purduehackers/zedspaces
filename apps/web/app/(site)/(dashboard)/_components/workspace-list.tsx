import Link from "next/link";
import type { WorkspaceView } from "@/lib/types";
import { formatRef, formatRelative, formatRepo, formatTimestamp, STATE_LABELS, stateTone } from "./format";
import { Badge, EmptyState } from "./ui";

export function WorkspaceList({ workspaces, now }: { workspaces: WorkspaceView[]; now?: number }) {
  if (!workspaces.length) return <EmptyState title="No workspaces yet">
    Open your workshop’s repo link to start. Your workspaces will be waiting here when you come back.
  </EmptyState>;

  return <div className="table-scroll" tabIndex={0} role="region" aria-label="Workspace list">
    <table className="data-table min-w-[44rem]">
      <caption className="sr-only">Your workspaces</caption>
      <thead><tr>
        <th scope="col">Workspace</th><th scope="col">Branch</th><th scope="col">Status</th>
        <th scope="col">Last active</th><th scope="col" className="text-right">Actions</th>
      </tr></thead>
      <tbody>{workspaces.map(workspace => <tr key={workspace.id} data-workspace={workspace.id}>
        <th scope="row" className="w-full min-w-56 font-normal">
          <Link href={`/workspaces/${workspace.id}`} className="table-name font-medium" title={workspace.name}>{workspace.name}</Link>
          <span className="block max-w-80 truncate text-xs text-muted" title={formatRepo(workspace.repo)} translate="no">{formatRepo(workspace.repo)}</span>
        </th>
        <td><span className="block max-w-44 truncate" title={formatRef(workspace)} translate="no">{formatRef(workspace)}</span></td>
        <td><Badge tone={stateTone(workspace.state)}>{STATE_LABELS[workspace.state]}</Badge></td>
        <td className="whitespace-nowrap tabular-nums text-muted"><time dateTime={workspace.lastActiveAt} title={formatTimestamp(workspace.lastActiveAt)}>{formatRelative(workspace.lastActiveAt, now)}</time></td>
        <td className="text-right whitespace-nowrap">
          <div className="flex items-center justify-end gap-3">
            <Link href={`/workspaces/${workspace.id}`} className="table-action" aria-label={`Manage ${workspace.name}`}>
              {workspace.state === "error" ? "View error" : "Manage"}
            </Link>
            {workspace.state !== "error" && workspace.state !== "deleting" && <Link href={`/w/${workspace.id}`} className="table-action rounded border border-line px-3 hover:border-muted hover:bg-raised" aria-label={`${workspace.state === "stopped" ? "Resume" : "Open"} ${workspace.name}`}>
              {workspace.state === "stopped" ? "Resume" : "Open"}
            </Link>}
          </div>
        </td>
      </tr>)}</tbody>
    </table>
  </div>;
}
