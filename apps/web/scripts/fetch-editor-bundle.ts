/**
 * Bundle delivery (b9 §3.30). Runs as the `prebuild` npm script, before
 * `next build`:
 *
 *   1. reads `ZS_CLIENT_BUILD_ID` (the bundle new workspaces load) and
 *      `ZS_EDITOR_BUNDLE_SOURCE` (where b7's nightly `web_bundle` job publishes
 *      `editor/<build>.tar` and `editor/manifest.json`);
 *   2. downloads `editor/<build>.tar` into `public/editor/<build>/` when that
 *      directory is absent, unpacking only the served files (`zed_web.js`,
 *      `zed_web_bg.wasm`, `zed-assets.tar`, `build.json`) and asserting
 *      `build.json.build_id === <build>`;
 *   3. mirrors `editor/manifest.json` to `public/editor/manifest.json` and
 *      fetches the previous `ZS_EDITOR_BUNDLES_KEEP - 1` builds it lists, so
 *      workspaces created on older images keep a matching bundle;
 *   4. removes bundle directories that are neither kept nor local (`dev-*`).
 *
 * Without a source or a build id the script exits 0 and leaves
 * `public/editor/` alone (local development with the `dev-0` stub).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The files a served bundle directory keeps; everything else in the tar is b7's dev harness. */
export const SERVED_FILES = ["zed_web.js", "zed_web_bg.wasm", "zed-assets.tar", "build.json"] as const;

/** Bundle ids that are never pruned: local placeholders. */
const LOCAL_BUILD_RE = /^dev-/;

/** `public/editor` of this app. */
export function editorDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "editor");
}

function log(message: string): void {
  console.log(`[fetch-editor-bundle] ${message}`);
}

/** `editor/manifest.json` at the source: `{ "builds": ["<newest>", …] }`. */
export interface BundleManifest {
  builds: string[];
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res;
}

