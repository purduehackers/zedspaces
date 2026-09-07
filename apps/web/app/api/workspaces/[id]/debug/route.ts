import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { SignJWT } from "jose";
import { z } from "zod";
import { ApiError, handler, parseBody } from "@/lib/api";
import { isInfraPort } from "@/lib/env";
import { limit } from "@/lib/ratelimit";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { sandboxApi, sandboxWsScheme } from "@/lib/sandbox";
import { loadSigningKeys } from "@/lib/tokens";

export const runtime = "nodejs";
const text = z.string().refine(value => !value.includes("\0"));
const launchSchema = z.object({
  command: text.min(1).nullable(), arguments: z.array(text).max(512),
  envs: z.record(text, text).refine(value => Object.keys(value).length <= 1024), cwd: text.nullable(),
  connection: z.object({
    host: z.string().refine(value => isIP(value) !== 0 && (value === "127.0.0.1" || value === "::1")),
    port: z.number().int().min(1024).max(65535).refine(port => !isInfraPort(port)),
    timeout: z.number().int().nonnegative().nullable(),
  }).strict().nullable(),
}).strict().refine(value => value.command !== null || value.connection !== null);

/** A short-lived, one-use capability for exactly one adapter launch. */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "cross_origin", "Start debugging from this workspace.");
  }
  const { workspace, viewer } = await requireWorkspaceParam(ctx, { control: true, allowStates: ["running"] });
  await limit("user.debug", viewer.userId);
  const launch = await parseBody(req, z.string().max(65_536), { maxBytes: 262_144 });
  if (Buffer.byteLength(launch) > 65_536) throw new ApiError(413, "too_large", "Debug configuration is too large.");
  try { launchSchema.parse(JSON.parse(launch)); }
  catch { throw new ApiError(400, "invalid_debug_config", "Use a sandbox command or a loopback debug adapter connection."); }
  const sandbox = await sandboxApi().get(workspace.sandboxName, { resume: false });
  if (!sandbox || sandbox.status !== "running") throw new ApiError(409, "not_running", "Start the workspace before debugging.");
  const signing = await loadSigningKeys();
  const token = await new SignJWT({ ws: workspace.id, launch: createHash("sha256").update(launch).digest("hex") })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: signing.active.kid })
    .setIssuer(signing.issuer).setSubject(viewer.userId).setAudience(`${workspace.audience}/debug`)
    .setIssuedAt().setExpirationTime("2m").setJti(crypto.randomUUID()).sign(signing.active.privateKey);
  return Response.json({ url: `${sandboxWsScheme()}://${new URL(sandbox.domain(8448)).host}/debug`, token }, { headers: { "Cache-Control": "private, no-store" } });
});
