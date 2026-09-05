import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { clearRequestCookies, ctx, editorCookieFor, jsonBody, req, setRequestCookies } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

const settings = await import("@/app/api/workspaces/[id]/settings/route");
const keymap = await import("@/app/api/workspaces/[id]/keymap/route");

let db: Awaited<ReturnType<typeof routeDb>>;

beforeEach(async () => {
  db = await routeDb();
  resetViewer();
  _resetKvForTests();
  _resetRatelimitForTests();
  clearRequestCookies();
  setViewer(SEED.userId);
});

/**
 * The editor page loads no clerk-js, so once the 60 s Clerk token has expired
 * every `saveDocument` goes out with the `zs_editor` cookie alone. The
 * documents are therefore served under the workspace path the cookie is
 * scoped to (b9 §3.8; CONTRACTS.md §8.2 "Clerk or cookie").
 */
describe("/api/workspaces/{id}/settings and /keymap", () => {
  it("reads and writes the viewer's documents with the editor cookie after Clerk is gone", async () => {
    const ws = await seedWorkspace(db);
    setViewer(null);
    setRequestCookies(await editorCookieFor(SEED.userId, ws.id));

    const initial = await settings.GET(req("GET", `/api/workspaces/${ws.id}/settings`), ctx({ id: ws.id }));
    expect(initial.status).toBe(200);
    expect(await jsonBody(initial)).toMatchObject({ version: 0 });

    const written = await settings.PUT(
      req("PUT", `/api/workspaces/${ws.id}/settings`, { body: { content: '// mine\n{ "theme": "One Dark", }' } }),
      ctx({ id: ws.id }),
    );
    expect(written.status).toBe(200);
    expect(await jsonBody(written)).toMatchObject({ version: 1 });

    const km = await keymap.PUT(
      req("PUT", `/api/workspaces/${ws.id}/keymap`, { body: { content: "[]", version: 0 } }),
      ctx({ id: ws.id }),
    );
    expect(km.status).toBe(200);

    const stale = await settings.PUT(
      req("PUT", `/api/workspaces/${ws.id}/settings`, { body: { content: "{}", version: 0 } }),
      ctx({ id: ws.id }),
    );
    expect(stale.status).toBe(409);
  });

  it("keeps internal cookies workspace-scoped while sharing documents with other viewers", async () => {
    const ws = await seedWorkspace(db);
    const other = await seedWorkspace(db);
    setViewer(null);
    setRequestCookies(await editorCookieFor(SEED.userId, other.id));
    const res = await settings.GET(req("GET", `/api/workspaces/${ws.id}/settings`), ctx({ id: ws.id }));
    expect(res.status).toBe(401);

    setRequestCookies({});
    setViewer(SEED.otherUserId);
    const stranger = await keymap.GET(req("GET", `/api/workspaces/${ws.id}/keymap`), ctx({ id: ws.id }));
    expect(stranger.status).toBe(200);
  });
});
