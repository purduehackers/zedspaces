import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api";
import { deleteWorkspaceAction, forwardPortAction, rebuildWorkspaceAction, stopWorkspaceAction,
  unforwardPortAction, updateWorkspaceAction } from "../../actions";
import { ActionForm } from "../../_components/action-form";
import { AutoRefresh } from "../../_components/auto-refresh";
import { formatMachine, formatRef, formatTimestamp, isBusyState, STATE_LABELS, stateTone } from "../../_components/format";
import { Alert, Badge, buttonClass, Card, DetailRow, Field, FIELD_CLASS, PageHeader } from "../../_components/ui";
import { dashboardViewer, workspaceDetail, type WorkspaceDetail } from "../../data";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { viewer } = await dashboardViewer();
  let detail: WorkspaceDetail;
  try { detail = await workspaceDetail(viewer, (await params).id); }
  catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) notFound();
    throw err;
  }
  const { view, sessions, listening, slotsFree } = detail;
  const fields = { workspaceId: view.id };
  const unforwarded = listening.filter((port) => !view.forwards.some((forward) => forward.port === port));
  return <div className="space-y-6">
    <PageHeader title={view.name} description={<span className="flex flex-wrap items-center gap-2">
      <Badge tone={stateTone(view.state)}>{STATE_LABELS[view.state]}</Badge>
      {view.repo.owner}/{view.repo.name} · {formatRef(view)} · {formatMachine(view.machine)} · {view.region}
    </span>} actions={<>
      <Link href={`/w/${view.id}`} className={buttonClass("primary")}>Open editor</Link>
      <ActionForm action={stopWorkspaceAction} fields={fields} submitLabel="Stop"
        confirm="Stop this workspace? Unsaved editor state is flushed first." inline />
    </>} />
    {view.stateReason && <Alert kind="info">{view.stateReason}</Alert>}
    {view.image.stale && <Alert kind="info">A newer editor is available. Open this workspace to download the update in the background, then choose when to restart.</Alert>}
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Overview"><dl>
        <DetailRow term="Revision">{view.revision?.slice(0, 12) ?? "—"}</DetailRow>
        <DetailRow term="Server build">{view.serverBuild}</DetailRow>
        <DetailRow term="Client build">{view.clientBuild}</DetailRow>
        <DetailRow term="Created">{formatTimestamp(view.createdAt)}</DetailRow>
        <DetailRow term="Last active">{formatTimestamp(view.lastActiveAt)}</DetailRow>
        <DetailRow term="Snapshot kept until">{formatTimestamp(view.retentionUntil)}</DetailRow>
      </dl></Card>
      <Card title="Settings">
        <ActionForm action={updateWorkspaceAction} fields={fields} submitLabel="Save">
          <Field label="Name" htmlFor="workspace-name">
            <input id="workspace-name" name="name" className={FIELD_CLASS} defaultValue={view.name} maxLength={64} required />
          </Field>
          <Field label="Idle timeout (minutes)" htmlFor="workspace-idle" hint="Between 5 and 240 minutes.">
            <input id="workspace-idle" name="idleMinutes" type="number" min={5} max={240}
              className={FIELD_CLASS} defaultValue={view.idleMinutes} />
          </Field>
        </ActionForm>
      </Card>
    </div>
    <Card title="Ports" description={`${slotsFree} preview slots available. Public previews can be opened by anyone with the link.`}>
      <div className="space-y-4">
        {view.forwards.length ? <ul className="space-y-2">{view.forwards.map((forward) =>
          <li key={forward.port} className="flex flex-wrap items-center gap-3 text-sm">
            <span>{forward.port} · {forward.visibility} {forward.label}</span>
            {forward.url ? <a href={forward.url} target="_blank" rel="noopener noreferrer" className="underline">Open</a>
              : <span>Available while running</span>}
            <ActionForm action={unforwardPortAction} fields={{ ...fields, port: forward.port }} submitLabel="Remove" inline />
          </li>)}</ul> : <p className="text-sm">No ports are forwarded yet.</p>}
        {unforwarded.length > 0 && <p className="text-sm">Listening, not forwarded: {unforwarded.join(", ")}.</p>}
        <ActionForm action={forwardPortAction} fields={fields} submitLabel="Forward port" inline>
          <Field label="Port" htmlFor="forward-port">
            <input id="forward-port" name="port" type="number" min={1} max={65535} required
              className={FIELD_CLASS} defaultValue={unforwarded[0]} />
          </Field>
          <Field label="Visibility" htmlFor="forward-visibility">
            <select id="forward-visibility" name="visibility" className={FIELD_CLASS} defaultValue="private">
              <option value="private">Only me</option>
              <option value="public">Public URL</option>
            </select>
          </Field>
          <Field label="Label" htmlFor="forward-label">
            <input id="forward-label" name="label" className={FIELD_CLASS} maxLength={64} />
          </Field>
        </ActionForm>
      </div>
    </Card>
    <Card title="Recent sessions">
      {sessions.length ? <ul className="space-y-2 text-sm">{sessions.map((session) =>
        <li key={session.id}>{formatTimestamp(session.startedAt.toISOString())} — {session.endReason ?? "open"}</li>
      )}</ul> : <p className="text-sm">No editor sessions yet.</p>}
    </Card>
    <Card title="Danger zone" description="Rebuilding preserves workspace files and editor data. Deleting removes the VM and all its snapshots.">
      <div className="flex flex-wrap gap-6">
        <ActionForm action={rebuildWorkspaceAction} fields={fields} submitLabel="Rebuild"
          confirm="Rebuild on the current base image? Your files will be archived and restored." inline />
        <ActionForm action={deleteWorkspaceAction} fields={fields} submitLabel="Delete workspace" variant="danger"
          confirm="Delete this workspace and all snapshots? Download any files you want to keep first. This cannot be undone." inline />
      </div>
    </Card>
    <AutoRefresh enabled={isBusyState(view.state)} />
  </div>;
}
