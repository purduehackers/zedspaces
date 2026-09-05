import { eq } from "drizzle-orm";
import { accepted, ApiError, clientIp, handler, json, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { dbReady } from "@/lib/db";
import { isRunActive, startLifecycle } from "@/lib/lifecycle";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { workspaces } from "@/lib/schema";
import { patchWorkspaceInput } from "@/lib/types";
import { workspaceView } from "@/lib/views";

export const runtime = "nodejs";

/**
 * `GET /api/workspaces/{id}` – the shell polls this while a resume runs, so
 * the editor cookie is accepted here as well as a Clerk session.
 */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  return json({ workspace: await workspaceView(workspace) });
});

/** `PATCH /api/workspaces/{id}` – rename, or change the idle timeout (owner or org admin). */
export const PATCH = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });
  const input = await parseBody(req, patchWorkspaceInput);
  const db = await dbReady();

  const patch: { name?: string; idleMinutes?: number; updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.idleMinutes !== undefined) {
    patch.idleMinutes = input.idleMinutes;
  }

  const [updated] = await db.update(workspaces).set(patch).where(eq(workspaces.id, workspace.id)).returning();
  await audit({
    actorType: "user",
    actorId: viewer.userId,
    action: "workspace.update",
    targetType: "workspace",
    targetId: workspace.id,
    metadata: { name: patch.name ?? null, idleMinutes: patch.idleMinutes ?? null },
    ip: clientIp(req),
  });
  return json({ workspace: await workspaceView(updated) });
});

/**
 * `DELETE /api/workspaces/{id}` – starts `deleteWorkspace` (owner or org
 * admin). Only a run that is still pending or running blocks with
 * `409 workspace_busy`; a terminal run no longer bricks the row (b9 §3.20).
 */
export const DELETE = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });
  if (await isRunActive(workspace.workflowRunId)) {
    throw new ApiError(409, "workspace_busy", "A lifecycle run is in flight", { runId: workspace.workflowRunId });
  }
  const { runId } = await startLifecycle(workspace.id, "deleteWorkspace", {
    workspaceId: workspace.id,
    userId: viewer.userId,
  });
  await audit({
    actorType: "user",
    actorId: viewer.userId,
    action: "workspace.delete",
    targetType: "workspace",
    targetId: workspace.id,
    ip: clientIp(req),
  });
  return accepted({ runId });
});
