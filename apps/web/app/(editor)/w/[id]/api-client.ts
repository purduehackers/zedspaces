import type { ClientErrorInput } from "@/lib/types";

/**
 * Browser-side calls the editor shell makes against the control plane
 * (b9 §3.26 bullets 4-8). Every call is same-origin and authenticated by the
 * `zs_editor` cookie the proxy mints on the document request, so no token
 * ever passes through this module.
 */

/** The `{ error: { code, message } }` envelope every route returns on failure. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** Reads the error envelope of a failed response; never throws. */
export async function apiErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    const body = (await res.json()) as { error?: Partial<ApiErrorBody> };
    const error = body.error ?? {};
    return {
      code: typeof error.code === "string" ? error.code : `http_${res.status}`,
      message: typeof error.message === "string" ? error.message : res.statusText,
      details: error.details,
    };
  } catch {
    return { code: `http_${res.status}`, message: res.statusText };
  }
}

/** `POST /api/workspaces/{id}/{path}` with a JSON body and no caching. */
async function post(workspaceId: string, path: string, body: unknown): Promise<Response> {
  return fetch(`/api/workspaces/${workspaceId}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
}

/** Result of {@link keepAlive}. */
export interface KeepAliveResult {
  /** ISO 8601 instant the idle clock now expires at, when the route reports one. */
  keptAliveUntil: string | null;
}

/** "Keep alive" on the idle-stop toast: pushes the idle clock forward (b9 §3.26 bullet 4). */
export async function keepAlive(workspaceId: string): Promise<KeepAliveResult> {
  const res = await post(workspaceId, "keepalive", {});
  if (!res.ok) throw new Error((await apiErrorBody(res)).message);
  const body = (await res.json().catch(() => ({}))) as { keptAliveUntil?: unknown };
  return { keptAliveUntil: typeof body.keptAliveUntil === "string" ? body.keptAliveUntil : null };
}

async function connectProcess(workspaceId: string, kind: "debug" | "kernel", body: unknown): Promise<{ launch: string; url: string; token: string }> {
  const res = await fetch(`/api/workspaces/${workspaceId}/${kind}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error((await apiErrorBody(res)).message);
  return res.json();
}

export const connectDebugAdapter = (workspaceId: string, launch: string) => connectProcess(workspaceId, "debug", launch);
export const connectKernel = (workspaceId: string, python: string | null, cwd: string) => connectProcess(workspaceId, "kernel", { python, cwd });

/**
 * Re-mints the `zs_editor` cookie (every 6 h and after any `401`,
 * b9 §3.26 bullet 8). Returns false when the caller must sign in again.
 */
export async function refreshEditorSession(workspaceId: string): Promise<boolean> {
  try {
    const res = await post(workspaceId, "session", {});
    return res.ok;
  } catch {
    return false;
  }
}

/** A client error report, without the build id the shell fills in. */
export type ClientErrorReport = Omit<ClientErrorInput, "build">;

/** `POST /api/workspaces/{id}/client-errors` — panics, boot failures and close-frame telemetry. */
export async function reportClientError(
  workspaceId: string,
  build: string,
  report: ClientErrorReport,
): Promise<void> {
  try {
    await post(workspaceId, "client-errors", { ...report, build });
  } catch {
    // Telemetry is best effort: a failed report must never break the editor.
  }
}

/** A settings or keymap document as `/api/workspaces/{id}/{settings,keymap}` returns it. */
export interface SettingsDocument {
  content: string;
  version: number | null;
}

/** Reads one of the user's JSONC documents; a missing document reads as empty. */
export async function fetchSettingsDocument(url: string): Promise<SettingsDocument> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { content: "", version: null };
  const body = (await res.json().catch(() => ({}))) as { content?: unknown; version?: unknown };
  return {
    content: typeof body.content === "string" ? body.content : "",
    version: typeof body.version === "number" ? body.version : null,
  };
}

/** Raised when `PUT /api/workspaces/{id}/{settings,keymap}` answers `409 version_conflict`. */
export class DocumentConflictError extends Error {
  /** Always `"version_conflict"`, so the wasm side can branch on it. */
  readonly code = "version_conflict";

  constructor(message: string) {
    super(message);
    this.name = "DocumentConflictError";
  }
}

/** Writes one of the user's JSONC documents (the `saveDocument` target). */
export async function putSettingsDocument(
  url: string,
  doc: { content: string; version: number | null },
): Promise<SettingsDocument> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc.version === null ? { content: doc.content } : doc),
    cache: "no-store",
  });
  if (res.status === 409) throw new DocumentConflictError((await apiErrorBody(res)).message);
  if (!res.ok) throw new Error((await apiErrorBody(res)).message);
  const body = (await res.json().catch(() => ({}))) as { content?: unknown; version?: unknown };
  return {
    content: typeof body.content === "string" ? body.content : doc.content,
    version: typeof body.version === "number" ? body.version : doc.version,
  };
}

/**
 * Opens a link outside the canvas (the replacement for the `openExternal`
 * host callback b7 declined, b9 §7 item 6). `noopener` keeps the editor's
 * cross-origin isolation intact.
 */
export function openExternal(url: string): void {
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

/** Reloading the public editor document mints fresh internal session cookies; no login route. */
export function sessionReloadUrl(returnTo: string): string {
  return returnTo.startsWith("/w/") && !returnTo.includes("\\") ? returnTo : "/";
}
