import { accepted, ApiError, clientIp, handler, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { isRunActive, startLifecycle } from "@/lib/lifecycle";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { rebuildInput } from "@/lib/types";

export const runtime = "nodejs";

export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });
  await parseBody(req, rebuildInput);
  if (await isRunActive(workspace.workflowRunId)) {
    throw new ApiError(409, "workspace_busy", "A lifecycle run is in flight", { runId: workspace.workflowRunId });
  }
  const { runId } = await startLifecycle(workspace.id, "rebuildWorkspace", {
    workspaceId: workspace.id, userId: viewer.userId,
  });
  await audit({ actorType: "user", actorId: viewer.userId, action: "workspace.rebuild",
    targetType: "workspace", targetId: workspace.id, ip: clientIp(req) });
  return accepted({ runId });
});
