import type { ClientErrorInput } from "@/lib/types";

/**
 * Browser-side calls the editor shell makes against the control plane
 * (b9 §3.26 bullets 4-8). Every call is same-origin and authenticated by the
 * `zs_editor` cookie the proxy mints on the document request, so no token
 * ever passes through this module.
 */

/** Injection point for tests; defaults to the page's `fetch`. */
export interface ApiDeps {
  fetch?: typeof fetch;
}

/** The `{ error: { code, message } }` envelope every route returns on failure. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

function fetchOf(deps?: ApiDeps): typeof fetch {
  const impl = deps?.fetch ?? globalThis.fetch;
  return (input, init) => impl(input, init);
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
async function post(workspaceId: string, path: string, body: unknown, deps?: ApiDeps): Promise<Response> {
  return fetchOf(deps)(`/api/workspaces/${workspaceId}/${path}`, {
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
export async function keepAlive(workspaceId: string, deps?: ApiDeps): Promise<KeepAliveResult> {
  const res = await post(workspaceId, "keepalive", {}, deps);
  if (!res.ok) throw new Error((await apiErrorBody(res)).message);
  const body = (await res.json().catch(() => ({}))) as { keptAliveUntil?: unknown };
  return { keptAliveUntil: typeof body.keptAliveUntil === "string" ? body.keptAliveUntil : null };
}

/** "Stop" in the top strip: asks the control plane to stop the workspace. */
export async function stopWorkspace(workspaceId: string, deps?: ApiDeps): Promise<void> {
  const res = await post(workspaceId, "stop", {}, deps);
  if (!res.ok) throw new Error((await apiErrorBody(res)).message);
}

/**
 * Re-mints the `zs_editor` cookie (every 6 h and after any `401`,
 * b9 §3.26 bullet 8). Returns false when the caller must sign in again.
 */
export async function refreshEditorSession(workspaceId: string, deps?: ApiDeps): Promise<boolean> {
  try {
    const res = await post(workspaceId, "session", {}, deps);
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
  deps?: ApiDeps,
): Promise<void> {
  try {
    await post(workspaceId, "client-errors", { ...report, build }, deps);
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
export async function fetchSettingsDocument(url: string, deps?: ApiDeps): Promise<SettingsDocument> {
  const res = await fetchOf(deps)(url, { cache: "no-store" });
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
  deps?: ApiDeps,
): Promise<SettingsDocument> {
  const res = await fetchOf(deps)(url, {
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

/** The deep link that opens the same repository in desktop Zed (b9 §3.26 bullet 5). */
export function desktopUrl(workspaceId: string): string {
  return `zed://zs/w/${workspaceId}`;
}
