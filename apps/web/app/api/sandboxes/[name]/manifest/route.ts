import { handler, json, type RouteCtx } from "@/lib/api";
import { buildManifest } from "@/lib/manifest";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";

export const runtime = "nodejs";

/**
 * `GET /api/sandboxes/{name}/manifest` – the boot document `zs-agent` fetches
 * (b9 §4.7). Names only: secret values reach the sandbox as the supervisor's
 * `runCommand` environment, never through this route.
 */
export const GET = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  const principal = await requireSandboxParam(req, ctx, "sandbox.manifest");
  return json(await buildManifest(principal));
});
