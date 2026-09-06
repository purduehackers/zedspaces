import type { Page } from "@playwright/test";
import type { PageLog } from "./control-plane";

/**
 * Typed access to `window.__zs_test`, the async test hooks the wasm bundle
 * exposes when built with `script/build-web --test-hooks`
 * (`zed/crates/zed_web/src/test_hooks.rs`). Every call runs on the GPUI
 * foreground executor inside the page and resolves with plain JSON.
 */

export interface ConnectionState {
  /** Last boot stage reported to the shell (`booting … ready | reconnecting | stopped | failed`). */
  phase: string;
  /** The stage's detail: for `stopped`, the `close_code_detail` name the shell was told. */
  detail: string;
  booted: boolean;
  /** `none | connecting | connected | heartbeat_missed | reconnecting | disconnected`. */
  connection: string;
  epoch: number | null;
  resumed: boolean | null;
  closeCode: number | null;
  closeReason: string | null;
  /**
   * The product's own `close_code_detail` name for the last close frame (`connect.rs`;
   * CONTRACTS §8.4: `taken_over` 4001, `session_busy` 4005, `incompatible_server` 4002/4006,
   * `server_stopping` 1001, `unauthorized` 4003, else `reconnect_exhausted`).
   */
  closeDetail: string | null;
}

export interface ConnectionEvent {
  /** `state` (a `ConnectionState` transition), `reconnected` or `disconnected`. */
  kind: "state" | "reconnected" | "disconnected";
  from: string | null;
  to: string | null;
  closeCode: number | null;
  closeReason: string | null;
  at: number;
}

export interface OpenItem {
  /** Worktree-relative path, or `null` for an item without one (a terminal in the center). */
  path: string | null;
  dirty: boolean;
  active: boolean;
}

export interface TerminalInfo {
  /**
   * The server-assigned remote terminal id as a decimal string (a random u64, beyond
   * `Number`'s exact range); `null` until the spawn was acknowledged.
   */
  id: string | null;
  title: string;
  cwd: string | null;
}

export interface LanguageServerInfo {
  id: number;
  name: string;
  language: string | null;
}

export interface LifecycleEvent {
  kind: "idle_stop_in" | "session_cap_in" | "stopping" | "resumed";
  seconds: number;
  at: number;
}

export interface ClientStateStatus {
  version: number;
  hidden: boolean;
  /** 15 000 while visible, 5 000 while hidden (D7). */
  intervalMs: number;
  dirty: boolean;
  readOnly: boolean;
  stopped: boolean;
}

export interface ClientStateEvent {
  kind: "saved" | "stale" | "save_failed" | "read_only";
  version: number | null;
  /** Whether the store reported the tab hidden when the event fired. */
  hidden: boolean;
  detail: string;
  at: number;
}

export interface VisibilityEvent {
  hidden: boolean;
  at: number;
  flushedAt: number | null;
  flushOk: boolean | null;
  flushError: string;
  versionAfter: number | null;
}

export interface WorkspaceLayout {
  /** The real Workspace dock state; names are the panels' persistent names. */
  docks: Record<"left" | "bottom" | "right", { visible: boolean; active_panel: string | null; zoom: boolean }>;
  /** Live merged settings used to construct TitleBarSettings, including user overrides. */
  titleBar: {
    show_branch_status_icon: boolean;
    show_branch_name: boolean;
    show_worktree_name: boolean;
    show_project_items: boolean;
    show_onboarding_banner: boolean;
    show_user_picture: boolean;
    show_sign_in: boolean;
    show_user_menu: boolean;
    show_menus: boolean;
  };
}

