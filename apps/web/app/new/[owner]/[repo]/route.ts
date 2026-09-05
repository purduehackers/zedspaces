import { ApiError, handler } from "@/lib/api";
import { requireViewer } from "@/lib/auth";
import { createPublicWorkspace } from "@/lib/create-workspace";
import { githubOwner, githubName } from "@/lib/github-repo";
import { controlPlaneUrl } from "@/lib/env";
import { createWorkspaceInput } from "@/lib/types";

export const runtime = "nodejs";

/** An intentional navigation creates one workspace. HEAD/prefetch/subresources never do. */
export const GET = handler<Request, { owner: string; repo: string }>(async (req, ctx) => {
  const purpose = req.headers.get("purpose") ?? req.headers.get("sec-purpose") ?? "";
  const dest = req.headers.get("sec-fetch-dest");
  if (/prefetch/i.test(purpose) || req.headers.has("next-router-prefetch") || req.headers.has("rsc") || (dest && dest !== "document")) {
    throw new ApiError(400, "navigation_required", "Open this link directly to create a workspace");
  }
  const params = await ctx.params;
  const owner = githubOwner.safeParse(params.owner);
  const name = githubName.safeParse(params.repo);
  if (!owner.success || !name.success) throw new ApiError(400, "invalid_repo", "Invalid GitHub repository");
  const branch = new URL(req.url).searchParams.get("branch");
  const input = createWorkspaceInput.safeParse({ repo: { owner: owner.data, name: name.data }, ...(branch ? { ref: { branch } } : {}) });
  if (!input.success) throw new ApiError(400, "invalid_ref", "Invalid branch");
  const result = await createPublicWorkspace(req, await requireViewer(), input.data);
  return Response.redirect(new URL(`/w/${result.workspace.id}`, controlPlaneUrl()), 303);
});

export function HEAD(): Response { return new Response(null, { status: 405, headers: { Allow: "GET" } }); }
