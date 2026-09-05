import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "./api";
import { dbReady, isUniqueViolation } from "./db";
import { controlApiBase, env, envTag } from "./env";
import { newConnectId, newId } from "./ids";
import { sandboxApi, sandboxHttpScheme, sandboxWsScheme } from "./sandbox";
import { sessions, workspaces, type Session, type Workspace } from "./schema";
import { mintSessionToken } from "./tokens";
import type { ConnectInfo, HealthProbe } from "./types";

/**
 * The pieces `/connect` and the lifecycle workflows share (b9 §3.18): session
 * arbitration, token minting, the supervisor's environment and the supervisor
 * health probe.
 */

/** Inputs of {@link openOrReuseSession}. */
export interface OpenSessionInput {
  userId: string;
  /** `sessionStorage` id of the tab asking; the same tab reloading reuses its session. */
  tabId: string;
  /** Host of `domain(8443)` for the current sandbox session. */
  host: string;
  clientBuild: string | null;
  serverBuild: string | null;
  /** Close another holder's session instead of answering `409 session_active`. */
  takeover: boolean;
}

/** Result of {@link openOrReuseSession}. */
export interface OpenSessionResult {
  session: Session;
  /** The session that was closed to make room, when `takeover` was honoured. */
  takenOver: Session | null;
  /** True when the caller's own tab already held the session. */
  reused: boolean;
}

/**
 * Opens (or reuses) the single open `sessions` row of a workspace generation.
 *
 * Same user and same `tabId` reuses the row silently — a page reload is not a
 * takeover. Another holder with `takeover` closes the previous row with
 * `end_reason: "takeover"`; without it the call throws
 * `ApiError(409, "session_active")` carrying the holder's start time.
 *
 * Two first connects racing past the `FOR UPDATE` (there is no row to lock
 * yet) collide on `sessions_open_idx`; the loser re-runs the arbitration once
 * and then sees the winner's row (b9 §3.18).
 */
export async function openOrReuseSession(
  workspace: Workspace,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  try {
    return await arbitrateSession(workspace, input);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return arbitrateSession(workspace, input);
  }
}

async function arbitrateSession(workspace: Workspace, input: OpenSessionInput): Promise<OpenSessionResult> {
  const db = await dbReady();
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, workspace.id), isNull(sessions.endedAt)));

    if (open) {
      const sameTab = open.userId === input.userId && open.holderTabId === input.tabId;
      if (sameTab && open.sandboxGeneration === workspace.sandboxGeneration) {
        const [refreshed] = await tx
          .update(sessions)
          .set({
            wsHost: input.host,
            clientBuild: input.clientBuild,
            serverBuild: input.serverBuild,
            sandboxSessionId: workspace.currentSandboxSessionId,
          })
          .where(eq(sessions.id, open.id))
          .returning();
        return { session: refreshed, takenOver: null, reused: true };
      }
      if (!input.takeover && !sameTab) {
        throw new ApiError(409, "session_active", "Another tab is holding this workspace", {
          holder: { startedAt: open.startedAt.toISOString() },
        });
      }
      const [closed] = await tx
        .update(sessions)
        .set({ endedAt: new Date(), endReason: sameTab ? "generation_changed" : "takeover" })
        .where(eq(sessions.id, open.id))
        .returning();
      const session = await insertSession(tx, workspace, input);
      return { session, takenOver: sameTab ? null : closed, reused: false };
    }

    const session = await insertSession(tx, workspace, input);
    return { session, takenOver: null, reused: false };
  });
}

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof dbReady>>["transaction"]>[0]>[0];

async function insertSession(tx: Tx, workspace: Workspace, input: OpenSessionInput): Promise<Session> {
  const [row] = await tx
    .insert(sessions)
    .values({
      id: newId("ses"),
      workspaceId: workspace.id,
      userId: input.userId,
      sandboxGeneration: workspace.sandboxGeneration,
      sandboxSessionId: workspace.currentSandboxSessionId,
      holderTabId: input.tabId,
      wsHost: input.host,
      clientBuild: input.clientBuild,
      serverBuild: input.serverBuild,
    })
    .returning();
  return row;
}

/**
 * Mints the per-connect session token and returns the `ConnectInfo` the shell
 * hands to the wasm client (D26). `sessionId` is a fresh `con_…` id on every
 * call and equals the token's `sid`; the stable identity is `workspaceId`
 * (D1).
 */
export async function mintConnectInfo(workspace: Workspace, session: Session): Promise<ConnectInfo> {
  const host = workspace.currentWsHost;
  if (!host) throw new ApiError(500, "sandbox_unhealthy", "The workspace has no rpc host");
  const sessionId = newConnectId();
  const minted = await mintSessionToken({
    userId: session.userId,
    workspaceId: workspace.id,
    sessionId,
    audience: workspace.audience,
  });
  const db = await dbReady();
  await db
    .update(sessions)
    .set({ tokensMinted: session.tokensMinted + 1, lastConnectId: sessionId })
    .where(eq(sessions.id, session.id));

  const startedAt = workspace.sessionStartedAt ?? session.startedAt;
  return {
    wsUrl: `${sandboxWsScheme()}://${host}/rpc`,
    token: minted.token,
    sessionId,
    workspaceId: workspace.id,
    serverBuild: workspace.serverBuild,
    clientBuild: workspace.clientBuild,
    sessionExpiresAt: minted.expiresAt.toISOString(),
    sessionCapAt: new Date(startedAt.getTime() + env().ZS_SESSION_CAP_MS).toISOString(),
    audience: workspace.audience,
  };
}

