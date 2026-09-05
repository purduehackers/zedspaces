import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as sweepGet } from "@/app/api/cron/sweep/route";
import { dbReady } from "@/lib/db";
import { env } from "@/lib/env";
import { newId, newSandboxName } from "@/lib/ids";
import { keys, kv } from "@/lib/kv";
import type { RunStatus } from "@/lib/lifecycle";
import { users, workspaces } from "@/lib/schema";
import { fakeSandbox } from "../helpers/fake-sandbox";
import { body, FIXTURE, insertWorkspace, request, seedFixtures } from "../helpers/routes";

const started: Array<{ workspaceId: string; name: string; args: Record<string, unknown> }> = [];
const runStatusMock = vi.fn<(runId: string) => Promise<RunStatus>>(async () => "running");

vi.mock("@/lib/lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle")>();
  return {
    ...actual,
    runStatus: (runId: string) => runStatusMock(runId),
    startLifecycle: async (workspaceId: string, name: string, args: Record<string, unknown>) => {
      started.push({ workspaceId, name, args });
      const { dbReady: ready } = await import("@/lib/db");
      const { workspaces: table } = await import("@/lib/schema");
      const { eq: equals } = await import("drizzle-orm");
      const db = await ready();
      const runId = `run_${started.length}`;
      await db
        .update(table)
        .set({ workflowRunId: runId, workflowRunStartedAt: new Date() })
        .where(equals(table.id, workspaceId));
      return { runId };
    },
  };
});

const CRON_SECRET = "cron-secret-for-tests";

function sweepRequest(secret = CRON_SECRET): Request {
  return request("/api/cron/sweep", { headers: { authorization: `Bearer ${secret}` } });
}

interface SweepBody {
  ran: boolean;
  reason?: string;
  stopped?: number;
  extended?: number;
  capped?: number;
  reconciledRuns?: number;
  reconciledVms?: number;
  abuse?: number;
  spendCapped?: number;
}

