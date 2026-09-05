import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { memberships, orgs, repos, users, workspaces } from "@/lib/schema";
import { _resetEnvForTests } from "@/lib/env";
import type { WorkspaceView } from "@/lib/types";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { resetGithub } from "../helpers/github-mock";
import { lifecycleState, recordedRuns, resetLifecycle } from "../helpers/lifecycle-mock";
import { ctx, errorBody, jsonBody, req } from "../helpers/request";
import { routeDb, SEED, seedWorkspace } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("@/lib/github", async () => (await import("../helpers/github-mock")).createGithubMock());
vi.mock("@/lib/lifecycle", async () => (await import("../helpers/lifecycle-mock")).createLifecycleMock());

const { GET, POST } = await import("@/app/api/workspaces/route");
const detail = await import("@/app/api/workspaces/[id]/route");

let db: Awaited<ReturnType<typeof routeDb>>;

beforeEach(async () => {
  process.env.ZS_MAX_RUNNING_WORKSPACES = "1";
  _resetEnvForTests();
  db = await routeDb();
  resetViewer();
  resetGithub();
  resetLifecycle();
  _resetKvForTests();
  _resetRatelimitForTests();
  setViewer(SEED.userId);
});

const createBody = { repo: { repoId: SEED.repoId }, ref: { branch: "main" } };

describe("POST /api/workspaces", () => {
  it("reserves a creating row and starts createWorkspace", async () => {
    const res = await POST(req("POST", "/api/workspaces", { body: createBody }), ctx({}));
    expect(res.status).toBe(202);
    const body = await jsonBody<{ workspace: WorkspaceView; runId: string }>(res);

    expect(body.workspace.state).toBe("creating");
    expect(body.workspace.repo.owner).toBe("test");
    expect(body.workspace.branch).toBe("main");
    expect(body.workspace.revision).toBe("a".repeat(40));
    expect(body.runId).toBe("run_1");

    const runs = recordedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].name).toBe("createWorkspace");
    expect(runs[0].args).toEqual({ workspaceId: body.workspace.id, userId: SEED.userId });

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, body.workspace.id));
    expect(row.state).toBe("creating");
    expect(row.sandboxName).toBe(`sb-dev-${row.id.slice(3).toLowerCase()}-g1`);
    expect(row.audience).toBe(row.sandboxName);
    expect(row.serverBuild).toBe("test-0");
    expect(row.clientBuild).toBe("test-0");
  });

  it("records a pull-request ref as refs/pull/N/head", async () => {
    const res = await POST(
      req("POST", "/api/workspaces", { body: { repo: { repoId: SEED.repoId }, ref: { pullRequest: 7 } } }),
      ctx({}),
    );
    const body = await jsonBody<{ workspace: WorkspaceView }>(res);
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, body.workspace.id));
    expect(row.gitRef).toBe("refs/pull/7/head");
    expect(row.pullRequest).toBe(7);
  });

  it("refuses a machine above the public 8-vCPU ceiling", async () => {
    const res = await POST(
      req("POST", "/api/workspaces", { body: { ...createBody, machine: "vcpu32" } }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("invalid_machine");
  });

  it("refuses a create past the shared workspace budget", async () => {
    await seedWorkspace(db, { state: "running" });
    const res = await POST(req("POST", "/api/workspaces", { body: createBody }), ctx({}));
    expect(res.status).toBe(429);
    expect((await errorBody(res)).code).toBe("workspace_limit");
  });

  it("refuses a flagged account", async () => {
    await db.update(users).set({ flaggedAt: new Date() }).where(eq(users.id, SEED.userId));
    const res = await POST(req("POST", "/api/workspaces", { body: createBody }), ctx({}));
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("account_flagged");
  });

  it("refuses a legacy private repository", async () => {
    await db.update(repos).set({ private: true }).where(eq(repos.id, SEED.repoId));
    const res = await POST(req("POST", "/api/workspaces", { body: createBody }), ctx({}));
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("repo_not_found");
  });

  it("replays an Idempotency-Key instead of creating a second workspace", async () => {
    const headers = { "idempotency-key": "key-1" };
    const first = await POST(req("POST", "/api/workspaces", { body: createBody, headers }), ctx({}));
    const second = await POST(req("POST", "/api/workspaces", { body: createBody, headers }), ctx({}));

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.clone().text()).toBe(await first.clone().text());
    expect(second.headers.get("idempotent-replayed")).toBe("true");

    const rows = await db.select().from(workspaces);
    expect(rows).toHaveLength(1);
    expect(recordedRuns()).toHaveLength(1);
  });

  it("does not replay a refusal under the same Idempotency-Key", async () => {
    await db.update(users).set({ plan: "free" }).where(eq(users.id, SEED.userId));
    const busy = await seedWorkspace(db, { state: "running" });
    const headers = { "idempotency-key": "key-2" };
    const refused = await POST(req("POST", "/api/workspaces", { body: createBody, headers }), ctx({}));
    expect(refused.status).toBe(429);
    // The other workspace stops: the same key must now succeed rather than replay the 402.
    await db.update(workspaces).set({ state: "stopped" }).where(eq(workspaces.id, busy.id));
    const retried = await POST(req("POST", "/api/workspaces", { body: createBody, headers }), ctx({}));
    expect(retried.status).toBe(202);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
  });
});

