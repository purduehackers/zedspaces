/**
 * Creating and removing port forwards (b9 §4.2, D8). Both the dashboard and
 * the supervisor's `POST /api/sandboxes/{name}/ports` land here, so the slot
 * allocation and the URL shape are defined once.
 */
import { and, eq } from "drizzle-orm";
import { ApiError } from "./api";
import { dbReady } from "./db";
import { isInfraPort } from "./env";
import { publicForwardUrl } from "./lifecycle";
import { allocateSlot, privateForwardUrl } from "./ports";
import { forwards, type PortVisibility, type Workspace } from "./schema";
import type { ForwardView } from "./types";
import { toForwardView } from "./views";

/** What {@link createForward} needs. */
export interface CreateForwardRequest {
  port: number;
  visibility: PortVisibility;
  label?: string | null;
}

function assertForwardablePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "invalid_port", `${port} is not a port number`);
  }
  if (isInfraPort(port)) {
    throw new ApiError(400, "infra_port", `Port ${port} is reserved by the platform`);
  }
}

/**
 * Adds (or updates) a forward.
 *
 * A private forward takes one of the four proxy slots inside the insert
 * transaction and is reached through the control plane's `/open` link; a
 * public forward is a Vercel Sandbox route and gets its `https://…` URL, which
 * requires a running sandbox when the port is outside the declared pool.
 */
export async function createForward(
  workspace: Workspace,
  request: CreateForwardRequest,
): Promise<ForwardView> {
  assertForwardablePort(request.port);
  const db = await dbReady();
  const label = request.label ?? null;

  if (request.visibility === "private") {
    return db.transaction(async (tx) => {
      const slot = await allocateSlot(tx, workspace.id, request.port);
      const url = privateForwardUrl(workspace.id, request.port);
      const [row] = await tx
        .insert(forwards)
        .values({ workspaceId: workspace.id, port: request.port, visibility: "private", label, url, slot })
        .onConflictDoUpdate({
          target: [forwards.workspaceId, forwards.port],
          set: { visibility: "private", label, url, slot },
        })
        .returning();
      return toForwardView(row);
    });
  }

  const url = workspace.state === "running" ? await publicForwardUrl(workspace, request.port) : null;
  const [row] = await db
    .insert(forwards)
    .values({ workspaceId: workspace.id, port: request.port, visibility: "public", label, url, slot: null })
    .onConflictDoUpdate({
      target: [forwards.workspaceId, forwards.port],
      set: { visibility: "public", label, url, slot: null },
    })
    .returning();
  return toForwardView(row);
}

/** Removes a forward and frees its slot. Removing a missing forward is success. */
export async function removeForward(workspaceId: string, port: number): Promise<void> {
  const db = await dbReady();
  await db.delete(forwards).where(and(eq(forwards.workspaceId, workspaceId), eq(forwards.port, port)));
}
