"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShellWorkspace } from "@/lib/types";
import type { ZsBootConfig, ZsBootStage, ZsConnectInfo, ZsDocumentKind, ZsHostOs, ZsLifecycleKind } from "@/lib/zed-web";
import { asBootFailure } from "@/lib/zed-web";
import {
  fetchSettingsDocument,
  keepAlive,
  openExternal,
  refreshEditorSession,
  reportClientError,
  sessionReloadUrl,
} from "./api-client";
import { ConnectError, connectWorkspace, waitForRunning, type ConnectReason } from "./connect-client";
import { bootEditor, BundleError, type EditorRuntime } from "./loader";
import "./editor-shell.css";
import {
  transitionForBootFailure,
  transitionForBootProgress,
  type ShellPhase,
  type ShellTransition,
  type StopReason,
} from "./shell-phase";
import { LifecycleToasts, ShellOverlay, type ShellActions, type ShellToast } from "./shell-ui";
import { createHost, type ShellController } from "./zs-host";
import { EditorUpdater } from "./editor-updater";
import { BrowserDiagnostics } from "./diagnostics";

/**
 * The editor shell (b9 §3.26): it authenticates the page's connection, loads
 * `/editor/<build>/zed_web.js`, hands it a {@link createHost} bridge and
 * renders every out-of-canvas state — boot overlay, reconnect overlay,
 * lifecycle toasts and the terminal "stopped" state that
 * offers a resume.
 */

/** Where `reconnect()` leaves its intent for the next page load (b9 §3.26 bullet 10). */
export const NEXT_BOOT_KEY = "zsNext";
/** The tab identity `/connect` arbitrates on; survives a reload, not a new tab. */
export const TAB_ID_KEY = "zsTabId";
/** The editor cookie is re-minted on this interval (b9 §3.26 bullet 8). */
export const SESSION_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Keys `navigator.keyboard.lock()` claims in fullscreen (b9 §3.26 bullet 6). */
export const LOCKED_KEYS = ["KeyW", "KeyT", "KeyN", "KeyQ", "Tab"];

/** What `reconnect()` asks the next page load to do. */
export interface NextBoot {
  resume?: boolean;
}

/** Props of {@link EditorShell}; assembled by the server component. */
export interface EditorShellProps {
  workspaceId: string;
  /** The workspace's pinned bundle; pre-updater workspaces bootstrap to the deployed build. */
  build: string;
  initial: ShellWorkspace;
  /** `ZsBootConfig.workspace.paths` — the clone inside the sandbox. */
  paths: string[];
  settingsUrl: string;
  keymapUrl: string;
}

interface KeyboardLockApi {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
}

/** Maps the browser's platform string to the keymap layer b7 picks (D12). */
export function hostOsOf(platform: string | undefined): ZsHostOs {
  const value = (platform ?? "").toLowerCase();
  if (value.includes("mac") || value.includes("iphone") || value.includes("ipad")) return "mac";
  if (value.includes("win")) return "windows";
  return "linux";
}

function currentHostOs(): ZsHostOs {
  if (typeof navigator === "undefined") return "linux";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return hostOsOf(data?.platform ?? navigator.platform);
}

function readSessionValue(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Private browsing without storage: the tab simply loses its identity on reload.
  }
}

