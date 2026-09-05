/**
 * Helpers for exercising route handlers directly: they take a `Request` and a
 * `{ params }` context, so no HTTP server is needed.
 *
 * Unlike `tests/helpers/db.ts` (which boots a standalone libSQL), these seed
 * the module singleton `dbReady()` returns, because route handlers and steps
 * resolve the database through it.
 */
import { clearTestDb } from "./clear-db";
import type { RouteCtx } from "@/lib/api";
import { _resetBlobForTests } from "@/lib/blob";
import { dbReady, type Db } from "@/lib/db";
import { newId, newSandboxName } from "@/lib/ids";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { rotateSandboxToken } from "@/lib/sandbox-auth";
import {
  githubInstallations,
  repos,
  sessions,
  users,
  workspaces,
  type NewWorkspace,
  type Session,
  type Workspace,
} from "@/lib/schema";
import { resetFakeSandbox } from "./fake-sandbox";

/** Ids of the rows {@link seedFixtures} inserts. */
export const FIXTURE = {
  userId: "user_route_test",
  otherUserId: "user_route_other",
  installationId: 2001,
  githubRepoId: 4242,
  repoId: "repo_route_test",
} as const;

// Children first so `TRUNCATE … CASCADE` can reset the shared instance.

/** Truncates every table, reseeds the fixtures and empties the in-memory fakes. */
export async function seedFixtures(): Promise<Db> {
  const db = await dbReady();
  await clearTestDb(db);
  _resetKvForTests();
  _resetRatelimitForTests();
  _resetBlobForTests();
  resetFakeSandbox();
  await db.insert(users).values([
    { id: FIXTURE.userId, email: "route@example.com", githubId: 11, githubLogin: "route", plan: "pro" },
    { id: FIXTURE.otherUserId, email: "other@example.com", githubId: 12, githubLogin: "other" },
  ]);
  await db.insert(githubInstallations).values({
    installationId: FIXTURE.installationId,
    accountId: 11,
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "all",
    ownerUserId: FIXTURE.userId,
  });
  await db.insert(repos).values({
    id: FIXTURE.repoId,
    installationId: FIXTURE.installationId,
    githubRepoId: FIXTURE.githubRepoId,
    owner: "acme",
    name: "api",
    defaultBranch: "main",
    private: false,
  });
  return db;
}

/** Inserts a running workspace owned by the fixture user. */
export async function insertWorkspace(overrides: Partial<NewWorkspace> = {}): Promise<Workspace> {
  const db = await dbReady();
  const id = overrides.id ?? newId("ws");
  const sandboxName = overrides.sandboxName ?? newSandboxName(id, 1);
  const [row] = await db
    .insert(workspaces)
    .values({
      id,
      ownerUserId: FIXTURE.userId,
      repoId: FIXTURE.repoId,
      name: "api",
      branch: "main",
      revision: "a".repeat(40),
      machine: "vcpu2",
      region: "iad1",
      sandboxName,
      audience: sandboxName,
      imageRef: "zs-workspace:test-0",
      serverBuild: "test-0",
      clientBuild: "test-0",
      state: "running",
      sessionStartedAt: new Date(),
      currentSandboxSessionId: "ses_0001",
      currentWsHost: `${sandboxName}-8443.fake.vercel.run`,
      currentHealthHost: `${sandboxName}-8448.fake.vercel.run`,
      currentSlotHosts: {
        "8444": `${sandboxName}-8444.fake.vercel.run`,
        "8445": `${sandboxName}-8445.fake.vercel.run`,
        "8446": `${sandboxName}-8446.fake.vercel.run`,
        "8447": `${sandboxName}-8447.fake.vercel.run`,
      },
      ...overrides,
    })
    .returning();
  return row;
}

/** Opens a `sessions` row for `workspace` (the control plane's own record that a client connected). */
export async function openEditorSession(workspace: Workspace, userId: string = FIXTURE.userId): Promise<Session> {
  const db = await dbReady();
  const [row] = await db
    .insert(sessions)
    .values({
      id: newId("ses"),
      workspaceId: workspace.id,
      userId,
      sandboxGeneration: workspace.sandboxGeneration,
      sandboxSessionId: workspace.currentSandboxSessionId,
      holderTabId: "tab-test-0001",
      wsHost: workspace.currentWsHost ?? "",
    })
    .returning();
  return row;
}

/** A workspace plus a live `zsb_…` bearer for its sandbox. */
export async function insertWorkspaceWithToken(
  overrides: Partial<NewWorkspace> = {},
): Promise<{ workspace: Workspace; token: string }> {
  const workspace = await insertWorkspace(overrides);
  const { token } = await rotateSandboxToken({ kind: "workspace", id: workspace.id });
  return { workspace, token };
}

/** Options of {@link request}. */
export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Raw body; takes precedence over `body`. */
  raw?: string;
  bearer?: string;
  headers?: Record<string, string>;
}

/** Builds a `Request` against the test control-plane origin. */
export function request(path: string, opts: RequestOptions = {}): Request {
  const headers = new Headers(opts.headers);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(`https://zs.test${path}`, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
}

/** Wraps route params in the promise shape Next hands a route handler. */
export function ctx<P>(params: P): RouteCtx<P> {
  return { params: Promise.resolve(params) };
}

/** Parses a handler's JSON response body. */
export async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
