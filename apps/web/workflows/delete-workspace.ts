/**
 * `deleteWorkspace` (b9 §4.8): stop, delete the sandbox and every snapshot it
 * owns, drop the rebuild archive, then soft-delete the rows (they are kept for
 * the ledger and the audit log).
 */
import { runChild } from "./child";
import { stepFinishRun, stepLoadWorkspace, stepPurgeWorkspaceRows, stepSetState } from "./steps/db-steps";
import { stepDeleteBlob, stepDeleteSandbox } from "./steps/sandbox-steps";

/** Input of {@link deleteWorkspace}. */
export interface DeleteWorkspaceRun {
  workspaceId: string;
  userId: string;
  /** Set by a parent workflow that owns `workflow_run_id`. */
  child?: boolean;
}

/** Deletes a workspace and everything the platform still holds for it. */
export async function deleteWorkspace(input: DeleteWorkspaceRun): Promise<{ ok: true }> {
  "use workflow";
  try {
    const ws = await stepLoadWorkspace(input.workspaceId);
    if (ws.state === "running" || ws.state === "stopping") {
      await runChild("stopWorkspace", { workspaceId: ws.id, reason: "delete", child: true });
    }
    await stepSetState(ws.id, "deleting");
    await stepDeleteSandbox(ws.sandboxName, { deleteSnapshots: true });
    if (ws.previousSandboxName) {
      await stepDeleteSandbox(ws.previousSandboxName, { deleteSnapshots: true });
    }
    if (ws.restoreBlobPathname) await stepDeleteBlob(ws.restoreBlobPathname);
    await stepPurgeWorkspaceRows(ws.id);
    if (!input.child) await stepFinishRun(ws.id, { ok: true });
    return { ok: true };
  } catch (err) {
    if (!input.child) {
      await stepFinishRun(input.workspaceId, { ok: false, error: String(err) });
    }
    throw err;
  }
}
