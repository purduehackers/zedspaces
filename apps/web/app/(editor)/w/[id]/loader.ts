import type { ZedWebModule, ZsBootConfig, ZsBootStage, ZsHost, ZsUpdateStatus } from "@/lib/zed-web";

/** Path of one file of a build's bundle. */
export function bundleUrl(build: string, file: string): string {
  return `/editor/${encodeURIComponent(build)}/${file}`;
}

/** The requested editor bundle could not be loaded. */
export class BundleError extends Error {
  readonly code: "bundle_missing" | "bundle_invalid";

  constructor(code: "bundle_missing" | "bundle_invalid", message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

/** The wasm exports the shell keeps calling after `start()`. */
export interface EditorRuntime {
  /** Writes the client-state image; awaited on hide and on `STOPPING`. */
  flushClientState(): Promise<void>;
  /** Stops rendering while the tab is hidden. */
  setHidden(hidden: boolean): void;
  /** Synchronous, for the `beforeunload` guard. */
  hasUnsavedChanges(): boolean;
  /** Build id the bundle reports about itself. */
  buildId(): string;
  setUpdateStatus(status: ZsUpdateStatus): void;
  /** A trapped WASM instance cannot safely service further shell callbacks. */
  invalidate(): void;
}

/** A started editor: the exports, plus the single-shot `start()` promise. */
export interface BootedEditor {
  runtime: EditorRuntime;
  /** Resolves when the editor exits and rejects with `{ code, message }`. */
  started: Promise<void>;
}

/** Everything `bootEditor` needs; `onStage` drives the overlay before `start()` takes over. */
export interface BootInput {
  build: string;
  config: ZsBootConfig;
  host: ZsHost;
  signal?: AbortSignal;
  onStage?: (stage: ZsBootStage, detail: string) => void;
}

/** Starts the editor from the browser shell. */
export type BootRunner = (input: BootInput) => Promise<BootedEditor>;

interface LoaderGlobals {
  /** Consumed by the patched `wasm_thread` when it spawns workers. */
  __zsBindgenShimUrl?: string;
  /** Set by the bundle when it wants the shell to run its static constructors. */
  __zsCallCtors?: () => void;
  caches?: CacheStorage;
}

function loaderGlobals(): LoaderGlobals {
  return globalThis as unknown as LoaderGlobals;
}

/**
 * Imports the bundle's JS glue. The import specifier is a runtime URL and is
 * never bundled — the file is dropped into `public/editor/<build>/` by
 * `scripts/fetch-editor-bundle.ts`, not built by Next.
 */
export async function loadZedWeb(build: string): Promise<ZedWebModule> {
  const url = bundleUrl(build, "zed_web.js");
  let mod: ZedWebModule;
  try {
    mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as unknown as ZedWebModule;
  } catch (err) {
    throw new BundleError(
      "bundle_missing",
      `The editor bundle ${url} could not be loaded (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const exports: (keyof ZedWebModule)[] = ["default", "start", "flush_client_state", "set_hidden", "has_unsaved_changes", "build_id", "set_update_status"];
  if (exports.some(name => typeof mod[name] !== "function")) {
    throw new BundleError("bundle_invalid", `${url} does not export the wasm loader contract.`);
  }
  return mod;
}

/** Reads staged bytes directly, including WASM too large for Chromium's HTTP disk cache. */
export async function fetchBundleFile(build: string, file: string, signal?: AbortSignal): Promise<Response> {
  const url = bundleUrl(build, file);
  const cache = await loaderGlobals().caches?.open(`zs-editor-${build}`).catch(() => undefined);
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(180_000);
  const response = await cache?.match(url).catch(() => undefined) ?? await fetch(url, {
    cache: "force-cache", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new BundleError("bundle_missing", `${url} is not available (HTTP ${response.status}).`);
  return response;
}

export async function fetchAssets(build: string, signal?: AbortSignal): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchBundleFile(build, "zed-assets.tar", signal)).arrayBuffer());
}

/**
 * The default {@link BootRunner}: import the glue, instantiate the wasm,
 * fetch the assets and call the single-shot `start()`.
 */
export const bootEditor: BootRunner = async ({ build, config, host, signal, onStage }) => {
  signal?.throwIfAborted();
  onStage?.("booting", "");
  const mod = await loadZedWeb(build);
  signal?.throwIfAborted();

  const globals = loaderGlobals();
  globals.__zsBindgenShimUrl = bundleUrl(build, "zed_web.js");
  const downloads = new AbortController();
  const downloadSignal = signal ? AbortSignal.any([signal, downloads.signal]) : downloads.signal;
  let instance;
  let assets;
  try {
    [instance, assets] = await Promise.all([
      fetchBundleFile(build, "zed_web_bg.wasm", downloadSignal).then(response => mod.default({ module_or_path: response })),
      fetchAssets(build, downloadSignal),
    ]);
  } finally { downloads.abort(); }
  signal?.throwIfAborted();
  const callCtors = globals.__zsCallCtors;
  if (typeof callCtors === "function") callCtors();
  else instance?.__wasm_call_ctors?.();

  onStage?.("assets", "");
  const actualBuild = mod.build_id();
  if (actualBuild !== build) throw new BundleError("bundle_invalid", "The loaded WASM does not match the requested editor build.");

  let invalid = false;
  const fail = (error: unknown) => {
    if (invalid) return;
    invalid = true;
    host.reportError("panic", error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack ?? "" : "");
  };
  const invoke = <T>(callback: () => T, fallback: T): T => {
    if (invalid) return fallback;
    try { return callback(); } catch (error) { fail(error); return fallback; }
  };
  const runtime: EditorRuntime = {
    invalidate: () => { invalid = true; },
    async flushClientState() {
      if (invalid) throw new Error("The editor runtime is no longer usable");
      try { await mod.flush_client_state(); }
      catch (error) { if (error instanceof WebAssembly.RuntimeError) fail(error); throw error; }
    },
    setHidden: hidden => invoke(() => mod.set_hidden(hidden), undefined),
    hasUnsavedChanges: () => invoke(() => mod.has_unsaved_changes(), true),
    buildId: () => actualBuild,
    setUpdateStatus: status => invoke(() => mod.set_update_status(JSON.stringify(status)), undefined),
  };

  // Single-shot: the shell never calls start() twice without a reload.
  const started = mod.start(JSON.stringify(config), assets, {
    ...host,
    reportError(kind, message, stack) {
      if (kind === "panic") runtime.invalidate();
      host.reportError(kind, message, stack);
    },
  });
  return { started, runtime };
};
