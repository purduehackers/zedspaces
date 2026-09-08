import { accepted, clientIp, handler, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { isRunActive, startLifecycle } from "@/lib/lifecycle";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";

export const runtime = "nodejs";

/**
 * `POST /api/workspaces/{id}/stop` – starts `stopWorkspace` with reason
 * `"user"`. Answers `200 { state: "stopped" }` when there is nothing to stop,
 * so the shell's Stop button is idempotent.
 */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });

  if (workspace.state === "stopped" && !(await isRunActive(workspace.workflowRunId))) {
    return json({ state: "stopped" });
  }

  const { runId } = await startLifecycle(workspace.id, "stopWorkspace", {
    workspaceId: workspace.id,
    reason: "user",
  });
  await audit({
    actorType: "user",
    actorId: viewer.userId,
    action: "workspace.stop",
    targetType: "workspace",
    targetId: workspace.id,
    metadata: { reason: "user" },
    ip: clientIp(req),
  });
  return accepted({ runId });
});
