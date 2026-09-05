import { ApiError, handler, json, parseBody, type RouteCtx } from "@/lib/api";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";
import { gitTokenInput, type GitTokenResponse } from "@/lib/types";

export const runtime = "nodejs";

/** Public clones need no forge credentials. Still authenticate and rate-limit the VM. */
export const POST = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  await requireSandboxParam(req, ctx, "sandbox.git-token");
  const body = await parseBody(req, gitTokenInput, { maxBytes: 8 * 1024 });
  if (body.host && body.host.toLowerCase() !== "github.com") {
    throw new ApiError(404, "host_unsupported", "Only public github.com repositories are supported");
  }
  const response: GitTokenResponse = {
    username: "", token: "", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  return json(response);
});
