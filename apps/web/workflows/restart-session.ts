/**
 * `restartSession` (b9 §4.8): the controlled stop and resume the sweep runs
 * 30 minutes before the platform session cap. Both halves are children of one
 * run so `workflow_run_id` stays set throughout and a reconnecting tab gets
 * `423 workspace_busy`, never `409 workspace_stopped`.
 */
import { stepFinishRun } from "./steps/db-steps";
import { runChild } from "./child";

/** Input of {@link restartSession}. */
export interface RestartSessionRun {
  workspaceId: string;
}

/** Stops and immediately resumes a workspace inside a single lifecycle run. */
export async function restartSession(input: RestartSessionRun): Promise<{ ok: true }> {
  "use workflow";
  try {
    await runChild("stopWorkspace", { workspaceId: input.workspaceId, reason: "cap", child: true });
    await runChild("connectWorkspace", {
      workspaceId: input.workspaceId,
      userId: "system",
      child: true,
    });
    await stepFinishRun(input.workspaceId, { ok: true });
    return { ok: true };
  } catch (err) {
    await stepFinishRun(input.workspaceId, { ok: false, error: String(err) });
    throw err;
  }
}
