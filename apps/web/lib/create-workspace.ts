import { and, eq, isNull } from "drizzle-orm";
import { ApiError, clientIp } from "./api";
import { audit } from "./audit";
import { assertNotFlagged, ensureUser, type Viewer } from "./auth";
import { dbReady } from "./db";
import { cloneUrl, resolveRef } from "./github";
import { newId, newSandboxName } from "./ids";
import { startLifecycle } from "./lifecycle";
import { idleMinutesFor } from "./plans";
import { limit } from "./ratelimit";
import { nearestRegion } from "./regions";
import { currentRelease } from "./release";
import { registerRepo } from "./repos";
import { repos, workspaces } from "./schema";
import type { CreateWorkspaceInput } from "./types";
import { workspaceView } from "./views";
import { assertWorkspaceCapacity } from "./workspace-budget";

export async function createPublicWorkspace(req: Request, viewer: Viewer, input: CreateWorkspaceInput, workshopKey?: string) {
  assertNotFlagged(viewer);
  await limit("user.workspaces.create", viewer.userId);
  const db = await dbReady();
  const user = await ensureUser(viewer);
  const workshopMatch = workshopKey ? and(eq(workspaces.ownerUserId, user.id), eq(workspaces.workshopKey, workshopKey), isNull(workspaces.deletedAt)) : undefined;
  if (workshopMatch) {
    const [existing] = await db.select().from(workspaces).where(workshopMatch).limit(1);
    if (existing) return { workspace: await workspaceView(existing), runId: existing.workflowRunId };
  }
  const repo = "repoId" in input.repo
    ? (await db.select().from(repos).where(eq(repos.id, input.repo.repoId)).limit(1))[0]
    : await registerRepo(viewer, input.repo);
  if (!repo || repo.private) throw new ApiError(404, "repo_not_found", "Public repository not found");
  const machine = input.machine ?? repo.defaultMachine;
  if (machine === "vcpu32") throw new ApiError(400, "invalid_machine", "Workspaces support up to 8 vCPUs");
  const ref = await resolveRef(repo.installationId, repo.owner, repo.name, input.ref ?? { branch: repo.defaultBranch });
  const release = currentRelease();
  const id = newId("ws");
  const sandboxName = newSandboxName(id, 1);
  const workspace = await db.transaction(async (tx) => {
    if (workshopMatch) {
      const [existing] = await tx.select().from(workspaces).where(workshopMatch).limit(1);
      if (existing) return existing;
    }
    await assertWorkspaceCapacity(tx);
    const [row] = await tx.insert(workspaces).values({
      id, ownerUserId: user.id, repoId: repo.id, name: input.name ?? repo.name,
      workshopKey,
      branch: ref.branch, revision: ref.sha, gitRef: ref.gitRef,
      pullRequest: input.ref && "pullRequest" in input.ref ? input.ref.pullRequest : null,
      machine,
      region: input.region ?? nearestRegion(req), sandboxName, audience: sandboxName,
      ...release,
      state: "creating", stateReason: "boot:manifest",
      idleMinutes: idleMinutesFor(input.idleMinutes ?? repo.idleMinutes ?? user.idleMinutesDefault),
    }).returning();
    return row;
  });
  if (workspace.id !== id) return { workspace: await workspaceView(workspace), runId: workspace.workflowRunId };
  await audit({
    actorType: "user", actorId: viewer.userId, action: "workspace.create",
    targetType: "workspace", targetId: workspace.id, ip: clientIp(req),
    metadata: { repo: cloneUrl(repo.owner, repo.name), machine: workspace.machine, region: workspace.region },
  });
  const { runId } = await startLifecycle(id, "createWorkspace", { workspaceId: id, userId: viewer.userId });
  return { workspace: await workspaceView(workspace), runId };
}