describe("cron sweep", () => {
  beforeEach(async () => {
    process.env.CRON_SECRET = CRON_SECRET;
    const { _resetEnvForTests } = await import("@/lib/env");
    _resetEnvForTests();
    await seedFixtures();
    started.length = 0;
    runStatusMock.mockReset();
    runStatusMock.mockResolvedValue("running");
  });

  it("refuses a missing or wrong bearer", async () => {
    expect((await sweepGet(request("/api/cron/sweep"), { params: Promise.resolve({}) })).status).toBe(401);
    expect((await sweepGet(sweepRequest("nope"), { params: Promise.resolve({}) })).status).toBe(401);
  });

  it("stops an idle workspace and records the run id", async () => {
    const workspace = await insertWorkspace({
      idleMinutes: 5,
      lastActiveAt: new Date(Date.now() - 60 * 60_000),
      sessionStartedAt: new Date(Date.now() - 2 * 3600_000),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    const res = await sweepGet(sweepRequest(), { params: Promise.resolve({}) });
    const out = await body<SweepBody>(res);
    expect(out.ran).toBe(true);
    expect(out.stopped).toBe(1);
    expect(started[0]).toMatchObject({ name: "stopWorkspace", args: { reason: "idle" } });
    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.workflowRunId).not.toBeNull();
  });

  it("defers the stop while a keepalive is fresh", async () => {
    const workspace = await insertWorkspace({
      idleMinutes: 5,
      lastActiveAt: new Date(Date.now() - 60 * 60_000),
      sessionStartedAt: new Date(Date.now() - 2 * 3600_000),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    await kv().set(keys.keepalive(workspace.id), String(Date.now()), { exMs: 600_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.stopped).toBe(0);
    expect(started).toHaveLength(0);
  });

  it("does not idle-stop a workspace whose supervisor reports busy (D13)", async () => {
    const workspace = await insertWorkspace({
      idleMinutes: 5,
      lastActiveAt: new Date(Date.now() - 60 * 60_000),
      sessionStartedAt: new Date(Date.now() - 2 * 3600_000),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    await kv().set(keys.busy(workspace.id), "post_create", { exMs: 120_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.stopped).toBe(0);
    expect(started).toHaveLength(0);
  });

  it("restarts a session close to the platform cap", async () => {
    const workspace = await insertWorkspace({
      sessionStartedAt: new Date(Date.now() - (env().ZS_SESSION_CAP_MS - 15 * 60_000)),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    await kv().set(keys.activity(workspace.id), String(Date.now()), { exMs: 600_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.capped).toBe(1);
    expect(started[0]).toMatchObject({ name: "restartSession" });
  });

  it("extends a near expiry without resuming, and leaves a distant one alone", async () => {
    const workspace = await insertWorkspace({
      sandboxExpiresAt: new Date(Date.now() + 3 * 3600_000),
    });
    fakeSandbox().seedSandbox(workspace.sandboxName, {
      status: "running",
      expiresAt: Date.now() + 3 * 3600_000,
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    await kv().set(keys.activity(workspace.id), String(Date.now()), { exMs: 600_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.extended).toBe(1);
    const peeks = fakeSandbox().callsOf("get");
    expect(peeks.every((call) => (call.args[1] as { resume: boolean }).resume === false)).toBe(true);
    expect(fakeSandbox().callsOf("extendTimeout")).toHaveLength(1);

    fakeSandbox().reset();
    const db = await dbReady();
    await db
      .update(workspaces)
      .set({ sandboxExpiresAt: new Date(Date.now() + 5 * 3600_000), workflowRunId: null })
      .where(eq(workspaces.id, workspace.id));
    const second = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(second.extended).toBe(0);
    expect(fakeSandbox().calls).toHaveLength(0);
  });

  it("clears a terminal run id and marks the row errored", async () => {
    const workspace = await insertWorkspace({
      workflowRunId: "run_dead",
      workflowRunStartedAt: new Date(Date.now() - 60_000),
    });
    runStatusMock.mockResolvedValue("failed");
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.reconciledRuns).toBe(1);
    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.workflowRunId).toBeNull();
    expect(row.state).toBe("error");
    expect(row.stateReason).toBe("run_failed");
  });

  it("leaves a run the store still reports as running alone, however old", async () => {
    const workspace = await insertWorkspace({
      state: "creating",
      workflowRunId: "run_slow_create",
      workflowRunStartedAt: new Date(Date.now() - 25 * 60_000),
    });
    runStatusMock.mockResolvedValue("running");
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.reconciledRuns).toBe(0);
    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.workflowRunId).toBe("run_slow_create");
    expect(row.state).toBe("creating");
  });

  it("releases an unreadable run only once it is older than every lifecycle ceiling", async () => {
    const young = await insertWorkspace({
      workflowRunId: "run_unknown_young",
      workflowRunStartedAt: new Date(Date.now() - 30 * 60_000),
    });
    const old = await insertWorkspace({
      workflowRunId: "run_unknown_old",
      workflowRunStartedAt: new Date(Date.now() - 2 * 3600_000),
    });
    runStatusMock.mockResolvedValue("unknown");
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.reconciledRuns).toBe(1);
    const db = await dbReady();
    const [youngRow] = await db.select().from(workspaces).where(eq(workspaces.id, young.id)).limit(1);
    const [oldRow] = await db.select().from(workspaces).where(eq(workspaces.id, old.id)).limit(1);
    expect(youngRow.workflowRunId).toBe("run_unknown_young");
    expect(oldRow.workflowRunId).toBeNull();
    expect(oldRow.stateReason).toBe("run_unknown");
  });

  it("does not idle-stop a workspace that just resumed, whatever last_active_at remembers", async () => {
    const workspace = await insertWorkspace({
      idleMinutes: 5,
      lastActiveAt: new Date(Date.now() - 24 * 3600_000),
      sessionStartedAt: new Date(Date.now() - 60_000),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    // The supervisor's first ping reported no input (nothing typed yet): the key is stale.
    await kv().set(keys.activity(workspace.id), String(Date.now() - 24 * 3600_000), { exMs: 600_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.stopped).toBe(0);
    expect(started).toHaveLength(0);
  });

  it("ends the session at the cap instead of restarting it when nobody is attached", async () => {
    const workspace = await insertWorkspace({
      sessionStartedAt: new Date(Date.now() - (env().ZS_SESSION_CAP_MS - 15 * 60_000)),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
      idleMinutes: 240,
    });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    await kv().set(keys.busy(workspace.id), "post_start", { exMs: 120_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.capped).toBe(0);
    expect(started[0]).toMatchObject({ name: "stopWorkspace", args: { reason: "cap" } });
  });

  it("reconciles a workspace whose VM is gone", async () => {
    const workspace = await insertWorkspace({
      updatedAt: new Date(Date.now() - 6 * 60_000),
      sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
    });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.reconciledVms).toBe(1);
    expect(started[0]).toMatchObject({ name: "stopWorkspace", args: { reason: "lost" } });
    expect(workspace.state).toBe("running");
  });

  it("stops and flags a workspace burning cpu with no session", async () => {
    const workspace = await insertWorkspace({ sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000) });
    await kv().set(keys.health(workspace.id), String(Date.now()), { exMs: 120_000 });
    await kv().set(keys.activity(workspace.id), String(Date.now()), { exMs: 600_000 });
    await kv().set(keys.cpu(workspace.id), "30", { exMs: 600_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.abuse).toBe(1);
    expect(started[0]).toMatchObject({ name: "stopWorkspace", args: { reason: "abuse" } });
    const db = await dbReady();
    const [owner] = await db.select().from(users).where(eq(users.id, FIXTURE.userId)).limit(1);
    expect(owner.flaggedAt).not.toBeNull();
    expect(owner.flagReason).toBe("sustained_cpu_no_session");
  });

  it("answers { ran: false } while another instance holds the lock", async () => {
    await kv().set(keys.lock("sweep"), "someone-else", { exMs: 55_000 });
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out).toEqual({ ran: false, reason: "locked" });
  });

  it("sweeps a thousand running workspaces inside the budget", async () => {
    const db = await dbReady();
    const rows = Array.from({ length: 1000 }, () => {
      const id = newId("ws");
      const sandboxName = newSandboxName(id, 1);
      return {
        id,
        ownerUserId: FIXTURE.userId,
        repoId: FIXTURE.repoId,
        name: "api",
        machine: "vcpu2" as const,
        region: "iad1" as const,
        sandboxName,
        audience: sandboxName,
        imageRef: "zs-workspace:test-0",
        serverBuild: "test-0",
        clientBuild: "test-0",
        state: "running" as const,
        sessionStartedAt: new Date(),
        lastActiveAt: new Date(),
        sandboxExpiresAt: new Date(Date.now() + 10 * 3600_000),
      };
    });
    await db.insert(workspaces).values(rows);
    for (const row of rows) await kv().set(keys.health(row.id), String(Date.now()), { exMs: 120_000 });
    const startedAt = Date.now();
    const out = await body<SweepBody>(await sweepGet(sweepRequest(), { params: Promise.resolve({}) }));
    expect(out.ran).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(50_000);
    expect(started).toHaveLength(0);
  }, 60_000);
});
