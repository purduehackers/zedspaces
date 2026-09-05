/**
 * `"use step"` functions that only touch the database (b9 §3.19). They are
 * the workflow's whole view of control-plane state: a workflow body never
 * opens a connection itself.
 */
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { FatalError } from "workflow";
import { closeOpenSession } from "@/lib/connect";
import { dbReady } from "@/lib/db";
import { env, envTag, portPool, proxySlots } from "@/lib/env";
import { newSandboxName } from "@/lib/ids";
import { MACHINES } from "@/lib/plans";
import {
  forwards,
  sessions,
  workspaces,
  type Workspace,
  type WorkspaceState,
} from "@/lib/schema";
import type { CreateSandboxInput, SandboxUsage } from "@/lib/sandbox";

/** The workspace row, or a fatal error when it is gone. */
export async function stepLoadWorkspace(workspaceId: string): Promise<Workspace> {
  "use step";
  const db = await dbReady();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row || row.deletedAt) throw new FatalError(`workspace_missing:${workspaceId}`);
  return row;
}

/** Columns a lifecycle step may patch alongside the state transition. */
export interface WorkspacePatch {
  currentWsHost?: string | null;
  currentSlotHosts?: Record<string, string> | null;
  currentHealthHost?: string | null;
  currentSandboxSessionId?: string | null;
  sessionStartedAt?: string | null;
  sandboxExpiresAt?: string | null;
  supervisorCmdId?: string | null;
  restoreKind?: Workspace["restoreKind"];
  restoreBlobPathname?: string | null;
  previousSandboxName?: string | null;
  lastStoppedAt?: string | null;
  retentionUntil?: string | null;
  retentionWarnedAt?: string | null;
}

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

