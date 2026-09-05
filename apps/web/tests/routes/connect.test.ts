import { decodeJwt } from "jose";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { memberships, orgs, sessions, workspaces } from "@/lib/schema";
import { verifySessionToken } from "@/lib/tokens";
import type { ConnectInfo } from "@/lib/types";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { recordedRuns, resetLifecycle } from "../helpers/lifecycle-mock";
import {
  clearRequestCookies,
  ctx,
  editorCookieFor,
  errorBody,
  jsonBody,
  req,
  setRequestCookies,
} from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("@/lib/lifecycle", async () => (await import("../helpers/lifecycle-mock")).createLifecycleMock());
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

// The resume path polls the workspace row; shorten both waits so the 202 case
// does not spend 45 s of real time.
process.env.ZS_CONNECT_RESUME_WAIT_MS = "0";
process.env.ZS_CONNECT_POLL_MS = "1";

const { POST } = await import("@/app/api/workspaces/[id]/connect/route");

const RPC_HOST = "sb-1-8443.fake.vercel.run";
const HEALTH_HOST = "sb-1-8448.fake.vercel.run";

let db: Awaited<ReturnType<typeof routeDb>>;
const realFetch = globalThis.fetch;

/** A healthy non-loopback `/health` body as `zs-agent` serves it (b8 §4.4). */
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

function stubHealth(body: unknown | null, status = 200): void {
  globalThis.fetch = vi.fn(async () =>
    body === null
      ? new Response(null, { status: 502 })
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
    ...overrides,
  });
}

const tab = { tabId: "tab-aaaaaaaa" };