/** Reads and clears `sessionStorage.zsNext` (written by `reconnect()`). */
export function takeNextBoot(): NextBoot | null {
  const raw = readSessionValue(NEXT_BOOT_KEY);
  writeSessionValue(NEXT_BOOT_KEY, null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NextBoot;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** The `sessionStorage` tab id, minted on first use. */
export function tabId(): string {
  const existing = readSessionValue(TAB_ID_KEY);
  if (existing && existing.length >= 8) return existing;
  const minted = globalThis.crypto?.randomUUID?.() ?? `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  writeSessionValue(TAB_ID_KEY, minted);
  return minted;
}

/** Maps a failed `connect()` to the phase the shell shows (b9 §3.26 bullet 2). */
export function transitionForConnectError(err: unknown): ShellTransition {
  if (err instanceof BundleError) {
    return transitionForBootFailure(err.code);
  }
  if (!(err instanceof ConnectError)) {
    return {
      phase: {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        code: "connect_failed",
      },
    };
  }
  switch (err.code) {
    case "stopped":
      return { phase: { kind: "stopped", reason: "unknown" } };
    case "build_mismatch":
      return {
        phase: { kind: "error", code: err.code, message: "This tab is running an older editor build.", retryable: true },
        effect: "reload",
      };
    case "unauthorized":
      return {
        phase: { kind: "error", code: err.code, message: "Your session expired.", retryable: false },
        effect: "reauthenticate",
      };
    case "plan_limit":
    case "forbidden":
    case "deleted":
      return { phase: { kind: "error", code: err.code, message: err.message, retryable: false } };
    default:
      return { phase: { kind: "error", code: err.code, message: err.message, retryable: true } };
  }
}

function toastFor(kind: ZsLifecycleKind, seconds: number, onKeepAlive: () => void): ShellToast | null {
  switch (kind) {
    case "idle_stop_in":
      return {
        id: "idle",
        message: `This workspace stops in ${seconds}s because it has been idle.`,
        action: { label: "Keep alive", onClick: onKeepAlive },
      };
    case "session_cap_in":
      return { id: "cap", message: `This session restarts in ${seconds}s (24 h session limit).` };
    default:
      return null;
  }
}

export function EditorShell({
  workspaceId,
  build,
  initial,
  paths,
  settingsUrl,
  keymapUrl,
}: EditorShellProps) {
  const [phase, setPhase] = useState<ShellPhase>({ kind: "booting", stage: "booting" });
  const [toasts, setToasts] = useState<ShellToast[]>([]);
  const [graphics, setGraphics] = useState("ready");

  const runtimeRef = useRef<EditorRuntime | null>(null);
  const [runtime, setRuntime] = useState<EditorRuntime | null>(null);
  const updaterRef = useRef<EditorUpdater | null>(null);
  const bootedRef = useRef(false);
  const flushAllowedRef = useRef(true);
  const stopReasonRef = useRef<StopReason>("unknown");
  const versionsRef = useRef<Record<ZsDocumentKind, number | null>>({ settings: null, keymap: null });
  const diagnosticsRef = useRef<BrowserDiagnostics | null>(null);
  const crashedRef = useRef(false);
  const connectionAbortRef = useRef<AbortController | null>(null);
  const waitingForStopRef = useRef(false);

  const runtimeFailed = useCallback(() => {
    if (crashedRef.current) return;
    crashedRef.current = true;
    flushAllowedRef.current = false;
    runtimeRef.current?.invalidate();
    updaterRef.current?.dispose();
    connectionAbortRef.current?.abort();
    // Never re-enter GPUI from its panic hook; only update the browser shell.
    setPhase({ kind: "error", code: "runtime_crashed", retryable: true,
      message: "The editor crashed. Saved files remain in the sandbox, but unsaved edits may be lost on reload. Download diagnostics before reconnecting." });
  }, []);

  useEffect(() => {
    const diagnostics = new BrowserDiagnostics(build, runtimeFailed);
    diagnosticsRef.current = diagnostics;
    return () => { diagnostics.dispose(); diagnosticsRef.current = null; };
  }, [build, runtimeFailed]);

  useEffect(() => {
    diagnosticsRef.current?.stage(phase.kind === "booting" ? phase.stage : phase.kind);
  }, [phase]);

  useEffect(() => {
    const changed = () => {
      const status = document.querySelector("canvas[data-gpui-graphics]")?.getAttribute("data-gpui-graphics");
      if (status === "ready" || status === "recovering" || status === "failed") {
        diagnosticsRef.current?.record("graphics", status);
        setGraphics(status);
      }
    };
    window.addEventListener("gpui-graphics-state", changed);
    changed();
    return () => window.removeEventListener("gpui-graphics-state", changed);
  }, []);

  /** `reconnect()` of D2/D30: stash the intent, then boot from scratch. */
  const reconnect = useCallback(
    (next: NextBoot = {}) => {
      writeSessionValue(NEXT_BOOT_KEY, JSON.stringify(next));
      globalThis.location.reload();
    },
    [],
  );

  const applyTransition = useCallback(
    (transition: ShellTransition) => {
      if (crashedRef.current) return;
      setPhase(transition.phase);
      if (transition.phase.kind === "error" && transition.phase.code === "connection_replaced") {
        // A replaced copy of the same tab must not overwrite its successor's layout.
        flushAllowedRef.current = false;
      }
      if (transition.effect === "reload") {
        globalThis.location.reload();
      } else if (transition.effect === "reauthenticate") {
        void refreshEditorSession(workspaceId).then((ok) => {
          if (!ok && !crashedRef.current) globalThis.location.assign(sessionReloadUrl(`/w/${workspaceId}`));
        });
      }
    },
    [workspaceId],
  );

  const onKeepAlive = useCallback(() => {
    void keepAlive(workspaceId)
      .then(() => setToasts((current) => current.filter((toast) => toast.id !== "idle")))
      .catch((err: unknown) => {
        diagnosticsRef.current?.error("keepalive", err);
        void reportClientError(workspaceId, build, {
          kind: "error",
          message: `keepalive failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }, [build, workspaceId]);

  const lifecycle = useCallback(
    (kind: ZsLifecycleKind, seconds: number) => {
      if (crashedRef.current) return;
      if (kind === "idle_stop_in") stopReasonRef.current = "idle";
      if (kind === "session_cap_in") stopReasonRef.current = "cap";

      if (kind === "stopping") {
        if (waitingForStopRef.current) return;
        waitingForStopRef.current = true;
        setToasts([]);
        setPhase({ kind: "stopped", reason: stopReasonRef.current === "unknown" ? "user" : stopReasonRef.current });
        // STOPPING starts the Rust client's flush. Do not unload it until the server has
        // stopped, archived its data and finished rebuilding. Normal idle/user stops stay stopped.
        void waitForRunning({
          workspaceId,
          afterStopping: true,
          signal: connectionAbortRef.current?.signal,
          onProgress: (detail) => {
            if (!crashedRef.current) setPhase({ kind: "booting", stage: "connecting", detail });
          },
        }).then(() => {
          if (crashedRef.current) return;
          flushAllowedRef.current = false;
          globalThis.location.reload();
        }).catch((err: unknown) => {
          if (crashedRef.current) return;
          if (err instanceof ConnectError && err.code === "stopped") {
            setPhase({ kind: "stopped", reason: stopReasonRef.current });
          } else {
            applyTransition(transitionForConnectError(err));
          }
        }).finally(() => { waitingForStopRef.current = false; });
        return;
      }
      if (kind === "resumed") {
        stopReasonRef.current = "unknown";
        setToasts([]);
        setPhase((current) =>
          current.kind === "stopped" || current.kind === "restarting"
            ? { kind: "booting", stage: "connecting" }
            : current,
        );
        return;
      }
      const toast = toastFor(kind, seconds, onKeepAlive);
      if (toast) {
        setToasts((current) => [...current.filter((entry) => entry.id !== toast.id), toast]);
      }
      if (kind === "session_cap_in" && seconds <= 30) {
        setPhase({ kind: "restarting", secondsLeft: seconds });
      }
    },
    [applyTransition, onKeepAlive, workspaceId],
  );

  /** One `connect()` call, with the overlay wired to its progress. */
  const connect = useCallback(
    async (reason: ConnectReason): Promise<ZsConnectInfo> => {
      if (crashedRef.current) throw new ConnectError("unavailable", "The editor crashed; reload to reconnect");
      connectionAbortRef.current ??= new AbortController();
      diagnosticsRef.current?.record("connection", reason);
      const info = await connectWorkspace(
        {
          workspaceId,
          build,
          tabId: tabId(),
          reason,
          signal: connectionAbortRef.current.signal,
          onProgress: (detail) => {
            if (!crashedRef.current) setPhase({ kind: "booting", stage: "connecting", detail });
          },
        },
      );
      diagnosticsRef.current?.record("connection", "connected");
      return {
        wsUrl: info.wsUrl,
        token: info.token,
        sessionId: info.sessionId,
        serverBuild: info.serverBuild,
        sessionExpiresAt: info.sessionExpiresAt,
      };
    },
    [build, workspaceId],
  );

  const controller = useMemo<ShellController>(
    () => ({
      workspaceId,
      build,
      bootProgress: (stage: ZsBootStage, detail: string) => {
        diagnosticsRef.current?.record("boot", `${stage}${detail ? `: ${detail}` : ""}`);
        applyTransition(transitionForBootProgress(stage, detail, { stopReason: stopReasonRef.current }));
      },
      lifecycle,
      updateAction: (action) => updaterRef.current?.action(action),
      refreshConnectInfo: async () => {
        try {
          return await connect("reconnect");
        } catch (err) {
          applyTransition(transitionForConnectError(err));
          throw err;
        }
      },
      documentUrl: (kind: ZsDocumentKind) => (kind === "settings" ? settingsUrl : keymapUrl),
      documentVersion: (kind: ZsDocumentKind) => versionsRef.current[kind],
      setDocumentVersion: (kind: ZsDocumentKind, version: number | null) => {
        versionsRef.current[kind] = version;
      },
      reportError: (kind, message, stack) => {
        diagnosticsRef.current?.record(kind, `${message}${stack ? `\n${stack}` : ""}`);
        if (kind === "panic") runtimeFailed();
        void reportClientError(workspaceId, build, { kind, message, stack });
      },
    }),
    [applyTransition, build, connect, keymapUrl, lifecycle, runtimeFailed, settingsUrl, workspaceId],
  );

  const boot = useCallback(async () => {
    const isolated = globalThis.crossOriginIsolated === true;
    if (!isolated) {
      setPhase({ kind: "unsupported-browser" });
      return;
    }

    const next = takeNextBoot();

    try {
      setPhase({ kind: "booting", stage: "connecting" });
      const [connectInfo, settingsDoc, keymapDoc] = await Promise.all([
        connect(next?.resume ? "resume" : "open"),
        fetchSettingsDocument(settingsUrl),
        fetchSettingsDocument(keymapUrl),
      ]);
      if (crashedRef.current) return;
      versionsRef.current = { settings: settingsDoc.version, keymap: keymapDoc.version };

      const config: ZsBootConfig = {
        buildId: build,
        connect: connectInfo,
        workspace: { id: workspaceId, paths },
        settingsJson: settingsDoc.content || undefined,
        keymapJson: keymapDoc.content || undefined,
        hostOs: currentHostOs(),
      };

      const host = createHost(controller);
      const booted = await bootEditor({
        build,
        config,
        host,
        signal: connectionAbortRef.current?.signal,
        onStage: (stage, detail) => {
          if (!crashedRef.current) setPhase({ kind: "booting", stage, detail: detail || undefined });
        },
      });
      runtimeRef.current = booted.runtime;
      if (crashedRef.current) booted.runtime.invalidate();
      else setRuntime(booted.runtime);
      booted.started.catch((err: unknown) => {
        diagnosticsRef.current?.error("boot", err);
        if (err instanceof WebAssembly.RuntimeError) runtimeFailed();
        const failure = asBootFailure(err);
        applyTransition(transitionForBootFailure(failure.code, { stopReason: stopReasonRef.current }));
        void reportClientError(workspaceId, build, { kind: "boot", message: failure.message });
      });
    } catch (err) {
      // A sibling preferences request may fail while /connect is still polling.
      connectionAbortRef.current?.abort();
      diagnosticsRef.current?.error("boot", err);
      if (err instanceof WebAssembly.RuntimeError) runtimeFailed();
      applyTransition(transitionForConnectError(err));
      if (err instanceof ConnectError && err.code === "build_mismatch") return;
      void reportClientError(
        workspaceId,
        build,
        { kind: "boot", message: err instanceof Error ? err.message : String(err) },
      );
    }
  }, [applyTransition, build, connect, controller, keymapUrl, paths, runtimeFailed, settingsUrl, workspaceId]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void boot();
  }, [boot]);

  // Begin update work only after the old editor is interactive. The worker never
  // precaches at install time and never owns API requests or workspace lifecycle.
  useEffect(() => {
    if (!runtime || crashedRef.current) return;
    const updater = new EditorUpdater(workspaceId, runtime, () => {
      if (crashedRef.current) return;
      flushAllowedRef.current = false;
      globalThis.location.reload();
    });
    updaterRef.current = updater;
    return () => { updater.dispose(); updaterRef.current = null; };
  }, [runtime, workspaceId]);

  useEffect(() => {
    const updater = updaterRef.current;
    updater?.setInteractive(phase.kind === "ready" && graphics === "ready");
    if (phase.kind === "ready" && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker?.register("/sw.js", { scope: "/w/" }).catch(() => undefined);
    }
  }, [phase.kind, runtime, graphics]);

  // Visibility, unload and fullscreen wiring (b9 §3.26 bullet 6).
  useEffect(() => {
    const flush = () => {
      if (!flushAllowedRef.current) return;
      void runtimeRef.current?.flushClientState().catch(error => diagnosticsRef.current?.error("state-flush", error));
    };
    const onVisibility = () => {
      const runtime = runtimeRef.current;
      if (!runtime || crashedRef.current) return;
      runtime.setHidden(document.hidden);
      if (document.hidden) flush();
    };
    const onPageHide = () => flush();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (crashedRef.current || (flushAllowedRef.current && runtimeRef.current?.hasUnsavedChanges())) event.preventDefault();
    };
    const onFullscreenChange = () => {
      const keyboard = keyboardApi();
      if (!keyboard) return;
      if (document.fullscreenElement) void keyboard.lock(LOCKED_KEYS).catch(() => undefined);
      else keyboard.unlock();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  // Keep the editor cookie fresh (b9 §3.26 bullet 8).
  useEffect(() => {
    const timer = setInterval(() => void refreshEditorSession(workspaceId), SESSION_REFRESH_MS);
    return () => clearInterval(timer);
  }, [workspaceId]);

  const actions = useMemo<ShellActions>(
    () => ({
      reconnect: () => reconnect(),
      resume: () => reconnect({ resume: true }),
      openExternal,
      downloadDiagnostics: () => diagnosticsRef.current?.download(),
    }),
    [reconnect],
  );

  return (
    <div className="zs-shell" data-zs="shell">
      <ShellOverlay phase={phase.kind === "ready" && graphics !== "ready" ? { kind: "graphics", failed: graphics === "failed" } : phase} workspace={initial} actions={actions} />
      <LifecycleToasts toasts={toasts} />
    </div>
  );
}

export default EditorShell;
