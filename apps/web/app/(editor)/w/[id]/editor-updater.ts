import { sameRelease, type EditorRelease } from "@/lib/builds";
import type { ZsUpdateAction } from "@/lib/zed-web";
import { apiErrorBody } from "./api-client";
import { waitForRunning } from "./connect-client";
import { bundleUrl, type EditorRuntime } from "./loader";

/** Staging is read-only: no second VM, file copy, WASM instantiation or workspace mutation. */
async function prepareBundle(build: string, signal: AbortSignal, progress: (value: number) => void) {
  const response = await fetch(bundleUrl(build, "build.json"), { signal });
  if (!response.ok) throw new Error(`Update metadata unavailable (${response.status})`);
  const meta = await response.json();
  if (meta.build_id !== build || meta.test_hooks !== false || meta.web_updates !== true) throw new Error("Invalid update bundle");
  const files: [string, number][] = [["zed_web.js", meta.js_bytes], ["zed_web_bg.wasm", meta.wasm_bytes], ["zed-assets.tar", meta.assets_bytes]];
  if (files.some(([, bytes]) => !Number.isSafeInteger(bytes) || bytes <= 0)) throw new Error("Invalid update sizes");
  const total = files.reduce((sum, [, bytes]) => sum + bytes, 0);
  const cache = await caches.open(`zs-editor-${build}`);
  let loaded = 0;
  let lastPercent = -1;
  for (const [file, expected] of files) {
    signal.throwIfAborted();
    const url = bundleUrl(build, file);
    const cached = await cache.match(url);
    const res = cached ?? await fetch(url, { signal, priority: "low" });
    if (!res.ok || !res.body) throw new Error(`Update download failed: ${file} (${res.status})`);
    let bytes = 0;
    const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        loaded += chunk.byteLength;
        if (bytes > expected) throw new Error(`Invalid update size: ${file}`);
        const percent = Math.floor(loaded / total * 100);
        if (percent !== lastPercent) { lastPercent = percent; progress(loaded / total); }
        controller.enqueue(chunk);
      },
      flush() { if (bytes !== expected) throw new Error(`Incomplete update: ${file}`); },
    }), { signal });
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.set("content-length", String(expected));
    try { await cache.put(url, new Response(body, { headers })); }
    catch (error) {
      // An aborted writer must not evict another tab's completed copy.
      if (!signal.aborted && cached) await cache.delete(url);
      throw error;
    }
  }
}

export class EditorUpdater {
  private prepared: EditorRelease | null = null;
  private pending: AbortController | null = null;
  private installing = false;
  private interactive = false;
  private lifetime = new AbortController();
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly workspaceId: string, private readonly runtime: EditorRuntime,
    private readonly reload: () => void) {
    this.timer = setInterval(() => void this.check(), 60_000);
  }

  setInteractive(value: boolean) {
    if (this.lifetime.signal.aborted) return;
    this.interactive = value;
    if (!value) this.pending?.abort();
    else void this.check();
  }

  dispose() {
    clearInterval(this.timer);
    this.pending?.abort();
    this.lifetime.abort();
    this.interactive = false;
  }

  action(action: ZsUpdateAction) {
    if (!this.interactive) return;
    if (action === "check") void this.check(true);
    if (action === "install") void this.install();
  }

  private async check(manual = false) {
    if (!this.interactive || this.pending || this.installing) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    this.pending = controller;
    if (manual) this.runtime.setUpdateStatus({ phase: "checking" });
    try {
      const res = await fetch(`/api/workspaces/${this.workspaceId}/update`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(`Could not check for updates (${res.status})`);
      const { release, available } = await res.json() as { release: EditorRelease; available: boolean };
      signal.throwIfAborted();
      if (!available) { this.prepared = null; this.runtime.setUpdateStatus({ phase: "idle" }); return; }
      if (this.prepared && sameRelease(this.prepared, release)) {
        if (manual) this.runtime.setUpdateStatus({ phase: "ready", build: release.clientBuild });
        return;
      }
      this.prepared = null;
      this.runtime.setUpdateStatus({ phase: "downloading", build: release.clientBuild, progress: 0 });
      await prepareBundle(release.clientBuild, signal, progress =>
        this.runtime.setUpdateStatus({ phase: "downloading", build: release.clientBuild, progress }));
      signal.throwIfAborted();
      this.prepared = release;
      this.runtime.setUpdateStatus({ phase: "ready", build: release.clientBuild });
    } catch (error) {
      if (!controller.signal.aborted) this.runtime.setUpdateStatus({ phase: "error", message: String(error) });
    } finally { if (this.pending === controller) this.pending = null; }
  }

  private async install() {
    if (!this.prepared || this.installing) return;
    this.installing = true;
    const release = this.prepared;
    this.runtime.setUpdateStatus({ phase: "installing", build: release.clientBuild });
    try {
      await this.runtime.flushClientState();
      this.lifetime.signal.throwIfAborted();
      const res = await fetch(`/api/workspaces/${this.workspaceId}/update`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(release),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]),
      });
      if (!res.ok && res.status !== 423) throw new Error((await apiErrorBody(res)).message);
      if (res.status !== 200) await waitForRunning({ workspaceId: this.workspaceId, signal: this.lifetime.signal });
      this.lifetime.signal.throwIfAborted();
      this.reload();
    } catch (error) {
      this.prepared = null;
      if (!this.lifetime.signal.aborted) this.runtime.setUpdateStatus({ phase: "error", message: String(error) });
    } finally { this.installing = false; }
  }
}