/**
 * The deployment-protection bypass the supervisor sends as
 * `x-vercel-protection-bypass` (D18). Only preview deployments are protected,
 * so only they hand the project-wide secret to a tenant VM (b9 §4.2: "from
 * preview deployments"); production and development never do.
 */
export function bypassSecretEnv(): Record<string, string> {
  const secret = env().VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret && envTag() === "preview" ? { ZS_BYPASS_SECRET: secret } : {};
}

export { buildsCompatible } from "./builds";

/**
 * The environment `zs-agent` is started with. Decrypted secrets first, then
 * the identity keys, which therefore always win over a secret row of the same
 * name (b8 strips the three identity keys from every child environment).
 */
export async function supervisorEnvFor(
  workspace: Workspace,
  sandboxToken: string,
): Promise<Record<string, string>> {
  return {
    ZS_CONTROL_URL: controlApiBase(),
    ZS_SANDBOX_TOKEN: sandboxToken,
    ZS_SANDBOX_NAME: workspace.sandboxName,
    ZS_WORKSPACE_ID: workspace.id,
    ...bypassSecretEnv(),
  };
}

interface RawHealthBody {
  status?: unknown;
  phase?: unknown;
  build?: unknown;
  manifestBuild?: unknown;
  resumed?: unknown;
  busy?: unknown;
  uptimeSecs?: unknown;
  server?: { running?: unknown; restarts?: unknown; crashLoop?: unknown };
  /** D21 minimal body of the public `8448` listener (b8 `MinimalHealth`): `{ ok, phase, build, serverUp, uptimeSec }`. */
  ok?: unknown;
  serverUp?: unknown;
  uptimeSec?: unknown;
}

const HEALTH_STATUSES = new Set(["booting", "ready", "degraded", "stopping"]);
const BOOT_PHASES = new Set([
  "manifest",
  "restore",
  "clone",
  "server_starting",
  "dotfiles",
  "post_create",
  "post_start",
  "warm",
  "ready",
]);

/** Parses the non-loopback `/health` body of `zs-agent` (b8 §4.4) into a {@link HealthProbe}. */
export function parseHealthBody(body: unknown): HealthProbe | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as RawHealthBody;
  if (typeof raw.status !== "string" && typeof raw.ok === "boolean") {
    // The D21 minimal body b8 serves on the declared health port carries no
    // `status`/`server` block: `ok` folds ready|degraded, `serverUp` is the
    // server process, and nothing distinguishes booting from stopping.
    const phase = typeof raw.phase === "string" && BOOT_PHASES.has(raw.phase) ? raw.phase : "manifest";
    const serverRunning = raw.serverUp === true;
    return {
      ready: raw.ok && serverRunning,
      status: raw.ok ? "ready" : "booting",
      phase: phase as HealthProbe["phase"],
      build: typeof raw.build === "string" ? raw.build : null,
      manifestBuild: null,
      resumed: false,
      busy: false,
      serverRunning,
      serverCrashLoop: false,
      serverRestarts: 0,
      uptimeSecs: typeof raw.uptimeSec === "number" ? raw.uptimeSec : 0,
    };
  }
  const status = typeof raw.status === "string" && HEALTH_STATUSES.has(raw.status) ? raw.status : null;
  if (!status) return null;
  const phase = typeof raw.phase === "string" && BOOT_PHASES.has(raw.phase) ? raw.phase : "manifest";
  const serverRunning = raw.server?.running === true;
  return {
    ready: (status === "ready" || status === "degraded") && serverRunning,
    status: status as HealthProbe["status"],
    phase: phase as HealthProbe["phase"],
    build: typeof raw.build === "string" ? raw.build : null,
    manifestBuild: typeof raw.manifestBuild === "string" ? raw.manifestBuild : null,
    resumed: raw.resumed === true,
    busy: raw.busy === true,
    serverRunning,
    serverCrashLoop: raw.server?.crashLoop === true,
    serverRestarts: typeof raw.server?.restarts === "number" ? raw.server.restarts : 0,
    uptimeSecs: typeof raw.uptimeSecs === "number" ? raw.uptimeSecs : 0,
  };
}

/**
 * Polls the supervisor's health listener (`ZS_HEALTH_PORT`, D21: 8448). Never
 * throws: an unreachable or unparseable answer is `null`. `503` still carries
 * a body while the sandbox boots, so the body is parsed for any status.
 */
