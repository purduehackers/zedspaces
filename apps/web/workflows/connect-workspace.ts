/**
 * `connectWorkspace` (b9 §4.8): the stopped → running path. The running fast
 * path is inline in `POST /api/workspaces/{id}/connect`; this workflow only
 * runs when a VM has to be resumed.
 */
import { FatalError, sleep } from "workflow";
import { buildsCompatible } from "@/lib/builds";
import { stepFinishRun, stepLoadWorkspace, stepRecordSandboxSession, stepSetState } from "./steps/db-steps";
import { stepProbeHealth, stepResumeSandbox, stepWaitForCommandExit } from "./steps/sandbox-steps";

/** Input of {@link connectWorkspace}. */
export interface ConnectWorkspaceRun {
  workspaceId: string;
  userId: string;
  /** Set by a parent workflow that owns `workflow_run_id` (`restartSession`). */
  child?: boolean;
  /** Ceiling for the readiness wait; defaults to 3 minutes (b8's resume budget). */
  readyCeilingMs?: number;
}

/** Resumes a stopped workspace and leaves the row `running`. */
export async function connectWorkspace(input: ConnectWorkspaceRun): Promise<{ host: string }> {
  "use workflow";
  try {
    const ws = await stepLoadWorkspace(input.workspaceId);
    // §7.2 has no "resuming" state: the row stays `stopped` and
    // `workflow_run_id` (set by startLifecycle) marks the run in flight, so a
    // reconnecting tab gets 423 rather than 409 workspace_stopped.
    await stepSetState(ws.id, "stopped", "resuming");
    const resumed = await stepResumeSandbox(ws.id, ws.sandboxName);
    if (!resumed) throw new FatalError("sandbox_missing");
    await stepRecordSandboxSession(ws.id, "stopped", "boot:manifest", resumed, {
      supervisorCmdId: resumed.cmdId,
    });

    const deadline = Date.now() + (input.readyCeilingMs ?? 3 * 60_000);
    for (;;) {
      const health = await stepProbeHealth(ws.id, resumed.healthHost, ws.serverBuild);
      if (health && health.serverRunning && (health.status === "ready" || health.status === "degraded")) {
        if (!buildsCompatible(health.build, ws.serverBuild)) {
          throw new FatalError(`build_mismatch:${health.build}`);
        }
        break;
      }
      const exit = await stepWaitForCommandExit(ws.sandboxName, resumed.cmdId, 1_000);
      if (exit.exitCode !== null) {
        throw new FatalError(`supervisor_exit:${exit.exitCode}:${health ? health.phase : "unreachable"}`);
      }
      if (Date.now() > deadline) {
        throw new FatalError(`health_timeout:${health ? health.phase : "unreachable"}`);
      }
      await sleep("5s");
    }

    await stepSetState(ws.id, "running", null);
    if (!input.child) await stepFinishRun(ws.id, { ok: true });
    return { host: resumed.rpcHost };
  } catch (err) {
    if (!input.child) {
      await stepFinishRun(input.workspaceId, { ok: false, error: String(err) });
    }
    throw err;
  }
}
