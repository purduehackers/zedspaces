import { ApiError, handler, noContent, type RouteCtx } from "@/lib/api";
import { removeForward } from "@/lib/forwards";
import {
  assertSandboxName,
  requireSandboxNamed,
  type SandboxPortParams,
} from "@/lib/sandbox-request";

export const runtime = "nodejs";

/**
 * `DELETE /api/sandboxes/{name}/ports/{port}` – the server's `UnforwardPort`
 * relayed by the supervisor. Frees the private forward's proxy slot.
 */
export const DELETE = handler(async (req: Request, ctx: RouteCtx<SandboxPortParams>) => {
  const { name, port } = await ctx.params;
  const principal = await requireSandboxNamed(req, assertSandboxName(name), "sandbox.ports");
  const { workspace } = principal;
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ApiError(400, "invalid_port", `${port} is not a port number`);
  }
  await removeForward(workspace.id, parsed);
  return noContent();
});
