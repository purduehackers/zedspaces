import { handler, json, parseBody } from "@/lib/api";
import { ensureUser } from "@/lib/auth";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { MAX_DOC_BYTES, readDoc, writeDoc } from "@/lib/settings-docs";
import { putSettingsDocInput } from "@/lib/types";

export const runtime = "nodejs";

/**
 * `GET /api/workspaces/{id}/settings` – the viewer's `settings.json`, as the
 * editor shell reads it at boot. The document is per user, not per workspace;
 * the workspace-scoped path exists so the `zs_editor` cookie (path-scoped to
 * `/api/workspaces/<id>`) authenticates the call after Clerk's 60 s token has
 * expired (b9 §3.8, CONTRACTS.md §8.2 "Clerk or cookie").
 */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { viewer } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  return json(await readDoc(viewer.userId, "settings"));
});

/** `PUT /api/workspaces/{id}/settings` – b7's `saveDocument("settings", …)` target; `409 version_conflict` on a stale version. */
export const PUT = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  await ensureUser(viewer);
  const input = await parseBody(req, putSettingsDocInput, { maxBytes: MAX_DOC_BYTES + 4096 });
  return json(await writeDoc(viewer.userId, "settings", input.content, input.version));
});
