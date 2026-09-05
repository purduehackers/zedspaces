import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { dbReady } from "@/lib/db";
import { forwards, sessions, workspaces } from "@/lib/schema";
import { stopWorkspace } from "@/workflows/stop-workspace";
import { fakeSandbox, health } from "../helpers/fake-sandbox";
import { insertWorkspace, openEditorSession, seedFixtures } from "../helpers/routes";

/**
 * `stopWorkspace` through the real Workflow runtime (b9 §6.6
 * `stop_records_ledger_idempotently`, `stop_without_cmd_id_polls_health`).
 * Fakes are selected by the environment: the workflow and step bundles are
 * separate module instances, so `vi.mock` cannot reach them.
 */
describe("stopWorkspace (workflow runtime)", () => {
  beforeEach(async () => {
    await seedFixtures();
  });

  it("signals the supervisor, waits on its exit, closes the session and keeps the forwards", async () => {
    const workspace = await insertWorkspace({ sessionStartedAt: new Date(Date.now() - 10 * 60_000) });
    await openEditorSession(workspace);
    fakeSandbox().seedSandbox(workspace.sandboxName, { status: "running", ports: [8443, 8448] });
    const { sandboxApi } = await import("@/lib/sandbox");
    const handle = await sandboxApi().get(workspace.sandboxName, { resume: false });
    const supervisor = await handle!.runDetached({ cmd: "zs-agent", args: ["start"] });
    fakeSandbox().exitCommand(supervisor.cmdId, 0);
    fakeSandbox().setUsage(workspace.sandboxName, { activeCpuDurationMs: 600_000, ingressBytes: 0, egressBytes: 5e8 });
    const db = await dbReady();
    await db.update(workspaces).set({ supervisorCmdId: supervisor.cmdId }).where(eq(workspaces.id, workspace.id));
    await db.insert(forwards).values({
      workspaceId: workspace.id,
      port: 3000,
      visibility: "private",
      label: "web",
      url: "https://zs.test/api/workspaces/x/ports/3000/open",
      slot: 8444,
    });

    const run = await start(stopWorkspace, [{ workspaceId: workspace.id, reason: "user" }]);
    await expect(run.returnValue).resolves.toEqual({ stopped: true });

    const order = fakeSandbox().calls.map((call) => call.method);
    expect(order.indexOf("killCommand")).toBeLessThan(order.indexOf("stop"));
    expect(order.indexOf("waitCommand")).toBeLessThan(order.indexOf("stop"));
    const [session] = await db.select().from(sessions).where(eq(sessions.workspaceId, workspace.id));
    expect(session.endedAt).toBeInstanceOf(Date);
    expect(session.endReason).toBe("user");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.state).toBe("stopped");
    expect(row.workflowRunId).toBeNull();
    expect(row.snapshotSizeBytes).toBe(32_000_000);
    const surviving = await db.select().from(forwards).where(eq(forwards.workspaceId, workspace.id));
    expect(surviving[0]?.slot).toBe(8444);
  });

  it("polls the supervisor's health when no command id is known", async () => {
    const workspace = await insertWorkspace({ supervisorCmdId: null });
    await openEditorSession(workspace);
    fakeSandbox().seedSandbox(workspace.sandboxName, { status: "running", ports: [8443, 8448] });
    fakeSandbox().setHealth(workspace.currentHealthHost as string, [
      health(),
      health({ status: "stopping", serverRunning: false }),
    ]);
    const run = await start(stopWorkspace, [{ workspaceId: workspace.id, reason: "idle" }]);
    await expect(run.returnValue).resolves.toEqual({ stopped: true });
    const methods = fakeSandbox().calls.map((call) => call.method);
    expect(methods).toContain("stop");
    expect(methods).not.toContain("waitCommand");
    const db = await dbReady();
    const [session] = await db.select().from(sessions).where(eq(sessions.workspaceId, workspace.id));
    expect(session.endedAt).toBeInstanceOf(Date);
    expect(session.endReason).toBe("idle");
  });
});
