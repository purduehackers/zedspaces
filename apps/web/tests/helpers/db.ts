import { clearTestDb } from "./clear-db";
import { newTestDb, type Db } from "@/lib/db";
import { newId, newSandboxName } from "@/lib/ids";
import { githubInstallations, repos, users, workspaces, type NewWorkspace, type Workspace } from "@/lib/schema";

/** Ids of the seeded rows. */
export const SEED = {
  userId: "user_test",
  otherUserId: "user_other",
  installationId: 1001,
  repoId: "repo_test",
} as const;

// Every table, children first, so TRUNCATE … CASCADE can reset a shared instance quickly.

let shared: Db | null = null;

/**
 * A migrated in-memory libSQL database with a minimal seed: two users, one
 * installation and one repo. Booting libSQL is the expensive part, so one
 * instance is shared per test file and truncated between calls.
 */
export async function testDb(): Promise<Db> {
  if (!shared) {
    shared = await newTestDb();
  } else {
    await clearTestDb(shared);
  }
  const db = shared;
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
    githubRepoId: 42,
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
