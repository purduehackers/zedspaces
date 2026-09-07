import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import { connectWorkspace } from "@/workflows/connect-workspace";
import { createWorkspace } from "@/workflows/create-workspace";
import { deleteWorkspace } from "@/workflows/delete-workspace";
import { gc } from "@/workflows/gc";
import { rebuildWorkspace } from "@/workflows/rebuild-workspace";
import { restartSession } from "@/workflows/restart-session";
import { stopWorkspace } from "@/workflows/stop-workspace";
import { ApiError } from "./api";
import { dbReady } from "./db";
import { infraPorts } from "./env";
import { keys, kv, withLock } from "./kv";
import { workspaces } from "./schema";
import { assertWorkspaceCapacity, ACTIVE_WORKSPACE_STATES } from "./workspace-budget";

/**
 * The seam between the user-facing routes and the lifecycle layer
 * (`workflows/*.ts` and `lib/sandbox.ts`, b9 §3.19/§4.8).
 *
 * Routes name a workflow rather than importing it, so the run-id bookkeeping,
 * the busy check and the database lock happen in exactly one place.
 */

/** The `"use workflow"` entry points a route may start. */
export type LifecycleWorkflowName =
  | "createWorkspace"
  | "connectWorkspace"
  | "stopWorkspace"
  | "restartSession"
  | "rebuildWorkspace"
  | "deleteWorkspace"
  | "gc";

type AnyWorkflow = (...args: never[]) => Promise<unknown>;

const WORKFLOWS: Record<LifecycleWorkflowName, AnyWorkflow> = {
  createWorkspace: createWorkspace as AnyWorkflow,
  connectWorkspace: connectWorkspace as AnyWorkflow,
  stopWorkspace: stopWorkspace as AnyWorkflow,
  restartSession: restartSession as AnyWorkflow,
  rebuildWorkspace: rebuildWorkspace as AnyWorkflow,
  deleteWorkspace: deleteWorkspace as AnyWorkflow,
  gc: gc as AnyWorkflow,
};

/** Starts a workflow that is not bound to one workspace (`prebuild`, `gc`). */
export async function startRun(name: LifecycleWorkflowName, args: unknown): Promise<{ runId: string }> {
  const run = await start(WORKFLOWS[name] as (...a: unknown[]) => Promise<unknown>, [args]);
  return { runId: run.runId };
}

/**
 * Starts a lifecycle run for one workspace and records it in
 * `workspaces.workflow_run_id`, under a database lock so two requests cannot start
 * two runs for the same workspace. Throws `ApiError(423, "workspace_busy")`
 * when a run is already in flight or the lock is held.
 */
export async function startLifecycle(
  workspaceId: string,
  name: LifecycleWorkflowName,
  args: unknown,
): Promise<{ runId: string }> {
  const result = await withLock(keys.lock(`lifecycle:${workspaceId}`), 30_000, async () => {
    const db = await dbReady();
    const [current] = await db
      .select({ runId: workspaces.workflowRunId, state: workspaces.state })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (current?.runId && (await isRunActive(current.runId))) {
      throw new ApiError(423, "workspace_busy", "Another lifecycle run is in flight", { runId: current.runId });
    }

    if (!current) throw new ApiError(404, "not_found", "Workspace not found");
    const pending = `admitting:${randomUUID()}`;
    await db.transaction(async (tx) => {
      const activates = ["connectWorkspace", "createWorkspace", "rebuildWorkspace", "restartSession"].includes(name);
      if (activates && !(ACTIVE_WORKSPACE_STATES as readonly string[]).includes(current.state)) {
        await assertWorkspaceCapacity(tx, workspaceId);
      }
      await tx.update(workspaces).set({ workflowRunId: pending, workflowRunStartedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
    });
    let runId: string;
    try { ({ runId } = await startRun(name, args)); }
    catch (err) {
      await db.update(workspaces).set({ workflowRunId: null, workflowRunStartedAt: null })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.workflowRunId, pending)));
      throw err;
    }
    await db
      .update(workspaces)
      .set({ workflowRunId: runId, workflowRunStartedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.workflowRunId, pending),
        ),
      );
    return { runId };
  });
  if (!result) throw new ApiError(423, "workspace_busy", "Another lifecycle request is in flight");
  return result;
}

/** Status of a workflow run, or `"unknown"` when the run cannot be read. */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";

/** Reads a run's status (b9 §3.19 `stepRunStatus`, called from route context). */
export async function runStatus(runId: string): Promise<RunStatus> {
  try {
    return await getRun(runId).status;
  } catch (err) {
    console.warn(`[lifecycle] run ${runId} status unavailable`, err instanceof Error ? err.message : err);
    return "unknown";
  }
}

/**
 * True while `runId` names a run that has not reached a terminal state. An
 * unknown run does not block: a terminal or lost run must never brick a
 * workspace (b9 §3.20).
 */
export async function isRunActive(runId: string | null): Promise<boolean> {
  if (!runId) return false;
  if (runId.startsWith("admitting:")) return true;
  const status = await runStatus(runId);
  return status === "pending" || status === "running";
}

/** Ports the last activity ping reported as listening inside the sandbox. */
export async function listeningPorts(workspaceId: string): Promise<number[]> {
  const raw = await kv().get(keys.listening(workspaceId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const infra = new Set(infraPorts());
    return parsed.filter((port): port is number => typeof port === "number" && !infra.has(port));
  } catch {
    return [];
  }
}
