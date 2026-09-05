import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxySlots } from "@/lib/env";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { forwards } from "@/lib/schema";
import type { ForwardView } from "@/lib/types";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { lifecycleState, resetLifecycle } from "../helpers/lifecycle-mock";
import { clearRequestCookies, ctx, errorBody, jsonBody, req } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("@/lib/lifecycle", async () => (await import("../helpers/lifecycle-mock")).createLifecycleMock());
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

const { GET, POST, DELETE } = await import("@/app/api/workspaces/[id]/ports/route");

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

async function workspace() {
  return seedWorkspace(db, {
    state: "running",
    currentWsHost: "sb-1-8443.fake.vercel.run",
    currentSlotHosts: Object.fromEntries(
      proxySlots().map((slot) => [String(slot), `sb-1-${slot}.fake.vercel.run`]),
    ),
  });
}

async function forward(id: string, port: number, visibility: "private" | "public" = "private") {
  return POST(
    req("POST", `/api/workspaces/${id}/ports`, { body: { port, visibility } }),
    ctx({ id }),
  );
}

describe("POST /api/workspaces/{id}/ports", () => {
  it("gives a private forward the first free proxy slot and the /open link", async () => {
    const ws = await workspace();
    const res = await forward(ws.id, 3000);
    expect(res.status).toBe(200);
    const { forward: view } = await jsonBody<{ forward: ForwardView }>(res);

    expect(view).toMatchObject({ port: 3000, visibility: "private", slot: proxySlots()[0] });
    expect(view.url).toBe(`https://zs.test/api/workspaces/${ws.id}/ports/3000/open`);

    const [row] = await db.select().from(forwards).where(eq(forwards.workspaceId, ws.id));
    expect(row.slot).toBe(proxySlots()[0]);
    expect(row.visibility).toBe("private");
  });

  it("hands out all four slots in order and refuses a fifth private forward", async () => {
    const ws = await workspace();
    const ports = [3000, 3001, 4000, 5000];
    for (const [index, port] of ports.entries()) {
      const res = await forward(ws.id, port);
      const { forward: view } = await jsonBody<{ forward: ForwardView }>(res);
      expect(view.slot).toBe(proxySlots()[index]);
    }

    const fifth = await forward(ws.id, 5173);
    expect(fifth.status).toBe(409);
    expect((await errorBody(fifth)).code).toBe("no_free_slot");
  });

  it("frees the slot on delete so the next private forward reuses it", async () => {
    const ws = await workspace();
    await forward(ws.id, 3000);
    const removed = await DELETE(
      req("DELETE", `/api/workspaces/${ws.id}/ports?port=3000`),
      ctx({ id: ws.id }),
    );
    expect(removed.status).toBe(204);

    const again = await forward(ws.id, 4000);
    const { forward: view } = await jsonBody<{ forward: ForwardView }>(again);
    expect(view.slot).toBe(proxySlots()[0]);
  });

  it("re-forwarding the same port keeps its slot", async () => {
    const ws = await workspace();
    const first = await jsonBody<{ forward: ForwardView }>(await forward(ws.id, 3000));
    const second = await jsonBody<{ forward: ForwardView }>(await forward(ws.id, 3000));
    expect(second.forward.slot).toBe(first.forward.slot);
    const rows = await db.select().from(forwards).where(eq(forwards.workspaceId, ws.id));
    expect(rows).toHaveLength(1);
  });

  it("stores the sandbox domain for a public forward and holds no slot", async () => {
    const ws = await workspace();
    lifecycleState().publicUrl = "https://sb-1-3000.fake.vercel.run";
    const res = await forward(ws.id, 3000, "public");
    const { forward: view } = await jsonBody<{ forward: ForwardView }>(res);
    expect(view).toEqual({
      port: 3000,
      visibility: "public",
      label: null,
      url: "https://sb-1-3000.fake.vercel.run",
      slot: null,
    });
  });

  it("refuses a public forward while the sandbox is not running", async () => {
    const ws = await workspace();
    lifecycleState().publicUrl = null;
    const res = await forward(ws.id, 3000, "public");
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("workspace_not_running");
  });

  it("refuses an infrastructure port", async () => {
    const ws = await workspace();
    const res = await forward(ws.id, 8443);
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("infra_port");
  });
});

describe("GET /api/workspaces/{id}/ports", () => {
  it("reports the forwards, the listening ports and the free slots", async () => {
    const ws = await workspace();
    await forward(ws.id, 3000);
    lifecycleState().listening = [3000, 5173];

    const res = await GET(req("GET", `/api/workspaces/${ws.id}/ports`), ctx({ id: ws.id }));
    const body = await jsonBody<{ ports: ForwardView[]; listening: number[]; slotsFree: number }>(res);
    expect(body.ports).toHaveLength(1);
    expect(body.listening).toEqual([3000, 5173]);
    expect(body.slotsFree).toBe(3);
  });
});
