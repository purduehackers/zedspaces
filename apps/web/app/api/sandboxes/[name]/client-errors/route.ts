import { accepted, handler, parseBody, type RouteCtx } from "@/lib/api";
import { shipToSink } from "@/lib/log-sink";
import { principalSubjectId } from "@/lib/sandbox-auth";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";
import { sandboxClientErrorInput } from "@/lib/types";

export const runtime = "nodejs";

/**
 * `POST /api/sandboxes/{name}/client-errors` – supervisor-originated crash and
 * boot reports (b9 §4.2). The browser posts to
 * `/api/workspaces/{id}/client-errors` instead, so this route only accepts a
 * sandbox bearer.
 */
export const POST = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  const principal = await requireSandboxParam(req, ctx, "sandbox.client-errors");
  const body = await parseBody(req, sandboxClientErrorInput, { maxBytes: 128 * 1024 });
  await shipToSink({
    kind: "client_error",
    workspaceId: principalSubjectId(principal),
    sandboxName: principal.sandboxName,
    build: body.build,
    payload: body,
  });
  return accepted({ accepted: true });
});
