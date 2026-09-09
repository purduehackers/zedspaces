import { diagnosticText, diagnosticUrl } from "@/lib/redact";

type Entry = { at: number; kind: string; message: string; duration?: number; count: number; status?: number; transferBytes?: number };
const LIMIT = 200;
const PREFIX = "zedspaces:";

/** A bounded, tab-local flight recorder. No console/network monkeypatching or editor access. */
export class BrowserDiagnostics {
  private entries: Entry[] = [];
  private dropped = 0;
  private disposed = false;
  private phase = "loading";
  private phaseStart = performance.now();
  private observers: PerformanceObserver[] = [];
  private lifetime = new AbortController();
  private stopProfile?: () => void;

  constructor(private readonly build: string, private readonly onTrap: () => void) {
    const options = { signal: this.lifetime.signal };
    window.addEventListener("error", (event: Event) => {
      if (event instanceof ErrorEvent) {
        this.error("javascript", event.error ?? event.message);
        if (event.error instanceof WebAssembly.RuntimeError) this.onTrap();
      } else {
        const target = event.target;
        const url = target instanceof HTMLScriptElement ? target.src : target instanceof HTMLLinkElement ? target.href : "";
        if (url) this.record("resource-error", diagnosticUrl(url));
      }
    }, { ...options, capture: true });
    window.addEventListener("unhandledrejection", event => {
      this.error("unhandled-rejection", event.reason);
      if (event.reason instanceof WebAssembly.RuntimeError) this.onTrap();
    }, options);
    document.addEventListener("securitypolicyviolation", event => {
      const source = ["inline", "eval", ""].includes(event.blockedURI) ? event.blockedURI || "unknown" : diagnosticUrl(event.blockedURI);
      this.record("csp", `${event.effectiveDirective}: ${source}`);
    }, options);
    for (const name of ["online", "offline", "pageshow", "pagehide"] as const) {
      window.addEventListener(name, () => this.record("page", name), options);
    }
    document.addEventListener("visibilitychange", () => {
      this.record("page", document.visibilityState);
      if (document.hidden) this.stopProfile?.();
    }, options);
    if (typeof PerformanceObserver !== "undefined") {
      for (const type of ["resource", "longtask"]) {
        if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry instanceof PerformanceResourceTiming) {
              this.record(type, diagnosticUrl(entry.name), entry.duration, {
                status: entry.responseStatus || undefined, transferBytes: entry.transferSize,
              });
            } else this.record(type, "main-thread task", entry.duration);
          }
        });
        try { observer.observe({ type, buffered: true }); this.observers.push(observer); }
        catch { observer.disconnect(); }
      }
    }
    const api = Object.freeze({
      snapshot: () => this.snapshot(),
      download: () => this.download(),
      clear: () => { this.entries = []; this.dropped = 0; },
      profile: (seconds = 10) => this.profile(seconds),
    });
    Object.defineProperty(window, "zedspaces", { value: api, configurable: true });
    this.lifetime.signal.addEventListener("abort", () => {
      if (Reflect.get(window, "zedspaces") === api) Reflect.deleteProperty(window, "zedspaces");
    }, { once: true });
  }

  record(kind: string, message: string, duration?: number, resource?: Pick<Entry, "status" | "transferBytes">) {
    if (this.disposed) return;
    const safe = diagnosticText(message);
    const previous = this.entries.at(-1);
    if (previous?.kind === kind && previous.message === safe && duration === undefined) {
      previous.count++;
      return;
    }
    if (this.entries.length === LIMIT) {
      // Routine fetches should not evict the error that prompted an investigation.
      const resource = this.entries.findIndex(entry => entry.kind === "resource");
      if (kind === "resource" && resource === -1) { this.dropped++; return; }
      this.entries.splice(Math.max(resource, 0), 1);
      this.dropped++;
    }
    this.entries.push({ at: Math.round(performance.now()), kind, message: safe, count: 1, ...resource,
      ...(duration === undefined ? {} : { duration: Math.round(duration * 10) / 10 }) });
  }

  error(kind: string, error: unknown) {
    this.record(kind, error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : diagnosticText(error));
  }

  stage(phase: string) {
    if (this.disposed || phase === this.phase) return;
    const now = performance.now();
    const name = PREFIX + this.phase;
    // Keep only the latest measure per phase; DevTools' active recording retains the timeline.
    try {
      performance.clearMeasures(name);
      performance.measure(name, { start: this.phaseStart, end: now });
    } catch { /* Optional timing support must never prevent booting. */ }
    this.record("phase", this.phase, now - this.phaseStart);
    this.phase = phase;
    this.phaseStart = now;
  }

  snapshot() {
    return {
      version: 1, build: this.build, capturedAt: new Date().toISOString(), phase: this.phase,
      environment: { userAgent: navigator.userAgent, isolated: globalThis.crossOriginIsolated, secure: globalThis.isSecureContext,
        online: navigator.onLine, visibility: document.visibilityState,
        serviceWorker: Boolean(navigator.serviceWorker?.controller),
        performanceEntries: typeof PerformanceObserver === "undefined" ? [] : [...(PerformanceObserver.supportedEntryTypes ?? [])] },
      dropped: this.dropped, entries: this.entries.map(entry => ({ ...entry })),
      notice: "Local diagnostics only. Error text and URL paths may contain project information; review before sharing.",
    };
  }

  download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.snapshot(), null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "zedspaces-diagnostics.json";
    document.body.append(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  /** Opt-in frame pacing, not a CPU profiler. Use browser DevTools for stack attribution. */
  profile(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) return Promise.reject(new Error("Profile duration must be 1–30 seconds"));
    if (this.disposed || document.hidden || this.stopProfile) return Promise.reject(new Error("Profiling requires a visible tab and no active profile"));
    return new Promise<{ frames: number; averageMs: number | null; p95Ms: number | null; maxMs: number | null; interrupted: boolean }>(resolve => {
      const started = performance.now();
      const gaps: number[] = [];
      let previous: number | undefined;
      let frame = 0;
      const finish = () => {
        clearTimeout(timer); cancelAnimationFrame(frame); this.stopProfile = undefined;
        gaps.sort((a, b) => a - b);
        const result = { frames: gaps.length, averageMs: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
          p95Ms: gaps.length ? gaps[Math.ceil(gaps.length * 0.95) - 1] : null, maxMs: gaps.at(-1) ?? null,
          interrupted: performance.now() - started < seconds * 1000 };
        this.record("profile", JSON.stringify(result), performance.now() - started);
        resolve(result);
      };
      const tick = (time: number) => {
        if (previous !== undefined && gaps.length < 10_000) gaps.push(time - previous);
        previous = time;
        frame = requestAnimationFrame(tick);
      };
      const timer = setTimeout(finish, seconds * 1000);
      this.stopProfile = finish;
      frame = requestAnimationFrame(tick);
    });
  }

  dispose() {
    this.stopProfile?.();
    this.disposed = true;
    this.lifetime.abort();
    for (const observer of this.observers) observer.disconnect();
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.name.startsWith(PREFIX)) performance.clearMeasures(entry.name);
    }
  }
}
