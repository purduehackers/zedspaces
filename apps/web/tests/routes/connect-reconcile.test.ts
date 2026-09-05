import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { sessions, workspaces } from "@/lib/schema";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { fakeSandbox, resetFakeSandbox } from "../helpers/fake-sandbox";
import { recordedRuns, resetLifecycle } from "../helpers/lifecycle-mock";
import { clearRequestCookies, ctx, errorBody, jsonBody, req } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("@/lib/lifecycle", async () => (await import("../helpers/lifecycle-mock")).createLifecycleMock());
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

process.env.ZS_CONNECT_RESUME_WAIT_MS = "0";
process.env.ZS_CONNECT_POLL_MS = "1";
process.env.ZS_CONNECT_HEALTH_PAUSE_MS = "1";

const { POST } = await import("@/app/api/workspaces/[id]/connect/route");

/**
 * Bug (a): a workspace whose row is `running` but whose sandbox is dead (the
 * local backend's processes gone after `dev-local.sh stop`, a Vercel session
 * that ended) made `/connect` answer `500 sandbox_unhealthy` for ever.
 * `/connect` now reconciles the row to `stopped` and takes the ordinary
 * resume path.
 */

const RPC_HOST = "sb-1-8443.fake.vercel.run";
const HEALTH_HOST = "sb-1-8448.fake.vercel.run";

let db: Awaited<ReturnType<typeof routeDb>>;
const realFetch = globalThis.fetch;

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    phase: "ready",
    build: "test-0",
    manifestBuild: "test-0",
    resumed: false,
    busy: false,
    uptimeSecs: 12,
    server: { running: true, pid: 42, restarts: 0, crashLoop: false },
    ...overrides,
  };
}

/** `probeHealth` goes through `fetch`; `null` = the listener is gone (connection refused). */
function stubHealth(body: unknown | null, status = 200): void {
  globalThis.fetch = vi.fn(async () =>
    body === null
      ? Promise.reject(new TypeError("fetch failed: ECONNREFUSED"))
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

async function runningWorkspace(overrides: Record<string, unknown> = {}) {
  return seedWorkspace(db, {
    state: "running",
    currentWsHost: RPC_HOST,
    currentHealthHost: HEALTH_HOST,
    currentSandboxSessionId: "sbx_1",
    sessionStartedAt: new Date(),
    supervisorCmdId: "cmd_1",
    ...overrides,
  });
}

const tab = { tabId: "tab-aaaaaaaa" };

beforeEach(async () => {
  db = await routeDb();
  resetViewer();
  resetLifecycle();
  resetFakeSandbox();
  _resetKvForTests();
  _resetRatelimitForTests();
  setViewer(SEED.userId);
  clearRequestCookies();
  stubHealth(healthBody());
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function row(id: string) {
  const [current] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return current;
}

describe("POST /connect reconciles a running row whose sandbox is dead", () => {
  it("resumes through connectWorkspace when the backend reports the sandbox stopped", async () => {
    const ws = await runningWorkspace();
    fakeSandbox().seedSandbox(ws.sandboxName, { status: "stopped", ports: [8443, 8448] });
    await db.insert(sessions).values({
      id: "ses_open",
      workspaceId: ws.id,
      userId: SEED.userId,
      sandboxGeneration: ws.sandboxGeneration,
      sandboxSessionId: "sbx_1",
      holderTabId: "tab-old",
      wsHost: RPC_HOST,
    });

    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(202);
    expect(await jsonBody(res)).toEqual({ status: "resuming", runId: "run_1" });
    expect(recordedRuns()[0]).toMatchObject({ name: "connectWorkspace", workspaceId: ws.id });

    const current = await row(ws.id);
    expect(current.state).toBe("stopped");
    expect(current.stateReason).toBe("lost:sandbox_stopped");
    expect(current.currentWsHost).toBeNull();
    expect(current.currentHealthHost).toBeNull();
    expect(current.supervisorCmdId).toBeNull();
    expect(current.lastStoppedAt).not.toBeNull();
    const open = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, ws.id), isNull(sessions.endedAt)));
    expect(open).toEqual([]);
    const [closed] = await db.select().from(sessions).where(eq(sessions.id, "ses_open"));
    expect(closed.endReason).toBe("sandbox_lost");
    // The health probe is never consulted for a sandbox the backend already reports stopped.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reconciles when the sandbox is running but its supervisor never answers, and never loops on sandbox_unhealthy", async () => {
    const ws = await runningWorkspace();
    fakeSandbox().seedSandbox(ws.sandboxName, { status: "running", ports: [8443, 8448] });
    stubHealth(null);

    const first = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(first.status).toBe(202);
    expect((await row(ws.id)).stateReason).toBe("lost:health_unreachable");
    expect(recordedRuns().map((run) => run.name)).toEqual(["connectWorkspace"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps answering sandbox_unhealthy while the supervisor answers but is not ready (it is alive)", async () => {
    const ws = await runningWorkspace();
    fakeSandbox().seedSandbox(ws.sandboxName, { status: "running", ports: [8443, 8448] });
    stubHealth(healthBody({ status: "booting", phase: "server_starting", server: { running: false } }), 503);

    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(500);
    const err = await errorBody(res);
    expect(err.code).toBe("sandbox_unhealthy");
    expect(err.details).toMatchObject({ status: "booting", phase: "server_starting", serverRunning: false });
    expect((await row(ws.id)).state).toBe("running");
    expect(recordedRuns()).toEqual([]);
  });

  it("answers 409 workspace_stopped to a reconnecting tab once reconciled, without resuming", async () => {
    const ws = await runningWorkspace();
    fakeSandbox().seedSandbox(ws.sandboxName, { status: "stopped", ports: [8443, 8448] });

    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "reconnect" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("workspace_stopped");
    expect((await row(ws.id)).state).toBe("stopped");
    expect(recordedRuns()).toEqual([]);
  });

  it("reconciles a running row that lost its hosts", async () => {
    const ws = await runningWorkspace({ currentWsHost: null, currentHealthHost: null });
    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(202);
    expect((await row(ws.id)).stateReason).toBe("lost:no_session");
  });

  it("names a sandbox the backend no longer knows when its listener is gone too", async () => {
    const ws = await runningWorkspace();
    // Nothing seeded: the fake's `get` answers null; the probe still decides.
    stubHealth(null);
    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(202);
    expect((await row(ws.id)).stateReason).toBe("lost:sandbox_missing");
  });

  it("trusts a healthy probe over a backend that does not know the sandbox", async () => {
    const ws = await runningWorkspace();
    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(200);
    expect((await row(ws.id)).state).toBe("running");
  });

  it("leaves a healthy running workspace alone and mints a token", async () => {
    const ws = await runningWorkspace();
    fakeSandbox().seedSandbox(ws.sandboxName, { status: "running", ports: [8443, 8448] });
    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(200);
    expect((await jsonBody<{ wsUrl: string }>(res)).wsUrl).toBe(`wss://${RPC_HOST}/rpc`);
    expect((await row(ws.id)).state).toBe("running");
    expect(recordedRuns()).toEqual([]);
  });
});
