/** Guard against local filesystem code tracing large WASM assets into Vercel Functions. */
import fs from "node:fs";
import path from "node:path";

function traces(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? traces(file) : entry.name.endsWith(".nft.json") ? [file] : [];
  });
}
const root = process.cwd();
const dist = path.resolve(root, process.env.ZS_NEXT_DIST_DIR ?? ".next");
const files = traces(path.join(dist, "server"));
if (!files.length) throw new Error("No server traces found; run next build first");
let largest = { file: "", bytes: 0 };
for (const trace of files) {
  const deps = JSON.parse(fs.readFileSync(trace, "utf8")).files as string[];
  let bytes = 0;
  for (const name of new Set(deps.map((dep) => path.resolve(path.dirname(trace), dep)))) {
    const relative = path.relative(root, name).replaceAll(path.sep, "/");
    if (/^(public\/editor\/|\.zs-dev\/|test-results\/|\.env(?:\.|$))/.test(relative)) throw new Error(`Local/static data leaked into ${path.relative(dist, trace)}: ${relative}`);
    bytes += fs.statSync(name).size;
  }
  if (bytes > largest.bytes) largest = { file: path.relative(dist, trace), bytes };
  // Conservative ceiling leaves room for the framework and platform wrapper.
  if (bytes > 200 * 1024 ** 2) throw new Error(`${path.relative(dist, trace)} traces more than 200 MiB into one Function`);
}
console.log(`[server-traces] ${files.length} traces checked; largest ${(largest.bytes / 1024 ** 2).toFixed(1)} MiB (${largest.file}). No editor assets, local state or env files bundled as Function dependencies.`);
