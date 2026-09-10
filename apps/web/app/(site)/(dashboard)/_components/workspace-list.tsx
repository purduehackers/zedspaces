import Link from "next/link";
import type { WorkspaceView } from "@/lib/types";
import { formatMachine, formatRef, formatRelative, formatRepo, STATE_LABELS, stateTone } from "./format";
import { Badge, buttonClass, EmptyState } from "./ui";

export function WorkspaceList({ workspaces, now }: { workspaces: WorkspaceView[]; now?: number }) {
  if (!workspaces.length) return <EmptyState title="Your next idea starts here.">
    Open a repository above. You’ll get a real terminal, your files, and a link to invite someone in.
  </EmptyState>;

  return <ul aria-label="Shared workspaces" className="divide-y divide-line rounded border border-line">
    {workspaces.map(workspace => <li key={workspace.id} data-workspace={workspace.id}
      className="flex flex-col gap-4 bg-panel p-5 first:rounded-t last:rounded-b sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/w/${workspace.id}`} className="font-medium break-all hover:text-gold">{workspace.name}</Link>
          <Badge tone={stateTone(workspace.state)}>{STATE_LABELS[workspace.state]}</Badge>
        </div>
        <p className="text-sm break-all text-muted">{formatRepo(workspace.repo)} <span aria-hidden="true">/</span> {formatRef(workspace)}</p>
        <p className="text-xs leading-relaxed text-muted">
          {formatMachine(workspace.machine)} · {workspace.region} · Active <time dateTime={workspace.lastActiveAt}>{formatRelative(workspace.lastActiveAt, now)}</time>
        </p>
        {workspace.stateReason && <p className="text-xs break-words text-muted">{workspace.stateReason}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Link href={`/workspaces/${workspace.id}`} className={buttonClass()} aria-label={`Manage ${workspace.name}`}>Manage</Link>
        <Link href={`/w/${workspace.id}`} className={buttonClass("primary")} aria-label={`Open ${workspace.name} in the editor`}>
          {workspace.state === "stopped" ? "Resume" : "Open"} →
        </Link>
      </div>
    </li>)}
  </ul>;
}
