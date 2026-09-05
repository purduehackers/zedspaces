/**
 * `stopWorkspace` (b9 §4.8). The supervisor is asked to shut down first
 * (SIGTERM → its own `STOPPING` lifecycle notice → the client's 5 s
 * client-state flush, D6) and the VM is stopped only once the supervisor has
 * exited or its health listener is gone (D13: never a fixed sleep).
 */
import { sleep } from "workflow";
import {
  stepFinishRun,
  stepLoadWorkspace,
  stepMarkStopped,
  stepRecordSessionEnd,
  stepSetState,
} from "./steps/db-steps";
import { stepProbeHealth, stepSignalSupervisor, stepStopSandbox, stepWaitForCommandExit } from "./steps/sandbox-steps";

/** Why a workspace is being stopped. */
export type StopReason = "idle" | "user" | "cap" | "rebuild" | "delete" | "abuse" | "lost" | "spend_cap";

/** Input of {@link stopWorkspace}. */
export interface StopWorkspaceRun {
  workspaceId: string;
  reason: StopReason;
  /** Set by a parent workflow that owns `workflow_run_id`. */
  child?: boolean;
}

/** Stops the workspace's VM and records the session's usage exactly once. */
export async function stopWorkspace(input: StopWorkspaceRun): Promise<{ stopped: boolean }> {
  "use workflow";
  try {
    const ws = await stepLoadWorkspace(input.workspaceId);
    if (ws.state === "stopped") {
      if (!input.child) await stepFinishRun(ws.id, { ok: true });
      return { stopped: false };
    }
    // From here the activity directive answers `stop: true`, the backstop if
    // the signal below never reaches the supervisor (b8 §3.16 step 8).
    await stepSetState(ws.id, "stopping", input.reason);
    await stepSignalSupervisor(ws.sandboxName, ws.supervisorCmdId, "SIGTERM");

    if (ws.supervisorCmdId) {
      // 25 s covers b8's worst case (5 s flush + SIGTERM + grace + log flush).
      await stepWaitForCommandExit(ws.sandboxName, ws.supervisorCmdId, 25_000);
    } else if (ws.currentHealthHost) {
      // No command id known: poll the supervisor's health until it reports
      // `stopping` with no server, or the listener is gone.
      const deadline = Date.now() + 25_000;
      for (;;) {
        const health = await stepProbeHealth(ws.id, ws.currentHealthHost, ws.serverBuild);
        if (!health || (health.status === "stopping" && !health.serverRunning)) break;
        if (Date.now() > deadline) break;
        await sleep("2s");
      }
    }

    const res = await stepStopSandbox(ws.sandboxName);
    await stepRecordSessionEnd(
      ws.id,
      res ? res.usage : { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 },
      input.reason,
    );
    // `forwards` rows and their slots survive a stop: the manifest re-delivers
    // them on resume.
    await stepMarkStopped(ws.id, input.reason, input.reason === "rebuild" ? "rebuilding" : "stopped", {
      snapshotSizeBytes: res?.snapshotSizeBytes ?? null,
    });
    if (!input.child) await stepFinishRun(ws.id, { ok: true });
    return { stopped: true };
  } catch (err) {
    if (!input.child) {
      await stepFinishRun(input.workspaceId, { ok: false, error: String(err) });
    }
    throw err;
  }
}
