import { ApiError, clientIp, handler, parseBody } from "@/lib/api";
import { callIceServers } from "@/lib/call-ice";
import { callRequestSchema, exchangeCall } from "@/lib/call-room";
import { limit } from "@/lib/ratelimit";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";

export const runtime = "nodejs";
export const maxDuration = 20;

export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  if (req.headers.get("origin") !== new URL(req.url).origin || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "cross_origin", "Join calls from the workspace page.");
  }
  const request = await parseBody(req, callRequestSchema, { maxBytes: 262_144 });
  if (request.op === "join") await limit("user.call.join", clientIp(req) ?? "unknown");
  const { workspace } = await requireWorkspaceParam(ctx, { control: true, allowStates: request.op === "leave" ? undefined : ["running"] });
  const reply = await exchangeCall(workspace.id, request);
  if (request.op === "join") reply.iceServers = await callIceServers();
  return Response.json(reply, { headers: { "Cache-Control": "private, no-store" } });
});
