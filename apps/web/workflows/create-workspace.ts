/**
 * `createWorkspace` (b9 §4.8): reserve → create the sandbox → start the
 * supervisor → wait for it to report a running server → `running`.
 *
 * The body only stitches steps together; every platform and database call
 * lives in `workflows/steps/*`.
 */
import { FatalError, sleep } from "workflow";
import { buildsCompatible } from "@/lib/builds";
import {
  stepBuildCreateInput,
  stepFinishRun,
  stepLoadWorkspace,
  stepPickImage,
  stepRecordSandboxSession,
  stepSetState,
} from "./steps/db-steps";
import { stepCreateSandbox, stepProbeHealth, stepStartSupervisor, stepWaitForCommandExit } from "./steps/sandbox-steps";

/** Input of {@link createWorkspace}. */
export interface CreateWorkspaceRun {
  workspaceId: string;
  userId: string;
  /**
   * When true the parent workflow owns `workflow_run_id` and this run must not
   * clear it (`rebuildWorkspace`, `restartSession`).
   */
  child?: boolean;
  /** Ceiling for the readiness wait; defaults to 35 minutes (b8's create budget). */
  readyCeilingMs?: number;
}

/** Boots the sandbox of a reserved workspace and leaves the row `running`. */
export async function createWorkspace(input: CreateWorkspaceRun): Promise<{ ok: true }> {
  "use workflow";
  try {
    const ws = await stepLoadWorkspace(input.workspaceId);
    const image = await stepPickImage(ws.id);
    const createInput = await stepBuildCreateInput(ws.id, image);
    const created = await stepCreateSandbox(createInput);
    await stepRecordSandboxSession(ws.id, "creating", "boot:manifest", created, {
      restoreKind: ws.restoreKind,
    });
    const { cmdId } = await stepStartSupervisor(ws.id, ws.sandboxName);

    // D13: wait on the supervisor's health and on the supervisor command's
    // exit, never on a fixed sleep. b8 starts `serve` as soon as the repository
    // exists and runs postCreateCommand beside it, so this normally returns
    // long before the ceiling.
    const deadline = Date.now() + (input.readyCeilingMs ?? 35 * 60_000);
    for (;;) {
      const health = await stepProbeHealth(ws.id, created.healthHost, ws.serverBuild);
      if (health && health.serverRunning && (health.status === "ready" || health.status === "degraded")) {
        if (!buildsCompatible(health.build, ws.serverBuild)) {
          throw new FatalError(`build_mismatch:${health.build}`);
        }
        break;
      }
      const exit = await stepWaitForCommandExit(ws.sandboxName, cmdId, 1_000);
      if (exit.exitCode !== null) {
        throw new FatalError(`supervisor_exit:${exit.exitCode}:${health ? health.phase : "unreachable"}`);
      }
      if (Date.now() > deadline) {
        throw new FatalError(`health_timeout:${health ? health.phase : "unreachable"}`);
      }
      await sleep("5s");
    }

    // The rebuild parent owns the archive until its old-generation cleanup completes.
    await stepSetState(ws.id, "running", null, ws.previousSandboxName ? undefined : { restoreBlobPathname: null });
    if (!input.child) await stepFinishRun(ws.id, { ok: true });
    return { ok: true };
  } catch (err) {
    if (!input.child) {
      await stepFinishRun(input.workspaceId, { ok: false, error: String(err) });
    }
    throw err;
  }
}
