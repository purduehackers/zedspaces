import { ApiError, type RouteCtx } from "./api";
import { assertNotFlagged, requireViewer, requireWorkspaceAccess, type Viewer } from "./auth";
import { isInfraPort } from "./env";
import { WORKSPACE_ID_RE } from "./ids";
import type { Workspace, WorkspaceState } from "./schema";

/** Shared parameter handling for the workspace-scoped route handlers (b9 §4.2). */

/** Params of every `/api/workspaces/[id]/…` route. */
export interface WorkspaceParams {
  id: string;
}

/** Params of `/api/workspaces/[id]/ports/[port]/…`. */
export interface PortParams extends WorkspaceParams {
  port: string;
}

/** Validates a workspace id; a malformed id is `404 not_found`, never `400`. */
export function assertWorkspaceId(id: string): string {
  if (!WORKSPACE_ID_RE.test(id)) throw new ApiError(404, "not_found", "Workspace not found");
  return id;
}

/** Parses a `[port]` path segment into a port a user may forward. */
export function assertUserPort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "invalid_port", `${raw} is not a port number`);
  }
  if (isInfraPort(port)) {
    throw new ApiError(400, "infra_port", `Port ${port} is reserved by the platform`);
  }
  return port;
}

/**
 * Resolves the shared viewer and workspace. `control` enforces the abuse flag
 * on mutations and VM access; it does not imply private ownership.
 */
export async function requireWorkspaceParam(
  ctx: RouteCtx<WorkspaceParams>,
  opts?: { allowStates?: WorkspaceState[]; control?: boolean },
): Promise<{ viewer: Viewer; workspace: Workspace }> {
  const { id } = await ctx.params;
  const workspaceId = assertWorkspaceId(id);
  const viewer = await requireViewer();
  if (opts?.control) assertNotFlagged(viewer);
  const workspace = await requireWorkspaceAccess(viewer, workspaceId, {
    allowStates: opts?.allowStates,
    control: opts?.control,
  });
  return { viewer, workspace };
}