/** Writes a workspace's state, its `state_reason` and an optional column patch. */
export async function stepSetState(
  workspaceId: string,
  state: WorkspaceState,
  reason?: string | null,
  patch?: WorkspacePatch,
): Promise<void> {
  "use step";
  const db = await dbReady();
  await db
    .update(workspaces)
    .set({
      state,
      ...(reason === undefined ? {} : { stateReason: reason }),
      ...(patch?.currentWsHost === undefined ? {} : { currentWsHost: patch.currentWsHost }),
      ...(patch?.currentSlotHosts === undefined ? {} : { currentSlotHosts: patch.currentSlotHosts }),
      ...(patch?.currentHealthHost === undefined ? {} : { currentHealthHost: patch.currentHealthHost }),
      ...(patch?.currentSandboxSessionId === undefined
        ? {}
        : { currentSandboxSessionId: patch.currentSandboxSessionId }),
      ...(patch?.sessionStartedAt === undefined ? {} : { sessionStartedAt: toDate(patch.sessionStartedAt) }),
      ...(patch?.sandboxExpiresAt === undefined ? {} : { sandboxExpiresAt: toDate(patch.sandboxExpiresAt) }),
      ...(patch?.supervisorCmdId === undefined ? {} : { supervisorCmdId: patch.supervisorCmdId }),
      ...(patch?.restoreKind === undefined ? {} : { restoreKind: patch.restoreKind }),
      ...(patch?.restoreBlobPathname === undefined ? {} : { restoreBlobPathname: patch.restoreBlobPathname }),
      ...(patch?.previousSandboxName === undefined ? {} : { previousSandboxName: patch.previousSandboxName }),
      ...(patch?.lastStoppedAt === undefined ? {} : { lastStoppedAt: toDate(patch.lastStoppedAt) }),
      ...(patch?.retentionUntil === undefined ? {} : { retentionUntil: toDate(patch.retentionUntil) }),
      ...(patch?.retentionWarnedAt === undefined ? {} : { retentionWarnedAt: toDate(patch.retentionWarnedAt) }),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}

/** How a lifecycle run ended. */
export type RunOutcome = { ok: true } | { ok: false; error: string; state?: WorkspaceState };

/**
 * Clears `workflow_run_id` on **both** paths, so a failed run can never leave
 * a workspace answering `423` forever (b9 §3.20). On failure the row also
 * takes the error state and reason.
 */
export async function stepFinishRun(workspaceId: string, outcome: RunOutcome): Promise<void> {
  "use step";
  const db = await dbReady();
  await db
    .update(workspaces)
    .set({
      workflowRunId: null,
      workflowRunStartedAt: null,
      ...(outcome.ok ? {} : { state: outcome.state ?? "error", stateReason: outcome.error.slice(0, 500) }),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}
export interface ImageChoice { kind: "image"; image: string }

export async function stepPickImage(workspaceId: string): Promise<ImageChoice> {
  "use step";
  const db = await dbReady();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw new FatalError(`workspace_missing:${workspaceId}`);
  return { kind: "image", image: workspace.imageRef };
}

/**
 * The full `Sandbox.getOrCreate` argument for a workspace generation. Built in
 * a step so the workflow body never touches `process.env`, the port map or the
 * machine table.
 */
export async function stepBuildCreateInput(
  workspaceId: string,
  image: ImageChoice,
): Promise<CreateSandboxInput> {
  "use step";
  const db = await dbReady();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw new FatalError(`workspace_missing:${workspaceId}`);
  const e = env();
  return {
    name: workspace.sandboxName,
    region: workspace.region,
    vcpus: MACHINES[workspace.machine].vcpus,
    // D8/D21: the rpc listener, the four proxy slots, supervisor health and the
    // forward pool are declared once, at create; `update({ ports })` only ever
    // adds a public forward outside the pool.
    ports: [...new Set([e.ZS_RPC_PORT, ...proxySlots(), e.ZS_HEALTH_PORT, ...portPool()])],
    timeoutMs: e.ZS_SESSION_TIMEOUT_MS,
    image: image.image,
    // Identity only: no secrets and no tokens reach `Sandbox.create`.
    env: {
      ZS_WORKSPACE_ID: workspace.id,
      ZS_SANDBOX_NAME: workspace.sandboxName,
      ZS_REGION: workspace.region,
    },
    networkPolicy: "allow-all",
    tags: { zs: envTag(), ws: workspace.id, owner: workspace.ownerUserId },
    snapshotExpirationMs: e.ZS_RETENTION_DAYS * 86_400_000,
    keepLastSnapshots: 1,
  };
}

/** Hosts of one sandbox session, as the create and resume steps report them. */
export interface SessionHostsPatch {
  rpcHost: string;
  healthHost: string;
  slotHosts: Record<string, string>;
  sessionId: string;
  expiresAt: string | null;
}

/**
 * Records a freshly started VM session on the workspace row: hosts, session
 * id, `session_started_at = now` and the platform timeout. `now` is read here
 * rather than in the workflow so a replay does not rewrite it.
 */
export async function stepRecordSandboxSession(
  workspaceId: string,
  state: WorkspaceState,
  reason: string | null,
  hosts: SessionHostsPatch,
  extra?: { restoreKind?: Workspace["restoreKind"]; supervisorCmdId?: string | null },
): Promise<void> {
  "use step";
  const db = await dbReady();
  await db
    .update(workspaces)
    .set({
      state,
      stateReason: reason,
      currentWsHost: hosts.rpcHost,
      currentHealthHost: hosts.healthHost,
      currentSlotHosts: hosts.slotHosts,
      currentSandboxSessionId: hosts.sessionId,
      sessionStartedAt: new Date(),
      // The durable idle fallback can never be older than the VM session it belongs to.
      lastActiveAt: new Date(),
      sandboxExpiresAt: hosts.expiresAt ? new Date(hosts.expiresAt) : null,
      ...(extra?.restoreKind === undefined ? {} : { restoreKind: extra.restoreKind }),
      ...(extra?.supervisorCmdId === undefined ? {} : { supervisorCmdId: extra.supervisorCmdId }),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * Moves a workspace to `stopped` (or `rebuilding`), clearing every per-session
 * column and recomputing the retention window. `forwards` rows and their slots
 * survive: the manifest re-delivers them on resume.
 */
export async function stepMarkStopped(
  workspaceId: string,
  reason: string,
  state: WorkspaceState = "stopped",
  extra?: { snapshotSizeBytes?: number | null },
): Promise<void> {
  "use step";
  const db = await dbReady();
  const days = env().ZS_RETENTION_DAYS;
  const now = new Date();
  await db
    .update(workspaces)
    .set({
      state,
      stateReason: reason,
      lastStoppedAt: now,
      retentionUntil: new Date(now.getTime() + days * 86_400_000),
      retentionWarnedAt: null,
      currentWsHost: null,
      currentSlotHosts: null,
      currentHealthHost: null,
      supervisorCmdId: null,
      sandboxExpiresAt: null,
      ...(extra?.snapshotSizeBytes === undefined ? {} : { snapshotSizeBytes: extra.snapshotSizeBytes }),
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspaceId));
}
export async function stepRecordSessionEnd(workspaceId: string, _usage: SandboxUsage, endReason: string): Promise<void> {
  "use step";
  await closeOpenSession(workspaceId, endReason);
}

/** {@link stepBumpGeneration} result. */
export interface GenerationBump {
  oldSandboxName: string;
  newSandboxName: string;
  generation: number;
}

/**
 * Moves the workspace onto a new sandbox generation: new sandbox name and JWT
 * audience, `restore_kind = "tarball"` pointing at the archive, the old name
 * kept in `previous_sandbox_name` until the new generation is healthy. A bump
 * while one is still pending is refused: overwriting `previous_sandbox_name`
 * would orphan the generation that holds the user's files.
 */
export async function stepBumpGeneration(
  workspaceId: string,
  archive: { blobPathname: string },
): Promise<GenerationBump> {
  "use step";
  const db = await dbReady();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw new FatalError(`workspace_missing:${workspaceId}`);
  if (workspace.previousSandboxName !== null) {
    throw new FatalError(`generation_bump_pending:${workspace.previousSandboxName}`);
  }
  const generation = workspace.sandboxGeneration + 1;
  const name = newSandboxName(workspace.id, generation);
  const nextImageRef = env().ZS_IMAGE_REF ?? workspace.imageRef;
  const nextServerBuild = env().ZS_SERVER_BUILD_ID ?? workspace.serverBuild;
  await db
    .update(workspaces)
    .set({
      sandboxGeneration: generation,
      sandboxName: name,
      audience: name,
      previousSandboxName: workspace.sandboxName,
      restoreKind: "tarball",
      restoreBlobPathname: archive.blobPathname,
      imageRef: nextImageRef,
      serverBuild: nextServerBuild,
      clientBuild: env().ZS_CLIENT_BUILD_ID ?? nextServerBuild,
      supervisorCmdId: null,
      currentWsHost: null,
      currentSlotHosts: null,
      currentHealthHost: null,
      currentSandboxSessionId: null,
      sandboxExpiresAt: null,
      snapshotSizeBytes: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
  return { oldSandboxName: workspace.sandboxName, newSandboxName: name, generation };
}

/** Soft-deletes a workspace: forwards dropped, sessions closed, `deleted_at` set. */
export async function stepPurgeWorkspaceRows(workspaceId: string): Promise<void> {
  "use step";
  const db = await dbReady();
  await db.delete(forwards).where(eq(forwards.workspaceId, workspaceId));
  await closeOpenSession(workspaceId, "deleted");
  await db
    .update(workspaces)
    .set({
      deletedAt: new Date(),
      state: "deleting",
      stateReason: null,
      currentWsHost: null,
      currentSlotHosts: null,
      currentHealthHost: null,
      supervisorCmdId: null,
      sandboxTokenHash: null,
      snapshotSizeBytes: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}

export interface GcCandidates {
  expiredWorkspaces: string[];
  knownSandboxNames: string[];
}

export async function stepGcCandidates(now: string): Promise<GcCandidates> {
  "use step";
  const db = await dbReady();
  const expired = await db.select({ id: workspaces.id }).from(workspaces).where(and(
    eq(workspaces.state, "stopped"), isNull(workspaces.deletedAt),
    lt(workspaces.retentionUntil, new Date(now)), isNotNull(workspaces.retentionWarnedAt),
  ));
  const live = await db.select({ name: workspaces.sandboxName, previous: workspaces.previousSandboxName })
    .from(workspaces).where(isNull(workspaces.deletedAt));
  return {
    expiredWorkspaces: expired.map((row) => row.id),
    knownSandboxNames: live.flatMap((row) => row.previous ? [row.name, row.previous] : [row.name]),
  };
}

/** Closes sessions still open after 25 h whose workspace is no longer running. */
export async function stepCloseStaleSessions(now: string): Promise<number> {
  "use step";
  const db = await dbReady();
  const cutoff = new Date(new Date(now).getTime() - 25 * 3600_000);
  const stale = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .where(and(isNull(sessions.endedAt), lt(sessions.startedAt, cutoff), sql`${workspaces.state} <> 'running'`));
  if (stale.length === 0) return 0;
  await db
    .update(sessions)
    .set({ endedAt: new Date(now), endReason: "stale" })
    .where(
      inArray(
        sessions.id,
        stale.map((row) => row.id),
      ),
    );
  return stale.length;
}

/** Stamps `retention_warned_at` a week before deletion; returns how many were warned. */
export async function stepWarnRetention(now: string): Promise<number> {
  "use step";
  const db = await dbReady();
  const horizon = new Date(new Date(now).getTime() + 7 * 86_400_000);
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.deletedAt),
        isNull(workspaces.retentionWarnedAt),
        isNotNull(workspaces.retentionUntil),
        lt(workspaces.retentionUntil, horizon),
      ),
    );
  if (rows.length === 0) return 0;
  await db
    .update(workspaces)
    .set({ retentionWarnedAt: new Date(now) })
    .where(
      inArray(
        workspaces.id,
        rows.map((row) => row.id),
      ),
    );
  return rows.length;
}