export async function probeHealth(healthHost: string, timeoutMs = 5_000): Promise<HealthProbe | null> {
  try {
    const res = await fetch(`${sandboxHttpScheme()}://${healthHost}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (res.status !== 200 && res.status !== 503) return null;
    return parseHealthBody(await res.json());
  } catch {
    return null;
  }
}

/** Consecutive failed health probes before {@link detectDeadSandbox} gives up on a running row. */
export const DEAD_SANDBOX_HEALTH_ATTEMPTS = 3;
/** Pause between those probes. */
const DEAD_SANDBOX_HEALTH_PAUSE_MS = Number(process.env.ZS_CONNECT_HEALTH_PAUSE_MS ?? 500);

/**
 * Result of {@link detectDeadSandbox}: the supervisor answered ready (`alive`),
 * it answered but is not ready — booting, stopping, no server (`unhealthy`,
 * the sandbox is there and the caller must not start a second resume under
 * it) — or nothing is behind the row any more (`dead`).
 */
export type SandboxLiveness =
  | { kind: "alive"; probe: HealthProbe }
  | { kind: "unhealthy"; probe: HealthProbe }
  | {
      kind: "dead";
      /** `no_session`, `sandbox_<status>`, `sandbox_missing` or `health_unreachable`. */
      reason: string;
    };

/**
 * Whether a `running` row still has a sandbox behind it. A workspace whose
 * database state is `running` but whose sandbox is gone — the local backend's
 * supervisor and server processes dead after `scripts/dev-local.sh stop`, a
 * crash or a reboot; a Vercel session that ended — used to make `/connect`
 * answer `500 sandbox_unhealthy` forever. Cheap checks first (no hosts, the
 * backend's own session status), then {@link DEAD_SANDBOX_HEALTH_ATTEMPTS}
 * health probes: `dead` only when the health listener never answers (a
 * backend that does not know the sandbox turns that into `sandbox_missing`);
 * an answer that is not `ready` is `unhealthy`. A backend error on the status
 * read is ignored in favour of the probe, which is what the fast path always
 * required.
 */
export async function detectDeadSandbox(workspace: Workspace): Promise<SandboxLiveness> {
  if (!workspace.currentWsHost || !workspace.currentHealthHost) return { kind: "dead", reason: "no_session" };
  let handle: Awaited<ReturnType<ReturnType<typeof sandboxApi>["get"]>> | undefined;
  try {
    handle = await sandboxApi().get(workspace.sandboxName, { resume: false });
  } catch {
    handle = undefined;
  }
  if (handle && handle.status !== "running" && handle.status !== "pending") {
    return { kind: "dead", reason: `sandbox_${handle.status}` };
  }
  let probe: HealthProbe | null = null;
  let answered: HealthProbe | null = null;
  for (let attempt = 0; attempt < DEAD_SANDBOX_HEALTH_ATTEMPTS && !probe?.ready; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, DEAD_SANDBOX_HEALTH_PAUSE_MS));
    probe = await probeHealth(workspace.currentHealthHost);
    if (probe) answered = probe;
  }
  if (probe?.ready) return { kind: "alive", probe };
  if (answered) return { kind: "unhealthy", probe: answered };
  return { kind: "dead", reason: handle === null ? "sandbox_missing" : "health_unreachable" };
}

/**
 * Reconciles a `running` row whose sandbox is dead ({@link detectDeadSandbox}):
 * the open session is closed with `sandbox_lost`, the row becomes `stopped`
 * with `state_reason: lost:<reason>` and no live hosts (the same columns
 * `stepMarkStopped` clears), so the ordinary resume path
 * (`connectWorkspace` → `Sandbox.get({ resume: true })` / the local backend's
 * `zs-agent resume`) can bring it back. The VM session's usage cannot be
 * metered any more and is not ledgered. Returns the row as re-read.
 */
export async function markWorkspaceLost(workspace: Workspace, reason: string): Promise<Workspace> {
  const db = await dbReady();
  const now = new Date();
  await closeOpenSession(workspace.id, "sandbox_lost");
  await db
    .update(workspaces)
    .set({
      state: "stopped",
      stateReason: `lost:${reason}`,
      lastStoppedAt: now,
      currentWsHost: null,
      currentSlotHosts: null,
      currentHealthHost: null,
      supervisorCmdId: null,
      sandboxExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(workspaces.id, workspace.id), eq(workspaces.state, "running")));
  console.warn(`[connect] workspace ${workspace.id}: sandbox ${workspace.sandboxName} is gone (${reason}); marked stopped`);
  return (await reloadWorkspace(workspace.id)) ?? { ...workspace, state: "stopped" as const };
}

/** Marks the open session of a workspace closed (used when a workspace stops). */
export async function closeOpenSession(workspaceId: string, endReason: string): Promise<void> {
  const db = await dbReady();
  await db
    .update(sessions)
    .set({ endedAt: new Date(), endReason })
    .where(and(eq(sessions.workspaceId, workspaceId), isNull(sessions.endedAt)));
}

/** The workspace row as the control plane re-reads it after a workflow step. */
export async function reloadWorkspace(workspaceId: string): Promise<Workspace | null> {
  const db = await dbReady();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row ?? null;
}
