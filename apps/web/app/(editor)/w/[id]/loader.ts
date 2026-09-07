import type { ZedWebModule, ZsBootConfig, ZsBootStage, ZsHost, ZsUpdateStatus } from "@/lib/zed-web";
import type { CallStatus } from "@/lib/call-protocol";

/**
 * Loads and starts `/editor/<build>/zed_web.js` (b9 §3.26 bullet 1 and 3;
 * CONTRACTS.md §8.4 "Loader requirements"). The bundle is same-origin by
 * necessity: the page is cross-origin isolated, so every subresource is
 * `self` or CORS-enabled.
 */

/** Path of one file of a build's bundle. */
export function bundleUrl(build: string, file: string): string {
  return `/editor/${encodeURIComponent(build)}/${file}`;
}

/** The bundle is absent (a deployment without `pnpm prebuild`) or is the development stub. */
export class BundleError extends Error {
  /** `bundle_missing` (nothing served) or `bundle_not_built` (the placeholder stub). */
  readonly code: "bundle_missing" | "bundle_not_built";

  constructor(code: "bundle_missing" | "bundle_not_built", message: string) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

/** The wasm exports the shell keeps calling after `start()` (b7 §4.2). */
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
  setCallStatus(status: CallStatus): void;
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
  onStage?: (stage: ZsBootStage, detail: string) => void;
}

/** The seam the shell and its tests swap out. */
export type BootRunner = (input: BootInput) => Promise<BootedEditor>;

interface LoaderGlobals {
  /** Consumed by the patched `wasm_thread` when it spawns workers (b7 §7.2). */
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
  if (mod.zsStub === true) {
    throw new BundleError("bundle_not_built", `${url} is the placeholder stub: no editor bundle was built for ${build}.`);
  }
  if (typeof mod.default !== "function" || typeof mod.start !== "function") {
    throw new BundleError("bundle_missing", `${url} does not export the wasm loader contract.`);
  }
  return mod;
}

/** Reads staged bytes directly, including WASM too large for Chromium's HTTP disk cache. */
export async function fetchBundleFile(build: string, file: string): Promise<Response> {
  const url = bundleUrl(build, file);
  const cache = await loaderGlobals().caches?.open(`zs-editor-${build}`).catch(() => undefined);
  const response = await cache?.match(url).catch(() => undefined) ?? await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new BundleError("bundle_missing", `${url} is not available (HTTP ${response.status}).`);
  return response;
}

export async function fetchAssets(build: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchBundleFile(build, "zed-assets.tar")).arrayBuffer());
}

/**
 * The default {@link BootRunner}: import the glue, instantiate the wasm,
 * fetch the assets and call the single-shot `start()`.
 */
export const bootEditor: BootRunner = async ({ build, config, host, onStage }) => {
  onStage?.("booting", "");
  const mod = await loadZedWeb(build);

  const globals = loaderGlobals();
  globals.__zsBindgenShimUrl = bundleUrl(build, "zed_web.js");
  // The asset tarball is fetched in parallel with `init()` (b7 §3.30).
  const assetsPromise = fetchAssets(build);
  assetsPromise.catch(() => undefined);
  const instance = await mod.default({ module_or_path: await fetchBundleFile(build, "zed_web_bg.wasm") });
  const callCtors = globals.__zsCallCtors;
  if (typeof callCtors === "function") callCtors();
  else instance?.__wasm_call_ctors?.();

  onStage?.("assets", "");
  const assets = await assetsPromise;

  // Single-shot: the shell never calls start() twice without a reload (b7 §7.3).
  const started = mod.start(JSON.stringify(config), assets, host);
  return {
    started,
    runtime: {
      flushClientState: () => mod.flush_client_state(),
      setHidden: (hidden) => mod.set_hidden(hidden),
      hasUnsavedChanges: () => mod.has_unsaved_changes(),
      buildId: () => mod.build_id(),
      setUpdateStatus: (status) => mod.set_update_status(JSON.stringify(status)),
      setCallStatus: (status) => mod.set_call_status?.(JSON.stringify(status)),
    },
  };
};
