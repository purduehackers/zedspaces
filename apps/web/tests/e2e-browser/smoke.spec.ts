/**
 * Browser boot smoke for the wasm editor bundle (b7 §6 "Boot smoke"; round-4 gap R4-5).
 *
 * Serves `public/` with the editor route's isolation headers (COOP/COEP/CORP, next.config.ts)
 * and the bundle CSP of `script/build-web --serve`, overlays b7's dev harness
 * (`zed/crates/zed_web/web/{index.html,loader.js}`, which apps/web never ships) onto
 * `/editor/<build>/`, and drives it in headless Chromium:
 *   1. without a server: the glue loads, the wasm instantiates, `build_id()` equals the
 *      bundle directory, and the boot reaches `connecting` before a `connect_failed`;
 *   2. against a native `zed-remote-server serve` (`zed/target/debug/remote_server` or
 *      `ZS_SMOKE_SERVER_BIN`) with a stub supervisor behind it: the stages arrive in order up
 *      to `ready`, a canvas mounts and paints (a non-uniform, opaque pixel sample of the
 *      compositor's picture), the server reports its extensions to the supervisor, and the
 *      console carries no error.
 * There is no control plane here by design: the static server answers the one control-plane
 * call the editor makes at `ready` (`GET /api/ai/keys`, an empty inventory) and every other
 * non-2xx response is recorded with its URL so the error assertion names what was missing.
 * Run: `pnpm test:browser` (the `smoke` project of playwright.config.ts); `ZS_SMOKE_BUILD`
 * picks a build other than the newest in `public/editor/manifest.json`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { expect, test, type Page } from "@playwright/test";
import { decodePng, samplePixels } from "./png";
import { EMPTY_INVENTORY, isCompletedInventoryAbort, observeInventoryReader, type FailedRequest, type InventoryRead } from "./smoke-network";

const webDir = path.resolve(__dirname, "../..");
const publicDir = path.join(webDir, "public");
const zedDir = path.resolve(webDir, "../../zed");
const harnessDir = path.join(zedDir, "crates/zed_web/web");
/**
 * The bundle to smoke. `public/editor/manifest.json` is committed but every bundle directory
 * it names is gitignored (they are built by `script/build-web` or fetched by
 * `scripts/fetch-editor-bundle.ts`), so a fresh checkout has the manifest and none of the
 * bundles: the newest build that is actually on disk wins, and with none the whole file skips
 * instead of throwing during collection and taking the other specs' projects down with it.
 */
function resolveBuild(): string | null {
  const complete = (id: string) => fs.existsSync(path.join(publicDir, "editor", id, "build.json"));
  if (process.env.ZS_SMOKE_BUILD) return complete(process.env.ZS_SMOKE_BUILD) ? process.env.ZS_SMOKE_BUILD : null;
  const manifestPath = path.join(publicDir, "editor/manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { builds?: unknown };
  const builds = Array.isArray(manifest.builds) ? (manifest.builds as string[]) : [];
  return builds.find((id) => typeof id === "string" && complete(id)) ?? null;
}

const build = resolveBuild();
/** `build.json` of {@link build}; read in `beforeAll`, never during collection. */
let buildJson: { build_id?: string; test_hooks?: boolean } = {};

const STAGES = ["booting", "assets", "settings", "connecting", "database", "languages", "window", "ready"];
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".tar": "application/x-tar",
  ".json": "application/json",
};
// script/build-web --serve's CSP: the editor CSP of CONTRACTS §8.4 minus the shell's nonce.
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss: http: https:; " +
  "worker-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/** `public/` plus the dev harness at `/editor/<build>/{index.html,loader.js}`, cross-origin isolated. */
function serveStatic(): Promise<{ origin: string; close(): void }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Chromium asks for it unprompted and logs a console error on a 404.
    if (pathname === "/favicon.ico") return void res.writeHead(204).end();
    // The editor's AI key inventory (b11 §3.11) is asked for at `ready`; without a control
    // plane the answer is "nothing configured".
    if (pathname === "/api/ai/keys") {
      const body = EMPTY_INVENTORY;
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      return void res.end(body);
    }
    const harness = /^\/editor\/[^/]+\/(index\.html|loader\.js)$/.exec(pathname);
    const file = harness ? path.join(harnessDir, harness[1]) : path.join(publicDir, path.normalize(pathname));
    if (!file.startsWith(publicDir) && !file.startsWith(harnessDir)) return void res.writeHead(403).end();
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": fs.statSync(file).size,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": CSP,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

interface LocalServer {
  wsUrl: string;
  token: string;
  workspaceId: string;
  sessionId: string;
  root: string;
  /** `METHOD path` of every request the server sent its supervisor. */
  supervisorRequests: string[];
  stop(): void;
}

/**
 * The supervisor's loopback API as the server sees it (`POST /extensions`, `POST /ports`,
 * `DELETE /ports/{port}`; `sandbox/supervisor/src/api.rs`): a stub that accepts and records,
 * so the server's reports at boot succeed instead of surfacing as console errors.
 */
