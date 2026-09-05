import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxySlots } from "@/lib/env";
import { PORT_BOOTSTRAP_TTL_SECS, portAudience, verifyPortBootstrapToken } from "@/lib/port-token";
import { _resetKvForTests } from "@/lib/kv";
import { forwards } from "@/lib/schema";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { clearRequestCookies, ctx, errorBody, req } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

const { GET } = await import("@/app/api/workspaces/[id]/ports/[port]/open/route");

let db: Awaited<ReturnType<typeof routeDb>>;
const SLOT = proxySlots()[0];
const SLOT_HOST = `sb-1-${SLOT}.fake.vercel.run`;

beforeEach(async () => {
  db = await routeDb();
  resetViewer();
  _resetKvForTests();
  clearRequestCookies();
  setViewer(SEED.userId);
});

async function workspaceWithForward(visibility: "private" | "public", state = "running" as const) {
  const ws = await seedWorkspace(db, {
    state,
    currentSlotHosts: { [String(SLOT)]: SLOT_HOST },
  });
  await db.insert(forwards).values({
    workspaceId: ws.id,
    port: 3000,
    visibility,
    url: visibility === "private" ? `https://zs.test/api/workspaces/${ws.id}/ports/3000/open` : "https://x",
    slot: visibility === "private" ? SLOT : null,
  });
  return ws;
}

describe("GET /api/workspaces/{id}/ports/{port}/open", () => {
  it("redirects to the slot host's bootstrap endpoint with a port-scoped token", async () => {
    const ws = await workspaceWithForward("private");
    const res = await GET(req("GET", "/open"), ctx({ id: ws.id, port: "3000" }));

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe(`https://${SLOT_HOST}`);
    expect(location.pathname).toBe("/__zs/auth");
    expect(location.searchParams.get("next")).toBe("/");

    const token = location.searchParams.get("zs_port_token") ?? "";
    const { port, claims } = await verifyPortBootstrapToken(token, {
      audience: ws.audience,
      workspaceId: ws.id,
    });
    expect(port).toBe(3000);
    expect(claims.sid).toBe("port:3000");
    expect(claims.sub).toBe(SEED.userId);
    expect(claims.aud).toBe(portAudience(ws.audience));
    expect(claims.exp - claims.iat).toBe(PORT_BOOTSTRAP_TTL_SECS);
    // The rpc audience must never accept it (b2 compares `aud` to --audience).
    expect(decodeJwt(token).aud).not.toBe(ws.audience);
  });

  it("404s a public forward and an unknown port", async () => {
    const ws = await workspaceWithForward("public");
    const publicPort = await GET(req("GET", "/open"), ctx({ id: ws.id, port: "3000" }));
    expect(publicPort.status).toBe(404);

    const unknown = await GET(req("GET", "/open"), ctx({ id: ws.id, port: "4000" }));
    expect(unknown.status).toBe(404);
  });

  it("409s while the workspace has no live slot hosts", async () => {
    const ws = await seedWorkspace(db, { state: "stopped", currentSlotHosts: null });
    await db.insert(forwards).values({ workspaceId: ws.id, port: 3000, visibility: "private", slot: SLOT });
    const res = await GET(req("GET", "/open"), ctx({ id: ws.id, port: "3000" }));
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("workspace_not_running");
  });

  it("refuses an infrastructure port outright", async () => {
    const ws = await workspaceWithForward("private");
    const res = await GET(req("GET", "/open"), ctx({ id: ws.id, port: "8443" }));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("infra_port");
  });

  it("opens a proxy forward for another viewer in the shared space", async () => {
    const ws = await workspaceWithForward("private");
    setViewer(SEED.otherUserId);
    const res = await GET(req("GET", "/open"), ctx({ id: ws.id, port: "3000" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("zs_port_token=");
  });
});
