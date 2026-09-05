import { handler, json, noContent, parseBody, type RouteCtx } from "@/lib/api";
import { createForward, removeForward } from "@/lib/forwards";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";
import { sandboxPortInput, type SandboxPortResponse } from "@/lib/types";

export const runtime = "nodejs";

/**
 * `POST /api/sandboxes/{name}/ports` – the server's `ForwardPort` relayed by
 * the supervisor (b9 §4.2). `action: "unforward"` behaves exactly like
 * `DELETE …/ports/{port}` and answers 204; a private forward allocates one of
 * the four proxy slots and answers `409 no_free_slot` when all four are held.
 */
export const POST = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  const principal = await requireSandboxParam(req, ctx, "sandbox.ports");
  const { workspace } = principal;
  const body = await parseBody(req, sandboxPortInput, { maxBytes: 8 * 1024 });
  if (body.action === "unforward") {
    await removeForward(workspace.id, body.port);
    return noContent();
  }
  const forward = await createForward(workspace, {
    port: body.port,
    visibility: body.visibility,
    label: body.label ?? null,
  });
  const response: SandboxPortResponse = {
    url: forward.url,
    visibility: forward.visibility,
    slot: forward.slot,
  };
  return json(response);
});