function stubSupervisor(requests: string[]): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push(`${req.method} ${pathname}`);
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && pathname === "/extensions") return void res.writeHead(204).end();
      if (req.method === "POST" && pathname === "/ports") {
        const body = JSON.stringify({ url: null });
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        return void res.end(body);
      }
      if (req.method === "DELETE" && /^\/ports\/\d+$/.test(pathname)) return void res.writeHead(204).end();
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

/** A native `zed-remote-server serve` on a loopback port with a throwaway ES256 key. */
async function startServer(origin: string): Promise<LocalServer | null> {
  const bin = process.env.ZS_SMOKE_SERVER_BIN ?? path.join(zedDir, "target/debug/remote_server");
  if (!fs.existsSync(bin)) return null;
  const supervisorRequests: string[] = [];
  const supervisor = await stubSupervisor(supervisorRequests);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zs-smoke-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "# smoke\n");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyFile = path.join(dir, "key.pem");
  fs.writeFileSync(keyFile, publicKey.export({ type: "spki", format: "pem" }));
  const secretFile = path.join(dir, "control.secret");
  fs.writeFileSync(secretFile, "smoke-control-secret\n");
  const portFile = path.join(dir, "server.port");
  const workspaceId = "ws_smoke";
  const sessionId = "con_smoke";
  const audience = "zs-smoke";
  const child: ChildProcess = spawn(
    bin,
    ["serve", "--listen", "127.0.0.1:0", "--jwt-public-key", keyFile, "--workspace-id", workspaceId,
      "--audience", audience, "--issuer", "zs", "--workspace-root", root, "--client-build", build!,
      "--allowed-origin", origin, "--control-secret-file", secretFile, "--control-listen", "127.0.0.1:0",
      "--supervisor-url", supervisor.url, "--port-file", portFile],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dir, XDG_DATA_HOME: path.join(dir, "data") } },
  );
  const log: string[] = [];
  child.stdout?.on("data", (chunk) => log.push(String(chunk)));
  child.stderr?.on("data", (chunk) => log.push(String(chunk)));
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(portFile) || fs.readFileSync(portFile, "utf8").trim() === "") {
    if (child.exitCode !== null) throw new Error(`remote_server exited ${child.exitCode}:\n${log.join("")}`);
    if (Date.now() > deadline) throw new Error(`remote_server wrote no port file:\n${log.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ ws: workspaceId, sid: sessionId })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer("zs")
    .setSubject("user_smoke")
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setJti("jti_smoke")
    .sign(privateKey);
  return {
    wsUrl: `ws://${fs.readFileSync(portFile, "utf8").trim()}/rpc`,
    token,
    workspaceId,
    sessionId,
    root,
    supervisorRequests,
    stop: () => {
      child.kill("SIGTERM");
      supervisor.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface BootLog {
  stages: { stage: string; detail: string }[];
  buildId: string | null;
  errors: string[];
  failedRequests: FailedRequest[];
  inventoryRequests: number;
}

/**
 * Collects the harness's `[zed-web] <stage> <detail>` console lines, console errors (with the
 * resource URL Chromium's "Failed to load resource" lines otherwise omit), page errors and
 * every non-2xx response or failed request, by URL.
 */
function watchBoot(page: Page): BootLog {
  const log: BootLog = { stages: [], buildId: null, errors: [], failedRequests: [], inventoryRequests: 0 };
  page.on("console", (message) => {
    const text = message.text();
    const boot = /^\[zed-web\] (\S+)\s?([\s\S]*)$/.exec(text);
    if (boot && boot[1] === "build") log.buildId = boot[2];
    else if (boot && STAGES.concat("failed", "stopped", "reconnecting").includes(boot[1])) {
      log.stages.push({ stage: boot[1], detail: boot[2] });
    }
    if (message.type() === "error") {
      const url = message.location().url;
      log.errors.push(url && !text.includes(url) ? `${text} (${url})` : text);
    }
  });
  page.on("pageerror", (error) => log.errors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) log.errors.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on("request", (request) => {
    if (request.url() === `${statik!.origin}/api/ai/keys`) log.inventoryRequests++;
  });
  page.on("requestfailed", (request) => log.failedRequests.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText ?? "?" }));
  return log;
}

function stageSequence(log: BootLog): string[] {
  return log.stages.map((s) => s.stage).filter((stage, i, all) => i === 0 || all[i - 1] !== stage);
}

// Software WebGL2 for the canvas: headless Chromium refuses SwiftShader unless asked.
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

test.skip(
  build === null,
  "no complete bundle under apps/web/public/editor (they are gitignored): build one with `zed/script/build-web --out-dir ../apps/web/public/editor`, fetch one with `pnpm tsx scripts/fetch-editor-bundle.ts`, or pick another with ZS_SMOKE_BUILD",
);

let statik: Awaited<ReturnType<typeof serveStatic>> | undefined;
test.beforeAll(async () => {
  if (build === null) return;
  buildJson = JSON.parse(fs.readFileSync(path.join(publicDir, "editor", build, "build.json"), "utf8"));
  statik = await serveStatic();
});
test.afterAll(() => statik?.close());

test(`bundle ${build ?? "(none on disk)"}: the wasm instantiates and the boot reaches connecting`, async ({ page }) => {
  test.setTimeout(180_000);
  expect(buildJson.build_id).toBe(build);
  const log = watchBoot(page);
  await page.goto(`${statik!.origin}/editor/${build}/index.html`);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await expect.poll(() => log.stages.some((s) => s.stage === "failed" || s.stage === "ready"), { timeout: 150_000 }).toBe(true);
  expect(log.buildId).toBe(build);
  expect(stageSequence(log)).toEqual(["booting", "assets", "settings", "connecting", "failed"]);
  expect(log.stages.at(-1)?.detail).toBe("connect_failed");
  await expect(page.locator("#stage")).toHaveText("failed");
  // The only console errors are the harness reporting that expected connect failure.
  expect(log.errors.filter((e) => !e.startsWith("[zed-web] boot failed") && !e.startsWith("[zed-web] boot "))).toEqual([]);
  expect(log.failedRequests).toEqual([]);
});

test(`bundle ${build ?? "(none on disk)"}: boots to ready against a local zed-remote-server and mounts the canvas`, async ({ page }) => {
  test.setTimeout(240_000);
  const server = await startServer(statik!.origin);
  test.skip(server === null, "zed/target/debug/remote_server is not built (cargo build -p remote_server --features serve)");
  try {
    const log = watchBoot(page);
    await page.addInitScript(observeInventoryReader);
    const query = new URLSearchParams({
      ws: server!.wsUrl, token: server!.token, session: server!.sessionId, workspace: server!.workspaceId, path: server!.root,
    });
    const startedAt = Date.now();
    await page.goto(`${statik!.origin}/editor/${build}/index.html?${query}`);
    await expect.poll(() => log.stages.some((s) => s.stage === "failed" || s.stage === "stopped" || s.stage === "ready"), {
      timeout: 200_000,
    }).toBe(true);
    const readyMs = Date.now() - startedAt;
    test.info().annotations.push({ type: "boot-to-ready-ms", description: `${readyMs} ms (b7 §6 asks for 10 s; SwiftShader here)` });
    expect(log.buildId).toBe(build);
    expect(stageSequence(log)).toEqual(STAGES);
    await expect(page.locator("canvas")).toHaveCount(1);
    await expect(page.locator("#boot")).toBeHidden();
    const size = await page.locator("canvas").evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    expect(size[0]).toBeGreaterThan(0);
    expect(size[1]).toBeGreaterThan(0);
    // The canvas painted: the compositor's picture of it is opaque and not one flat colour
    // (Zed's chrome, gutter and status bar are several); a canvas that never presented a frame
    // shows the page background alone.
    const sample = samplePixels(decodePng(await page.locator("canvas").screenshot()));
    const summary = [...sample.colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([rgba, n]) => `${rgba} x${n}`).join("; ");
    test.info().annotations.push({ type: "canvas-sample", description: `${sample.colours.size} colours in ${sample.sampled} pixels: ${summary}` });
    // `locator.screenshot()` composites over the page background, so every sampled pixel is
    // opaque whatever the canvas did: an alpha assertion here could not fail. What a canvas that
    // never presented a frame *would* fail is the shape of the picture — several distinct
    // colours, none of them covering nearly the whole sample.
    const dominant = Math.max(...sample.colours.values());
    expect(sample.colours.size, `distinct colours (${summary})`).toBeGreaterThanOrEqual(4);
    expect(dominant / sample.sampled, `the most common colour covers ${dominant}/${sample.sampled} sampled pixels (${summary})`).toBeLessThan(0.95);
    // The server told its supervisor which extensions are installed (b2/b8: `POST /extensions`
    // on every boot).
    await expect.poll(() => server!.supervisorRequests.filter((r) => r === "POST /extensions").length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const inventoryReads = () => page.evaluate(() => (globalThis as typeof globalThis & { __smokeInventoryReads: InventoryRead[] }).__smokeInventoryReads);
    await expect.poll(async () => (await inventoryReads()).some((read) => read.eof || read.error), { timeout: 30_000 }).toBe(true);
    const reads = await inventoryReads();
    expect(log.inventoryRequests).toBe(1);
    expect(reads).toEqual([{ url: `${statik!.origin}/api/ai/keys`, status: 200, bytes: [...new TextEncoder().encode(EMPTY_INVENTORY)], eof: true, error: null, cancelled: false }]);
    const artifacts = log.failedRequests.filter((failure) => isCompletedInventoryAbort(failure, statik!.origin, log.inventoryRequests, reads));
    if (artifacts.length) test.info().annotations.push({ type: "chromium-completed-reader-abort", description: JSON.stringify({ artifacts, reads }) });
    await test.info().attach("boot-network.json", { body: JSON.stringify({ log, reads }, null, 2), contentType: "application/json" });
    expect(log.failedRequests.filter((failure) => !isCompletedInventoryAbort(failure, statik!.origin, log.inventoryRequests, reads))).toEqual([]);
    expect(log.errors).toEqual([]);
  } finally {
    server?.stop();
  }
});
