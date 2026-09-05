import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as activityPost } from "@/app/api/sandboxes/[name]/activity/route";
import { POST as clientErrorsPost } from "@/app/api/sandboxes/[name]/client-errors/route";
import { POST as extensionsPost } from "@/app/api/sandboxes/[name]/extensions/route";
import { POST as gitTokenPost } from "@/app/api/sandboxes/[name]/git-token/route";
import { POST as logsPost } from "@/app/api/sandboxes/[name]/logs/route";
import { GET as manifestGet } from "@/app/api/sandboxes/[name]/manifest/route";
import { DELETE as portDelete } from "@/app/api/sandboxes/[name]/ports/[port]/route";
import { POST as portsPost } from "@/app/api/sandboxes/[name]/ports/route";
import { dbReady } from "@/lib/db";
import { portPool, proxySlots } from "@/lib/env";
import { keys, kv } from "@/lib/kv";
import { auditLog, forwards, sessions, settingsDocs, workspaces } from "@/lib/schema";
import type { ActivityDirective, SandboxManifest, SandboxPortResponse } from "@/lib/types";
import { fakeSandbox } from "../helpers/fake-sandbox";
import { body, ctx, FIXTURE, insertWorkspaceWithToken, openEditorSession, request, seedFixtures } from "../helpers/routes";

/** Repositories the fake installation can reach, keyed `owner/name` → GitHub id. */
const REACHABLE: Record<string, number> = { "acme/api": FIXTURE.githubRepoId, "route/dotfiles": 7777 };

vi.mock("@/lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github")>();
  return {
    ...actual,
    installationToken: vi.fn(async (_installationId: number, opts?: { repositoryIds?: number[] }) => ({
      token: `ghs_installation_${opts?.repositoryIds?.join("_") ?? "all"}`,
      expiresAt: new Date("2026-09-02T12:00:00.000Z"),
    })),
    fetchRepo: vi.fn(async (_installationId: number, owner: string, name: string) => {
      const id = REACHABLE[`${owner}/${name}`];
      return id ? { id, owner, name, defaultBranch: "main", private: true } : null;
    }),
  };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, githubUserToken: vi.fn(async () => "gho_user_oauth") };
});

const PING = {
  sessionActive: true,
  busy: false,
  phase: "ready" as const,
  lastInputAt: Date.now(),
};

