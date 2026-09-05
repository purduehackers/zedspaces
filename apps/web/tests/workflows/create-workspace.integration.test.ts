import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { dbReady } from "@/lib/db";
import { portPool, proxySlots } from "@/lib/env";
import { workspaces } from "@/lib/schema";
import { createWorkspace } from "@/workflows/create-workspace";
import { fakeSandbox, health } from "../helpers/fake-sandbox";
import { FIXTURE, insertWorkspace, seedFixtures } from "../helpers/routes";
import { healthHostOf } from "../helpers/workflow";

/**
 * The same happy path as `tests/workflows/lifecycle.test.ts`, but driven
 * through the real Workflow runtime (`@workflow/vitest`): the directives are
 * transformed, every step crosses a serialization boundary and the run is
 * event-sourced. Fakes are selected by the environment because the workflow
 * and step bundles are separate module instances (`vi.mock` cannot reach them).
 */
// `@workflow/builders` emits a JSON import without an import attribute, which
// Node 22+ rejects with `ERR_IMPORT_ATTRIBUTE_MISSING`; the integration config
// patches the emitted bundles in `tests/helpers/workflow-bundle-fix.ts`.
describe("createWorkspace (workflow runtime)", () => {
  beforeEach(async () => {
    await seedFixtures();
  });

  it("boots a sandbox and leaves the workspace running", async () => {
    const workspace = await insertWorkspace({
      state: "creating",
      stateReason: "boot:manifest",
      currentWsHost: null,
      currentHealthHost: null,
      currentSlotHosts: null,
      sessionStartedAt: null,
    });
    fakeSandbox().setHealth(healthHostOf(workspace.sandboxName), [
      health({ status: "booting", phase: "clone", serverRunning: false }),
      health({ phase: "post_create", busy: true }),
    ]);

    const run = await start(createWorkspace, [{ workspaceId: workspace.id, userId: FIXTURE.userId }]);
    await expect(run.returnValue).resolves.toEqual({ ok: true });

    const create = fakeSandbox().callsOf("create")[0].args[0] as { ports: number[]; source?: unknown };
    expect(create.ports).toEqual([8443, ...proxySlots(), 8448, ...portPool()]);
    expect(create.source).toBeUndefined();

    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.state).toBe("running");
    expect(row.workflowRunId).toBeNull();
    expect(row.supervisorCmdId).not.toBeNull();
  });
});
