import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { envSchema } from "../lib/env";
import { assertBuildId, assertServableBuild, editorDir, unpackBundle } from "./fetch-editor-bundle";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(app, "../..");
const root = path.resolve(process.env.ZS_DOCKER_ROOT || path.join(app, ".zs-dev/docker"));
const port = Number(process.env.ZS_DEV_PORT || 3100);
const origin = `http://127.0.0.1:${port}`;
const relayPort = port + 1;
interface Release { build: string; server: { url: string; sha256: string }; browser: { url: string; sha256: string } }

function command(cmd: string, args: string[], cwd = repo): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(asset: { url: string; sha256: string }, file: string) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || new URL(asset.url).protocol !== "https:") throw new Error("Invalid release asset");
  if (existsSync(file) && await digest(file) === asset.sha256) return;
  console.log(`Downloading ${path.basename(file)}…`);
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
  const temporary = `${file}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(temporary));
    if (await digest(temporary) !== asset.sha256) throw new Error("Release checksum mismatch");
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function main() {
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error("ZS_DEV_PORT must be between 1024 and 65534");
  if (process.env.VERCEL || process.env.VERCEL_ENV === "production") throw new Error("Run dev:docker locally, not on Vercel");
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: ["ignore", "ignore", "inherit"] });
  const dockerHost = process.env.DOCKER_HOST || execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" }).trim();
  if (!/^(unix|npipe):/.test(dockerHost)) throw new Error("Select a local Docker socket context. Remote Docker hosts are not supported.");
  const configFile = path.resolve(process.env.ZS_DOCKER_ENV_FILE || path.join(app, ".env.docker.local"));
  const config = existsSync(configFile) ? parse(await readFile(configFile)) : {};
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    throw new Error(`Add a local GitHub OAuth app's GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to ${configFile}. Callback: ${origin}/api/auth/callback/github`);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const secretsFile = path.join(root, "secrets.json");
  if (!existsSync(secretsFile)) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    await writeFile(secretsFile, JSON.stringify({ ZS_JWT_PRIVATE_KEY: privateKey, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"), CRON_SECRET: randomBytes(32).toString("base64url") }), { mode: 0o600, flag: "wx" });
  }
  const releaseFile = path.join(root, "release.json");
  if (!existsSync(releaseFile) || process.argv.includes("--update")) {
    const url = process.env.ZS_DOCKER_RELEASE_URL || "https://github.com/purduehackers/zedspaces/releases/latest/download/docker-release.json";
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Release manifest returned HTTP ${res.status}`);
    const release = await res.json() as Release;
    assertServableBuild(assertBuildId(release.build));
    await writeFile(releaseFile, JSON.stringify(release));
  }
  const release = JSON.parse(await readFile(releaseFile, "utf8")) as Release;
  const build = assertServableBuild(assertBuildId(release.build));
  const cache = path.join(root, build);
  await mkdir(cache, { recursive: true });
  const browser = path.join(cache, "editor.tar");
  await download(release.browser, browser);
  const destination = path.join(editorDir(), build);
  if (!existsSync(path.join(destination, "build.json"))) unpackBundle(browser, destination, build);
  // Preserve older bundles: stopped workspaces still need their matching client.
  const manifest = path.join(editorDir(), "manifest.json");
  const old = existsSync(manifest) ? JSON.parse(await readFile(manifest, "utf8")).builds as string[] : [];
  const builds = [...new Set([build, ...old])];
  await writeFile(manifest, JSON.stringify({ builds }));
  const imageHash = createHash("sha256");
  const inputs = ["sandbox/image/Dockerfile.local", "sandbox/image/repl-requirements.txt", "sandbox/image/patch-astro.mjs", "sandbox/image/export-project.py", "sandbox/image/kernel.py", "sandbox/supervisor/Cargo.toml", "sandbox/supervisor/Cargo.lock"];
  const sources = await readdir(path.join(repo, "sandbox/supervisor/src"), { recursive: true, withFileTypes: true });
  for (const file of sources) if (file.isFile()) inputs.push(path.relative(repo, path.join(file.parentPath, file.name)));
  for (const file of inputs.sort()) imageHash.update(file).update(await readFile(path.join(repo, file)));
  const fingerprint = imageHash.digest("hex").slice(0, 12);
  const image = `zedspaces-local:${build}-${fingerprint}`;
  let present = false;
  try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); present = true; } catch { /* First startup builds the runtime. */ }
  if (!present) {
    const server = path.join(cache, "zed-remote-server.gz");
    await download(release.server, server);
    // A separate build context leaves a developer's native build artifacts alone.
    const context = path.join(cache, `context-${fingerprint}`);
    await mkdir(path.join(context, "sandbox/image/dist"), { recursive: true });
    await mkdir(path.join(context, "sandbox/supervisor"), { recursive: true });
    for (const file of ["Cargo.toml", "Cargo.lock", "src"]) await cp(path.join(repo, "sandbox/supervisor", file), path.join(context, "sandbox/supervisor", file), { recursive: true });
    await command("cp", [path.join(repo, "sandbox/image/Dockerfile.local"), path.join(repo, "sandbox/image/repl-requirements.txt"), path.join(repo, "sandbox/image/patch-astro.mjs"), path.join(repo, "sandbox/image/export-project.py"), path.join(repo, "sandbox/image/kernel.py"), path.join(context, "sandbox/image")]);
    const { createGunzip } = await import("node:zlib");
    await pipeline(createReadStream(server), createGunzip(), createWriteStream(path.join(context, "sandbox/image/dist/zed-remote-server"), { mode: 0o755 }));
    await command("docker", ["build", "--platform", "linux/amd64", "--build-arg", `ZS_BUILD_ID=${build}`, "--tag", image, "--file", "sandbox/image/Dockerfile.local", "."], context);
  }
  // Only JWT-protected sandbox callbacks and signed archive URLs cross this
  // bridge. The dashboard, OAuth and workspace APIs stay on host loopback.
  const relay = createServer((req, res) => {
    const target = new URL(req.url ?? "/", origin);
    if (!target.pathname.startsWith("/api/sandboxes/")) { res.writeHead(404).end(); return; }
    const upstream = httpRequest(new URL(target.pathname + target.search, origin), { method: req.method, headers: { ...req.headers, host: new URL(origin).host }, timeout: 60_000 }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on("timeout", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { relay.once("error", reject); relay.listen(relayPort, "0.0.0.0", resolve); });
  // Empty strings prevent Next's .env.local from reintroducing cloud credentials.
  const clean = Object.fromEntries(Object.keys(envSchema.shape).map((key) => [key, ""]));
  const runtime = {
    ...process.env, ...clean, VERCEL: "", ...JSON.parse(await readFile(secretsFile, "utf8")),
    GITHUB_CLIENT_ID: config.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: config.GITHUB_CLIENT_SECRET,
    NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", ZS_SANDBOX_BACKEND: "docker", ZS_DOCKER_ROOT: root,
    ZS_DOCKER_CONTROL_URL: `http://host.docker.internal:${relayPort}/api`, ZS_CONTROL_URL: `${origin}/api`,
    ZS_DB_URL: `file:${path.join(root, "control.db")}`, ZS_BLOB_DRIVER: "file",
    WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: path.join(root, "workflows"), WORKFLOW_LOCAL_BASE_URL: origin,
    ZS_CLIENT_BUILD_ID: build, ZS_SERVER_BUILD_ID: build, ZS_IMAGE_REF: image,
    ZS_EDITOR_BUNDLES: builds.join(","), ZS_EDITOR_UPDATE_BUILDS: builds.join(","),
  };
  const child = spawn(process.execPath, [path.join(app, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: app, env: runtime, stdio: "inherit" });
  const sweep = setInterval(() => {
    void fetch(`${origin}/api/cron/sweep`, { headers: { Authorization: `Bearer ${runtime.CRON_SECRET}` }, signal: AbortSignal.timeout(55_000) }).then((res) => {
      if (!res.ok) console.warn(`Local workspace sweep returned HTTP ${res.status}`);
      void res.body?.cancel();
    }).catch(() => { /* Next may be compiling or restarting. Retry next minute. */ });
  }, 60_000);
  console.log(`Docker workspaces: ${origin}\nState: ${root}\nCtrl+C stops the web app. Stop workspaces in the dashboard; their files stay in Docker.`);
  const stop = () => { clearInterval(sweep); relay.close(); relay.closeAllConnections(); child.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.on("error", (err) => { console.error(err.message); stop(); process.exitCode = 1; });
  child.on("exit", (code) => { clearInterval(sweep); relay.close(); relay.closeAllConnections(); process.exitCode = code ?? 0; });
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
