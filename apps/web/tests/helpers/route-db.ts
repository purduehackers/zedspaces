import { clearTestDb } from "./clear-db";
import { dbReady, type Db } from "@/lib/db";
import { newId, newSandboxName } from "@/lib/ids";
import {
  githubInstallations,
  repos,
  users,
  workspaces,
  type NewWorkspace,
  type Workspace,
} from "@/lib/schema";

/**
 * The database the route handlers themselves use.
 *
 * `tests/helpers/db.ts` hands out a standalone libSQL instance, which is right
 * for unit tests but invisible to a handler: handlers call `dbReady()`. This
 * helper migrates that singleton once, then truncates and re-seeds it before
 * each case, so a test and the code under test share one database without
 * mocking `@/lib/db`.
 *
 * The seeded ids match the shapes the routes validate
 * (`^(ws|repo)_[0-9A-HJKMNP-TV-Z]{20}$`), so a path parameter built from them
 * reaches the handler instead of the id guard.
 */

/** Ids of the seeded rows. */
export const SEED = {
  userId: "user_test",
  otherUserId: "user_other",
  installationId: 1001,
  repoId: "repo_TESTTESTTESTTESTTEST",
  githubRepoId: 42,
} as const;

// Children first, so TRUNCATE … CASCADE is cheap.

/** Truncates and re-seeds the singleton database, returning it. */
export async function routeDb(): Promise<Db> {
  const db = await dbReady();
  await clearTestDb(db);
  await db.insert(users).values([
    { id: SEED.userId, email: "test@example.com", githubId: 1, githubLogin: "test", plan: "pro" },
    { id: SEED.otherUserId, email: "other@example.com", githubId: 2, githubLogin: "other" },
  ]);
  await db.insert(githubInstallations).values({
    installationId: SEED.installationId,
    accountId: 1,
    accountLogin: "test",
    accountType: "User",
    repositorySelection: "all",
    ownerUserId: SEED.userId,
  });
  await db.insert(repos).values({
    id: SEED.repoId,
    installationId: SEED.installationId,
    githubRepoId: SEED.githubRepoId,
    owner: "test",
    name: "repo",
    defaultBranch: "main",
    private: false,
  });
  return db;
}

/** Inserts a workspace owned by the seed user with sensible defaults, returning the row. */
export async function seedWorkspace(db: Db, overrides: Partial<NewWorkspace> = {}): Promise<Workspace> {
  const id = overrides.id ?? newId("ws");
  const sandboxName = overrides.sandboxName ?? newSandboxName(id, 1);
  const [row] = await db
    .insert(workspaces)
    .values({
      id,
      ownerUserId: SEED.userId,
      repoId: SEED.repoId,
      name: "repo",
      branch: "main",
      machine: "vcpu2",
      region: "iad1",
      sandboxName,
      imageRef: "zs-workspace:test-0",
      serverBuild: "test-0",
      clientBuild: "test-0",
      audience: sandboxName,
      state: "running",
      ...overrides,
    })
    .returning();
  return row;
}
