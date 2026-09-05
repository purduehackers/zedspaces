import type { ConnectInfo, WorkspaceView } from "@/lib/types";
import { apiErrorBody, refreshEditorSession, type ApiDeps } from "./api-client";

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
  | "session_active"
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
  /** `sessionStorage` tab id: the same tab reconnecting is not a takeover. */
  tabId: string;
  reason: ConnectReason;
  /** Close another tab's session instead of answering `409 session_active`. */
  takeover?: boolean;
  /** How long `202`/`423` may be polled inside one call (default 5 min). */
  deadlineMs?: number;
  /** Boot detail for the overlay, e.g. `boot:clone`. */
  onProgress?: (detail: string) => void;
  signal?: AbortSignal;
}

/** Injection points for the tests: `fetch`, the clock and the sleep. */
export interface ConnectDeps extends ApiDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Interval between `GET /api/workspaces/{id}` polls while a resume runs. */
export const CONNECT_POLL_MS = 1_500;
/** One connect call spans a session-cap restart (b1 §7.5, D2). */
export const CONNECT_DEADLINE_MS = 300_000;

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
export async function connectWorkspace(req: ConnectRequest, deps: ConnectDeps = {}): Promise<ConnectInfo> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + (req.deadlineMs ?? CONNECT_DEADLINE_MS);
  const takeover = req.takeover ?? false;
  let remintedCookie = false;

  for (;;) {
    const res = await doFetch(`/api/workspaces/${req.workspaceId}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ takeover, clientBuild: req.build, reason: req.reason, tabId: req.tabId }),
      cache: "no-store",
      signal: req.signal,
    });

    if (res.status === 200) return parseConnectInfo(await res.json());

    if (res.status === 202) {
      // `{ status: "resuming", runId }` – the run id is only useful in logs.
      await res.json().catch(() => ({}));
      req.onProgress?.("boot:resuming");
      await waitForRunning(req, deps, deadline);
      continue;
    }

    const body = await apiErrorBody(res);
    switch (res.status) {
      case 401: {
        if (remintedCookie) throw new ConnectError("unauthorized", body.message, 401);
        remintedCookie = true;
        if (!(await refreshEditorSession(req.workspaceId, deps))) {
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
        if (body.code === "session_active") throw new ConnectError("session_active", body.message, 409, body.details);
        if (body.code === "client_build_mismatch") {
          throw new ConnectError("build_mismatch", body.message, 409, body.details);
        }
        throw new ConnectError("unavailable", body.message, 409, body.details);
      case 423:
        req.onProgress?.("boot:starting");
        await waitOrGiveUp(sleep, now, deadline, body.message);
        continue;
      default:
        throw new ConnectError("unavailable", body.message, res.status, body.details);
    }
  }
}

async function waitOrGiveUp(
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  deadline: number,
  message: string,
): Promise<void> {
  if (now() >= deadline) throw new ConnectError("unavailable", message || "The workspace is still starting");
  await sleep(CONNECT_POLL_MS);
  if (now() > deadline) throw new ConnectError("unavailable", message || "The workspace is still starting");
}

/**
 * Polls `GET /api/workspaces/{id}` until the resume workflow has finished, so
 * the caller can re-`POST /connect`. `stateReason` (`boot:<phase>`) drives the
 * overlay's detail line.
 */
async function waitForRunning(req: ConnectRequest, deps: ConnectDeps, deadline: number): Promise<void> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  for (;;) {
    const res = await doFetch(`/api/workspaces/${req.workspaceId}`, { cache: "no-store", signal: req.signal });
    if (res.status === 410) throw new ConnectError("deleted", "This workspace was deleted", 410);
    if (res.status === 401 || res.status === 403) {
      throw new ConnectError(res.status === 401 ? "unauthorized" : "forbidden", "Not allowed", res.status);
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { workspace?: Partial<WorkspaceView> };
      const workspace = body.workspace ?? {};
      if (workspace.stateReason) req.onProgress?.(workspace.stateReason);
      if (workspace.state === "running" && !workspace.workflowRunId) return;
      if (workspace.state === "stopped" && !workspace.workflowRunId) {
        throw new ConnectError("stopped", "The workspace is stopped", 409);
      }
      if (workspace.state === "error") {
        throw new ConnectError("unavailable", workspace.stateReason ?? "The workspace failed to start");
      }
    }
    await waitOrGiveUp(sleep, now, deadline, "The workspace is still starting");
  }
}
