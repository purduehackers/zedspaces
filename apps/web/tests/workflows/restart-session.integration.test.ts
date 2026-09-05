import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { dbReady } from "@/lib/db";
import { portPool, proxySlots } from "@/lib/env";
import { workspaces } from "@/lib/schema";
import { restartSession } from "@/workflows/restart-session";
import { fakeSandbox, health } from "../helpers/fake-sandbox";
import { insertWorkspace, seedFixtures } from "../helpers/routes";
import { healthHostOf } from "../helpers/workflow";

/**
 * `restartSession` through the real Workflow runtime (b9 §6.6
 * `restart_session_keeps_run_id`): the stop and the resume are child runs of
 * one parent, so `workflow_run_id` stays set until the workspace is running
 * again on a fresh VM session.
 */
describe("restartSession (workflow runtime)", () => {
  beforeEach(async () => {
    await seedFixtures();
  });

  it("stops and resumes inside one run and ends running with a fresh session", async () => {
    const workspace = await insertWorkspace({ sessionStartedAt: new Date(Date.now() - 23 * 3600_000) });
    fakeSandbox().seedSandbox(workspace.sandboxName, {
      status: "running",
      ports: [8443, ...proxySlots(), 8448, ...portPool()],
    });
    fakeSandbox().setHealth(healthHostOf(workspace.sandboxName), [
      health(),
      health({ status: "stopping", serverRunning: false }),
      health(),
    ]);
    const db = await dbReady();
    const run = await start(restartSession, [{ workspaceId: workspace.id }]);
    // The parent's id is what the route layer records; it must survive both children.
    await db
      .update(workspaces)
      .set({ workflowRunId: run.runId, workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    await expect(run.returnValue).resolves.toEqual({ ok: true });

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.state).toBe("running");
    expect(row.workflowRunId).toBeNull();
    expect(row.currentWsHost).toBe(`${workspace.sandboxName}-8443.fake.vercel.run`);
    expect(row.sessionStartedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const methods = fakeSandbox().calls.map((call) => call.method);
    expect(methods.indexOf("stop")).toBeLessThan(methods.lastIndexOf("runDetached"));
  });
});
