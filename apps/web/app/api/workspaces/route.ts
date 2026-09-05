import { accepted, handler, idempotent, json, parseBody } from "@/lib/api";
import { requireViewer } from "@/lib/auth";
import { createPublicWorkspace } from "@/lib/create-workspace";
import { createWorkspaceInput } from "@/lib/types";
import { visibleWorkspaces, workspaceViews } from "@/lib/views";

export const runtime = "nodejs";

export const GET = handler(async () => {
  await requireViewer();
  const rows = await visibleWorkspaces();
  return json({ workspaces: await workspaceViews(rows) });
});

export const POST = handler(async (req) => {
  const viewer = await requireViewer();
  return idempotent(req, viewer.userId, async () =>
    accepted(await createPublicWorkspace(req, viewer, await parseBody(req, createWorkspaceInput))));
});
