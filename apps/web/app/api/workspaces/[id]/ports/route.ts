import { ApiError, clientIp, handler, json, noContent, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { proxySlots } from "@/lib/env";
import { createForward, removeForward } from "@/lib/forwards";
import { listeningPorts } from "@/lib/lifecycle";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { createForwardInput } from "@/lib/types";
import { forwardViews } from "@/lib/views";

export const runtime = "nodejs";

/** Current forwards, discovered listeners and remaining preview capacity. */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { workspace } = await requireWorkspaceParam(ctx);
  const ports = await forwardViews(workspace.id);
  const used = ports.filter((forward) => forward.slot !== null).length;
  return json({
    ports,
    listening: await listeningPorts(workspace.id),
    slotsFree: Math.max(0, proxySlots().length - used),
  });
});

/** Explicitly forward a port or change its visibility. */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });
  const input = await parseBody(req, createForwardInput);
  const forward = await createForward(workspace, input);

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
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });
  const raw = new URL(req.url).searchParams.get("port");
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "invalid_port", "A `port` query parameter is required");
  }
  await removeForward(workspace.id, port);
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
