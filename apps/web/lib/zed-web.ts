/**
 * The shell ↔ wasm loader contract (CONTRACTS.md §8.4, b7 §4.2, b9 §4.6).
 *
 * These are the types of `/editor/<build>/zed_web.js`. They are declared here
 * rather than imported from `@zs/sdk/zed-web` (b9 §3.32) because the shared
 * SDK package does not exist yet; when it lands this module re-exports it.
 * Nothing here touches the server, so client components may import it freely.
 */

/** Boot stages `ZsHost.bootProgress` reports, in the order they occur. */
export const ZS_BOOT_STAGES = [
  "booting",
  "assets",
  "settings",
  "connecting",
  "database",
  "languages",
  "window",
  "ready",
] as const;

/** A stage of the wasm boot sequence, plus the three terminal stages. */
export type ZsBootStage = (typeof ZS_BOOT_STAGES)[number] | "reconnecting" | "stopped" | "failed";

/**
 * `detail` of a `stopped` progress event and of a `start()` rejection
 * (b7 §3.28 `close_code_detail`). Unknown codes are tolerated.
 */
export type ZsBootErrorCode =
  | "bad_config"
  | "bad_host"
  | "bad_assets"
  | "runtime_missing"
  | "ctors_missing"
  | "settings"
  | "connect_failed"
  // b7's legacy close-code names.
  | "connection_replaced"
  | "rejoin_required"
  | "incompatible_server"
  | "server_stopping"
  | "unauthorized"
  | "workspace_stopped"
  // D23 `close_code_detail` names (4001, 4002, 4005, 4006, 1001).
  | "superseded"
  | "build_mismatch"
  | "bad_hello"
  | "going_away"
  | "reconnect_exhausted"
  | "database"
  | "window"
  | "boot_timeout"
  | "cancelled"
  | "quit";

/** Lifecycle notices the server relays to the client (D29: snake_case). */
export type ZsLifecycleKind = "idle_stop_in" | "session_cap_in" | "stopping" | "resumed";

/** The connect half of {@link ZsBootConfig}; a subset of the control plane's `ConnectInfo` (D26). */
export interface ZsConnectInfo {
  /** `wss://<host8443>/rpc`. */
  wsUrl: string;
  token: string;
  /** Fresh `con_…` on every `/connect`; informational (D1). */
  sessionId: string;
  serverBuild?: string;
  /** ISO 8601. */
  sessionExpiresAt?: string;
}

/** The JSON document handed to `start()` as its first argument. */
export interface ZsBootConfig {
  buildId: string;
  connect: ZsConnectInfo;
  /** `id` is the stable identity the client persists under (D1). */
  workspace: { id: string; paths: string[] };
  settingsJson?: string;
  keymapJson?: string;
  backend?: "auto" | "webgpu" | "webgl";
  hostOs?: ZsHostOs;
}

/** Host platform the keymap layer is picked from (D12). */
export type ZsHostOs = "mac" | "windows" | "linux";

/** Argument of the optional `onClosed` callback: the raw WebSocket close frame. */
export interface ZsCloseInfo {
  code: number;
  reason: string;
}

/** Which of the two user documents `saveDocument` carries. */
export type ZsDocumentKind = "settings" | "keymap";

export type ZsUpdateAction = "check" | "install";
export type ZsUpdateStatus =
  | { phase: "idle" | "checking" }
  | { phase: "downloading"; build: string; progress: number | null }
  | { phase: "ready" | "installing"; build: string }
  | { phase: "error"; message: string };

/**
 * The object the shell passes as the third argument of `start()`. Every
 * method is called from the wasm client; none of them may throw
 * synchronously.
 */
export interface ZsHost {
  /** Drives the boot overlay; `stopped` carries a {@link ZsBootErrorCode} in `detail`. */
  bootProgress(stage: ZsBootStage, detail: string): void;
  /**
   * Mints a fresh connection for the transport. Rejects with
   * `{ code: "stopped" }`, `{ code: "unauthorized" }` (both terminal for b1)
   * or `{ code: "unavailable" }` (retried with backoff).
   */
  refreshConnectInfo(): Promise<ZsConnectInfo>;
  /** Persists a settings or keymap document; rejects on `409 version_conflict`. */
  saveDocument(kind: ZsDocumentKind, json: string): Promise<void>;
  /** Reports a panic or boot failure to the control plane. */
  reportError(kind: "panic" | "boot", message: string, stack: string): void;
  /** Lifecycle notice relayed from the supervisor; `seconds` is the countdown. */
  onLifecycle(kind: ZsLifecycleKind, seconds: number): void;
  /** Runs after the GPUI callback returns, so status updates cannot reenter its App borrow. */
  updateAction(action: ZsUpdateAction): void;
  /** Archives saved working files in the sandbox and starts a browser download. */
  downloadProject(path: string, includeIgnored: boolean): Promise<string>;
  /** Optional: the raw close frame, telemetry only (b7 §3.21). */
  onClosed?(info: ZsCloseInfo): void;
}

/** The exports of `/editor/<build>/zed_web.js` the shell calls. */
export interface ZedWebModule {
  /** wasm-bindgen's init; resolves to the instance's exports. */
  default(options?: { module_or_path?: string | Response }): Promise<ZedWebInstance>;
  /** Single-shot: rejects with `{ code, message }`; every retry is a page reload. */
  start(configJson: string, assets: Uint8Array, host: ZsHost): Promise<void>;
  flush_client_state(): Promise<void>;
  set_hidden(hidden: boolean): void;
  has_unsaved_changes(): boolean;
  build_id(): string;
  set_update_status(statusJson: string): void;
  /** Present only in the development stub of §"bundle not built" (public/editor/README.md). */
  zsStub?: boolean;
}

/** The wasm instance wasm-bindgen's init resolves to. */
export interface ZedWebInstance {
  /** Called once after init when the module does not call it itself (b7 §3.30). */
  __wasm_call_ctors?(): void;
}

/** A rejection of `start()` or a `stopped` progress event, once normalised. */
export interface ZsBootFailure {
  code: string;
  message: string;
}

/** Narrows an unknown rejection to {@link ZsBootFailure}. */
export function asBootFailure(err: unknown): ZsBootFailure {
  if (typeof err === "object" && err !== null) {
    const raw = err as { code?: unknown; message?: unknown };
    const code = typeof raw.code === "string" ? raw.code : "failed";
    const message = typeof raw.message === "string" ? raw.message : String(err);
    return { code, message };
  }
  return { code: "failed", message: String(err) };
}
