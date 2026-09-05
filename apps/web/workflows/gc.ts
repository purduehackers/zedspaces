import { runChild } from "./child";
import { stepCloseStaleSessions, stepGcCandidates, stepWarnRetention } from "./steps/db-steps";
import { stepDeleteSandbox, stepListOrphanSandboxes } from "./steps/sandbox-steps";

export interface GcRun { now: string }

export async function gc(input: GcRun) {
  "use workflow";
  const warned = await stepWarnRetention(input.now);
  const candidates = await stepGcCandidates(input.now);
  for (const id of candidates.expiredWorkspaces) {
    await runChild("deleteWorkspace", { workspaceId: id, userId: "system" });
  }
  // The tag filter isolates preview and production environments.
  const orphans = await stepListOrphanSandboxes(candidates.knownSandboxNames);
  for (const name of orphans) await stepDeleteSandbox(name, { deleteSnapshots: true });
  const staleSessions = await stepCloseStaleSessions(input.now);
  return { deletedWorkspaces: candidates.expiredWorkspaces.length, orphanedSandboxes: orphans.length, warned, staleSessions };
}
