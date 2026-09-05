import { and, eq } from "drizzle-orm";
import { ApiError, clientIp, handler, json, noContent, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { dbReady } from "@/lib/db";
import { isInfraPort, proxySlots } from "@/lib/env";
import { listeningPorts, publicForwardUrl } from "@/lib/lifecycle";
import { allocateSlot, privateForwardUrl } from "@/lib/ports";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { forwards, type Workspace } from "@/lib/schema";
import { createForwardInput, type ForwardView } from "@/lib/types";
import { forwardViews, toForwardView } from "@/lib/views";

export const runtime = "nodejs";

/**
 * `GET /api/workspaces/{id}/ports` – the forwards of a workspace, the ports the
 * last activity ping saw a process listening on, and how many of the four
 * private proxy slots are still free (D8).
 */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  const ports = await forwardViews(workspace.id);
  const used = ports.filter((forward) => forward.slot !== null).length;
  return json({
    ports,
    listening: await listeningPorts(workspace.id),
    slotsFree: Math.max(0, proxySlots().length - used),
  });
});

/**
 * `POST /api/workspaces/{id}/ports` – forwards a port.
 *
 * A private forward takes one of the four proxy slots and is reached through
 * the control plane's `/open` link, which redirects to the slot host's
 * `/__zs/auth` with a 10-minute bootstrap token (D8). A public forward gets the
 * sandbox's own `https://…` domain for that port and holds no slot.
 */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true, control: true });
  const input = await parseBody(req, createForwardInput);
  assertForwardable(input.port);

  const forward =
    input.visibility === "private"
      ? await upsertPrivateForward(workspace, input.port, input.label ?? null)
      : await upsertPublicForward(workspace, input.port, input.label ?? null);

  await audit({
    actorType: "user",
    actorId: viewer.userId,
    action: "port.forward",
    targetType: "workspace",
    targetId: workspace.id,
    metadata: { port: input.port, visibility: input.visibility, slot: forward.slot },
    ip: clientIp(req),
  });
  return json({ forward });
});

/**
 * `DELETE /api/workspaces/{id}/ports?port=N` – removes the forward and frees
 * its proxy slot. Removing a port that is not forwarded is a no-op.
 */
export const DELETE = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true, control: true });
  const raw = new URL(req.url).searchParams.get("port");
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "invalid_port", "A `port` query parameter is required");
  }
  const db = await dbReady();
  await db.delete(forwards).where(and(eq(forwards.workspaceId, workspace.id), eq(forwards.port, port)));
  await audit({
    actorType: "user",
    actorId: viewer.userId,
    action: "port.unforward",
    targetType: "workspace",
    targetId: workspace.id,
    metadata: { port },
    ip: clientIp(req),
  });
  return noContent();
});

/** Rejects the infrastructure ports (D21: `8443`-`8451` plus the configured set). */
function assertForwardable(port: number): void {
  if (isInfraPort(port)) {
    throw new ApiError(400, "infra_port", `Port ${port} is reserved by the platform`);
  }
}

/**
 * Allocates a slot and stores the forward in one transaction, so two parallel
 * requests can never hand out the same slot.
 */
async function upsertPrivateForward(workspace: Workspace, port: number, label: string | null): Promise<ForwardView> {
  const db = await dbReady();
  const url = privateForwardUrl(workspace.id, port);
  return db.transaction(async (tx) => {
    const slot = await allocateSlot(tx, workspace.id, port);
    const [row] = await tx
      .insert(forwards)
      .values({ workspaceId: workspace.id, port, visibility: "private", label, url, slot })
      .onConflictDoUpdate({
        target: [forwards.workspaceId, forwards.port],
        set: { visibility: "private", label, url, slot },
      })
      .returning();
    return toForwardView(row);
  });
}

/** Declares the port on the sandbox (when needed) and stores its public URL. */
async function upsertPublicForward(workspace: Workspace, port: number, label: string | null): Promise<ForwardView> {
  const url = await publicForwardUrl(workspace, port);
  const db = await dbReady();
  const [row] = await db
    .insert(forwards)
    .values({ workspaceId: workspace.id, port, visibility: "public", label, url, slot: null })
    .onConflictDoUpdate({
      target: [forwards.workspaceId, forwards.port],
      set: { visibility: "public", label, url, slot: null },
    })
    .returning();
  return toForwardView(row);
}
