import { ZS_BOOT_STAGES, type ZsBootStage } from "@/lib/zed-web";

/**
 * The editor shell's state machine (b9 §3.26). Pure: every function here is a
 * total mapping from a wasm-side event to the phase the UI renders, so the
 * mapping is unit-tested without a browser.
 */

/** Why a workspace is stopped, as far as the shell can tell. */
export type StopReason = "idle" | "user" | "cap" | "error" | "unknown";

/** What the shell renders (b9 §3.26). */
export type ShellPhase =
  | { kind: "booting"; stage: ZsBootStage; detail?: string }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "stopped"; reason: StopReason }
  | { kind: "takeover-required" }
  | { kind: "taken-over" }
  | { kind: "restarting"; secondsLeft: number }
  | { kind: "unsupported-browser" }
  | { kind: "error"; message: string; retryable: boolean; code?: string };

/**
 * A phase plus the side effect the shell must run after applying it. The
 * effects are the two the contract prescribes: `incompatible_server` reloads
 * the page and `unauthorized` re-mints the editor cookie and then signs in
 * again (b9 §3.26 bullet 4).
 */
export interface ShellTransition {
  phase: ShellPhase;
  effect?: "reload" | "reauthenticate";
}

/** Human label of each boot stage, shown under the progress bar. */
export const BOOT_STAGE_LABELS: Readonly<Record<ZsBootStage, string>> = {
  booting: "Starting the editor",
  assets: "Loading fonts and themes",
  settings: "Applying your settings",
  connecting: "Connecting to your workspace",
  database: "Restoring your layout",
  languages: "Loading languages",
  window: "Opening the window",
  ready: "Ready",
  reconnecting: "Reconnecting",
  stopped: "Stopped",
  failed: "Failed",
};

/** Fraction of the boot the overlay shows for `stage`, in `[0, 1]`. */
export function bootProgressRatio(stage: ZsBootStage): number {
  const index = (ZS_BOOT_STAGES as readonly string[]).indexOf(stage);
  if (index < 0) return 0;
  return (index + 1) / ZS_BOOT_STAGES.length;
}

/** Boot error codes a reload or a "Reconnect" click cannot fix. */
const TERMINAL_BOOT_CODES: ReadonlySet<string> = new Set([
  "bad_config",
  "bad_host",
  "bad_assets",
  "runtime_missing",
  "ctors_missing",
  "settings",
  "database",
  "window",
  "bundle_not_built",
  "bundle_missing",
]);

const BOOT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  bad_config: "The editor rejected its boot configuration.",
  bad_host: "The editor rejected the page's host bridge.",
  bad_assets: "The editor asset bundle could not be read.",
  runtime_missing: "The editor bundle is incomplete.",
  ctors_missing: "The editor bundle is incomplete.",
  settings: "Your settings could not be applied.",
  database: "Your saved layout could not be restored.",
  window: "The editor window could not be opened.",
  connect_failed: "Could not reach the workspace.",
  reconnect_exhausted: "Lost the connection to your workspace.",
  boot_timeout: "The editor took too long to start.",
  cancelled: "The editor start was cancelled.",
  bundle_not_built: "The editor bundle has not been built for this deployment.",
  bundle_missing: "The editor bundle is missing from this deployment.",
};

function errorPhase(code: string, fallback: string): ShellPhase {
  return {
    kind: "error",
    code,
    message: BOOT_ERROR_MESSAGES[code] ?? fallback,
    retryable: !TERMINAL_BOOT_CODES.has(code),
  };
}

/**
 * Maps a `stopped` progress event (or a `start()` rejection, which is handled
 * identically) to a transition. `detail` is a `close_code_detail` name — the
 * D23 vocabulary (`superseded` 4001, `build_mismatch` 4002, `unauthorized`
 * 4003, `session_active` 4005, `bad_hello` 4006, `going_away` 1001) and b7's
 * legacy names for the same codes are both accepted; the numeric close code
 * never reaches this function (`onClosed` is telemetry only).
 */
export function transitionForBootFailure(code: string, hint?: { stopReason?: StopReason }): ShellTransition {
  switch (code) {
    case "taken_over":
    case "superseded":
      return { phase: { kind: "taken-over" } };
    case "session_busy":
    case "session_active":
      return { phase: { kind: "takeover-required" } };
    case "incompatible_server":
    case "build_mismatch":
    case "bad_hello":
      return { phase: errorPhase(code, "This tab is running an older editor build."), effect: "reload" };
    case "unauthorized":
      return {
        phase: { kind: "error", code, message: "Your session expired.", retryable: false },
        effect: "reauthenticate",
      };
    case "workspace_stopped":
    case "server_stopping":
    case "going_away":
      return { phase: { kind: "stopped", reason: hint?.stopReason ?? "unknown" } };
    case "quit":
      return { phase: { kind: "stopped", reason: "user" } };
    default:
      return { phase: errorPhase(code, "The editor stopped unexpectedly.") };
  }
}

/** Parses the attempt number b7 puts in the `reconnecting` detail (`"3"` or `"3/20"`). */
function reconnectAttempt(detail: string): number {
  const attempt = Number.parseInt(detail, 10);
  return Number.isFinite(attempt) && attempt > 0 ? attempt : 1;
}

/**
 * Maps one `host.bootProgress(stage, detail)` call to a transition
 * (b9 §3.26 bullet 4).
 */
export function transitionForBootProgress(
  stage: ZsBootStage,
  detail: string,
  hint?: { stopReason?: StopReason },
): ShellTransition {
  switch (stage) {
    case "ready":
      return { phase: { kind: "ready" } };
    case "reconnecting":
      return { phase: { kind: "reconnecting", attempt: reconnectAttempt(detail) } };
    case "stopped":
      return transitionForBootFailure(detail, hint);
    case "failed":
      return {
        phase: {
          kind: "error",
          code: detail || "failed",
          message: BOOT_ERROR_MESSAGES[detail] ?? "The editor failed to start.",
          retryable: !TERMINAL_BOOT_CODES.has(detail),
        },
      };
    default:
      return { phase: { kind: "booting", stage, detail: detail || undefined } };
  }
}

/** Phases in which the top strip offers "Reconnect"/"Resume" (b9 §3.26 bullet 5). */
export function offersReconnect(phase: ShellPhase): boolean {
  return (
    phase.kind === "stopped" ||
    phase.kind === "taken-over" ||
    (phase.kind === "error" && phase.retryable)
  );
}

/** True while the boot overlay covers the canvas. */
export function coversCanvas(phase: ShellPhase): boolean {
  return phase.kind !== "ready";
}
