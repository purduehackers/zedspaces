import { and, eq } from "drizzle-orm";
import { ApiError, handler } from "@/lib/api";
import { requireViewer, requireWorkspaceAccess } from "@/lib/auth";
import { dbReady } from "@/lib/db";
import { mintPortBootstrapToken } from "@/lib/port-token";
import { authRedirect, slotHost } from "@/lib/ports";
import { assertUserPort, assertWorkspaceId, type PortParams } from "@/lib/route-context";
import { forwards } from "@/lib/schema";

export const runtime = "nodejs";

/**
 * `GET /api/workspaces/{id}/ports/{port}/open` – the link the dashboard and the
 * editor show for a private forward.
 *
 * It answers `303` to `https://<slot-host>/__zs/auth?zs_port_token=<jwt>&next=/`
 * (D8). The token is an ES256 JWT with `sid = "port:<port>"` and
 * `aud = "<audience>/ports"` — a distinct audience, so `serve`'s `/rpc`
 * verifier can never accept it — which the supervisor's proxy exchanges for
 * its own `zs_port_session` cookie on that slot host.
 *
 * This is a browser navigation, so it authenticates with the Clerk session
 * only: the editor cookie is scoped to `/api/workspaces/<id>` and would be
 * sent here, but a top-level navigation from a foreign site must not be able
 * to mint a port token, and `SameSite=Strict` plus the Clerk check keep that
 * closed.
 */
export const GET = handler<Request, PortParams>(async (_req, ctx) => {
  const params = await ctx.params;
  const workspaceId = assertWorkspaceId(params.id);
  const port = assertUserPort(params.port);

  const viewer = await requireViewer();
  const workspace = await requireWorkspaceAccess(viewer, workspaceId, { control: true });

  const db = await dbReady();
  const [forward] = await db
    .select()
    .from(forwards)
    .where(and(eq(forwards.workspaceId, workspaceId), eq(forwards.port, port)))
    .limit(1);
  if (!forward || forward.visibility !== "private" || forward.slot === null) {
    throw new ApiError(404, "not_found", `Port ${port} is not forwarded privately`);
  }

  const host = slotHost(workspace, forward.slot);
  if (!host || workspace.state !== "running") {
    throw new ApiError(409, "workspace_not_running", "Start the workspace to open a forwarded port");
  }

  const { token } = await mintPortBootstrapToken({
    userId: viewer.userId,
    workspaceId,
    audience: workspace.audience,
    port,
  });
  return new Response(null, { status: 303, headers: { location: authRedirect(host, token), "cache-control": "no-store" } });
});
