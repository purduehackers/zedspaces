import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_COOKIE, verifyEditorCookie } from "@/lib/editor-cookie";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests, keys, kv } from "@/lib/kv";
import { auditLog } from "@/lib/schema";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { lifecycleState, recordedRuns, resetLifecycle } from "../helpers/lifecycle-mock";
import { clearRequestCookies, ctx, errorBody, jsonBody, req } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("@/lib/lifecycle", async () => (await import("../helpers/lifecycle-mock")).createLifecycleMock());
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

const stop = await import("@/app/api/workspaces/[id]/stop/route");
const rebuild = await import("@/app/api/workspaces/[id]/rebuild/route");
const keepalive = await import("@/app/api/workspaces/[id]/keepalive/route");
const session = await import("@/app/api/workspaces/[id]/session/route");
const clientErrors = await import("@/app/api/workspaces/[id]/client-errors/route");

let db: Awaited<ReturnType<typeof routeDb>>;

beforeEach(async () => {
  db = await routeDb();
  resetViewer();
  resetLifecycle();
  _resetKvForTests();
  _resetRatelimitForTests();
  clearRequestCookies();
  setViewer(SEED.userId);
});

describe("POST /api/workspaces/{id}/stop", () => {
  it("starts stopWorkspace with reason user and audits it", async () => {
    const ws = await seedWorkspace(db, { state: "running" });
    const res = await stop.POST(req("POST", "/stop"), ctx({ id: ws.id }));
    expect(res.status).toBe(202);
    expect(recordedRuns()[0]).toMatchObject({ name: "stopWorkspace", args: { workspaceId: ws.id, reason: "user" } });

    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, ws.id));
    expect(audits.map((row) => row.action)).toContain("workspace.stop");
  });

  it("is a no-op for an already stopped workspace", async () => {
    const ws = await seedWorkspace(db, { state: "stopped" });
    lifecycleState().status = "completed";
    const res = await stop.POST(req("POST", "/stop"), ctx({ id: ws.id }));
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ state: "stopped" });
    expect(recordedRuns()).toHaveLength(0);
  });
});

describe("POST /api/workspaces/{id}/rebuild", () => {
  it("starts a base-image rebuild; ignores the legacy fromImage option", async () => {
    const ws = await seedWorkspace(db);
    const res = await rebuild.POST(req("POST", "/rebuild", { body: { fromImage: true } }), ctx({ id: ws.id }));
    expect(res.status).toBe(202);
    expect(recordedRuns()[0]).toMatchObject({
      name: "rebuildWorkspace",
      args: { workspaceId: ws.id, userId: SEED.userId },
    });
  });

  it("refuses while a lifecycle run is in flight", async () => {
    const ws = await seedWorkspace(db, { workflowRunId: "run_9" });
    lifecycleState().status = "running";
    const res = await rebuild.POST(req("POST", "/rebuild", { body: {} }), ctx({ id: ws.id }));
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("workspace_busy");
  });
});

describe("POST /api/workspaces/{id}/keepalive", () => {
  it("writes the keepalive key with the workspace's idle budget", async () => {
    const ws = await seedWorkspace(db, { idleMinutes: 45 });
    const before = Date.now();
    const res = await keepalive.POST(req("POST", "/keepalive"), ctx({ id: ws.id }));
    expect(res.status).toBe(200);

    const body = await jsonBody<{ keptAliveUntil: string }>(res);
    const until = new Date(body.keptAliveUntil).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(await kv().get(keys.keepalive(ws.id))).not.toBeNull();
  });
});

describe("POST /api/workspaces/{id}/session", () => {
  it("renews from a cookie without extending its lineage, and refuses a cookie from a revoked epoch", async () => {
    const { users } = await import("@/lib/schema");
    const { editorCookieFor, setRequestCookies } = await import("../helpers/request");
    const { decodeJwt } = await import("jose");
    const { mintEditorCookie } = await import("@/lib/editor-cookie");
    const ws = await seedWorkspace(db);
    setViewer(null);

    // A cookie whose lineage began 23.5 h ago renews only until the 24 h mark.
    const origin = Math.floor(Date.now() / 1000) - 23.5 * 3600;
    const aged = await mintEditorCookie(SEED.userId, ws.id, { originIat: origin });
    setRequestCookies({ [EDITOR_COOKIE]: aged.value });
    const renewed = await session.POST(req("POST", `/api/workspaces/${ws.id}/session`), ctx({ id: ws.id }));
    expect(renewed.status).toBe(204);
    const value = (renewed.headers.get("set-cookie") ?? "").slice(`${EDITOR_COOKIE}=`.length).split(";")[0];
    const claims = decodeJwt(value);
    expect(claims.oi).toBe(origin);
    expect((claims.exp as number) - origin).toBeLessThanOrEqual(24 * 3600);

    // A Clerk sign-out bumped the epoch: the old cookie is no longer accepted.
    setRequestCookies(await editorCookieFor(SEED.userId, ws.id));
    await db.update(users).set({ authEpoch: 1 }).where(eq(users.id, SEED.userId));
    const stale = await session.POST(req("POST", `/api/workspaces/${ws.id}/session`), ctx({ id: ws.id }));
    expect(stale.status).toBe(401);
  });

  it("re-mints the editor cookie scoped to that workspace", async () => {
    const ws = await seedWorkspace(db);
    const res = await session.POST(req("POST", "/session"), ctx({ id: ws.id }));
    expect(res.status).toBe(204);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${EDITOR_COOKIE}=`);
    expect(cookie).toContain(`Path=/api/workspaces/${ws.id}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const value = cookie.slice(`${EDITOR_COOKIE}=`.length).split(";")[0];
    const claims = await verifyEditorCookie({ get: () => ({ value }) }, ws.id);
    expect(claims?.sub).toBe(SEED.userId);
  });
});

describe("POST /api/workspaces/{id}/client-errors", () => {
  it("accepts shell reports from everyone in the shared space", async () => {
    const ws = await seedWorkspace(db);
    const body = { build: "test-0", kind: "panic", message: "boom", stack: "at foo" };
    const res = await clientErrors.POST(req("POST", "/client-errors", { body }), ctx({ id: ws.id }));
    expect(res.status).toBe(202);

    setViewer(SEED.otherUserId);
    const stranger = await clientErrors.POST(req("POST", "/client-errors", { body }), ctx({ id: ws.id }));
    expect(stranger.status).toBe(202);
  });

  it("rejects an unknown report kind", async () => {
    const ws = await seedWorkspace(db);
    const res = await clientErrors.POST(
      req("POST", "/client-errors", { body: { build: "test-0", kind: "whatever", message: "x" } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(400);
  });
});
