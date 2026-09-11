import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { assertBuildId } from "./fetch-editor-bundle";
import { packEditorBundle } from "./pack-editor-bundle";

async function main() {
  const [build, server, output] = process.argv.slice(2);
  if (!build || !server || !output) throw new Error("Usage: publish-docker-release.ts build_id server_binary output_directory");
  assertBuildId(build);
  const repo = process.env.GITHUB_REPOSITORY || "purduehackers/zedspaces";
  const tag = `editor-${build}`;
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  await mkdir(output, { recursive: true });
  const gzip = path.join(output, "zed-remote-server.gz");
  await pipeline(createReadStream(server), createGzip({ level: 9 }), createWriteStream(gzip));
  const bundle = packEditorBundle(build, path.join(output, "browser"));
  const tar = path.join(bundle, "editor", `${build}.tar`);
  const checksum = async (file: string) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  };
  const manifest = path.join(output, "docker-release.json");
  await writeFile(manifest, JSON.stringify({ build, server: { url: `${base}/zed-remote-server.gz`, sha256: await checksum(gzip) }, browser: { url: `${base}/${build}.tar`, sha256: await checksum(tar) } }, null, 2));
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const zed = execFileSync("git", ["ls-tree", "HEAD", "../../zed"], { encoding: "utf8" }).match(/[a-f0-9]{40}/)?.[0];
  const notes = `Matching browser and Linux x86-64 server binaries for local Docker workspaces. Run pnpm dev:docker from apps/web.\n\nApp/supervisor source: https://github.com/${repo}/tree/${source}\nZed source: https://github.com/purduehackers/zed/tree/${zed}\n\nThe Zed binary and bundled assets retain their upstream licenses; see the pinned source. SHA-256 checksums are in docker-release.json. No credentials are included.`;
  // Draft first: /releases/latest must never return partially uploaded artifacts.
  execFileSync("gh", ["release", "create", tag, gzip, tar, manifest, "--repo", repo, "--target", source, "--draft", "--title", `Editor ${build}`, "--notes", notes], { stdio: "inherit" });
  execFileSync("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"], { stdio: "inherit" });
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
