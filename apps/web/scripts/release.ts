/** CI release operations. Only `publish`, `configure`, and `restore` change external state. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { head, list, put } from "@vercel/blob";
import { assertBuildId, assertServableBuild, editorDir } from "./fetch-editor-bundle";
import { bundleProblems } from "./deploy-preflight";

const keys = ["ZS_IMAGE_REF", "ZS_CLIENT_BUILD_ID", "ZS_SERVER_BUILD_ID", "ZS_EDITOR_BUNDLES", "ZS_EDITOR_BUNDLES_KEEP"] as const;
type Values = Record<typeof keys[number], string>;
interface RecordFile { build: string; values: Values; previous: Record<typeof keys[number], string | null>; assetSha256: string }
const recordPath = path.resolve("release-record.json");
const required = (key: string): string => { const value = process.env[key]; assert.ok(value, `${key} is required`); return value; };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function releaseValues(build: string, image: { build: string; tag: string; digest: string }, repository: string): Values {
  assertServableBuild(assertBuildId(build));
  assert.ok(!/^dev/.test(build) && !build.endsWith("-names"), "Production build required");
  assert.match(repository, /^vcr\.vercel\.com\/[a-z0-9._-]+\/[a-z0-9._-]+\/zs-workspace$/);
  assert.equal(image.build, build, "Image and browser build must match");
  assert.equal(image.tag, `${repository}:${build}`);
  assert.match(image.digest, /^sha256:[a-f0-9]{64}$/);
  return { ZS_IMAGE_REF: `${repository}@${image.digest}`, ZS_CLIENT_BUILD_ID: build, ZS_SERVER_BUILD_ID: build,
    ZS_EDITOR_BUNDLES: build, ZS_EDITOR_BUNDLES_KEEP: "1" };
}

function api(endpoint: string, method = "GET", body?: unknown) {
  const args = ["api", endpoint, "--raw", "--scope", required("VERCEL_TEAM_SLUG"), "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const output = execFileSync("vercel", args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const result = output.trim() ? JSON.parse(output) : {};
  assert.ok(!result.error && !result.errors?.length, `Vercel ${method} request failed`);
  return result;
}

async function publish(build: string, delivery: string) {
  assert.deepEqual(bundleProblems(editorDir(), [build]), [], "Production bundle validation");
  const team = required("VERCEL_TEAM_SLUG");
  const repository = `vcr.vercel.com/${team}/${required("VERCEL_PROJECT_SLUG")}/zs-workspace`;
  const source = new URL(required("ZS_EDITOR_BUNDLE_SOURCE"));
  assert.ok(source.protocol === "https:" && !source.username && !source.password && !source.search && !source.hash && source.pathname === "/");
  const token = required("EDITOR_ASSETS_READ_WRITE_TOKEN");
  const manifestUrl = new URL("editor/manifest.json", source).href;
  const response = await fetch(manifestUrl);
  assert.ok(response.ok || response.status === 404, `Manifest HTTP ${response.status}`);
  const manifestHead = response.ok ? await head(manifestUrl, { token }) : null;
  const image = JSON.parse(fs.readFileSync("../../sandbox/image/dist/image.json", "utf8"));
  const values = releaseValues(build, image, repository);

  const archive = fs.readFileSync(path.join(delivery, "editor", `${build}.tar`));
  const pathname = `editor/${build}.tar`;
  const existing = (await list({ token, prefix: pathname })).blobs.find(blob => blob.pathname === pathname);
  const asset = existing ?? await put(pathname, archive, { token, access: "public", addRandomSuffix: false,
    allowOverwrite: false, multipart: true, contentType: "application/x-tar" });
  assert.equal(new URL(asset.url).origin, source.origin, "Asset token must belong to the configured public store");
  const downloaded = await fetch(asset.url);
  assert.equal(downloaded.status, 200);
  const assetSha256 = sha256(archive);
  assert.equal(sha256(new Uint8Array(await downloaded.arrayBuffer())), assetSha256, "Immutable asset checksum");
  const builds = values.ZS_EDITOR_BUNDLES.split(",");
  await put("editor/manifest.json", JSON.stringify({ builds }) + "\n", { token, access: "public", addRandomSuffix: false,
    allowOverwrite: Boolean(manifestHead), ...(manifestHead ? { ifMatch: manifestHead.etag } : {}), cacheControlMaxAge: 60, contentType: "application/json" });
  // Blob invalidation is asynchronous; don't mistake a stale CDN read for a failed upload.
  let visible = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const check = await fetch(manifestUrl);
    if (check.ok && JSON.stringify((await check.json()).builds) === JSON.stringify(builds)) { visible = true; break; }
    await delay(5000);
  }
  assert.ok(visible, "New manifest must be visible before deployment");
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
  fs.writeFileSync(recordPath, JSON.stringify({ build, values, previous, assetSha256 }, null, 2) + "\n");
  console.log(JSON.stringify({ build, image: values.ZS_IMAGE_REF, assetSha256 }));
}

export function configure(record: RecordFile, restore: boolean, request = api) {
  const project = required("VERCEL_PROJECT_ID");
  const envs = request(`/v9/projects/${project}/env`).envs as { id: string; key: string; target: string[] }[];
  for (const key of keys) {
    const value = (restore ? record.previous : record.values)[key];
    const entry = envs.find(item => item.key === key && item.target.includes("production"));
    if (value === null) { if (entry) request(`/v9/projects/${project}/env/${entry.id}`, "DELETE"); }
    else request(entry ? `/v9/projects/${project}/env/${entry.id}` : `/v10/projects/${project}/env`, entry ? "PATCH" : "POST", { key, value, type: "encrypted", target: ["production"] });
  }
  console.log(restore ? "Previous release configuration restored; no workspace was changed." : "Matching release configuration set; no workspace was changed.");
}

async function verify(record: RecordFile) {
  const origin = "https://code.purduehackers.com";
  assert.equal((await fetch(origin)).status, 200, "Public homepage must be reachable without login");
  for (const build of record.values.ZS_EDITOR_BUNDLES.split(",")) {
    const response = await fetch(`${origin}/editor/${build}/build.json`);
    assert.equal(response.status, 200, `Published build ${build}`);
    const meta = await response.json();
    assert.equal(meta.build_id, build);
    assert.equal(meta.test_hooks, false);
  }
  console.log(`Verified ${origin} and the current production bundle.`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Zedspaces release\n\n- Live: ${origin}\n- Build: \`${record.build}\`\n- Image: \`${record.values.ZS_IMAGE_REF}\`\n- Recreate old workspaces after a breaking release.\n`);
}

async function main() {
  const [command, build, delivery] = process.argv.slice(2);
  if (command === "publish") { assert.ok(build && delivery, "publish needs build ID and delivery directory"); await publish(build, delivery); }
  else {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as RecordFile;
    if (command === "configure" || command === "restore") configure(record, command === "restore");
    else { assert.equal(command, "verify", "Use publish, configure, restore, or verify"); await verify(record); }
  }
}
if (process.argv[1]?.endsWith("release.ts")) main().catch(error => {
  // SDK/CLI errors can contain request bodies or credentials. Don't print raw error objects.
  console.error(error instanceof assert.AssertionError ? error.message : "Release operation failed; inspect the preceding stage. Credentials were not logged.");
  process.exitCode = 1;
});
