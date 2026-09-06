import { desc, eq, inArray, isNull } from "drizzle-orm";
import { dbReady } from "./db";
import { sameRelease } from "./builds";
import { currentRelease } from "./release";
import { forwards, repos, workspaces, type Repo, type Workspace } from "./schema";
import type { ForwardView, RepoView, WorkspaceView } from "./types";

export function toForwardView(row: Pick<ForwardView, "port" | "visibility" | "label" | "url" | "slot">): ForwardView {
  return { port: row.port, visibility: row.visibility, label: row.label, url: row.url, slot: row.slot };
}

export async function forwardViews(workspaceId: string): Promise<ForwardView[]> {
  const db = await dbReady();
  return (await db.select().from(forwards).where(eq(forwards.workspaceId, workspaceId)))
    .sort((a, b) => a.port - b.port).map(toForwardView);
}

export function toRepoView(repo: Repo): RepoView {
  return {
    id: repo.id, installationId: repo.installationId, githubRepoId: repo.githubRepoId,
    owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, private: repo.private,
    defaultMachine: repo.defaultMachine, idleMinutes: repo.idleMinutes,
  };
}

export async function workspaceViews(rows: Workspace[]): Promise<WorkspaceView[]> {
  if (!rows.length) return [];
  const db = await dbReady();
  const [repoRows, forwardRows] = await Promise.all([
    db.select().from(repos).where(inArray(repos.id, [...new Set(rows.map((row) => row.repoId))])),
    db.select().from(forwards).where(inArray(forwards.workspaceId, rows.map((row) => row.id))),
  ]);
  const repoById = new Map(repoRows.map((repo) => [repo.id, repo]));
  const release = currentRelease();
  return rows.map((row) => {
    const repo = repoById.get(row.repoId);
    return {
      id: row.id, name: row.name,
      repo: { id: row.repoId, owner: repo?.owner ?? "", name: repo?.name ?? "", defaultBranch: repo?.defaultBranch ?? "main" },
      branch: row.branch, revision: row.revision, pullRequest: row.pullRequest,
      machine: row.machine, region: row.region, state: row.state, stateReason: row.stateReason,
      workflowRunId: row.workflowRunId, idleMinutes: row.idleMinutes,
      serverBuild: row.serverBuild, clientBuild: row.clientBuild,
      lastActiveAt: row.lastActiveAt.toISOString(), createdAt: row.createdAt.toISOString(),
      lastStoppedAt: row.lastStoppedAt?.toISOString() ?? null,
      retentionUntil: row.retentionUntil?.toISOString() ?? null,
      forwards: forwardRows.filter((forward) => forward.workspaceId === row.id)
        .sort((a, b) => a.port - b.port).map(toForwardView),
      image: { kind: "base", ref: row.imageRef, serverBuild: row.serverBuild,
        stale: !sameRelease(row, release) },
    };
  });
}

export async function workspaceView(row: Workspace): Promise<WorkspaceView> {
  return (await workspaceViews([row]))[0];
}

export async function visibleWorkspaces(): Promise<Workspace[]> {
  const db = await dbReady();
  return db.select().from(workspaces).where(isNull(workspaces.deletedAt)).orderBy(desc(workspaces.createdAt));
}
