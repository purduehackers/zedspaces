import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvForTests, EnvError } from "@/lib/env";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { readWorkspaceFile, testRoutesEnabled } from "@/lib/test-routes";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { clearRequestCookies, ctx, errorBody, req } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

const { GET, POST } = await import("@/app/api/workspaces/[id]/test-local/route");

/**
 * The test-only route exists only with `ZS_TEST_ROUTES=1` on the local
 * backend and is refused outright in a production build.
 */

let db: Awaited<ReturnType<typeof routeDb>>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  db = await routeDb();
  resetViewer();
  _resetKvForTests();
  _resetRatelimitForTests();
  clearRequestCookies();
  setViewer(SEED.userId);
  for (const key of ["ZS_TEST_ROUTES", "ZS_SANDBOX_BACKEND", "ZS_LOCAL_ROOT", "NODE_ENV"]) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
  _resetEnvForTests();
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zs-test-local-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("/api/workspaces/{id}/test-local", () => {
  it("is 404 without ZS_TEST_ROUTES", async () => {
    delete process.env.ZS_TEST_ROUTES;
    _resetEnvForTests();
    const ws = await seedWorkspace(db);
    const res = await GET(req("GET", "/t"), ctx({ id: ws.id }));
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("not_found");
    const post = await POST(req("POST", "/t", { body: { op: "drop_socket" } }), ctx({ id: ws.id }));
    expect(post.status).toBe(404);
  });

  it("is 404 with the routes on but the sandbox backend not local", async () => {
    process.env.ZS_TEST_ROUTES = "1";
    process.env.ZS_SANDBOX_BACKEND = "vercel";
    _resetEnvForTests();
    const ws = await seedWorkspace(db);
    const res = await GET(req("GET", "/t"), ctx({ id: ws.id }));
    expect(res.status).toBe(404);
  });

  it("is refused in a production build whatever the flag says", () => {
    process.env.ZS_TEST_ROUTES = "1";
    Reflect.set(process.env, "NODE_ENV", "production");
    _resetEnvForTests();
    expect(() => testRoutesEnabled()).toThrow(EnvError);
  });

  it("describes the local sandbox and reads files of the checkout only", async () => {
    process.env.ZS_TEST_ROUTES = "1";
    process.env.ZS_SANDBOX_BACKEND = "local";
    process.env.ZS_LOCAL_ROOT = path.join(tmp, "sandboxes");
    _resetEnvForTests();
    const ws = await seedWorkspace(db);
    const checkout = path.join(process.env.ZS_LOCAL_ROOT, ws.sandboxName, "workspaces", "repo");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "README.md"), "# hi\n");

    const res = await GET(req("GET", "/t"), ctx({ id: ws.id }));
    expect(res.status).toBe(200);
    const info = (await res.json()) as { workspaceDir: string; sandbox: { dir: string; status: string | null; alive: boolean } };
    expect(info.workspaceDir).toBe(checkout);
    expect(info.sandbox.dir).toBe(path.join(process.env.ZS_LOCAL_ROOT, ws.sandboxName));
    expect(info.sandbox.status).toBeNull();
    expect(info.sandbox.alive).toBe(false);

    const file = await POST(req("POST", "/t", { body: { op: "read_file", path: "README.md" } }), ctx({ id: ws.id }));
    expect(file.status).toBe(200);
    expect(((await file.json()) as { content: string }).content).toBe("# hi\n");

    const outside = await POST(req("POST", "/t", { body: { op: "read_file", path: "../../sandbox.json" } }), ctx({ id: ws.id }));
    expect(outside.status).toBe(400);
    expect(() => readWorkspaceFile(checkout, "../x")).toThrow();
    expect(readWorkspaceFile(checkout, "missing.txt")).toBeNull();

    const drop = await POST(req("POST", "/t", { body: { op: "drop_socket" } }), ctx({ id: ws.id }));
    expect(drop.status).toBe(409);
    expect((await errorBody(drop)).code).toBe("rpc_proxy_off");
  });

  it("rejects an unknown op", async () => {
    process.env.ZS_TEST_ROUTES = "1";
    process.env.ZS_SANDBOX_BACKEND = "local";
    process.env.ZS_LOCAL_ROOT = path.join(tmp, "sandboxes");
    _resetEnvForTests();
    const ws = await seedWorkspace(db);
    const res = await POST(req("POST", "/t", { body: { op: "format_disk" } }), ctx({ id: ws.id }));
    expect(res.status).toBe(400);
  });
});
