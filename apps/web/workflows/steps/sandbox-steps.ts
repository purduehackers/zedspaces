/**
 * `"use step"` functions that touch the sandbox platform (b9 §3.19). Every
 * `@vercel/sandbox` call in the control plane goes through one of these, so a
 * workflow body never holds an SDK object and the retry semantics are the
 * step runtime's.
 */
import { FatalError, RetryableError } from "workflow";
import { blobPathnameFor } from "@/lib/archive";
import { blobStore } from "@/lib/blob";
import { probeHealth, supervisorEnvFor } from "@/lib/connect";
import { dbReady } from "@/lib/db";
import { env, envTag, proxySlots } from "@/lib/env";
import type { SlotHosts } from "@/lib/ports";
import { rotateSandboxToken } from "@/lib/sandbox-auth";
import {
  hostOf,
  sandboxApi,
  ZERO_USAGE,
  type CreateSandboxInput,
  type SandboxHandle,
  type SandboxStatus,
  type SandboxUsage,
} from "@/lib/sandbox";
import { SandboxError } from "@/lib/sandbox-error";
import { eq } from "drizzle-orm";
import { workspaces, type Workspace } from "@/lib/schema";
import type { HealthProbe } from "@/lib/types";

/** Hosts and identifiers a freshly created or resumed sandbox session exposes. */
export interface SandboxSessionHosts {
  /** Host of `domain(ZS_RPC_PORT)` — the `wss://…/rpc` origin. */
  rpcHost: string;
  /** Host of `domain(ZS_HEALTH_PORT)` — where `waitUntilReady` polls (D21: 8448). */
  healthHost: string;
  /** Proxy-slot port → host of `domain(slot)` (D8). */
  slotHosts: SlotHosts;
  /** The Vercel session id of the running VM. */
  sessionId: string;
  /** ISO 8601 timeout of the running session, or `null` when unknown. */
  expiresAt: string | null;
}

/** {@link stepCreateSandbox} result. */
export interface CreatedSandbox extends SandboxSessionHosts {
  name: string;
  region: string;
}

/** {@link stepResumeSandbox} result. */
export interface ResumedSandbox extends SandboxSessionHosts {
  /** Command id of the `zs-agent resume` the resume hook started. */
  cmdId: string;
  tokenGeneration: number;
}

/**
 * Older sandbox generations may not expose every configured port.
 */
function hostFor(handle: SandboxHandle, port: number): string | null {
  try {
    return hostOf(handle.domain(port));
  } catch {
    return null;
  }
}

function hostsOf(handle: SandboxHandle): SandboxSessionHosts {
  const slotHosts: SlotHosts = {};
  for (const slot of proxySlots()) {
    const host = hostFor(handle, slot);
    if (host) slotHosts[String(slot)] = host;
  }
  const e = env();
  const rpcHost = hostFor(handle, e.ZS_RPC_PORT);
  const healthHost = hostFor(handle, e.ZS_HEALTH_PORT);
  if (!rpcHost || !healthHost) {
    throw new FatalError(`sandbox_missing_routes:${handle.name}`);
  }
  return {
    rpcHost,
    healthHost,
    slotHosts,
    sessionId: handle.currentSessionId ?? "",
    expiresAt: handle.expiresAt ? handle.expiresAt.toISOString() : null,
  };
}

function fail(err: unknown): never {
  if (err instanceof SandboxError) {
    if (err.retryable) throw new RetryableError(`sandbox_${err.code}`, { retryAfter: "20s" });
    throw new FatalError(`sandbox_${err.code}: ${err.message}`);
  }
  throw err;
}

async function loadWorkspaceRow(workspaceId: string): Promise<Workspace> {
  const db = await dbReady();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row || row.deletedAt) throw new FatalError(`workspace_missing:${workspaceId}`);
  return row;
}

/**
 * Rotates the sandbox bearer, starts `zs-agent <mode>` detached with the
 * decrypted secrets in its environment and persists the command id. Called
 * both directly and from the SDK's `onResume` hook, so a retry that finds the
 * VM already resumed still records the running supervisor's command id.
 */
