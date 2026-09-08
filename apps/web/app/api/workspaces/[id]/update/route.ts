import { z } from "zod";
import { accepted, ApiError, clientIp, handler, json, parseBody } from "@/lib/api";
import { audit } from "@/lib/audit";
import { sameRelease } from "@/lib/builds";
import { startLifecycle } from "@/lib/lifecycle";
import { currentRelease } from "@/lib/release";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";

export const runtime = "nodejs";
const updateInput = z.object({ imageRef: z.string(), serverBuild: z.string(), clientBuild: z.string() }).strict();

/** Discovery never starts or rebuilds a sandbox. */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { workspace } = await requireWorkspaceParam(ctx);
  const release = currentRelease();
  return json({ release, available: !sameRelease(workspace, release) });
});

/** Apply exactly the release the user finished downloading and chose to install. */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { control: true });
  const target = await parseBody(req, updateInput);
  const release = currentRelease();
  if (!sameRelease(target, release)) throw new ApiError(409, "release_changed", "A newer update is available; download it before restarting.");
  if (sameRelease(workspace, release) && !workspace.previousSandboxName) return json({ status: "updated" });
  const { runId } = await startLifecycle(workspace.id, "rebuildWorkspace", {
    workspaceId: workspace.id, userId: viewer.userId, upgrade: release,
  });
  await audit({ actorType: "user", actorId: viewer.userId, action: "workspace.update-editor",
    targetType: "workspace", targetId: workspace.id, ip: clientIp(req) });
  return accepted({ status: "upgrading", runId });
});
