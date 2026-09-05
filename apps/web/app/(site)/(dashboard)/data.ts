import "server-only";
import { desc, eq } from "drizzle-orm";
import { cache } from "react";
import { ensureUser, requireViewer, requireWorkspaceAccess, type Viewer } from "@/lib/auth";
import { dbReady } from "@/lib/db";
import { proxySlots } from "@/lib/env";
import { listeningPorts } from "@/lib/lifecycle";
import { assertWorkspaceId } from "@/lib/route-context";
import { repos, sessions } from "@/lib/schema";
import { readDoc, readDotfiles } from "@/lib/settings-docs";
import { toRepoView, visibleWorkspaces, workspaceView, workspaceViews } from "@/lib/views";

export const dashboardViewer = cache(async () => {
  const viewer = await requireViewer();
  return { viewer, user: await ensureUser(viewer) };
});

export async function listWorkspaceViews() {
  return workspaceViews(await visibleWorkspaces());
}

export async function workspaceDetail(viewer: Viewer, id: string) {
  const workspace = await requireWorkspaceAccess(viewer, assertWorkspaceId(id));
  const db = await dbReady();
  const [view, recentSessions, listening] = await Promise.all([
    workspaceView(workspace),
    db.select().from(sessions).where(eq(sessions.workspaceId, workspace.id)).orderBy(desc(sessions.startedAt)).limit(10),
    listeningPorts(workspace.id).catch(() => [] as number[]),
  ]);
  return {
    workspace, view, sessions: recentSessions, listening,
    slotsFree: Math.max(0, proxySlots().length - view.forwards.filter((forward) => forward.slot !== null).length),
  };
}

export type WorkspaceDetail = Awaited<ReturnType<typeof workspaceDetail>>;

export async function listRegisteredRepos() {
  const db = await dbReady();
  return (await db.select().from(repos).where(eq(repos.private, false)).orderBy(repos.owner, repos.name)).map(toRepoView);
}

export async function settingsPageData(viewer: Viewer) {
  const [settings, keymap, dotfiles] = await Promise.all([
    readDoc(viewer.userId, "settings"), readDoc(viewer.userId, "keymap"), readDotfiles(viewer.userId),
  ]);
  return { settings, keymap, dotfiles };
}