/** Reads and validates the source's manifest; `null` when the source has none. */
export async function fetchManifest(source: string): Promise<BundleManifest | null> {
  const res = await fetch(`${source}/editor/manifest.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`editor/manifest.json answered HTTP ${res.status}`);
  const raw = (await res.json()) as { builds?: unknown };
  if (!Array.isArray(raw.builds) || !raw.builds.every((entry) => typeof entry === "string")) {
    throw new Error("editor/manifest.json does not carry a builds: string[] array");
  }
  return { builds: raw.builds as string[] };
}

/** A build id must be a safe path segment. */
export function assertBuildId(build: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(build)) throw new Error(`invalid build id ${JSON.stringify(build)}`);
  return build;
}

/**
 * Whether a build id names a test-hooks bundle: `script/build-web --test-hooks` suffixes the
 * id with `-test` (`-test-names` with `--names`) and stamps `test_hooks: true` into its
 * build.json. Such a bundle exposes `window.__zs_test` and must not be delivered.
 */
export function isTestBuildId(build: string): boolean {
  return /-test(-names)?$/.test(build);
}

/**
 * Refuses a test-hooks bundle for delivery, by id or by its build.json.
 */
export function assertServableBuild(build: string, meta?: { test_hooks?: unknown }): string {
  if (isTestBuildId(build)) throw new Error(`refusing the test-hooks bundle ${build}`);
  if (meta?.test_hooks === true) {
    throw new Error(`refusing ${build}: its build.json says test_hooks: true`);
  }
  return build;
}

/**
 * Unpacks `tarPath` into `dest`, keeping only {@link SERVED_FILES} and
 * asserting the embedded `build.json` names `build` and is not a test-hooks bundle.
 */
export function unpackBundle(tarPath: string, dest: string, build: string): void {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "zs-editor-"));
  try {
    execFileSync("tar", ["-xf", tarPath, "-C", staging], { stdio: "inherit" });
    // The tar may carry the files at its root or under `<build>/`.
    const root = fs.existsSync(path.join(staging, "build.json")) ? staging : path.join(staging, build);
    const buildJson = path.join(root, "build.json");
    if (!fs.existsSync(buildJson)) throw new Error(`${tarPath} carries no build.json`);
    const meta = JSON.parse(fs.readFileSync(buildJson, "utf8")) as { build_id?: unknown; test_hooks?: unknown };
    if (meta.build_id !== build) {
      throw new Error(`${tarPath}: build.json.build_id ${JSON.stringify(meta.build_id)} !== ${build}`);
    }
    assertServableBuild(build, meta);
    for (const file of SERVED_FILES) {
      if (!fs.existsSync(path.join(root, file))) throw new Error(`${tarPath} carries no ${file}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const file of SERVED_FILES) fs.copyFileSync(path.join(root, file), path.join(dest, file));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Downloads and unpacks one build unless `public/editor/<build>/` already holds it. */
export async function ensureBundle(source: string, build: string, dir: string): Promise<boolean> {
  const dest = path.join(dir, build);
  if (SERVED_FILES.every((file) => fs.existsSync(path.join(dest, file)))) {
    const meta = JSON.parse(fs.readFileSync(path.join(dest, "build.json"), "utf8"));
    if (meta.build_id !== build) throw new Error(`${build}: existing build.json names another build`);
    assertServableBuild(build, meta);
    log(`${build}: present`);
    return false;
  }
  const url = `${source}/editor/${build}.tar`;
  log(`${build}: downloading ${url}`);
  const res = await fetchOk(url);
  const tarPath = path.join(os.tmpdir(), `zs-editor-${build}-${process.pid}.tar`);
  fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
  try {
    unpackBundle(tarPath, dest, build);
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
  log(`${build}: unpacked into ${dest}`);
  return true;
}

/** Deletes every bundle directory under `dir` that is not in `keep` and is not a local `dev-*` build. */
export function pruneBundles(dir: string, keep: ReadonlySet<string>): string[] {
  if (!fs.existsSync(dir)) return [];
  const removed: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name) || LOCAL_BUILD_RE.test(entry.name)) continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/** What one run did. */
export interface FetchResult {
  fetched: string[];
  kept: string[];
  removed: string[];
}

/** The whole `prebuild` step for one environment. */
export async function fetchEditorBundles(opts: {
  source: string;
  build: string;
  keep: number;
  dir: string;
}): Promise<FetchResult> {
  const build = assertServableBuild(assertBuildId(opts.build));
  const dir = opts.dir;
  fs.mkdirSync(dir, { recursive: true });
  const manifest = await fetchManifest(opts.source);
  const wanted: string[] = [build];
  for (const older of manifest?.builds ?? []) {
    if (wanted.length >= Math.max(1, opts.keep)) break;
    const id = assertBuildId(older);
    // A test bundle listed at the source is skipped, never fetched beside the production ones.
    if (isTestBuildId(id)) {
      log(`${id}: skipped (a test-hooks bundle is never delivered)`);
      continue;
    }
    if (!wanted.includes(id)) wanted.push(id);
  }
  const fetched: string[] = [];
  for (const id of wanted) {
    // Every retained build may be needed by an interactive workspace. Fail publication
    // rather than deploying an incomplete set and forcing those users to upgrade.
    if (await ensureBundle(opts.source, id, dir)) fetched.push(id);
  }
  const kept = wanted.filter((id) => fs.existsSync(path.join(dir, id, "build.json")));
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ builds: kept }, null, 2)}\n`);
  const removed = pruneBundles(dir, new Set(kept));
  return { fetched, kept, removed };
}

async function main(): Promise<void> {
  const source = process.env.ZS_EDITOR_BUNDLE_SOURCE?.replace(/\/+$/, "");
  const build = process.env.ZS_CLIENT_BUILD_ID;
  const keep = Number(process.env.ZS_EDITOR_BUNDLES_KEEP ?? "5");
  if (!source || !build) {
    log("ZS_EDITOR_BUNDLE_SOURCE or ZS_CLIENT_BUILD_ID unset: leaving public/editor/ as is");
    return;
  }
  const result = await fetchEditorBundles({ source, build, keep: Number.isFinite(keep) ? keep : 5, dir: editorDir() });
  log(`fetched ${result.fetched.length}, kept [${result.kept.join(", ")}], removed [${result.removed.join(", ")}]`);
}

const invokedDirectly = process.argv[1]?.endsWith("fetch-editor-bundle.ts") ?? false;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[fetch-editor-bundle] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