async function startSupervisor(
  handle: SandboxHandle,
  workspace: Workspace,
  mode: "start" | "resume",
): Promise<{ cmdId: string; tokenGeneration: number }> {
  const { token, generation } = await rotateSandboxToken({ kind: "workspace", id: workspace.id });
  const supervisorEnv = await supervisorEnvFor(workspace, token);
  const { cmdId } = await handle.runDetached({
    cmd: "zs-agent",
    args: [mode],
    env: supervisorEnv,
    sudo: false,
  });
  const db = await dbReady();
  await db
    .update(workspaces)
    .set({ supervisorCmdId: cmdId, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  return { cmdId, tokenGeneration: generation };
}

/**
 * Creates (or adopts) the workspace sandbox. `image_not_ready` becomes a
 * `RetryableError`; quota, a missing image and a region mismatch are fatal.
 */
export async function stepCreateSandbox(input: CreateSandboxInput): Promise<CreatedSandbox> {
  "use step";
  const api = sandboxApi();
  let handle: SandboxHandle;
  try {
    handle = await api.create(input);
  } catch (err) {
    return fail(err);
  }
  if (handle.status !== "running") {
    const resumed = await api.get(input.name, { resume: true }).catch(fail);
    if (!resumed) throw new FatalError(`sandbox_missing:${input.name}`);
    handle = resumed;
  }
  return { name: handle.name, region: handle.region, ...hostsOf(handle) };
}

/**
 * Whether a detached command is still running: a one-second `wait` that
 * times out means alive; an exit code or a `not_found` means dead. Any other
 * platform error is treated as alive, because starting a second supervisor
 * beside a live one is the worse failure.
 */
async function commandAlive(handle: SandboxHandle, cmdId: string): Promise<boolean> {
  try {
    await handle.waitCommand(cmdId, 1_000);
    return false;
  } catch (err) {
    if (err instanceof SandboxError && err.code === "not_found") return false;
    return true;
  }
}

/**
 * Resumes a stopped workspace sandbox and starts `zs-agent resume` inside the
 * SDK's resume hook. `null` when the sandbox no longer exists. When the VM
 * was already running (a retried step, or an `error` row whose boot failed
 * with the VM up) the recorded supervisor is reused only while it is alive;
 * a dead one is replaced, so an explicit open can retry the boot.
 */
export async function stepResumeSandbox(workspaceId: string, name: string): Promise<ResumedSandbox | null> {
  "use step";
  const workspace = await loadWorkspaceRow(workspaceId);
  let started: { cmdId: string; tokenGeneration: number } | null = null;
  const handle = await sandboxApi()
    .get(name, {
      resume: true,
      onResume: async (resumed) => {
        started = await startSupervisor(resumed, workspace, "resume");
      },
    })
    .catch(fail);
  if (!handle) return null;
  if (!started) {
    const current = await loadWorkspaceRow(workspaceId);
    if (current.supervisorCmdId && (await commandAlive(handle, current.supervisorCmdId))) {
      started = { cmdId: current.supervisorCmdId, tokenGeneration: current.sandboxTokenGeneration };
    } else {
      started = await startSupervisor(handle, current, "resume");
    }
  }
  const { cmdId, tokenGeneration } = started as { cmdId: string; tokenGeneration: number };
  return { ...hostsOf(handle), cmdId, tokenGeneration };
}

/** Resumes a sandbox **without** starting a supervisor: a VM to read files from (rebuild). */
export async function stepResumeSandboxQuiet(name: string): Promise<{ sessionId: string } | null> {
  "use step";
  const handle = await sandboxApi().get(name, { resume: true }).catch(fail);
  if (!handle) return null;
  return { sessionId: handle.currentSessionId ?? "" };
}

/** Starts `zs-agent start` on a sandbox that is already running. */
export async function stepStartSupervisor(
  workspaceId: string,
  sandboxName: string,
): Promise<{ cmdId: string; tokenGeneration: number }> {
  "use step";
  const workspace = await loadWorkspaceRow(workspaceId);
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(fail);
  if (!handle) throw new FatalError(`sandbox_missing:${sandboxName}`);
  return startSupervisor(handle, workspace, "start");
}

/**
 * One health probe against the supervisor. Writes `boot:<phase>` into
 * `state_reason` while the row is not yet running so the shell's overlay can
 * show progress. Never throws: an unreachable supervisor is `null`.
 */
export async function stepProbeHealth(
  workspaceId: string,
  healthHost: string,
  expectBuild: string,
): Promise<HealthProbe | null> {
  "use step";
  void expectBuild;
  const probe = await probeHealth(healthHost);
  if (probe) {
    const db = await dbReady();
    const [row] = await db
      .select({ state: workspaces.state, stateReason: workspaces.stateReason })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const reason = `boot:${probe.phase}`;
    if (row && row.state !== "running" && row.stateReason !== reason) {
      await db
        .update(workspaces)
        .set({ stateReason: reason, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
    }
  }
  return probe;
}

/** Sends a signal to the supervisor command; a `null` command id is a no-op. */
export async function stepSignalSupervisor(
  sandboxName: string,
  cmdId: string | null,
  signal: "SIGTERM",
): Promise<void> {
  "use step";
  if (!cmdId) return;
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(() => null);
  if (!handle || handle.status !== "running") return;
  await handle.killCommand(cmdId, signal).catch(() => undefined);
}

/**
 * Waits for a command to exit. `{ exitCode: null }` on timeout, when the
 * sandbox is gone, or when its session is not running — the SDK's
 * `getCommand` auto-resumes a stopped persistent sandbox, and a stopped VM
 * has no running command to wait for anyway. Never throws.
 */
export async function stepWaitForCommandExit(
  sandboxName: string,
  cmdId: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null }> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(() => null);
  if (!handle || handle.status !== "running") return { exitCode: null };
  try {
    return await handle.waitCommand(cmdId, timeoutMs);
  } catch {
    return { exitCode: null };
  }
}

/** Stops the sandbox, returning the snapshot it produced and the session's usage. */
export async function stepStopSandbox(
  sandboxName: string,
): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage } | null> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(fail);
  if (!handle) return null;
  if (handle.status === "stopped" || handle.status === "failed" || handle.status === "aborted") {
    return { usage: ZERO_USAGE };
  }
  return handle.stop();
}

/** Stops the sandbox during a rebuild; the caller records the usage under reason `rebuild`. */
export async function stepStopSandboxDiscard(sandboxName: string): Promise<SandboxUsage | null> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(fail);
  if (!handle) return null;
  if (handle.status === "stopped") return ZERO_USAGE;
  const res = await handle.stop();
  return res.usage;
}

