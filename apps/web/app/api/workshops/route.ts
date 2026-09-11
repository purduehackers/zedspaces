import { accepted, handler, parseBody } from "@/lib/api";
import { requireViewer } from "@/lib/auth";
import { createPublicWorkspace } from "@/lib/create-workspace";
import { workshopInput, workshopKey, workspaceInput } from "@/lib/workshop";

export const runtime = "nodejs";
export const POST = handler(async (req) => {
  const viewer = await requireViewer();
  const workshop = await parseBody(req, workshopInput);
  return accepted(await createPublicWorkspace(req, viewer, workspaceInput(workshop), workshopKey(workshop)));
});