describe("sandbox-facing routes", () => {
  beforeEach(async () => {
    await seedFixtures();
    vi.clearAllMocks();
  });

  describe("manifest", () => {
    it("serves the manifest to its own sandbox and 401s a stranger", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const ok = await manifestGet(
        request(`/api/sandboxes/${workspace.sandboxName}/manifest`, { bearer: token }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(ok.status).toBe(200);
      const manifest = await body<SandboxManifest>(ok);
      expect(manifest.sandboxName).toBe(workspace.sandboxName);

      const bad = await manifestGet(
        request(`/api/sandboxes/${workspace.sandboxName}/manifest`, { bearer: "zsb_wrong" }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(bad.status).toBe(401);
    });
  });

  describe("activity", () => {
    it("returns the directive shape and writes the activity keys", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
          bearer: token,
          body: { ...PING, listening: [{ port: 3000 }, { port: 5173 }] },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      const directive = await body<ActivityDirective>(res);
      expect(Object.keys(directive).sort()).toEqual([
        "forwards",
        "idleStopAt",
        "serverTime",
        "sessionCapAt",
        "stop",
      ]);
      expect(directive.stop).toBe(false);
      expect(directive.idleStopAt).toBeGreaterThan(Date.now());
      expect(directive.sessionCapAt).toBeGreaterThan(Date.now());
      expect(await kv().get(keys.listening(workspace.id))).toBe("[3000,5173]");
      expect(await kv().get(keys.health(workspace.id))).not.toBeNull();
      expect(await kv().get(keys.busy(workspace.id))).toBeNull();
    });

    it("counts a bootstrapping sandbox as active (D13)", async () => {
      const stale = Date.now() - 6 * 3600_000;
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
          bearer: token,
          body: { sessionActive: false, busy: true, phase: "post_create", lastInputAt: stale },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      const directive = await body<ActivityDirective>(res);
      expect(directive.idleStopAt).toBeGreaterThan(Date.now());
      expect(await kv().get(keys.busy(workspace.id))).toBe("post_create");
      expect(Number(await kv().get(keys.activity(workspace.id)))).toBeGreaterThan(stale);
      const db = await dbReady();
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      expect(row.stateReason).toBe("boot:post_create");
    });

    it("keeps last_active_at on the input instant, not on the ping's arrival", async () => {
      const stale = Date.now() - 4 * 3600_000;
      const { workspace, token } = await insertWorkspaceWithToken({
        lastActiveAt: new Date(stale),
        sessionStartedAt: new Date(stale),
      });
      await openEditorSession(workspace);
      const res = await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
          bearer: token,
          body: { sessionActive: false, busy: false, phase: "ready", lastInputAt: stale },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      const directive = await body<ActivityDirective>(res);
      const db = await dbReady();
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      // A heartbeat with no new input must not keep the workspace alive.
      expect(row.lastActiveAt.getTime()).toBe(stale);
      expect(Number(await kv().get(keys.activity(workspace.id)))).toBe(stale);
      // `sessionStartedAt` is part of the directive's floor, so the deadline is
      // measured from the session start rather than from this ping.
      expect(directive.idleStopAt).toBeLessThan(Date.now() + workspace.idleMinutes * 60_000 + 5_000);
    });

    it("keeps the previous instant when a ping reports no input at all", async () => {
      const stale = Date.now() - 4 * 3600_000;
      const { workspace, token } = await insertWorkspaceWithToken({
        lastActiveAt: new Date(stale),
        sessionStartedAt: new Date(stale),
      });
      await openEditorSession(workspace);
      await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
          bearer: token,
          body: { sessionActive: false, busy: false, phase: "ready", lastInputAt: null },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(Number(await kv().get(keys.activity(workspace.id)))).toBe(stale);
      const db = await dbReady();
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      expect(row.lastActiveAt.getTime()).toBe(stale);
    });

    it("clears the boot reason once the supervisor reports ready", async () => {
      const { workspace, token } = await insertWorkspaceWithToken({ stateReason: "boot:clone" });
      await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, { bearer: token, body: PING }),
        ctx({ name: workspace.sandboxName }),
      );
      const db = await dbReady();
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      expect(row.stateReason).toBeNull();
    });

    it("answers stop: true once the workspace is stopping", async () => {
      const { workspace, token } = await insertWorkspaceWithToken({ state: "stopping" });
      const res = await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, { bearer: token, body: PING }),
        ctx({ name: workspace.sandboxName }),
      );
      expect((await body<ActivityDirective>(res)).stop).toBe(true);
    });

    it("counts sustained cpu only without a session and without a lifecycle command", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const ping = (patch: Record<string, unknown>) =>
        activityPost(
          request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
            bearer: token,
            body: { ...PING, ...patch },
          }),
          ctx({ name: workspace.sandboxName }),
        );
      // "No session" is the control plane's knowledge (an open sessions row),
      // never the report's own `sessionActive` flag.
      await ping({ sessionActive: true, busy: false, cpuBusyPct: 95 });
      expect(await kv().get(keys.cpu(workspace.id))).toBe("1");
      const session = await openEditorSession(workspace);
      await ping({ sessionActive: false, busy: false, cpuBusyPct: 95 });
      expect(await kv().get(keys.cpu(workspace.id))).toBeNull();
      const db = await dbReady();
      await db.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, session.id));
      await ping({ sessionActive: false, busy: true, phase: "post_create", cpuBusyPct: 99 });
      expect(await kv().get(keys.cpu(workspace.id))).toBeNull();
    });

    it("bounds what the VM reports: no input without a client, no future input, no endless busy", async () => {
      const startedAt = Date.now() - 2 * 3600_000;
      const { workspace, token } = await insertWorkspaceWithToken({
        sessionStartedAt: new Date(startedAt),
        lastActiveAt: new Date(startedAt),
      });
      const ping = (patch: Record<string, unknown>) =>
        activityPost(
          request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
            bearer: token,
            body: { ...PING, ...patch },
          }),
          ctx({ name: workspace.sandboxName }),
        );
      // No sessions row: the reported input is ignored and the floor is the session start.
      await ping({ lastInputAt: Date.now() });
      expect(Number(await kv().get(keys.activity(workspace.id)))).toBe(startedAt);
      // A `busy` report two hours into the session no longer counts as activity.
      await ping({ busy: true, phase: "post_create" });
      expect(await kv().get(keys.busy(workspace.id))).toBeNull();
      expect(Number(await kv().get(keys.activity(workspace.id)))).toBe(startedAt);
      // With a client attached, a future instant is clamped to now (+ skew).
      await openEditorSession(workspace);
      const before = Date.now();
      await ping({ lastInputAt: 4102444800000 });
      const recorded = Number(await kv().get(keys.activity(workspace.id)));
      expect(recorded).toBeLessThanOrEqual(Date.now() + 30_000);
      expect(recorded).toBeGreaterThanOrEqual(before);
      const db = await dbReady();
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      expect(row.lastActiveAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    });

    it("does not charge the sandbox's budget for unauthenticated calls", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      for (let i = 0; i < 12; i += 1) {
        const res = await activityPost(
          request(`/api/sandboxes/${workspace.sandboxName}/activity`, { bearer: "zsb_wrong", body: PING }),
          ctx({ name: workspace.sandboxName }),
        );
        expect(res.status).toBe(401);
      }
      const real = await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, { bearer: token, body: PING }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(real.status).toBe(200);
    });

    it("accepts the field names b8 sends today", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await activityPost(
        request(`/api/sandboxes/${workspace.sandboxName}/activity`, {
          bearer: token,
          body: {
            ...PING,
            sid: "con_abc",
            serverBuild: "test-0",
            supervisorBuild: "test-0",
            uptimeSeconds: 42,
            serverUptimeSecs: 40,
            agentUptimeSecs: 42,
            status: "ready",
          },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
    });

    it("rate limits at ten pings a minute", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      let last: Response | null = null;
      for (let i = 0; i < 11; i += 1) {
        last = await activityPost(
          request(`/api/sandboxes/${workspace.sandboxName}/activity`, { bearer: token, body: PING }),
          ctx({ name: workspace.sandboxName }),
        );
      }
      expect(last?.status).toBe(429);
      expect(last?.headers.get("retry-after")).not.toBeNull();
    });
  });

  describe("ports", () => {
    it("allocates a slot per private forward and refuses the fifth", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const post = (port: number, visibility: "private" | "public") =>
        portsPost(
          request(`/api/sandboxes/${workspace.sandboxName}/ports`, {
            bearer: token,
            body: { port, visibility, label: `p${port}` },
          }),
          ctx({ name: workspace.sandboxName }),
        );
      const slots: number[] = [];
      for (const port of [3000, 3001, 4000, 5000]) {
        const res = await post(port, "private");
        expect(res.status).toBe(200);
        const forward = await body<SandboxPortResponse>(res);
        expect(forward.url).toContain(`/workspaces/${workspace.id}/ports/${port}/open`);
        expect(forward.slot).not.toBeNull();
        slots.push(forward.slot as number);
      }
      expect(slots.sort((a, b) => a - b)).toEqual(proxySlots());

      const fifth = await post(5173, "private");
      expect(fifth.status).toBe(409);
      expect((await body<{ error: { code: string } }>(fifth)).error.code).toBe("no_free_slot");

      const freed = await portDelete(
        request(`/api/sandboxes/${workspace.sandboxName}/ports/3000`, { bearer: token, method: "DELETE" }),
        ctx({ name: workspace.sandboxName, port: "3000" }),
      );
      expect(freed.status).toBe(204);
      const reused = await post(5173, "private");
      expect((await body<SandboxPortResponse>(reused)).slot).toBe(proxySlots()[0]);
    });

    it("treats action unforward like DELETE", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      await portsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/ports`, {
          bearer: token,
          body: { port: 8080, visibility: "private" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      const res = await portsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/ports`, {
          bearer: token,
          body: { port: 8080, visibility: "private", action: "unforward" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(204);
      const db = await dbReady();
      const rows = await db.select().from(forwards).where(eq(forwards.workspaceId, workspace.id));
      expect(rows).toHaveLength(0);
    });

    it("returns the sandbox route url for a public forward in the pool", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      fakeSandbox().seedSandbox(workspace.sandboxName, {
        status: "running",
        ports: [8443, ...proxySlots(), 8448, 3000, 5173],
      });
      const res = await portsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/ports`, {
          bearer: token,
          body: { port: 3000, visibility: "public", label: "web" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      const forward = await body<SandboxPortResponse>(res);
      expect(forward.slot).toBeNull();
      expect(forward.url).toBe(`https://${workspace.sandboxName}-3000.fake.vercel.run`);
      // A pool port needs no `update({ ports })` call.
      expect(fakeSandbox().callsOf("updatePorts")).toHaveLength(0);
    });

    it("declares a public port outside the pool before returning its url", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      fakeSandbox().seedSandbox(workspace.sandboxName, {
        status: "running",
        ports: [8443, ...proxySlots(), 8448, ...portPool()],
      });
      const res = await portsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/ports`, {
          bearer: token,
          body: { port: 4321, visibility: "public" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      expect((await body<SandboxPortResponse>(res)).url).toBe(
        `https://${workspace.sandboxName}-4321.fake.vercel.run`,
      );
      const updates = fakeSandbox().callsOf("updatePorts");
      expect(updates).toHaveLength(1);
      expect(updates[0].args[1] as number[]).toContain(4321);
    });

    it("refuses an infrastructure port", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await portsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/ports`, {
          bearer: token,
          body: { port: 8444, visibility: "private" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(400);
      expect((await body<{ error: { code: string } }>(res)).error.code).toBe("infra_port");
    });
  });

  describe("extensions relay", () => {
    it("stores the installed list and rejects a malformed id", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const ok = await extensionsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/extensions`, {
          bearer: token,
          body: { installed: ["toml", "html"] },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(ok.status).toBe(204);
      const db = await dbReady();
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      expect(row.installedExtensions).toEqual(["html", "toml"]);

      const bad = await extensionsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/extensions`, {
          bearer: token,
          body: { installed: ["Not Valid"] },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(bad.status).toBe(400);
    });
  });

  describe("logs", () => {
    it("accepts a JSON batch, an NDJSON body and rejects an oversized one", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const json = await logsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/logs`, {
          bearer: token,
          body: { entries: [{ ts: Date.now(), level: "info", source: "agent", msg: "hello" }] },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(json.status).toBe(204);

      const ndjson = await logsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/logs`, {
          bearer: token,
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          raw: `${JSON.stringify({ ts: Date.now(), level: "info", target: "server", msg: "line" })}\n`,
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(ndjson.status).toBe(204);

      const huge = await logsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/logs`, {
          bearer: token,
          method: "POST",
          headers: { "content-type": "application/json" },
          raw: JSON.stringify({ entries: [], padding: "x".repeat(300 * 1024) }),
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(huge.status).toBe(413);
    });
  });

  describe("client errors", () => {
    it("accepts a supervisor crash report", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await clientErrorsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/client-errors`, {
          bearer: token,
          body: { build: "test-0", kind: "server_crash", message: "boom" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(202);
    });

    it("rejects a caller without a sandbox bearer", async () => {
      const { workspace } = await insertWorkspaceWithToken();
      const res = await clientErrorsPost(
        request(`/api/sandboxes/${workspace.sandboxName}/client-errors`, {
          body: { build: "test-0", kind: "boot", message: "boom" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(401);
    });
  });

  describe("git token", () => {
    it("returns no GitHub credentials to an authenticated workspace", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await gitTokenPost(
        request(`/api/sandboxes/${workspace.sandboxName}/git-token`, {
          bearer: token,
          body: { host: "github.com", protocol: "https", path: "acme/api" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      const payload = await body<{ username: string; token: string; expiresAt: string }>(res);
      expect(payload.username).toBe("");
      expect(payload.token).toBe("");
      expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());
      const db = await dbReady();
      const rows = await db.select().from(auditLog);
      expect(rows.some((row) => row.action === "git_token.issue")).toBe(false);
    });

    it("treats an empty body as the workspace repository", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await gitTokenPost(
        request(`/api/sandboxes/${workspace.sandboxName}/git-token`, { bearer: token, body: {} }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      expect((await body<{ token: string }>(res)).token).toBe("");
    });

    it("returns no credentials for public dotfiles either", async () => {
      const db = await dbReady();
      await db.insert(settingsDocs).values({
        userId: FIXTURE.userId,
        kind: "dotfiles",
        content: JSON.stringify({ repoUrl: "https://github.com/route/dotfiles", installCommand: null }),
      });
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await gitTokenPost(
        request(`/api/sandboxes/${workspace.sandboxName}/git-token`, {
          bearer: token,
          body: { host: "github.com", path: "route/dotfiles.git" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      const payload = await body<{ token: string }>(res);
      expect(payload.token).toBe("");
      expect(payload.token).not.toContain("gho_");
    });

    it("does not mint credentials even for a private repository path", async () => {
      const db = await dbReady();
      await db.insert(settingsDocs).values({
        userId: FIXTURE.userId,
        kind: "dotfiles",
        content: JSON.stringify({ repoUrl: "https://github.com/route/private-dotfiles", installCommand: null }),
      });
      const { workspace, token } = await insertWorkspaceWithToken();
      const res = await gitTokenPost(
        request(`/api/sandboxes/${workspace.sandboxName}/git-token`, {
          bearer: token,
          body: { path: "route/private-dotfiles" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(res.status).toBe(200);
      expect((await body<{ token: string }>(res)).token).toBe("");
    });

    it("answers 429 on the 31st call in a minute", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      let last: Response | null = null;
      for (let i = 0; i < 31; i += 1) {
        last = await gitTokenPost(
          request(`/api/sandboxes/${workspace.sandboxName}/git-token`, { bearer: token, body: {} }),
          ctx({ name: workspace.sandboxName }),
        );
      }
      expect(last?.status).toBe(429);
    });

    it("returns no credentials for another repository and refuses another forge", async () => {
      const { workspace, token } = await insertWorkspaceWithToken();
      const foreign = await gitTokenPost(
        request(`/api/sandboxes/${workspace.sandboxName}/git-token`, {
          bearer: token,
          body: { path: "someone/else" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(foreign.status).toBe(200);
      expect((await body<{ token: string }>(foreign)).token).toBe("");

      const gitlab = await gitTokenPost(
        request(`/api/sandboxes/${workspace.sandboxName}/git-token`, {
          bearer: token,
          body: { host: "gitlab.com" },
        }),
        ctx({ name: workspace.sandboxName }),
      );
      expect(gitlab.status).toBe(404);
      expect((await body<{ error: { code: string } }>(gitlab)).error.code).toBe("host_unsupported");
    });
  });
});
