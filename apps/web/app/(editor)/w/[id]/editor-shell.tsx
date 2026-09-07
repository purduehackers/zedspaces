"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserCall } from "./browser-call";
import { CallPanel } from "./call-panel";
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
  type ApiDeps,
} from "./api-client";
import { ConnectError, connectWorkspace, waitForRunning, type ConnectReason } from "./connect-client";
import { bootEditor, BundleError, type BootRunner, type EditorRuntime } from "./loader";
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

/** Test and dev-harness seams; the page passes none of them. */
export interface ShellOverrides {
  /** Replaces the wasm boot. */
  boot?: BootRunner;
  /** Replaces `fetch` for every control-plane call. */
  fetch?: typeof fetch;
  /** Overrides the `crossOriginIsolated` check. */
  crossOriginIsolated?: boolean;
  /** Replaces `location.reload()` / `location.assign()`. */
  navigation?: { reload: () => void; assign: (url: string) => void };
  /** Forces the service-worker registration on or off; by default it happens in production builds only. */
  registerServiceWorker?: boolean;
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
  overrides?: ShellOverrides;
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
  overrides,
}: EditorShellProps) {
  const [phase, setPhase] = useState<ShellPhase>({ kind: "booting", stage: "booting" });
  const [toasts, setToasts] = useState<ShellToast[]>([]);

  const deps = useMemo<ApiDeps>(() => ({ fetch: overrides?.fetch }), [overrides?.fetch]);
  const runtimeRef = useRef<EditorRuntime | null>(null);
  const [runtime, setRuntime] = useState<EditorRuntime | null>(null);
  const updaterRef = useRef<EditorUpdater | null>(null);
  const callRef = useRef<BrowserCall | null>(null);
  const [call, setCall] = useState<BrowserCall | null>(null);
  const bootedRef = useRef(false);
  const flushAllowedRef = useRef(true);
  const stopReasonRef = useRef<StopReason>("unknown");
  const versionsRef = useRef<Record<ZsDocumentKind, number | null>>({ settings: null, keymap: null });

  const navigation = useMemo(
    () =>
      overrides?.navigation ?? {
        reload: () => globalThis.location?.reload(),
        assign: (url: string) => globalThis.location?.assign(url),
      },
    [overrides?.navigation],
  );

  /** `reconnect()` of D2/D30: stash the intent, then boot from scratch. */
  const reconnect = useCallback(
    (next: NextBoot = {}) => {
      writeSessionValue(NEXT_BOOT_KEY, JSON.stringify(next));
      navigation.reload();
    },
    [navigation],
  );

  const applyTransition = useCallback(
    (transition: ShellTransition) => {
      setPhase(transition.phase);
      if (transition.phase.kind === "error" && transition.phase.code === "connection_replaced") {
        // A replaced copy of the same tab must not overwrite its successor's layout.
        flushAllowedRef.current = false;
      }
      if (transition.effect === "reload") {
        navigation.reload();
      } else if (transition.effect === "reauthenticate") {
        void refreshEditorSession(workspaceId, deps).then((ok) => {
          if (!ok) navigation.assign(sessionReloadUrl(`/w/${workspaceId}`));
        });
      }
    },
    [deps, navigation, workspaceId],
  );

  const onKeepAlive = useCallback(() => {
    void keepAlive(workspaceId, deps)
      .then(() => setToasts((current) => current.filter((toast) => toast.id !== "idle")))
      .catch((err: unknown) => {
        void reportClientError(workspaceId, build, {
          kind: "error",
          message: `keepalive failed: ${err instanceof Error ? err.message : String(err)}`,
        }, deps);
      });
  }, [build, deps, workspaceId]);

  const lifecycle = useCallback(
    (kind: ZsLifecycleKind, seconds: number) => {
      if (kind === "idle_stop_in") stopReasonRef.current = "idle";
      if (kind === "session_cap_in") stopReasonRef.current = "cap";

      if (kind === "stopping") {
        setToasts([]);
        setPhase({ kind: "stopped", reason: stopReasonRef.current === "unknown" ? "user" : stopReasonRef.current });
        // STOPPING starts the Rust client's flush. Do not unload it until the server has
        // stopped, archived its data and finished rebuilding. Normal idle/user stops stay stopped.
        void waitForRunning({
          workspaceId,
          afterStopping: true,
          onProgress: (detail) => setPhase({ kind: "booting", stage: "connecting", detail }),
        }, deps).then(() => {
          flushAllowedRef.current = false;
          navigation.reload();
        }).catch((err: unknown) => {
          if (err instanceof ConnectError && err.code === "stopped") {
            setPhase({ kind: "stopped", reason: stopReasonRef.current });
          } else {
            applyTransition(transitionForConnectError(err));
          }
        });
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
    [applyTransition, deps, navigation, onKeepAlive, workspaceId],
  );

  /** One `connect()` call, with the overlay wired to its progress. */
  const connect = useCallback(
    async (reason: ConnectReason): Promise<ZsConnectInfo> => {
      const info = await connectWorkspace(
        {
          workspaceId,
          build,
          tabId: tabId(),
          reason,
          onProgress: (detail) => setPhase({ kind: "booting", stage: "connecting", detail }),
        },
        deps,
      );
      return {
        wsUrl: info.wsUrl,
        token: info.token,
        sessionId: info.sessionId,
        serverBuild: info.serverBuild,
        sessionExpiresAt: info.sessionExpiresAt,
      };
    },
    [build, deps, workspaceId],
  );

  const controller = useMemo<ShellController>(
    () => ({
      workspaceId,
      build,
      bootProgress: (stage: ZsBootStage, detail: string) => {
        applyTransition(transitionForBootProgress(stage, detail, { stopReason: stopReasonRef.current }));
      },
      lifecycle,
      updateAction: (action) => updaterRef.current?.action(action),
      callAction: (action, replica, name) => callRef.current?.action(action, replica, name),
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
      deps,
    }),
    [applyTransition, build, connect, deps, keymapUrl, lifecycle, settingsUrl, workspaceId],
  );

  const boot = useCallback(async () => {
    const isolated = overrides?.crossOriginIsolated ?? globalThis.crossOriginIsolated === true;
    if (!isolated) {
      setPhase({ kind: "unsupported-browser" });
      return;
    }

    const next = takeNextBoot();
    const runner: BootRunner = overrides?.boot ?? bootEditor;

    try {
      setPhase({ kind: "booting", stage: "connecting" });
      const [connectInfo, settingsDoc, keymapDoc] = await Promise.all([
        connect(next?.resume ? "resume" : "open"),
        fetchSettingsDocument(settingsUrl, deps),
        fetchSettingsDocument(keymapUrl, deps),
      ]);
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
      const booted = await runner({
        build,
        config,
        host,
        onStage: (stage, detail) => setPhase({ kind: "booting", stage, detail: detail || undefined }),
      });
      runtimeRef.current = booted.runtime;
      setRuntime(booted.runtime);
      booted.started.then(() => {
        const call = new BrowserCall(workspaceId, status => booted.runtime.setCallStatus(status));
        callRef.current = call;
        setCall(call);
      }).catch((err: unknown) => {
        const failure = asBootFailure(err);
        applyTransition(transitionForBootFailure(failure.code, { stopReason: stopReasonRef.current }));
        void reportClientError(workspaceId, build, { kind: "boot", message: failure.message }, deps);
      });
    } catch (err) {
      applyTransition(transitionForConnectError(err));
      if (err instanceof ConnectError && err.code === "build_mismatch") return;
      void reportClientError(
        workspaceId,
        build,
        { kind: "boot", message: err instanceof Error ? err.message : String(err) },
        deps,
      );
    }
  }, [applyTransition, build, connect, controller, deps, keymapUrl, overrides, paths, settingsUrl, workspaceId]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void boot();
  }, [boot]);

  // Begin update work only after the old editor is interactive. The worker never
  // precaches at install time and never owns API requests or workspace lifecycle.
  useEffect(() => {
    if (!runtime) return;
    const updater = new EditorUpdater(workspaceId, runtime, () => {
      flushAllowedRef.current = false;
      navigation.reload();
    }, deps);
    updaterRef.current = updater;
    return () => { updater.dispose(); updaterRef.current = null; };
  }, [deps, navigation, runtime, workspaceId]);

  useEffect(() => {
    return () => { call?.dispose(); if (callRef.current === call) callRef.current = null; };
  }, [call]);

  useEffect(() => {
    if (phase.kind === "stopped" || phase.kind === "restarting" || phase.kind === "error") callRef.current?.leave();
  }, [phase.kind]);

  useEffect(() => {
    const updater = updaterRef.current;
    updater?.setInteractive(phase.kind === "ready");
    if (phase.kind === "ready" && (overrides?.registerServiceWorker ?? process.env.NODE_ENV === "production")) {
      void navigator.serviceWorker?.register("/sw.js", { scope: "/w/" }).catch(() => undefined);
    }
  }, [phase.kind, runtime, overrides?.registerServiceWorker]);

  // Visibility, unload and fullscreen wiring (b9 §3.26 bullet 6).
  useEffect(() => {
    const flush = () => {
      if (!flushAllowedRef.current) return;
      void runtimeRef.current?.flushClientState().catch(() => undefined);
    };
    const onVisibility = () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.setHidden(document.hidden);
      if (document.hidden) flush();
    };
    const onPageHide = () => flush();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (flushAllowedRef.current && runtimeRef.current?.hasUnsavedChanges()) event.preventDefault();
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
    const timer = setInterval(() => void refreshEditorSession(workspaceId, deps), SESSION_REFRESH_MS);
    return () => clearInterval(timer);
  }, [deps, workspaceId]);

  const actions = useMemo<ShellActions>(
    () => ({
      reconnect: () => reconnect(),
      resume: () => reconnect({ resume: true }),
      openExternal,
    }),
    [reconnect],
  );

  return (
    <div className="zs-shell" data-zs="shell">
      <ShellOverlay phase={phase} workspace={initial} actions={actions} />
      <LifecycleToasts toasts={toasts} />
      {call && <CallPanel call={call} />}
    </div>
  );
}

export default EditorShell;
