import { and, inArray, isNull } from "drizzle-orm";
import { closeOpenSession } from "./connect";
import { type Db } from "./db";
import { workspaces, type WorkspaceState } from "./schema";

/**
 * What `scripts/dev-local.sh stop` does to the database once every local
 * sandbox process is gone and `next dev` is down (`scripts/dev-local-db.ts`).
 * With the control plane stopped there is nothing left to stop a workspace
 * through the API, and a row left `running` (or mid-lifecycle) over a dead
 * sandbox is exactly what `/connect`'s reconciliation has to recover from on
 * the next start; marking the rows here keeps the next `dev` honest from its
 * first request.
 */

/** States a workspace can be left in when its sandbox processes were killed underneath it. */
export const LIVE_STATES: readonly WorkspaceState[] = ["creating", "running", "stopping", "rebuilding"];

/** One row {@link markLocalWorkspacesStopped} changed. */
export interface MarkedStopped {
  id: string;
  from: WorkspaceState;
}

/**
 * Marks every live, non-deleted workspace `stopped` (`state_reason:
 * stopped:dev-local`), clears its hosts and its in-flight run id (the run died
 * with the server), and closes its open session. Returns what changed.
 */
export async function markLocalWorkspacesStopped(db: Db): Promise<MarkedStopped[]> {
  const rows = await db
    .select({ id: workspaces.id, state: workspaces.state })
    .from(workspaces)
    .where(and(inArray(workspaces.state, [...LIVE_STATES]), isNull(workspaces.deletedAt)));
  const now = new Date();
  const changed: MarkedStopped[] = [];
  for (const row of rows) {
    await db
      .update(workspaces)
      .set({
        state: "stopped",
        stateReason: "stopped:dev-local",
        lastStoppedAt: now,
        currentWsHost: null,
        currentSlotHosts: null,
        currentHealthHost: null,
        supervisorCmdId: null,
        sandboxExpiresAt: null,
        workflowRunId: null,
        workflowRunStartedAt: null,
        updatedAt: now,
      })
      .where(and(inArray(workspaces.id, [row.id]), inArray(workspaces.state, [...LIVE_STATES])));
    await closeOpenSession(row.id, "dev_local_stop");
    changed.push({ id: row.id, from: row.state });
  }
  return changed;
}
