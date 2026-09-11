import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { ApiError, type RouteCtx } from "./api";
import { limit } from "./ratelimit";
import { originMatchesHost } from "./origin";
import { requireWorkspaceParam, type WorkspaceParams } from "./route-context";
import { sandboxApi, sandboxWsScheme } from "./sandbox";
import { loadSigningKeys } from "./tokens";

/** DAP and kernels share the same private, one-use sandbox byte tunnel. */
export async function connectSandboxProcess(req: Request, ctx: RouteCtx<WorkspaceParams>, readLaunch: () => Promise<string>): Promise<Response> {
  if (!originMatchesHost(req.headers) || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "cross_origin", "Start this session from the workspace.");
  }
  const { workspace, viewer } = await requireWorkspaceParam(ctx, { control: true, allowStates: ["running"] });
  await limit("user.process", viewer.userId);
  const launch = await readLaunch();
  if (Buffer.byteLength(launch) > 65_536) throw new ApiError(413, "too_large", "Launch configuration is too large.");
  const sandbox = await sandboxApi().get(workspace.sandboxName, { resume: false });
  if (!sandbox || sandbox.status !== "running") throw new ApiError(409, "not_running", "Start the workspace before launching a session.");
  const signing = await loadSigningKeys();
  const token = await new SignJWT({ ws: workspace.id, launch: createHash("sha256").update(launch).digest("hex") })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: signing.active.kid })
    .setIssuer(signing.issuer).setSubject(viewer.userId).setAudience(`${workspace.audience}/debug`)
    .setIssuedAt().setExpirationTime("2m").setJti(crypto.randomUUID()).sign(signing.active.privateKey);
  return Response.json({ launch, url: `${sandboxWsScheme()}://${new URL(sandbox.domain(8448)).host}/debug`, token }, { headers: { "Cache-Control": "private, no-store" } });
}
