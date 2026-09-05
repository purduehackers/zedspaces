import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { markLocalWorkspacesStopped } from "@/lib/dev-local-admin";
import { sessions, workspaces } from "@/lib/schema";
import { routeDb, SEED, seedWorkspace } from "./helpers/route-db";

/** `scripts/dev-local.sh stop`'s database fallback (`scripts/dev-local-db.ts mark-stopped`). */
describe("markLocalWorkspacesStopped", () => {
  let db: Awaited<ReturnType<typeof routeDb>>;

  beforeEach(async () => {
    db = await routeDb();
  });

  it("marks every live row stopped, clears its hosts and run, and closes its session", async () => {
    const running = await seedWorkspace(db, {
      state: "running",
      currentWsHost: "h:1",
      currentHealthHost: "h:2",
      supervisorCmdId: "cmd",
      workflowRunId: "run_dead",
      workflowRunStartedAt: new Date(),
    });
    const creating = await seedWorkspace(db, { state: "creating", stateReason: "boot:clone", workflowRunId: "run_x" });
    const stopped = await seedWorkspace(db, { state: "stopped", stateReason: "user" });
    const errored = await seedWorkspace(db, { state: "error", stateReason: "supervisor_exit:3" });
    const deleted = await seedWorkspace(db, { state: "running", deletedAt: new Date() });
    await db.insert(sessions).values({
      id: "ses_live",
      workspaceId: running.id,
      userId: SEED.userId,
      sandboxGeneration: 1,
      holderTabId: "tab-x",
      wsHost: "h:1",
    });

    const changed = await markLocalWorkspacesStopped(db);
    expect(changed.map((row) => `${row.id}:${row.from}`).sort()).toEqual([`${creating.id}:creating`, `${running.id}:running`].sort());

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, running.id));
    expect(row.state).toBe("stopped");
    expect(row.stateReason).toBe("stopped:dev-local");
    expect(row.currentWsHost).toBeNull();
    expect(row.currentHealthHost).toBeNull();
    expect(row.supervisorCmdId).toBeNull();
    expect(row.workflowRunId).toBeNull();
    expect(row.lastStoppedAt).not.toBeNull();
    const open = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, running.id), isNull(sessions.endedAt)));
    expect(open).toEqual([]);

    const untouched = await db
      .select({ id: workspaces.id, state: workspaces.state, reason: workspaces.stateReason })
      .from(workspaces)
      .where(eq(workspaces.id, stopped.id));
    expect(untouched[0]).toEqual({ id: stopped.id, state: "stopped", reason: "user" });
    const [err] = await db.select().from(workspaces).where(eq(workspaces.id, errored.id));
    expect(err.state).toBe("error");
    const [gone] = await db.select().from(workspaces).where(eq(workspaces.id, deleted.id));
    expect(gone.state).toBe("running");
  });

  it("is a no-op when nothing is live", async () => {
    await seedWorkspace(db, { state: "stopped" });
    expect(await markLocalWorkspacesStopped(db)).toEqual([]);
  });
});