describe("GET /api/workspaces", () => {
  it("lists everyone's workspaces, excluding deleted rows", async () => {
    await db.insert(orgs).values({ id: "org_1", slug: "acme", name: "Acme" });
    await db.insert(memberships).values({ orgId: "org_1", userId: SEED.userId, role: "member" });
    const mine = await seedWorkspace(db, { name: "mine" });
    const teammate = await seedWorkspace(db, { name: "team", ownerUserId: SEED.otherUserId, orgId: "org_1" });
    await seedWorkspace(db, { name: "stranger", ownerUserId: SEED.otherUserId });
    await seedWorkspace(db, { name: "gone", deletedAt: new Date() });

    const res = await GET(req("GET", "/api/workspaces"), ctx({}));
    const body = await jsonBody<{ workspaces: WorkspaceView[] }>(res);
    const ids = body.workspaces.map((view) => view.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(teammate.id);
    expect(ids).toHaveLength(3);
  });
});

describe("/api/workspaces/[id]", () => {
  it("shares a workspace originally created by somebody else", async () => {
    const other = await seedWorkspace(db, { ownerUserId: SEED.otherUserId });
    const res = await detail.GET(req("GET", `/api/workspaces/${other.id}`), ctx({ id: other.id }));
    expect(res.status).toBe(200);
  });

  it("404s a malformed id without touching the database", async () => {
    const res = await detail.GET(req("GET", "/api/workspaces/nope"), ctx({ id: "nope" }));
    expect(res.status).toBe(404);
  });

  it("rejects an idle timeout below the allowed range", async () => {
    const ws = await seedWorkspace(db);
    const res = await detail.PATCH(
      req("PATCH", `/api/workspaces/${ws.id}`, { body: { idleMinutes: 3 } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("invalid_body");
  });

  it("renames and clamps the idle timeout", async () => {
    const ws = await seedWorkspace(db);
    const res = await detail.PATCH(
      req("PATCH", `/api/workspaces/${ws.id}`, { body: { name: "renamed", idleMinutes: 45 } }),
      ctx({ id: ws.id }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ workspace: WorkspaceView }>(res);
    expect(body.workspace.name).toBe("renamed");
    expect(body.workspace.idleMinutes).toBe(45);
  });

  it("starts deleteWorkspace, blocks a second delete while the run lives, and allows it once terminal", async () => {
    const ws = await seedWorkspace(db);
    const first = await detail.DELETE(req("DELETE", `/api/workspaces/${ws.id}`), ctx({ id: ws.id }));
    expect(first.status).toBe(202);
    expect(recordedRuns()[0].name).toBe("deleteWorkspace");

    // The workflow layer records its run id on the row.
    await db.update(workspaces).set({ workflowRunId: "run_1" }).where(eq(workspaces.id, ws.id));
    lifecycleState().status = "running";
    const second = await detail.DELETE(req("DELETE", `/api/workspaces/${ws.id}`), ctx({ id: ws.id }));
    expect(second.status).toBe(409);
    expect((await errorBody(second)).code).toBe("workspace_busy");

    lifecycleState().status = "failed";
    const third = await detail.DELETE(req("DELETE", `/api/workspaces/${ws.id}`), ctx({ id: ws.id }));
    expect(third.status).toBe(202);
  });
});
