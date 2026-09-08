import type { ConnectInfo, WorkspaceView } from "@/lib/types";
import { apiErrorBody, refreshEditorSession } from "./api-client";

/**
 * The shell's `connect()` (b9 §3.26 bullet 2): one `POST
 * /api/workspaces/{id}/connect` plus the polling and error mapping the
 * contract prescribes. Used both for the initial boot and, through
 * `ZsHost.refreshConnectInfo`, for every transport redial.
 */

/** Why a connect attempt failed, in the vocabulary b7's `RefreshError` maps from. */
export type ConnectErrorCode =
  | "stopped"
  | "unauthorized"
  | "build_mismatch"
  | "plan_limit"
  | "forbidden"
  | "deleted"
  | "unavailable";

/**
 * A failed connect. The `code` is the contract: b7 maps `stopped` to
 * `RefreshError::Stopped`, `unauthorized` to `RefreshError::Unauthorized` and
 * everything else to `RefreshError::Other` (D2).
 */
export class ConnectError extends Error {
  /** @see ConnectErrorCode */
  readonly code: ConnectErrorCode;
  /** HTTP status that produced it, when there was one. */
  readonly status: number | null;
  /** `details` of the error envelope (e.g. `{ holder: { startedAt } }`). */
  readonly details: unknown;

  constructor(code: ConnectErrorCode, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Why the shell is connecting; the route treats `reconnect` as "never resume". */
export type ConnectReason = "open" | "reconnect" | "resume";

/** One connect attempt. */
export interface ConnectRequest {
  workspaceId: string;
  /** Bundle build id of this page, checked against the workspace's server build. */
  build: string;
  /** Stable `sessionStorage` participant identity. */
  tabId: string;
  reason: ConnectReason;
  /** How long `202`/`423` may be polled inside one call (default 60 min, including an upgrade). */
  deadlineMs?: number;
  /** Boot detail for the overlay, e.g. `boot:clone`. */
  onProgress?: (detail: string) => void;
  signal?: AbortSignal;
}

/** Interval between `GET /api/workspaces/{id}` polls while a resume runs. */
export const CONNECT_POLL_MS = 1_500;
/** Covers the bounded rebuild: up to 20 minutes archiving and 35 minutes creating. */
export const CONNECT_DEADLINE_MS = 60 * 60_000;

function parseConnectInfo(body: unknown): ConnectInfo {
  const raw = (body ?? {}) as Partial<ConnectInfo>;
  if (typeof raw.wsUrl !== "string" || typeof raw.token !== "string" || typeof raw.sessionId !== "string") {
    throw new ConnectError("unavailable", "The control plane returned an unusable connection");
  }
  return raw as ConnectInfo;
}

/**
 * Connects, resuming and retrying exactly as b9 §3.26 bullet 2 prescribes.
 * Resolves with a fresh {@link ConnectInfo} (a new `sessionId` on every call,
 * D1) and rejects with a {@link ConnectError}.
 */
export async function connectWorkspace(req: ConnectRequest): Promise<ConnectInfo> {
  const deadline = Date.now() + (req.deadlineMs ?? CONNECT_DEADLINE_MS);
  let remintedCookie = false;

  for (;;) {
    const res = await fetch(`/api/workspaces/${req.workspaceId}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientBuild: req.build, reason: req.reason, tabId: req.tabId }),
      cache: "no-store",
      signal: req.signal,
    });

    if (res.status === 200) return parseConnectInfo(await res.json());

    if (res.status === 202) {
      const body = await res.json() as { status: string };
      req.onProgress?.(body.status === "upgrading" ? "Upgrading the editor; keeping your files and editor state…" : "boot:resuming");
      await waitForRunning(req, deadline);
      // Refresh page props too: the local backend's workspace path changes with its generation.
      if (body.status === "upgrading") throw new ConnectError("build_mismatch", "The workspace was upgraded. Reloading…");
      continue;
    }

    const body = await apiErrorBody(res);
    switch (res.status) {
      case 401: {
        if (remintedCookie) throw new ConnectError("unauthorized", body.message, 401);
        remintedCookie = true;
        if (!(await refreshEditorSession(req.workspaceId))) {
          throw new ConnectError("unauthorized", body.message, 401);
        }
        continue;
      }
      case 402:
        throw new ConnectError("plan_limit", body.message, 402, body.details);
      case 403:
        throw new ConnectError("forbidden", body.message, 403, body.details);
      case 410:
        throw new ConnectError("deleted", body.message, 410, body.details);
      case 409:
        if (body.code === "workspace_stopped") throw new ConnectError("stopped", body.message, 409, body.details);
        if (body.code === "client_build_mismatch") {
          throw new ConnectError("build_mismatch", body.message, 409, body.details);
        }
        throw new ConnectError("unavailable", body.message, 409, body.details);
      case 423:
        req.onProgress?.("boot:starting");
        await waitForRunning(req, deadline);
        // Another tab may have upgraded while this request waited for the lifecycle lock.
        throw new ConnectError("build_mismatch", "The workspace restarted. Reloading…");
      default:
        throw new ConnectError("unavailable", body.message, res.status, body.details);
    }
  }
}

async function waitOrGiveUp(
  deadline: number,
  message: string,
): Promise<void> {
  if (Date.now() >= deadline) throw new ConnectError("unavailable", message || "The workspace is still starting");
  await new Promise<void>(resolve => setTimeout(resolve, CONNECT_POLL_MS));
  if (Date.now() > deadline) throw new ConnectError("unavailable", message || "The workspace is still starting");
}

/**
 * Polls until the lifecycle run finishes. A STOPPING listener must observe a
 * lifecycle transition before reloading: a platform SIGTERM can leave the DB
 * looking running while the Rust client is still flushing its unsaved buffers.
 */
export async function waitForRunning(
  req: Pick<ConnectRequest, "workspaceId" | "signal" | "onProgress"> & { afterStopping?: boolean },
  deadline = Date.now() + CONNECT_DEADLINE_MS,
): Promise<void> {
  let observedLifecycle = !req.afterStopping;

  for (;;) {
    const res = await fetch(`/api/workspaces/${req.workspaceId}`, { cache: "no-store", signal: req.signal });
    if (res.status === 404 || res.status === 410) throw new ConnectError("deleted", "This workspace was deleted", res.status);
    if (res.status === 401 || res.status === 403) {
      throw new ConnectError(res.status === 401 ? "unauthorized" : "forbidden", "Not allowed", res.status);
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { workspace?: Partial<WorkspaceView> };
      const workspace = body.workspace ?? {};
      if (workspace.workflowRunId || (workspace.state && workspace.state !== "running")) observedLifecycle = true;
      if (workspace.state === "rebuilding" || workspace.stateReason === "rebuild") {
        req.onProgress?.("Upgrading the editor; keeping your files and editor state…");
      } else if (workspace.stateReason) req.onProgress?.(workspace.stateReason);
      if (workspace.state === "running" && !workspace.workflowRunId) {
        if (observedLifecycle) return;
        throw new ConnectError("stopped", "The workspace server stopped", 409);
      }
      if (workspace.state === "stopped" && !workspace.workflowRunId) {
        throw new ConnectError("stopped", "The workspace is stopped", 409);
      }
      if (workspace.state === "error" && !workspace.workflowRunId) {
        throw new ConnectError("unavailable", workspace.stateReason ?? "The workspace failed to start");
      }
    }
    await waitOrGiveUp(deadline, "The workspace is still starting");
  }
}
