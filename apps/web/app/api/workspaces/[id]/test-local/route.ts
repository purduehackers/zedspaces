import { z } from "zod";
import { ApiError, handler, json, parseBody } from "@/lib/api";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { repoOf } from "@/lib/shell";
import {
  describeLocalWorkspace,
  dropWorkspaceSocket,
  killWorkspaceSandbox,
  readWorkspaceFile,
  requireTestRoutes,
} from "@/lib/test-routes";

export const runtime = "nodejs";

/**
 * `GET|POST /api/workspaces/{id}/test-local` — test-only (`ZS_TEST_ROUTES=1`,
 * `ZS_SANDBOX_BACKEND=local`, never in a production build; `404` otherwise,
 * exactly like a route that does not exist). Owner or org admin, editor cookie
 * accepted. See `lib/test-routes.ts`.
 */
export const GET = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  requireTestRoutes();
  const { workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true, control: true });
  return json(await describeLocalWorkspace(workspace, await repoOf(workspace)));
});

const testLocalInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("drop_socket") }),
  z.object({ op: z.literal("kill_sandbox") }),
  z.object({ op: z.literal("read_file"), path: z.string().min(1).max(1024) }),
]);

export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  requireTestRoutes();
  const { workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true, control: true });
  const input = await parseBody(req, testLocalInput);
  switch (input.op) {
    case "drop_socket":
      return json(dropWorkspaceSocket(workspace));
    case "kill_sandbox":
      return json(await killWorkspaceSandbox(workspace));
    case "read_file": {
      const info = await describeLocalWorkspace(workspace, await repoOf(workspace));
      if (!info.workspaceDir) throw new ApiError(404, "not_found", "The workspace has no checkout");
      const file = readWorkspaceFile(info.workspaceDir, input.path);
      if (!file) throw new ApiError(404, "not_found", `${input.path} is not a file of the checkout`);
      return json(file);
    }
  }
});