beforeEach(async () => {
  db = await routeDb();
  resetViewer();
  resetLifecycle();
  _resetKvForTests();
  _resetRatelimitForTests();
  setViewer(SEED.userId);
  clearRequestCookies();
  stubHealth(healthBody());
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("POST /api/workspaces/{id}/connect", () => {
  it("mints a fresh per-connect session id whose claims name the workspace", async () => {
    const ws = await runningWorkspace();
    const res = await POST(
      req("POST", `/api/workspaces/${ws.id}/connect`, { body: { ...tab, reason: "open" } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(200);
    const info = await jsonBody<ConnectInfo>(res);

    expect(info.wsUrl).toBe(`wss://${RPC_HOST}/rpc`);
    expect(info.workspaceId).toBe(ws.id);
    expect(info.sessionId).toMatch(/^con_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(info.sessionId).not.toBe(ws.id);
    expect(info.audience).toBe(ws.audience);

    const claims = await verifySessionToken(info.token, { audience: ws.audience, workspaceId: ws.id });
    expect(claims.ws).toBe(ws.id);
    expect(claims.sid).toBe(info.sessionId);
    expect(claims.sub).toBe(SEED.userId);
    expect(new Date(claims.exp * 1000).toISOString()).toBe(info.sessionExpiresAt);

    const [row] = await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id));
    expect(row.tokensMinted).toBe(1);
    expect(row.lastConnectId).toBe(info.sessionId);
    expect(row.holderTabId).toBe(tab.tabId);
  });

  it("rotates the session id on every call and records the latest", async () => {
    const ws = await runningWorkspace();
    const first = await jsonBody<ConnectInfo>(
      await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id })),
    );
    const second = await jsonBody<ConnectInfo>(
      await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id })),
    );
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(decodeJwt(second.token).sid).toBe(second.sessionId);

    const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].lastConnectId).toBe(second.sessionId);
    expect(rows[0].tokensMinted).toBe(2);
  });

  it("reuses the session for the same tab and refuses a second tab without takeover", async () => {
    const ws = await runningWorkspace();
    await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));

    const sameTab = await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));
    expect(sameTab.status).toBe(200);

    const otherTab = await POST(req("POST", "/c", { body: { tabId: "tab-bbbbbbbb" } }), ctx({ id: ws.id }));
    expect(otherTab.status).toBe(409);
    expect((await errorBody(otherTab)).code).toBe("session_active");
  });

  it("takes the session over and closes the previous holder's row", async () => {
    await db.insert(orgs).values({ id: "org_1", slug: "acme", name: "Acme" });
    await db.insert(memberships).values([
      { orgId: "org_1", userId: SEED.userId, role: "owner" },
      { orgId: "org_1", userId: SEED.otherUserId, role: "admin" },
    ]);
    const ws = await runningWorkspace({ orgId: "org_1" });
    await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));
    const [first] = await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id));

    setViewer(SEED.otherUserId);
    const res = await POST(
      req("POST", "/c", { body: { tabId: "tab-bbbbbbbb", takeover: true } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(200);

    const [closed] = await db.select().from(sessions).where(eq(sessions.id, first.id));
    expect(closed.endReason).toBe("takeover");
    expect(closed.endedAt).not.toBeNull();
    const open = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, ws.id), isNull(sessions.endedAt)));
    expect(open).toHaveLength(1);
    expect(open[0].userId).toBe(SEED.otherUserId);
  });

  it("refuses a client build that does not match the workspace's bundle", async () => {
    const ws = await runningWorkspace();
    const res = await POST(
      req("POST", "/c", { body: { ...tab, clientBuild: "other-build" } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(409);
    const err = await errorBody(res);
    expect(err.code).toBe("client_build_mismatch");
    expect(err.details).toMatchObject({ clientBuild: "test-0" });
  });

  it("still connects a workspace on an older client build than ZS_CLIENT_BUILD_ID, and a dev bundle anywhere", async () => {
    const older = await runningWorkspace({ clientBuild: "older-1", serverBuild: "older-1" });
    const ok = await POST(req("POST", "/c", { body: { ...tab, clientBuild: "older-1" } }), ctx({ id: older.id }));
    expect(ok.status).toBe(200);
    const dev = await POST(
      req("POST", "/c", { body: { tabId: "tab-devdevdev", clientBuild: "dev-local", takeover: true } }),
      ctx({ id: older.id }),
    );
    expect(dev.status).toBe(200);
  });

  it("allows anyone in the public space to attach to a legacy org workspace", async () => {
    await db.insert(orgs).values({ id: "org_1", slug: "acme", name: "Acme" });
    await db.insert(memberships).values([
      { orgId: "org_1", userId: SEED.userId, role: "owner" },
      { orgId: "org_1", userId: SEED.otherUserId, role: "member" },
    ]);
    const ws = await runningWorkspace({ orgId: "org_1" });
    setViewer(SEED.otherUserId);
    const res = await POST(req("POST", "/c", { body: { tabId: "tab-bbbbbbbb", takeover: true } }), ctx({ id: ws.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).workspaceId).toBe(ws.id);
  });

  it("two first connects race to one sessions row", async () => {
    const ws = await runningWorkspace();
    const [a, b] = await Promise.all([
      POST(req("POST", "/c", { body: { tabId: "tab-aaaaaaaa" } }), ctx({ id: ws.id })),
      POST(req("POST", "/c", { body: { tabId: "tab-aaaaaaaa" } }), ctx({ id: ws.id })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id));
    expect(rows).toHaveLength(1);
  });

  it("never resumes a flagged owner's workspace", async () => {
    const { users } = await import("@/lib/schema");
    await db.update(users).set({ flaggedAt: new Date() }).where(eq(users.id, SEED.userId));
    const ws = await seedWorkspace(db, { state: "stopped" });
    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("account_flagged");
    expect(recordedRuns()).toHaveLength(0);
  });

  it("never resumes a stopped workspace for a reconnecting tab", async () => {
    const ws = await seedWorkspace(db, { state: "stopped" });
    const res = await POST(
      req("POST", "/c", { body: { ...tab, reason: "reconnect" } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("workspace_stopped");
    expect(recordedRuns()).toHaveLength(0);
  });

  it("starts connectWorkspace for an explicit open and answers 202 while it runs", async () => {
    const ws = await seedWorkspace(db, { state: "stopped" });
    const res = await POST(req("POST", "/c", { body: { ...tab, reason: "open" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(202);
    expect(await jsonBody(res)).toEqual({ status: "resuming", runId: "run_1" });
    expect(recordedRuns()[0].name).toBe("connectWorkspace");
  });

  it("answers 423 while a lifecycle run is in flight, then 200 once the row is running", async () => {
    const ws = await runningWorkspace({ state: "stopping", workflowRunId: "run_9" });
    const busy = await POST(
      req("POST", "/c", { body: { ...tab, reason: "reconnect" } }),
      ctx({ id: ws.id }),
    );
    expect(busy.status).toBe(423);
    expect((await errorBody(busy)).code).toBe("workspace_busy");

    await db
      .update(workspaces)
      .set({ state: "running", workflowRunId: null })
      .where(eq(workspaces.id, ws.id));
    const ok = await POST(req("POST", "/c", { body: { ...tab, reason: "reconnect" } }), ctx({ id: ws.id }));
    expect(ok.status).toBe(200);
  });

  it("reports an unhealthy supervisor instead of minting a token", async () => {
    const ws = await runningWorkspace();
    stubHealth(healthBody({ status: "booting", server: { running: false } }), 503);
    const res = await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));
    expect(res.status).toBe(500);
    expect((await errorBody(res)).code).toBe("sandbox_unhealthy");
  });

  it("accepts the editor cookie when the Clerk session is gone, and only for its own workspace", async () => {
    const ws = await runningWorkspace();
    const other = await runningWorkspace();
    setViewer(null);

    setRequestCookies(await editorCookieFor(SEED.userId, ws.id));
    const ok = await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));
    expect(ok.status).toBe(200);

    setRequestCookies(await editorCookieFor(SEED.userId, other.id));
    const wrong = await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));
    expect(wrong.status).toBe(401);
  });

  it("410s a deleted workspace", async () => {
    const ws = await runningWorkspace({ deletedAt: new Date() });
    const res = await POST(req("POST", "/c", { body: { ...tab } }), ctx({ id: ws.id }));
    expect(res.status).toBe(410);
  });
});
