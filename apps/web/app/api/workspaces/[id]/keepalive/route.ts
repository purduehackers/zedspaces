import { handler, json } from "@/lib/api";
import { limit } from "@/lib/ratelimit";
import { keys, kv } from "@/lib/kv";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";

export const runtime = "nodejs";

/**
 * `POST /api/workspaces/{id}/keepalive` – the "Keep alive" button of the
 * `idle_stop_in` toast. Writes `zs:keepalive:<ws>` with the workspace's idle
 * budget as its TTL; the sweep and the activity directive both treat the key
 * as activity (b9 §3.25, §4.10).
 */
export const POST = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true, control: true });
  await limit("user.keepalive", viewer.userId);

  const now = Date.now();
  const ttlMs = workspace.idleMinutes * 60_000;
  await kv().set(keys.keepalive(workspace.id), String(now), { exMs: ttlMs });
  return json({ keptAliveUntil: new Date(now + ttlMs).toISOString() });
});
