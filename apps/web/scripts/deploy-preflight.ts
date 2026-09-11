/** Read-only deployment checks. Never provisions, migrates, publishes, or deploys. */
import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertBuildId, assertServableBuild, editorDir, SERVED_FILES } from "./fetch-editor-bundle";

type Variables = Record<string, string | undefined>;
export function deploymentProblems(e: Variables): string[] {
  const problems: string[] = [];
  const requireValue = (key: string) => { if (!e[key]?.trim()) problems.push(`${key} is required`); };
  for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "ZS_CONTROL_URL", "ZS_JWT_PRIVATE_KEY",
    "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "BETTER_AUTH_SECRET", "CRON_SECRET",
    "ZS_CLIENT_BUILD_ID", "ZS_SERVER_BUILD_ID", "ZS_IMAGE_REF", "ZS_EDITOR_BUNDLE_SOURCE", "ZS_EDITOR_BUNDLES", "ZS_EDITOR_UPDATE_BUILDS",
    "BLOB_READ_WRITE_TOKEN"]) requireValue(key);
  if (e.TURSO_DATABASE_URL && !/^(libsql|https):\/\//.test(e.TURSO_DATABASE_URL)) problems.push("TURSO_DATABASE_URL must be a remote libsql:// or https:// database");
  for (const [key, suffix] of [["ZS_CONTROL_URL", "/api"], ["ZS_EDITOR_BUNDLE_SOURCE", null]] as const) {
    if (!e[key]) continue;
    try {
      const url = new URL(e[key]!);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        /^(localhost|127\.|\[::1\])/.test(url.hostname) || (suffix && url.pathname !== suffix)) throw new Error();
    } catch { problems.push(`${key} must be a public HTTPS URL${suffix ? " ending in /api" : ""}, without credentials/query/fragment`); }
  }
  for (const key of ["ZS_CLIENT_BUILD_ID", "ZS_SERVER_BUILD_ID"]) {
    if (!e[key]) continue;
    try {
      assertServableBuild(assertBuildId(e[key]!));
      if (/^dev|(?:-names)$/.test(e[key]!)) throw new Error();
    } catch { problems.push(`${key} must name a production build, not dev/test/debug output`); }
  }
  if (e.ZS_CLIENT_BUILD_ID && e.ZS_SERVER_BUILD_ID && e.ZS_CLIENT_BUILD_ID !== e.ZS_SERVER_BUILD_ID) problems.push("Client and server build IDs must match exactly");
  if (e.ZS_IMAGE_REF && !/^vcr\.vercel\.com\/[a-z0-9._-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(e.ZS_IMAGE_REF)) problems.push("ZS_IMAGE_REF must be a digest-pinned VCR image");
  const served = e.ZS_EDITOR_BUNDLES?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
  if (e.ZS_CLIENT_BUILD_ID && !served.includes(e.ZS_CLIENT_BUILD_ID)) problems.push("ZS_EDITOR_BUNDLES must include ZS_CLIENT_BUILD_ID");
  const updateBuilds = e.ZS_EDITOR_UPDATE_BUILDS?.split(",").filter(Boolean) ?? [];
  if (e.ZS_CLIENT_BUILD_ID && !updateBuilds.includes(e.ZS_CLIENT_BUILD_ID)) problems.push("Current build must support deferred updates");
  if (updateBuilds.some(build => !served.includes(build))) problems.push("Update-capable builds must be served");
  for (const id of served) {
    try { assertServableBuild(assertBuildId(id)); if (/^dev|(?:-names)$/.test(id)) throw new Error(); }
    catch { problems.push("ZS_EDITOR_BUNDLES contains a non-production build"); }
  }
  for (const [key, value] of [["ZS_SANDBOX_BACKEND", "vercel"], ["ZS_BLOB_DRIVER", "vercel"]]) {
    if (e[key] && e[key] !== value) problems.push(`${key} must be ${value} in a deployment`);
  }
  for (const key of ["ZS_DB_URL", "ZS_LOCAL_ROOT", "ZS_SERVE_BIN", "ZS_AGENT_BIN"]) if (e[key]) problems.push(`${key} is local-only; remove it from deployment variables`);
  if (e.CRON_SECRET && e.CRON_SECRET.length < 16) problems.push("CRON_SECRET must have at least 16 characters");
  if (e.BETTER_AUTH_SECRET && e.BETTER_AUTH_SECRET.length < 32) problems.push("BETTER_AUTH_SECRET must contain at least 32 random characters");
  if (e.ZS_JWT_PRIVATE_KEY) {
    try {
      const key = createPrivateKey(e.ZS_JWT_PRIVATE_KEY.replace(/\\n/g, "\n"));
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    } catch { problems.push("ZS_JWT_PRIVATE_KEY must be an ES256/P-256 private PEM key"); }
  }
  if (e.ZS_MAX_RUNNING_WORKSPACES && (!/^\d+$/.test(e.ZS_MAX_RUNNING_WORKSPACES) || Number(e.ZS_MAX_RUNNING_WORKSPACES) < 1 || Number(e.ZS_MAX_RUNNING_WORKSPACES) > 100)) problems.push("ZS_MAX_RUNNING_WORKSPACES must be between 1 and 100");
  return problems;
}

export function bundleProblems(dir: string, builds: string[]): string[] {
  const problems: string[] = [];
  for (const build of builds) {
    try {
      assertBuildId(build);
      const root = path.join(dir, build);
      const meta = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"));
      assertServableBuild(build, meta);
      if (meta.build_id !== build || meta.test_hooks !== false) throw new Error("build.json identity/test_hooks mismatch");
      for (const file of SERVED_FILES) if (!fs.statSync(path.join(root, file)).isFile() || fs.statSync(path.join(root, file)).size === 0) throw new Error(`${file} missing or empty`);
      const wasm = fs.openSync(path.join(root, "zed_web_bg.wasm"), "r");
      const magic = Buffer.alloc(8);
      try { fs.readSync(wasm, magic, 0, 8, 0); } finally { fs.closeSync(wasm); }
      if (!magic.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error("invalid WebAssembly header (development stub?)");
      if (meta.wasm_bytes !== fs.statSync(path.join(root, "zed_web_bg.wasm")).size) throw new Error("WebAssembly size differs from build.json");
    } catch (err) { problems.push(`${build}: ${err instanceof Error ? err.message : "invalid bundle"}`); }
  }
  return problems;
}

export function preflight(e: Variables = process.env, dir = editorDir()): void {
  const problems = deploymentProblems(e);
  if (!problems.length) problems.push(...bundleProblems(dir, e.ZS_EDITOR_BUNDLES!.split(",").map((id) => id.trim()).filter(Boolean)));
  if (!problems.length) for (const build of e.ZS_EDITOR_UPDATE_BUILDS!.split(",")) {
    const root = path.join(dir, build);
    const meta = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"));
    if (meta.web_updates !== true || meta.assets_bytes !== fs.statSync(path.join(root, "zed-assets.tar")).size ||
      meta.js_bytes !== fs.statSync(path.join(root, "zed_web.js")).size) problems.push(`${build}: invalid deferred-update metadata`);
  }
  if (problems.length) throw new Error(`Deployment is not ready:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  console.log("[deploy-preflight] Configuration and editor bundles valid. Remote database, image readiness, and Sandbox boot still require live validation. No resources were changed.");
}

if (process.argv[1]?.endsWith("deploy-preflight.ts")) {
  try { preflight(); } catch (err) { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}
