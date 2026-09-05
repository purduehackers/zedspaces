import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbReady } from "@/lib/db";
import { controlApiBase, portPool, proxySlots } from "@/lib/env";
import { blobPathnameFor } from "@/lib/manifest";
import { forwards, sessions, workspaces } from "@/lib/schema";
import { fakeSandbox, health } from "../helpers/fake-sandbox";
import { FIXTURE, insertWorkspace, openEditorSession, seedFixtures } from "../helpers/routes";
import { healthHostOf, installSleepShim, removeSleepShim } from "../helpers/workflow";

// b10: `prebuild` resolves the repo image first, which reads the devcontainer through
// `@/lib/github`; the fake answers "no devcontainer", so every prebuild here runs on the base image.
vi.mock("@/lib/github", async () => (await import("../helpers/github-mock")).createGithubMock());

// Child workflows are started through `start()` and polled in production;
// under the unit config the parent calls them directly so the whole chain is
// exercised.
vi.mock("@/workflows/child", () => ({

  runChild: async (name: string, args: unknown) => {
    switch (name) {
      case "stopWorkspace":
        return (await import("@/workflows/stop-workspace")).stopWorkspace(
          args as Parameters<typeof import("@/workflows/stop-workspace").stopWorkspace>[0],
        );
      case "connectWorkspace":
        return (await import("@/workflows/connect-workspace")).connectWorkspace(
          args as Parameters<typeof import("@/workflows/connect-workspace").connectWorkspace>[0],
        );
      case "createWorkspace":
        return (await import("@/workflows/create-workspace")).createWorkspace(
          args as Parameters<typeof import("@/workflows/create-workspace").createWorkspace>[0],
        );
      case "deleteWorkspace":
        return (await import("@/workflows/delete-workspace")).deleteWorkspace(
          args as Parameters<typeof import("@/workflows/delete-workspace").deleteWorkspace>[0],
        );
      default:
        throw new Error(`unexpected child workflow ${name}`);
    }
  },
}));

const { createWorkspace } = await import("@/workflows/create-workspace");
const { connectWorkspace } = await import("@/workflows/connect-workspace");
const { stopWorkspace } = await import("@/workflows/stop-workspace");
const { restartSession } = await import("@/workflows/restart-session");
const { rebuildWorkspace } = await import("@/workflows/rebuild-workspace");
const { deleteWorkspace } = await import("@/workflows/delete-workspace");
const { gc } = await import("@/workflows/gc");
const { stepCreateSandbox, stepWaitForCommandExit, ARCHIVE_PATHS } = await import("@/workflows/steps/sandbox-steps");
const { stepRecordSessionEnd } = await import("@/workflows/steps/db-steps");

/** Scripts a supervisor that reports `ready` from the first probe. */
function scriptReady(sandboxName: string): void {
  fakeSandbox().setHealth(healthHostOf(sandboxName), health({ phase: "post_create", busy: true }));
}

/** The rebuild's detached `tar` exits 0 at once. */
function scriptArchive(): void {
  fakeSandbox().scriptCommandExit("tar czf", 0);
}

async function reload(workspaceId: string) {
  const db = await dbReady();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row;
}

