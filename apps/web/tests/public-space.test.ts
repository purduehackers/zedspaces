import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireViewer, requireWorkspaceAccess } from "@/lib/auth";
import { _resetEnvForTests } from "@/lib/env";
import { _resetKvForTests } from "@/lib/kv";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { parsePublicRepo } from "@/lib/github-repo";
import { users, workspaces } from "@/lib/schema";
import { buildManifest } from "@/lib/manifest";
import { routeDb, seedWorkspace, SEED } from "./helpers/route-db";
import { resetGithub } from "./helpers/github-mock";
import { resetLifecycle, recordedRuns } from "./helpers/lifecycle-mock";
import { ctx, req } from "./helpers/request";

// Only the remote forge and workflow execution are fake: the public viewer and SQL are real.
vi.mock("@/lib/github", async () => (await import("./helpers/github-mock")).createGithubMock());
vi.mock("@/lib/lifecycle", async () => (await import("./helpers/lifecycle-mock")).createLifecycleMock());
const workspacesRoute = await import("@/app/api/workspaces/route");
const newRoute = await import("@/app/new/[owner]/[repo]/route");
const { default: proxy } = await import("@/proxy");

beforeEach(async () => {
  process.env.ZS_MAX_RUNNING_WORKSPACES = "5";
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  _resetEnvForTests(); _resetKvForTests(); _resetRatelimitForTests();
  resetGithub(); resetLifecycle();
  await routeDb();
});

describe("shared public space", () => {
  it("resolves the same implicit viewer without cookies, including concurrent cold starts", async () => {
    const viewers = await Promise.all(Array.from({ length: 8 }, () => requireViewer()));
    expect(new Set(viewers.map((v) => v.userId))).toEqual(new Set(["user_public"]));
    expect(viewers[0]).toMatchObject({ via: "open", orgIds: [] });
  });

  it("lists and controls everyone's workspaces; missing and deleted rows still fail", async () => {
    const db = await routeDb();
    const ws = await seedWorkspace(db, { ownerUserId: SEED.otherUserId });
    const viewer = await requireViewer();
    expect((await requireWorkspaceAccess(viewer, ws.id, { control: true })).id).toBe(ws.id);
    const list = await workspacesRoute.GET(req("GET", "/api/workspaces"), ctx({}));
    expect((await list.json()).workspaces.map((w: { id: string }) => w.id)).toContain(ws.id);
    await expect(requireWorkspaceAccess(viewer, "missing")).rejects.toMatchObject({ status: 404 });
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, ws.id));
    await expect(requireWorkspaceAccess(viewer, ws.id)).rejects.toMatchObject({ status: 410 });
  });

  it("creates and de-duplicates a public repository without an installation ID or credentials", async () => {
    const input = { repo: { owner: "test", name: "repo" }, ref: { branch: "main" } };
    const make = () => workspacesRoute.POST(req("POST", "/api/workspaces", { body: input, headers: { "Idempotency-Key": "public-create" } }), ctx({}));
    const first = await make();
    expect(first.status).toBe(202);
    const value = await first.json();
    const second = await make();
    expect((await second.json()).workspace.id).toBe(value.workspace.id);
    expect(recordedRuns()).toHaveLength(1);
  });

  it("enforces the shared cap atomically even when creates race", async () => {
    process.env.ZS_MAX_RUNNING_WORKSPACES = "2";
    _resetEnvForTests();
    const results = await Promise.all(Array.from({ length: 6 }, () => workspacesRoute.POST(
      req("POST", "/api/workspaces", { body: { repo: { owner: "test", name: "repo" } } }), ctx({}))));
    expect(results.filter((r) => r.status === 202)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
  });

  it("always clones onto the base image with no custom build workflow", async () => {
    const response = await workspacesRoute.POST(req("POST", "/api/workspaces", { body: { repo: { owner: "test", name: "repo" } } }), ctx({}));
    expect(response.status).toBe(202);
    expect(recordedRuns().map((r) => r.name)).toEqual(["createWorkspace"]);
    const { dbReady } = await import("@/lib/db");
    const db = await dbReady();
    const [workspace] = await db.select().from(workspaces);
    const manifest = await buildManifest({ kind: "workspace", workspace, sandboxName: workspace.sandboxName, tokenGeneration: workspace.sandboxTokenGeneration });
    expect(manifest.devcontainer).toBeNull();
  });

  it("opens /new/owner/repo with a 303 and prevents HEAD or prefetch from creating", async () => {
    expect(newRoute.HEAD().status).toBe(405);
    const params = ctx({ owner: "test", repo: "repo" });
    const prefetch = await newRoute.GET(req("GET", "/new/test/repo", { headers: { purpose: "prefetch" } }), params);
    expect(prefetch.status).toBe(400);
    expect(recordedRuns()).toHaveLength(0);
    const response = await newRoute.GET(req("GET", "/new/test/repo?branch=main"), params);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^https:\/\/zs.test\/w\/ws_/);
    expect(recordedRuns()).toHaveLength(1);
  });

  it("honors a disabled shared principal", async () => {
    await requireViewer();
    const db = await routeDb();
    await requireViewer();
    await db.update(users).set({ deletedAt: new Date() }).where(and(eq(users.id, "user_public")));
    await expect(requireViewer()).rejects.toMatchObject({ status: 403 });
  });
});

describe("public URL and origin guards", () => {
  it("refreshes an expired editor session by reloading the public document, never a login page", async () => {
    const { sessionReloadUrl } = await import("@/app/(editor)/w/[id]/api-client");
    expect(sessionReloadUrl("/w/ws_example")).toBe("/w/ws_example");
    expect(sessionReloadUrl("https://evil.test")).toBe("/");
  });
  it("accepts only public GitHub repo locators", () => {
    expect(parsePublicRepo("https://github.com/octocat/Hello-World.git")).toEqual({ owner: "octocat", name: "Hello-World" });
    expect(parsePublicRepo("zed-industries/zed").name).toBe("zed");
    for (const value of ["https://evil.test/a/b", "https://u:p@github.com/a/b", "https://github.com/a/b/tree/main", "a/..", "../b", "a/b?x"]) {
      expect(() => parsePublicRepo(value)).toThrow();
    }
  });

  it("does not redirect public pages to login", async () => {
    const response = await proxy(new NextRequest("https://zs.test/workspaces"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("accepts browser-facing Host even when Next normalizes nextUrl; rejects foreign origins", async () => {
    const make = (origin: string) => new NextRequest("http://localhost:3110/api/workspaces", {
      method: "POST", headers: { host: "127.0.0.1:3110", origin, "sec-fetch-site": "same-origin" },
    });
    expect((await proxy(make("http://127.0.0.1:3110"))).status).toBe(200);
    expect((await proxy(make("https://evil.test"))).status).toBe(403);
  });
});