/** Reads a sandbox's status without resuming it. */
export async function stepPeekSandbox(
  sandboxName: string,
): Promise<{ status: SandboxStatus; expiresAt: string | null } | null> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(() => null);
  if (!handle) return null;
  return { status: handle.status, expiresAt: handle.expiresAt?.toISOString() ?? null };
}

/** Extends the rolling session timeout; only on a sandbox observed running. */
export async function stepExtendTimeout(sandboxName: string, ms: number): Promise<void> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(() => null);
  if (!handle || handle.status !== "running") return;
  await handle.extendTimeout(ms);
}

/** Replaces the sandbox's declared port list (public forwards outside the pool). */
export async function stepUpdatePorts(sandboxName: string, ports: number[]): Promise<void> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: false }).catch(fail);
  if (!handle) throw new FatalError(`sandbox_missing:${sandboxName}`);
  await handle.updatePorts(ports);
}

/** Deletes a sandbox and, when asked, every snapshot it owns. A missing sandbox is success. */
export async function stepDeleteSandbox(
  sandboxName: string,
  opts: { deleteSnapshots: boolean },
): Promise<void> {
  "use step";
  const api = sandboxApi();
  const handle = await api.get(sandboxName, { resume: false }).catch(() => null);
  if (!handle) return;
  if (handle.status === "running" || handle.status === "pending") {
    await handle.stop().catch(() => undefined);
  }
  if (opts.deleteSnapshots) {
    const ids = await handle.listSnapshotIds().catch(() => [] as string[]);
    for (const id of ids) await api.deleteSnapshot(id).catch(() => undefined);
  }
  await handle.delete().catch(() => undefined);
}

/** The exact two paths D9 archives, relative to `/` because b8 extracts at `/`. */
export const ARCHIVE_PATHS = ["workspaces", "vercel/.local/share/zed"] as const;

/** Where the tarball is written inside the sandbox before it is streamed out. */
const ARCHIVE_TMP = "/tmp/zs-rebuild.tgz";

/**
 * Starts the tar of D9's two paths inside the sandbox, detached. The caller
 * polls {@link stepWaitForCommandExit} for it (a large workspace takes longer
 * than one step may run) and then calls {@link stepFinishArchive}.
 */
export async function stepStartArchive(sandboxName: string): Promise<{ cmdId: string }> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: true }).catch(fail);
  if (!handle) throw new FatalError(`sandbox_missing:${sandboxName}`);
  return handle.runDetached({ cmd: "tar", args: ["czf", ARCHIVE_TMP, "-C", "/", ...ARCHIVE_PATHS] });
}

/**
 * Digests the finished tarball and streams it into the private blob store.
 * The sha256 travels in the pathname (b9 §4.7); when `sha256sum` fails the
 * pathname carries none and the manifest's `restore.sha256` is `null`, so the
 * supervisor skips verification instead of failing against a fake digest.
 */
export async function stepFinishArchive(
  sandboxName: string,
  workspaceId: string,
): Promise<{ blobPathname: string; bytes: number; sha256: string | null }> {
  "use step";
  const handle = await sandboxApi().get(sandboxName, { resume: true }).catch(fail);
  if (!handle) throw new FatalError(`sandbox_missing:${sandboxName}`);
  const digest = await handle.run({ cmd: "sha256sum", args: [ARCHIVE_TMP], timeoutMs: 5 * 60_000 });
  const sha256 = digest.exitCode === 0 ? (/^([0-9a-f]{64})/.exec(digest.stdout.trim())?.[1] ?? null) : null;
  const stream = await handle.readFile(ARCHIVE_TMP);
  if (!stream) throw new FatalError("archive_missing");
  const pathname = blobPathnameFor(workspaceId, Date.now(), sha256);
  const stored = await blobStore().put(pathname, stream, "application/gzip");
  return { blobPathname: stored.pathname, bytes: stored.bytes, sha256 };
}

/** Deletes a blob; a missing object is success. */
export async function stepDeleteBlob(pathname: string): Promise<void> {
  "use step";
  await blobStore()
    .del(pathname)
    .catch(() => undefined);
}

/** Sandboxes tagged for this environment that the database does not know about. */
export async function stepListOrphanSandboxes(knownNames: string[]): Promise<string[]> {
  "use step";
  const known = new Set(knownNames);
  const orphans: string[] = [];
  for await (const summary of sandboxApi().listByTag({ zs: envTag() })) {
    if (known.has(summary.name)) continue;
    if (summary.status === "snapshotting") continue;
    orphans.push(summary.name);
  }
  return orphans;
}