describe("lifecycle workflows", () => {
  beforeEach(async () => {
    installSleepShim();
    await seedFixtures();
  });

  afterAll(() => {
    removeSleepShim();
  });

  it("creates a workspace: ports, tags, supervisor env and the running row", async () => {
    const workspace = await insertWorkspace({
      state: "creating",
      stateReason: "boot:manifest",
      currentWsHost: null,
      currentHealthHost: null,
      currentSlotHosts: null,
      currentSandboxSessionId: null,
      sessionStartedAt: null,
      workflowRunId: "run_create",
      workflowRunStartedAt: new Date(),
    });
    // Two probes: still cloning, then ready with the server up.
    fakeSandbox().setHealth(healthHostOf(workspace.sandboxName), [
      health({ status: "booting", phase: "clone", serverRunning: false }),
      health({ phase: "post_create", busy: true }),
    ]);

    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });

    const create = fakeSandbox().callsOf("create")[0].args[0] as {
      ports: number[];
      tags: Record<string, string>;
      env: Record<string, string>;
      source?: unknown;
      image?: string;
      keepLastSnapshots: number;
    };
    expect(create.ports).toEqual([8443, ...proxySlots(), 8448, ...portPool()]);
    expect(create.keepLastSnapshots).toBe(1);
    expect(create.tags.zs).toBe("development");
    expect(create.tags.ws).toBe(workspace.id);
    // D19: never a git source, and no secret or token in the VM environment.
    expect(create.source).toBeUndefined();
    expect(create.image).toBe("zs-workspace:test-0");
    expect(create.env).toEqual({
      ZS_WORKSPACE_ID: workspace.id,
      ZS_SANDBOX_NAME: workspace.sandboxName,
      ZS_REGION: "iad1",
    });
    expect(JSON.stringify(create.env)).not.toContain("npm_supersecret");

    const detached = fakeSandbox().callsOf("runDetached")[0].args[1] as {
      cmd: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(detached.cmd).toBe("zs-agent");
    expect(detached.args).toEqual(["start"]);
    expect(detached.env.ZS_SANDBOX_TOKEN.startsWith("zsb_")).toBe(true);
    expect(detached.env.ZS_CONTROL_URL).toBe(controlApiBase());
    expect(detached.env.NPM_TOKEN).toBeUndefined();

    const row = await reload(workspace.id);
    expect(row.state).toBe("running");
    expect(row.stateReason).toBeNull();
    expect(row.workflowRunId).toBeNull();
    expect(row.supervisorCmdId).not.toBeNull();
    expect(row.currentWsHost).toBe(`${workspace.sandboxName}-8443.fake.vercel.run`);
    expect(row.currentHealthHost).toBe(healthHostOf(workspace.sandboxName));
    expect(Object.keys(row.currentSlotHosts ?? {})).toHaveLength(4);
    expect(row.sessionStartedAt).not.toBeNull();
    expect(row.sandboxExpiresAt).not.toBeNull();
  });

  it("fails fast when the supervisor exits instead of waiting for the ceiling", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    fakeSandbox().scriptCommandExit("zs-agent start", 3);
    await expect(createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId })).rejects.toThrow(
      /supervisor_exit:3:unreachable/,
    );
    const row = await reload(workspace.id);
    expect(row.state).toBe("error");
    expect(row.stateReason).toContain("supervisor_exit:3");
    expect(row.workflowRunId).toBeNull();
  });

  it("clears the run id and errors the row on a health timeout", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    fakeSandbox().setHealth(
      healthHostOf(workspace.sandboxName),
      health({ status: "booting", phase: "post_create", serverRunning: false }),
    );
    await expect(
      createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId, readyCeilingMs: 0 }),
    ).rejects.toThrow(/health_timeout:post_create/);
    const row = await reload(workspace.id);
    expect(row.state).toBe("error");
    expect(row.workflowRunId).toBeNull();
    // The sandbox is left running for the operator.
    expect(fakeSandbox().sandbox(workspace.sandboxName)?.status).toBe("running");
  });

  it("maps image_not_ready to a retryable error and quota to a fatal one", async () => {
    const workspace = await insertWorkspace({ state: "creating" });
    const input = {
      name: workspace.sandboxName,
      region: "iad1" as const,
      vcpus: 2 as const,
      ports: [8443],
      timeoutMs: 1000,
      image: "zs-workspace:test-0",
      env: {},
      networkPolicy: "allow-all" as const,
      tags: {},
      snapshotExpirationMs: 0,
      keepLastSnapshots: 1,
    };
    fakeSandbox().failNextCreateWith("image_not_ready", 1);
    await expect(stepCreateSandbox(input)).rejects.toMatchObject({ name: "RetryableError" });
    fakeSandbox().failNextCreateWith("quota", 1);
    await expect(stepCreateSandbox(input)).rejects.toMatchObject({ name: "FatalError" });
  });

  it("resumes a stopped workspace and records the new supervisor command", async () => {
    const workspace = await insertWorkspace({
      state: "stopped",
      supervisorCmdId: null,
      currentWsHost: null,
      currentHealthHost: null,
      workflowRunId: "run_resume",
    });
    fakeSandbox().seedSandbox(workspace.sandboxName, {
      status: "stopped",
      ports: [8443, ...proxySlots(), 8448, ...portPool()],
    });
    scriptReady(workspace.sandboxName);
    const before = (await reload(workspace.id)).sandboxTokenGeneration;

    const result = await connectWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    expect(result.host).toBe(`${workspace.sandboxName}-8443.fake.vercel.run`);

    const detached = fakeSandbox().callsOf("runDetached");
    expect(detached).toHaveLength(1);
    expect((detached[0].args[1] as { args: string[] }).args).toEqual(["resume"]);
    const row = await reload(workspace.id);
    expect(row.state).toBe("running");
    expect(row.supervisorCmdId).toBe(fakeSandbox().commands()[0].cmdId);
    expect(row.sandboxTokenGeneration).toBe(before + 1);
    expect(row.workflowRunId).toBeNull();
  });

  it("stops a workspace, signals the supervisor first and closes the session idempotently", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    const db = await dbReady();
    await db.insert(forwards).values({
      workspaceId: workspace.id,
      port: 3000,
      visibility: "private",
      label: "web",
      url: "https://zs.test/api/workspaces/x/ports/3000/open",
      slot: proxySlots()[0],
    });
    fakeSandbox().setUsage(workspace.sandboxName, {
      activeCpuDurationMs: 600_000,
      ingressBytes: 0,
      egressBytes: 5e8,
    });
    await openEditorSession(await reload(workspace.id));

    await stopWorkspace({ workspaceId: workspace.id, reason: "user" });

    const order = fakeSandbox().calls.map((call) => call.method);
    expect(order.indexOf("killCommand")).toBeLessThan(order.indexOf("stop"));
    expect(order.indexOf("waitCommand")).toBeLessThan(order.indexOf("stop"));

    const [session] = await db.select().from(sessions).where(eq(sessions.workspaceId, workspace.id));
    expect(session.endReason).toBe("user");
    expect(session.endedAt).toBeInstanceOf(Date);

    // A retried step must not rewrite the closed session.
    await stepRecordSessionEnd(
      workspace.id,
      { activeCpuDurationMs: 600_000, ingressBytes: 0, egressBytes: 5e8 },
      "user",
    );
    const again = await db.select().from(sessions).where(eq(sessions.workspaceId, workspace.id));
    expect(again).toHaveLength(1);
    expect(again[0].endedAt).toEqual(session.endedAt);

    const row = await reload(workspace.id);
    expect(row.state).toBe("stopped");
    expect(row.retentionUntil).not.toBeNull();
    expect(row.currentWsHost).toBeNull();
    const survivingForwards = await db.select().from(forwards).where(eq(forwards.workspaceId, workspace.id));
    expect(survivingForwards[0].slot).toBe(proxySlots()[0]);
  });

  it("polls the supervisor's health when no command id is known", async () => {
    const workspace = await insertWorkspace({ supervisorCmdId: null });
    fakeSandbox().seedSandbox(workspace.sandboxName, { status: "running", ports: [8443, 8448] });
    fakeSandbox().setHealth(workspace.currentHealthHost as string, [
      health(),
      health({ status: "stopping", serverRunning: false }),
    ]);
    await stopWorkspace({ workspaceId: workspace.id, reason: "user" });
    const methods = fakeSandbox().calls.map((call) => call.method);
    expect(methods).toContain("stop");
    expect(methods).not.toContain("waitCommand");
  });

  it("keeps the parent's run id across a child stop", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId, child: true });
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ workflowRunId: "run_restart", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    await stopWorkspace({ workspaceId: workspace.id, reason: "cap", child: true });
    expect((await reload(workspace.id)).workflowRunId).toBe("run_restart");
  });

  it("restarts a session and ends running with a fresh host", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ workflowRunId: "run_restart", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));

    await restartSession({ workspaceId: workspace.id });

    const row = await reload(workspace.id);
    expect(row.state).toBe("running");
    expect(row.workflowRunId).toBeNull();
    expect(row.currentWsHost).toBe(`${workspace.sandboxName}-8443.fake.vercel.run`);
  });

  it("rebuilds: archives exactly D9's paths, then deletes the old sandbox last", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    const oldName = workspace.sandboxName;
    const newName = oldName.replace(/-g1$/, "-g2");
    fakeSandbox().setHealth(healthHostOf(newName), health());
    scriptArchive();
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ workflowRunId: "run_rebuild", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));

    await rebuildWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });

    const tar = fakeSandbox()
      .callsOf("runDetached")
      .map((call) => call.args[1] as { cmd: string; args: string[] })
      .find((run) => run.cmd === "tar");
    expect(tar?.args).toEqual(["czf", "/tmp/zs-rebuild.tgz", "-C", "/", ...ARCHIVE_PATHS]);

    const deletes = fakeSandbox().callsOf("delete");
    expect(deletes.map((call) => call.args[0])).toEqual([oldName]);
    const row = await reload(workspace.id);
    expect(row.sandboxGeneration).toBe(2);
    expect(row.sandboxName).toBe(newName);
    expect(row.audience).toBe(newName);
    expect(row.previousSandboxName).toBeNull();
    expect(row.restoreBlobPathname).toBeNull();
    expect(row.state).toBe("running");
    expect(row.workflowRunId).toBeNull();
  });

  it("rebuild failure keeps the old sandbox, the archive and the pointers", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    const oldName = workspace.sandboxName;
    scriptArchive();
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ workflowRunId: "run_rebuild", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    // The new generation's supervisor never comes up.
    fakeSandbox().scriptCommandExit("zs-agent start", 4);

    await expect(
      rebuildWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId }),
    ).rejects.toThrow();

    expect(fakeSandbox().callsOf("delete")).toHaveLength(0);
    const row = await reload(workspace.id);
    expect(row.state).toBe("error");
    expect(row.workflowRunId).toBeNull();
    expect(row.previousSandboxName).toBe(oldName);
    expect(row.restoreBlobPathname).not.toBeNull();
    expect(row.restoreKind).toBe("tarball");
  });

  it("a rebuild after a failed one resumes from the pointers instead of archiving the empty generation", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    const oldName = workspace.sandboxName;
    const newName = oldName.replace(/-g1$/, "-g2");
    scriptArchive();
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ workflowRunId: "run_rebuild", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    fakeSandbox().scriptCommandExit("zs-agent start", 4);
    await expect(
      rebuildWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId }),
    ).rejects.toThrow();
    const failed = await reload(workspace.id);
    const archive = failed.restoreBlobPathname;
    expect(archive).not.toBeNull();
    expect(fakeSandbox().sandbox(newName)).toBeDefined();

    // Second attempt: the supervisor comes up this time.
    fakeSandbox().clearCommandExit("zs-agent start");
    fakeSandbox().setHealth(healthHostOf(newName), health());
    await db
      .update(workspaces)
      .set({ workflowRunId: "run_rebuild_2", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    await rebuildWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });

    // Exactly one archive was ever taken, of the generation that held the files.
    const tars = fakeSandbox()
      .callsOf("runDetached")
      .filter((call) => (call.args[1] as { cmd: string }).cmd === "tar");
    expect(tars).toHaveLength(1);
    expect(tars[0].args[0]).toBe(oldName);
    // The half-built g2 was discarded before the retry, and g1 deleted only after the new g2 was healthy.
    const deletes = fakeSandbox().callsOf("delete").map((call) => call.args[0]);
    expect(deletes).toEqual([newName, oldName]);
    const row = await reload(workspace.id);
    expect(row.sandboxGeneration).toBe(2);
    expect(row.sandboxName).toBe(newName);
    expect(row.previousSandboxName).toBeNull();
    expect(row.restoreBlobPathname).toBeNull();
    expect(row.state).toBe("running");
    // The archive survived the failed attempt and was removed by the successful one.
    const { blobStore } = await import("@/lib/blob");
    const { _resetBlobForTests } = await import("@/lib/blob");
    void _resetBlobForTests;
    expect(archive).not.toBeNull();
    void blobStore;
  });

  it("refuses to archive over a pending generation bump", async () => {
    const { stepBumpGeneration } = await import("@/workflows/steps/db-steps");
    const workspace = await insertWorkspace({ previousSandboxName: "sb-dev-old-g1", restoreKind: "tarball" });
    await expect(stepBumpGeneration(workspace.id, { blobPathname: "rebuild/x/1.tgz" })).rejects.toThrow(
      /generation_bump_pending/,
    );
  });

  it("resumes a running sandbox whose recorded supervisor exited by starting a fresh one", async () => {
    const workspace = await insertWorkspace({ state: "error", stateReason: "supervisor_exit:3:unreachable" });
    fakeSandbox().seedSandbox(workspace.sandboxName, {
      status: "running",
      ports: [8443, ...proxySlots(), 8448, ...portPool()],
    });
    // The recorded supervisor is dead (exit code 3), the VM itself is up.
    fakeSandbox().scriptCommandExit("zs-agent start", 3);
    const handle = await (await import("@/lib/sandbox")).sandboxApi().get(workspace.sandboxName, { resume: false });
    const dead = await handle!.runDetached({ cmd: "zs-agent", args: ["start"] });
    fakeSandbox().clearCommandExit("zs-agent start");
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ supervisorCmdId: dead.cmdId, workflowRunId: "run_resume", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    scriptReady(workspace.sandboxName);

    await connectWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });

    const detached = fakeSandbox().callsOf("runDetached");
    expect(detached).toHaveLength(2);
    expect((detached[1].args[1] as { args: string[] }).args).toEqual(["resume"]);
    const row = await reload(workspace.id);
    expect(row.state).toBe("running");
    expect(row.supervisorCmdId).not.toBe(dead.cmdId);
  });

  it("keeps a live supervisor when the resume step is retried on a running VM", async () => {
    const workspace = await insertWorkspace({ state: "stopped" });
    fakeSandbox().seedSandbox(workspace.sandboxName, {
      status: "running",
      ports: [8443, ...proxySlots(), 8448, ...portPool()],
    });
    const handle = await (await import("@/lib/sandbox")).sandboxApi().get(workspace.sandboxName, { resume: false });
    const alive = await handle!.runDetached({ cmd: "zs-agent", args: ["resume"] });
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ supervisorCmdId: alive.cmdId, workflowRunId: "run_resume", workflowRunStartedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    scriptReady(workspace.sandboxName);
    await connectWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    expect(fakeSandbox().callsOf("runDetached")).toHaveLength(1);
    expect((await reload(workspace.id)).supervisorCmdId).toBe(alive.cmdId);
  });

  it("never waits on a command of a sandbox that is not running", async () => {
    const workspace = await insertWorkspace();
    fakeSandbox().seedSandbox(workspace.sandboxName, { status: "stopped", ports: [8443, 8448] });
    const result = await stepWaitForCommandExit(workspace.sandboxName, "cmd_0001", 1_000);
    expect(result).toEqual({ exitCode: null });
    expect(fakeSandbox().callsOf("waitCommand")).toHaveLength(0);
  });

  it("deletes a workspace with its snapshots, forwards and blob", async () => {
    const workspace = await insertWorkspace({ state: "creating", workflowRunId: "run_create" });
    scriptReady(workspace.sandboxName);
    await createWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });
    const db = await dbReady();
    await db.insert(forwards).values({
      workspaceId: workspace.id,
      port: 3000,
      visibility: "public",
      label: null,
      url: null,
      slot: null,
    });
    await db
      .update(workspaces)
      .set({ restoreBlobPathname: blobPathnameFor(workspace.id, 1, "f".repeat(64)) })
      .where(eq(workspaces.id, workspace.id));

    await deleteWorkspace({ workspaceId: workspace.id, userId: FIXTURE.userId });

    const methods = fakeSandbox().calls.map((call) => call.method);
    expect(methods).toContain("listSnapshotIds");
    expect(methods).toContain("deleteSnapshot");
    expect(methods).toContain("delete");
    // Nothing on the delete path may resume a stopped VM.
    expect(
      fakeSandbox()
        .callsOf("get")
        .every((call) => (call.args[1] as { resume: boolean }).resume === false),
    ).toBe(true);
    const remaining = await db.select().from(forwards).where(eq(forwards.workspaceId, workspace.id));
    expect(remaining).toHaveLength(0);
    const row = await reload(workspace.id);
    expect(row.deletedAt).not.toBeNull();
  });

  it("gc only deletes sandboxes tagged for this environment", async () => {
    const known = await insertWorkspace();
    fakeSandbox().seedSandbox(known.sandboxName, { tags: { zs: "development" } });
    fakeSandbox().seedSandbox("sb-dev-orphan-g1", { tags: { zs: "development" } });
    fakeSandbox().seedSandbox("sb-prod-other-g1", { tags: { zs: "production" } });

    const result = await gc({ now: new Date().toISOString() });

    expect(result.orphanedSandboxes).toBe(1);
    expect(fakeSandbox().callsOf("delete").map((call) => call.args[0])).toEqual(["sb-dev-orphan-g1"]);
    const listCalls = fakeSandbox().callsOf("listByTag");
    expect(listCalls).toHaveLength(1);
    expect(Object.keys(listCalls[0].args[0] as Record<string, string>)).toHaveLength(1);
  });

  it("gc deletes an expired, warned workspace", async () => {
    const expired = await insertWorkspace({
      state: "stopped",
      retentionUntil: new Date(Date.now() - 86_400_000),
      retentionWarnedAt: new Date(Date.now() - 8 * 86_400_000),
    });
    fakeSandbox().seedSandbox(expired.sandboxName, { tags: { zs: "development" } });
    const result = await gc({ now: new Date().toISOString() });
    expect(result.deletedWorkspaces).toBe(1);
    const row = await reload(expired.id);
    expect(row.deletedAt).not.toBeNull();
  });

  it("gc warns a workspace a week before its retention expires", async () => {
    const soon = await insertWorkspace({
      state: "stopped",
      retentionUntil: new Date(Date.now() + 3 * 86_400_000),
      retentionWarnedAt: null,
    });
    const result = await gc({ now: new Date().toISOString() });
    expect(result.warned).toBe(1);
    expect((await reload(soon.id)).retentionWarnedAt).not.toBeNull();
  });
});
