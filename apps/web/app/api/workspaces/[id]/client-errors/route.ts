import { accepted, handler, parseBody } from "@/lib/api";
import { shipToSink } from "@/lib/log-sink";
import { limit } from "@/lib/ratelimit";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { clientErrorInput } from "@/lib/types";

export const runtime = "nodejs";

/** Ceiling for one report: 4 KiB message + 64 KiB stack plus framing. */
const MAX_BODY_BYTES = 128 * 1024;

/**
 * `POST /api/workspaces/{id}/client-errors` – panics, boot failures, close
 * frames and performance marks from the wasm shell.
 *
 * The browser never learns the sandbox name, so the route resolves it and
 * ships the record to `ZS_LOG_SINK_URL`; without a sink it lands in the
 * platform log instead. Delivery is best effort and never fails the request.
 */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  await limit("user.client-errors", viewer.userId);
  const input = await parseBody(req, clientErrorInput, { maxBytes: MAX_BODY_BYTES });

  await shipToSink({
    kind: "client_error",
    workspaceId: workspace.id,
    sandboxName: workspace.sandboxName,
    build: input.build,
    payload: { ...input, source: "shell", userId: viewer.userId, ts: Date.now() },
  });
  return accepted({ received: true });
});