export interface ZsTestHooks {
  connectionState(): Promise<ConnectionState>;
  connectionEvents(): Promise<ConnectionEvent[]>;
  /**
   * Resolves (with the wait in ms) once the boot reached `ready`, the workspace is open and the
   * transport is connected; rejects as soon as the boot reports `failed`/`stopped`, else on
   * `timeoutMs` (default 120 s, past the boot's own 90 s budget).
   */
  waitIdle(timeoutMs?: number): Promise<number>;
  /** `mac | windows | linux` as the keymap layer (D12) saw it. */
  hostOs(): Promise<"mac" | "windows" | "linux" | null>;
  openFile(path: string): Promise<{ path: string; kind: "editor" | "other"; dirty: boolean }>;
  openItems(): Promise<OpenItem[]>;
  bufferText(path: string): Promise<string>;
  bufferSyntax(path: string): Promise<{ language: string | null; highlightedChunks: number }>;
  commandPaletteVisible(): Promise<boolean>;
  collaborationStatus(): Promise<{ replica: number; peers: number[]; remoteSelections: number }>;
  activeBufferText(): Promise<string>;
  insertText(text: string): Promise<boolean>;
  moveCursorEnd(): Promise<boolean>;
  save(): Promise<boolean>;
  isDirty(path: string): Promise<boolean>;
  languageServers(): Promise<LanguageServerInfo[]>;
  spawnTerminal(cwd?: string): Promise<TerminalInfo>;
  terminals(): Promise<TerminalInfo[]>;
  terminalInput(id: string, text: string): Promise<boolean>;
  terminalScrollback(id: string): Promise<string>;
  lifecycleEvents(): Promise<LifecycleEvent[]>;
  /** Whether the active editor's *completions* menu is up (a code-action menu does not count). */
  completionsVisible(): Promise<boolean>;
  /** The visible code context menu, or `null`; `rows` is 0 for a `code_actions` menu. */
  contextMenu(): Promise<{ kind: "completions" | "code_actions"; rows: number } | null>;
  triggerCompletion(): Promise<boolean>;
  clientStateVersion(): Promise<number | null>;
  clientStateStatus(): Promise<ClientStateStatus | null>;
  clientStateEvents(): Promise<ClientStateEvent[]>;
  visibilityEvents(): Promise<VisibilityEvent[]>;
  /** Waits for panel initialization/restoration before reporting the actual workspace. */
  workspaceLayout(): Promise<WorkspaceLayout>;
  /** Closes all docks and awaits local DB serialization, before the normal hidden-tab flush. */
  closeDocks(): Promise<boolean>;
  forceDisconnect(): Promise<boolean>;
  /** Milliseconds each executor path took (`null` = stuck): the first question when a boot stalls at `connecting`. */
  executorProbe(): Promise<{
    foregroundTask: number | null;
    backgroundTask: number | null;
    backgroundTimer: number | null;
    backgroundThenForeground: number | null;
  }>;
  /** Forces Shared notifier contention against a worker and proves entry into D42's parker. */
  sharedContentionProbe(): Promise<{
    mainThreadParks: number;
    workerObservedPark: boolean;
    workerPending: boolean;
    mainPending: boolean;
    wakersReleased: boolean;
    completionWakes: number;
    completionValue: number;
    completedCloneValue: number;
  }>;
}

type HookName = keyof ZsTestHooks;

const HOOK_NAMES: HookName[] = [
  "connectionState",
  "connectionEvents",
  "waitIdle",
  "hostOs",
  "openFile",
  "openItems",
  "bufferText",
  "bufferSyntax",
  "commandPaletteVisible",
  "collaborationStatus",
  "activeBufferText",
  "insertText",
  "moveCursorEnd",
  "save",
  "isDirty",
  "languageServers",
  "spawnTerminal",
  "terminals",
  "terminalInput",
  "terminalScrollback",
  "lifecycleEvents",
  "completionsVisible",
  "contextMenu",
  "triggerCompletion",
  "clientStateVersion",
  "clientStateStatus",
  "clientStateEvents",
  "visibilityEvents",
  "workspaceLayout",
  "closeDocks",
  "forceDisconnect",
  "executorProbe",
  "sharedContentionProbe",
];

