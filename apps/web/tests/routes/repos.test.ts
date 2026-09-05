import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { repos } from "@/lib/schema";
import { githubState, resetGithub } from "../helpers/github-mock";
import { routeDb, SEED } from "../helpers/route-db";
import { ctx, req } from "../helpers/request";
import { _resetKvForTests } from "@/lib/kv";
import { _resetRatelimitForTests } from "@/lib/ratelimit";

vi.mock("@/lib/github", async () => (await import("../helpers/github-mock")).createGithubMock());
const { GET, POST } = await import("@/app/api/repos/route");

beforeEach(async () => { await routeDb(); resetGithub(); _resetKvForTests(); _resetRatelimitForTests(); });

describe("public repositories", () => {
  it("lists previously registered public repos without GitHub credentials", async () => {
    const result = await GET(req("GET", "/api/repos"), ctx({}));
    expect(result.status).toBe(200);
    expect((await result.json()).repos).toEqual([expect.objectContaining({ id: SEED.repoId, owner: "test", name: "repo" })]);
  });
  it("registers idempotently without an installation id", async () => {
    const make = () => POST(req("POST", "/api/repos", { body: { owner: "test", name: "repo" } }), ctx({}));
    const a = await make(), b = await make();
    expect(a.status).toBe(200);
    expect((await a.json()).repo.id).toBe((await b.json()).repo.id);
  });
  it("rejects missing or private repositories", async () => {
    for (const input of [{ owner: "missing", name: "repo" }, { owner: "test", name: "repo" }]) {
      githubState().repos[0].private = true;
      expect((await POST(req("POST", "/api/repos", { body: input }), ctx({}))).status).toBe(404);
    }
  });
  it("validates the public GitHub path and does not expose legacy private rows", async () => {
    expect((await POST(req("POST", "/api/repos", { body: { owner: "..", name: "repo" } }), ctx({}))).status).toBe(400);
    const { dbReady } = await import("@/lib/db");
    await (await dbReady()).update(repos).set({ private: true }).where(eq(repos.id, SEED.repoId));
    expect((await (await GET(req("GET", "/api/repos"), ctx({}))).json()).repos).toEqual([]);
  });
});
