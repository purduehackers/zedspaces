import { handler, json, parseBody } from "@/lib/api";
import { ensureUser } from "@/lib/auth";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { MAX_DOC_BYTES, readDoc, writeDoc } from "@/lib/settings-docs";
import { putSettingsDocInput } from "@/lib/types";

export const runtime = "nodejs";

/**
 * `GET /api/workspaces/{id}/keymap` – the viewer's `keymap.json` for the
 * editor shell; accepts the `zs_editor` cookie like its `settings` sibling.
 */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { viewer } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  return json(await readDoc(viewer.userId, "keymap"));
});

/** `PUT /api/workspaces/{id}/keymap` – b7's `saveDocument("keymap", …)` target; `409 version_conflict` on a stale version. */
export const PUT = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  await ensureUser(viewer);
  const input = await parseBody(req, putSettingsDocInput, { maxBytes: MAX_DOC_BYTES + 4096 });
  return json(await writeDoc(viewer.userId, "keymap", input.content, input.version));
});
