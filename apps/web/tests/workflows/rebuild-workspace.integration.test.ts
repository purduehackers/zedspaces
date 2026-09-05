import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { dbReady } from "@/lib/db";
import { portPool, proxySlots } from "@/lib/env";
import { workspaces } from "@/lib/schema";
import { rebuildWorkspace } from "@/workflows/rebuild-workspace";
import { ARCHIVE_PATHS } from "@/workflows/steps/sandbox-steps";
import { fakeSandbox, health } from "../helpers/fake-sandbox";
import { FIXTURE, insertWorkspace, seedFixtures } from "../helpers/routes";
import { healthHostOf } from "../helpers/workflow";

/**
 * `rebuildWorkspace` through the real Workflow runtime (b9 §6.6
 * `rebuild_crash_keeps_old_sandbox_and_blob`, `archive_paths_are_exactly_d9`).
 * The child `stopWorkspace`/`createWorkspace` runs are real child runs
 * started and polled by `workflows/child.ts`.
 */
describe("rebuildWorkspace (workflow runtime)", () => {
  beforeEach(async () => {
    await seedFixtures();
    fakeSandbox().scriptCommandExit("tar czf", 0);
  });

  it("archives exactly D9's paths, boots the new generation and deletes the old one last", async () => {
    const workspace = await insertWorkspace({ state: "stopped", currentWsHost: null, currentHealthHost: null });
    const oldName = workspace.sandboxName;
    const newName = oldName.replace(/-g1$/, "-g2");
    fakeSandbox().seedSandbox(oldName, { status: "stopped", ports: [8443, ...proxySlots(), 8448, ...portPool()] });
    fakeSandbox().setHealth(healthHostOf(newName), health());

    const run = await start(rebuildWorkspace, [{ workspaceId: workspace.id, userId: FIXTURE.userId }]);
    await expect(run.returnValue).resolves.toEqual({ ok: true });

    const tar = fakeSandbox()
      .callsOf("runDetached")
      .map((call) => call.args[1] as { cmd: string; args: string[] })
      .find((command) => command.cmd === "tar");
    expect(tar?.args).toEqual(["czf", "/tmp/zs-rebuild.tgz", "-C", "/", ...ARCHIVE_PATHS]);
    const methods = fakeSandbox().calls.map((call) => call.method);
    expect(methods.indexOf("delete")).toBeGreaterThan(methods.lastIndexOf("create"));
    expect(fakeSandbox().callsOf("delete").map((call) => call.args[0])).toEqual([oldName]);
    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.sandboxGeneration).toBe(2);
    expect(row.sandboxName).toBe(newName);
    expect(row.previousSandboxName).toBeNull();
    expect(row.restoreBlobPathname).toBeNull();
    expect(row.state).toBe("running");
    expect(row.workflowRunId).toBeNull();
  });

  it("keeps the old sandbox, the archive and the pointers when the child create fails", async () => {
    const workspace = await insertWorkspace({ state: "stopped", currentWsHost: null, currentHealthHost: null });
    const oldName = workspace.sandboxName;
    fakeSandbox().seedSandbox(oldName, { status: "stopped", ports: [8443, ...proxySlots(), 8448, ...portPool()] });
    fakeSandbox().scriptCommandExit("zs-agent start", 4);

    const run = await start(rebuildWorkspace, [{ workspaceId: workspace.id, userId: FIXTURE.userId }]);
    await expect(run.returnValue).rejects.toThrow();

    expect(fakeSandbox().callsOf("delete")).toHaveLength(0);
    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.state).toBe("error");
    expect(row.workflowRunId).toBeNull();
    expect(row.previousSandboxName).toBe(oldName);
    expect(row.restoreKind).toBe("tarball");
    expect(row.restoreBlobPathname).not.toBeNull();
  });
});
