import { handler, json, parseBody } from "@/lib/api";
import { ensureUser } from "@/lib/auth";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { MAX_DOC_BYTES, readDoc, writeDoc } from "@/lib/settings-docs";
import { putSettingsDocInput } from "@/lib/types";

export const runtime = "nodejs";

/**
 * The shared space's settings, read by the editor at boot.
 */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { viewer } = await requireWorkspaceParam(ctx);
  return json(await readDoc(viewer.userId, "settings"));
});

/** `PUT /api/workspaces/{id}/settings` – b7's `saveDocument("settings", …)` target; `409 version_conflict` on a stale version. */
export const PUT = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer } = await requireWorkspaceParam(ctx);
  await ensureUser(viewer);
  const input = await parseBody(req, putSettingsDocInput, { maxBytes: MAX_DOC_BYTES + 4096 });
  return json(await writeDoc(viewer.userId, "settings", input.content, input.version));
});
