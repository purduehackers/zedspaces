import { eq } from "drizzle-orm";
import { accepted, ApiError, handler, json, parseBody } from "@/lib/api";
import {
  buildsCompatible,
  detectDeadSandbox,
  markWorkspaceLost,
  mintConnectInfo,
  openOrReuseSession,
  reloadWorkspace,
} from "@/lib/connect";
import { dbReady } from "@/lib/db";
import { isRunActive, startLifecycle } from "@/lib/lifecycle";
import { limit } from "@/lib/ratelimit";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { users, type Workspace } from "@/lib/schema";
import { connectInput, type HealthProbe } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/** States from which `/connect` can never mint a token right away. */
const BUSY_STATES: ReadonlyArray<Workspace["state"]> = ["creating", "stopping", "rebuilding", "deleting"];

/** How long the route waits for a resume before answering `202`, within `maxDuration`. */
const RESUME_WAIT_MS = 45_000;
const RESUME_POLL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `POST /api/workspaces/{id}/connect` – the only route that mints an rpc
 * session token (D26).
 *
 * `200 ConnectInfo` on the fast path (running, no run in flight, supervisor
 * healthy); `202 { status: "resuming", runId }` while `connectWorkspace` boots
 * a stopped workspace; `409 workspace_stopped` when a *reconnecting* tab finds
 * the workspace stopped — an idle stop must end at "stopped, click to resume"
 * and never resume itself (Appendix B; D2 turns this into
 * `RefreshError::Stopped`).
 *
 * A `running` row whose sandbox is gone (`detectDeadSandbox`: the backend
 * reports it not running, or its supervisor never answers) is reconciled to
 * `stopped` first and then handled like any stopped workspace: an explicit
 * open resumes it, a reconnect gets `409 workspace_stopped`. Without this the
 * route answered `500 sandbox_unhealthy` for ever.
 */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  // Connecting attaches to the VM (terminals, files, secrets): owner or org admin only.
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true, control: true });
  await limit("user.connect", viewer.userId);
  const input = await parseBody(req, connectInput);

  if (input.clientBuild && !buildsCompatible(input.clientBuild, workspace.clientBuild)) {
    throw new ApiError(409, "client_build_mismatch", "Reload to pick up the matching editor bundle", {
      serverBuild: workspace.serverBuild,
      clientBuild: workspace.clientBuild,
    });
  }

  // A lifecycle run in flight always wins: a session-cap restart must answer
  // 423 (retry) to a reconnecting tab, never 409 workspace_stopped.
  if (await isRunActive(workspace.workflowRunId)) {
    throw new ApiError(423, "workspace_busy", "A lifecycle run is in flight", { runId: workspace.workflowRunId });
  }
  if (BUSY_STATES.includes(workspace.state)) {
    throw new ApiError(423, "workspace_busy", `Workspace is ${workspace.state}`, { state: workspace.state });
  }

  let live = workspace;
  let probe: HealthProbe | null = null;
  if (live.state === "running") {
    const liveness = await detectDeadSandbox(live);
    if (liveness.kind === "alive") probe = liveness.probe;
    else if (liveness.kind === "unhealthy") throw unhealthy(liveness.probe);
    else live = await markWorkspaceLost(live, liveness.reason);
  }

  // `error` is treated like `stopped`: an explicit open may retry the boot,
  // a reconnect may not.
  if (live.state !== "running") {
    if (input.reason === "reconnect") {
      throw new ApiError(409, "workspace_stopped", "The workspace is stopped");
    }
    await assertOwnerNotFlagged(live);
    const resumed = await resume(live, viewer.userId);
    if (!resumed.workspace) return accepted({ status: "resuming", runId: resumed.runId });
    live = resumed.workspace;
    const liveness = await detectDeadSandbox(live);
    if (liveness.kind === "unhealthy") throw unhealthy(liveness.probe);
    if (liveness.kind === "dead") {
      throw new ApiError(500, "sandbox_unhealthy", `The workspace server is not answering after the resume (${liveness.reason})`);
    }
    probe = liveness.probe;
  }

  return connectRunning(live, probe, viewer.userId, input.tabId, input.clientBuild ?? null);
});

/** The supervisor answers but is not ready: the sandbox is alive, the client retries. */
function unhealthy(probe: HealthProbe): ApiError {
  return new ApiError(500, "sandbox_unhealthy", "The workspace server is not answering", {
    status: probe.status,
    phase: probe.phase,
    serverRunning: probe.serverRunning,
  });
}

/** A flagged owner's workspace is never resumed, whoever asks (§7.11). */
async function assertOwnerNotFlagged(workspace: Workspace): Promise<void> {
  const db = await dbReady();
  const [owner] = await db
    .select({ flaggedAt: users.flaggedAt })
    .from(users)
    .where(eq(users.id, workspace.ownerUserId))
    .limit(1);
  if (owner?.flaggedAt) {
    throw new ApiError(403, "account_flagged", "The workspace owner's account is flagged; the workspace stays stopped");
  }
}

/**
 * Starts `connectWorkspace` and waits for the row to reach `running`.
 * Resolves with `workspace: null` when the run is still going, which the
 * caller turns into `202 { status: "resuming", runId }`.
 */
async function resume(
  workspace: Workspace,
  userId: string,
): Promise<{ runId: string; workspace: Workspace | null }> {
  const { runId } = await startLifecycle(workspace.id, "connectWorkspace", {
    workspaceId: workspace.id,
    userId,
  });
  const deadline = Date.now() + RESUME_WAIT_MS;
  for (;;) {
    const current = await reloadWorkspace(workspace.id);
    if (current && current.state === "running" && !current.workflowRunId) {
      return { runId, workspace: current };
    }
    if (Date.now() >= deadline) return { runId, workspace: null };
    await sleep(RESUME_POLL_MS);
  }
}

/** The fast path: the supervisor already probed healthy, arbitrate the session, mint the token. */
async function connectRunning(
  workspace: Workspace,
  probe: HealthProbe | null,
  userId: string,
  tabId: string,
  clientBuild: string | null,
): Promise<Response> {
  const host = workspace.currentWsHost;
  if (!host || !probe?.ready) {
    throw new ApiError(500, "sandbox_unhealthy", "The workspace has no live sandbox session");
  }

  const session = await openOrReuseSession(workspace, {
    userId,
    tabId,
    host,
    clientBuild,
    serverBuild: probe.build ?? workspace.serverBuild,
  });
  return json(await mintConnectInfo(workspace, session));
}
