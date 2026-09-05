"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { assertNotFlagged, ensureUser, requireViewer, requireWorkspaceAccess, type Viewer } from "@/lib/auth";
import { dbReady } from "@/lib/db";
import { EnvError } from "@/lib/env";
import { createForward, removeForward } from "@/lib/forwards";
import { isRunActive, startLifecycle } from "@/lib/lifecycle";
import { assertWorkspaceId } from "@/lib/route-context";
import { workspaces, type Workspace } from "@/lib/schema";
import { writeDoc, writeDotfiles } from "@/lib/settings-docs";
import { createForwardInput, patchWorkspaceInput, putDotfilesInput, putSettingsDocInput, userPortSchema } from "@/lib/types";
import { failed, ok, type ActionState } from "./_components/action-state";

async function run(fn: () => Promise<ActionState>): Promise<ActionState> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ApiError || err instanceof EnvError) return failed(err.message);
    if (err instanceof z.ZodError) return failed(err.issues[0]?.message ?? "Invalid value.");
    throw err; // Preserve Next's redirect/notFound control flow.
  }
}

function text(form: FormData, field: string): string {
  return String(form.get(field) ?? "").trim();
}

async function workspaceAction(
  form: FormData,
  action: string,
  mutate: (workspace: Workspace, viewer: Viewer) => Promise<string>,
): Promise<ActionState> {
  return run(async () => {
    const viewer = await requireViewer();
    assertNotFlagged(viewer);
    const id = assertWorkspaceId(text(form, "workspaceId"));
    const workspace = await requireWorkspaceAccess(viewer, id);
    const message = await mutate(workspace, viewer);
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    await audit({ actorType: "user", actorId: viewer.userId, action, targetType: "workspace", targetId: id, ip });
    revalidatePath(`/workspaces/${id}`);
    revalidatePath("/workspaces");
    return ok(message);
  });
}

export async function stopWorkspaceAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return workspaceAction(form, "workspace.stop", async (ws) => {
    if (ws.state === "stopped" && !(await isRunActive(ws.workflowRunId))) return "Already stopped.";
    await startLifecycle(ws.id, "stopWorkspace", { workspaceId: ws.id, reason: "user" });
    return "Stopping the workspace…";
  });
}

export async function rebuildWorkspaceAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return workspaceAction(form, "workspace.rebuild", async (ws, viewer) => {
    await startLifecycle(ws.id, "rebuildWorkspace", { workspaceId: ws.id, userId: viewer.userId });
    return "Rebuilding the workspace…";
  });
}

export async function deleteWorkspaceAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const result = await workspaceAction(form, "workspace.delete", async (ws, viewer) => {
    await startLifecycle(ws.id, "deleteWorkspace", { workspaceId: ws.id, userId: viewer.userId });
    return "Deleting the workspace…";
  });
  if (result.status === "ok") redirect("/workspaces");
  return result;
}

export async function updateWorkspaceAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return workspaceAction(form, "workspace.update", async (ws) => {
    const patch = patchWorkspaceInput.parse({ name: text(form, "name") || undefined,
      idleMinutes: text(form, "idleMinutes") ? Number(text(form, "idleMinutes")) : undefined });
    const db = await dbReady();
    await db.update(workspaces).set({ ...patch, updatedAt: new Date() }).where(eq(workspaces.id, ws.id));
    return "Workspace settings saved.";
  });
}

export async function forwardPortAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return workspaceAction(form, "port.forward", async (ws) => {
    const input = createForwardInput.parse({ port: Number(text(form, "port")),
      visibility: text(form, "visibility"), label: text(form, "label") || null });
    await createForward(ws, input);
    return `Port ${input.port} is forwarded (${input.visibility}).`;
  });
}

export async function unforwardPortAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return workspaceAction(form, "port.unforward", async (ws) => {
    const port = userPortSchema.parse(Number(text(form, "port")));
    await removeForward(ws.id, port);
    return `Port ${port} is no longer forwarded.`;
  });
}

export async function saveSettingsDocAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return run(async () => {
    const viewer = await requireViewer();
    assertNotFlagged(viewer);
    await ensureUser(viewer);
    const kind = z.enum(["settings", "keymap"]).parse(text(form, "kind"));
    const input = putSettingsDocInput.parse({ content: form.get("content"),
      version: text(form, "version") ? Number(text(form, "version")) : undefined });
    const saved = await writeDoc(viewer.userId, kind, input.content, input.version);
    revalidatePath("/settings");
    return ok(`Saved ${kind}.json (version ${saved.version}).`);
  });
}

export async function saveDotfilesAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return run(async () => {
    const viewer = await requireViewer();
    assertNotFlagged(viewer);
    await ensureUser(viewer);
    const input = putDotfilesInput.parse({ repoUrl: text(form, "repoUrl") || null,
      installCommand: text(form, "installCommand") || null });
    await writeDotfiles(viewer.userId, input);
    revalidatePath("/settings");
    return ok("Dotfiles configuration saved.");
  });
}
