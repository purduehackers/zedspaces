import "server-only";
import { desc, eq } from "drizzle-orm";
import { cache } from "react";
import { ensureUser, requirePageViewer, requireWorkspaceAccess, type Viewer } from "@/lib/auth";
import { dbReady } from "@/lib/db";
import { proxySlots } from "@/lib/env";
import { listeningPorts } from "@/lib/lifecycle";
import { assertWorkspaceId } from "@/lib/route-context";
import { sessions } from "@/lib/schema";
import { readDoc, readDotfiles } from "@/lib/settings-docs";
import { visibleRepos, visibleWorkspaces, workspaceView, workspaceViews } from "@/lib/views";

export const dashboardViewer = cache(async () => {
  const viewer = await requirePageViewer();
  return { viewer, user: await ensureUser(viewer) };
});

export async function listWorkspaceViews() {
  const { viewer } = await dashboardViewer();
  return workspaceViews(await visibleWorkspaces(viewer.userId));
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
  const { viewer } = await dashboardViewer();
  return visibleRepos(viewer.userId);
}

export async function settingsPageData(viewer: Viewer) {
  const [settings, keymap, dotfiles] = await Promise.all([
    readDoc(viewer.userId, "settings"), readDoc(viewer.userId, "keymap"), readDotfiles(viewer.userId),
  ]);
  return { settings, keymap, dotfiles };
}