/** Calls one hook inside the page; a hook rejection surfaces as a thrown `Error` with its message. */
async function call<T>(page: Page, name: HookName, args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([hook, hookArgs]) => {
      const hooks = (globalThis as { __zs_test?: Record<string, (...a: unknown[]) => Promise<unknown>> }).__zs_test;
      if (!hooks || typeof hooks[hook] !== "function") throw new Error(`window.__zs_test.${hook} is not installed`);
      try {
        return (await hooks[hook](...hookArgs)) as unknown;
      } catch (err) {
        throw new Error(`__zs_test.${hook}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [name, args] as [HookName, unknown[]],
  ) as Promise<T>;
}

/** The hooks bound to `page`. */
export function hooks(page: Page): ZsTestHooks {
  const bound = {} as Record<HookName, (...args: unknown[]) => Promise<unknown>>;
  for (const name of HOOK_NAMES) bound[name] = (...args: unknown[]) => call(page, name, args);
  return bound as unknown as ZsTestHooks;
}

/** Whether the bundle installed its hooks (it does so at the start of `start()`). */
export async function hooksInstalled(page: Page): Promise<boolean> {
  return page.evaluate(
    () => typeof (globalThis as { __zs_test?: { waitIdle?: unknown } }).__zs_test?.waitIdle === "function",
  );
}

/**
 * Races `promise` against the page's first panic (`watchPage`'s `panic` promise): a wasm panic or
 * an `unreachable` page error during a wait fails the test with the panic text in seconds instead
 * of letting the wait burn its timeout.
 */
export async function untilOrPanic<T>(promise: Promise<T>, log: PageLog | undefined): Promise<T> {
  if (!log) return promise;
  let release: (() => void) | undefined;
  const failure = new Promise<never>((_, reject) => {
    const settled = (text: string) => reject(new Error(`the page panicked while waiting: ${text}`));
    if (log.firstPanic) settled(log.firstPanic);
    else {
      log.onPanic.push(settled);
      release = () => {
        const index = log.onPanic.indexOf(settled);
        if (index >= 0) log.onPanic.splice(index, 1);
      };
    }
  });
  try {
    return await Promise.race([promise, failure]);
  } finally {
    release?.();
  }
}

/** Phases the shell never leaves on its own: waiting for the hooks past one of them is a hang. */
const TERMINAL_PHASES = ["error", "unsupported-browser", "stopped"];

/**
 * `performance.timeOrigin` of the document currently loaded in `page`: the stamp
 * {@link waitForHooks} takes before a reload so it can tell the new document from the outgoing
 * one. Every value is distinct because a reload starts a new time origin.
 */
export async function documentStamp(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin);
}

/**
 * Waits until the bundle installed `window.__zs_test` (the shell loaded a test-hooks bundle and
 * called `start()`); with `log`, a panic while waiting fails at once.
 *
 * `after` is a {@link documentStamp} taken before something that reloads the page (the shell's
 * `reconnect()` on resume): the wait then ignores the outgoing document, whose hooks are
 * still installed until the navigation commits, so the caller's next hook call cannot land on the
 * page it just replaced.
 *
 * A boot that ends in one of {@link TERMINAL_PHASES} installs no hooks and never will, so the
 * overlay's `data-phase` is watched beside them and fails at once, naming the phase and the card,
 * instead of burning the whole timeout on a generic message.
 */
export async function waitForHooks(page: Page, timeoutMs = 120_000, log?: PageLog, after?: number): Promise<void> {
  const handle = await untilOrPanic(
    page.waitForFunction(
      ([previous, terminal]: [number | null, string[]]) => {
        // Still the document the caller is navigating away from.
        if (previous !== null && performance.timeOrigin === previous) return null;
        if (typeof (globalThis as { __zs_test?: { waitIdle?: unknown } }).__zs_test?.waitIdle === "function") {
          return { ready: true, phase: "", card: "" };
        }
        const overlay = document.querySelector('[data-zs="overlay"]');
        const phase = overlay?.getAttribute("data-phase") ?? "";
        if (!terminal.includes(phase)) return null;
        return { ready: false, phase, card: (overlay?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) };
      },
      [after ?? null, TERMINAL_PHASES] as [number | null, string[]],
      { timeout: timeoutMs, polling: 100 },
    ),
    log,
  );
  // `waitForFunction` resolves only on a truthy value, so the handle is one of the two objects.
  const outcome = (await handle.jsonValue()) as { ready: boolean; phase: string; card: string };
  if (!outcome.ready) {
    throw new Error(`the shell stopped at phase "${outcome.phase}" instead of installing the test hooks: ${outcome.card}`);
  }
}

/** Polls `fn` until it returns a truthy value or `timeoutMs` elapses (`what` names the wait in the error). */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  what: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 250));
  }
}
