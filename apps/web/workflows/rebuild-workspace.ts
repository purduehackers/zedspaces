/**
 * `rebuildWorkspace` (b9 §4.8). Crash-safe order: nothing that holds the
 * user's files is deleted before the new generation is healthy. If the child
 * create fails, the old sandbox and the archive both survive and
 * `previous_sandbox_name` / `restore_blob_pathname` name what to retry — and
 * the *next* rebuild resumes from those pointers instead of archiving the
 * empty new generation over them.
 */
import { FatalError, sleep } from "workflow";
import { runChild } from "./child";
import {
  stepBumpGeneration,
  stepFinishRun,
  stepLoadWorkspace,
  stepRecordSessionEnd,
  stepSetState,
} from "./steps/db-steps";
import {
  stepDeleteBlob,
  stepDeleteSandbox,
  stepFinishArchive,
  stepResumeSandboxQuiet,
  stepStartArchive,
  stepStopSandboxDiscard,
  stepWaitForCommandExit,
} from "./steps/sandbox-steps";

/** Input of {@link rebuildWorkspace}. */
export interface RebuildWorkspaceRun {
  workspaceId: string;
  userId: string;
}

/** Ceiling for the tar of the workspace directory and the server data dir (D9). */
const ARCHIVE_CEILING_MS = 20 * 60_000;

/**
 * Tars D9's paths inside the old generation and uploads the archive. The
 * tar runs detached and is polled from here (D13: bounded polls, never one
 * long step), so a large workspace never exceeds a step's duration ceiling.
 */
async function archiveGeneration(sandboxName: string, workspaceId: string): Promise<{ blobPathname: string }> {
  const { cmdId } = await stepStartArchive(sandboxName);
  const deadline = Date.now() + ARCHIVE_CEILING_MS;
  for (;;) {
    const exit = await stepWaitForCommandExit(sandboxName, cmdId, 30_000);
    if (exit.exitCode !== null) {
      if (exit.exitCode !== 0) throw new FatalError(`archive_failed:${exit.exitCode}`);
      break;
    }
    if (Date.now() > deadline) throw new FatalError("archive_timeout");
    await sleep("5s");
  }
  return stepFinishArchive(sandboxName, workspaceId);
}

/** Archives the workspace, boots a new sandbox generation from it, then deletes the old one. */
export async function rebuildWorkspace(input: RebuildWorkspaceRun): Promise<{ ok: true }> {
  "use workflow";
  try {
    const ws = await stepLoadWorkspace(input.workspaceId);

    let previousSandboxName: string;
    let blobPathname: string;
    if (ws.previousSandboxName !== null) {
      // A generation bump is pending from a failed rebuild: the previous
      // generation still holds the files and the archive already exists.
      // Never archive the (empty) current generation over them.
      if (ws.restoreKind !== "tarball" || !ws.restoreBlobPathname) {
        throw new FatalError("rebuild_pointers_inconsistent");
      }
      previousSandboxName = ws.previousSandboxName;
      blobPathname = ws.restoreBlobPathname;
      await stepSetState(ws.id, "rebuilding", "retry");
      // Whatever the failed create left behind under the current name.
      await stepDeleteSandbox(ws.sandboxName, { deleteSnapshots: true });
    } else {
      if (ws.state === "running") {
        await runChild("stopWorkspace", { workspaceId: ws.id, reason: "rebuild", child: true });
      }
      await stepSetState(ws.id, "rebuilding", "archive");
      // Resume without a supervisor: this VM is only a filesystem to read from.
      const resumed = await stepResumeSandboxQuiet(ws.sandboxName);
      if (!resumed) throw new FatalError(`sandbox_missing:${ws.sandboxName}`);
      const archive = await archiveGeneration(ws.sandboxName, ws.id);
      const usage = await stepStopSandboxDiscard(ws.sandboxName);
      await stepRecordSessionEnd(ws.id, usage ?? { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 }, "rebuild");
      const generation = await stepBumpGeneration(ws.id, { blobPathname: archive.blobPathname });
      previousSandboxName = generation.oldSandboxName;
      blobPathname = archive.blobPathname;
    }

    await runChild("createWorkspace", { workspaceId: ws.id, userId: input.userId, child: true });

    // Only now: the new generation is healthy.
    await stepDeleteSandbox(previousSandboxName, { deleteSnapshots: true });
    await stepSetState(ws.id, "running", null, { previousSandboxName: null });
    await stepDeleteBlob(blobPathname);
    await stepSetState(ws.id, "running", null, { restoreBlobPathname: null });
    await stepFinishRun(ws.id, { ok: true });
    return { ok: true };
  } catch (err) {
    await stepFinishRun(input.workspaceId, { ok: false, error: String(err) });
    throw err;
  }
}
