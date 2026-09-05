import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/web");
const extensions = /\.(?:[cm]?[jt]sx?|css|sh)$/;
const files = [];
function scan(dir, group) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".well-known") continue; // Workflow-generated routes.
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file, group);
    else if (extensions.test(entry.name)) {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      files.push({ file: path.relative(root, file), group, lines: lines.length,
        nonblank: lines.filter((line) => line.trim()).length, bytes: Buffer.byteLength(text) });
    }
  }
}
for (const dir of ["app", "lib", "workflows", "scripts"]) scan(path.join(root, dir), dir);
const totals = {};
for (const file of files) {
  const group = totals[file.group] ??= { files: 0, lines: 0, nonblank: 0, bytes: 0 };
  group.files++;
  for (const key of ["lines", "nonblank", "bytes"]) group[key] += file[key];
}
const total = Object.values(totals).reduce((sum, group) => {
  for (const key of Object.keys(sum)) sum[key] += group[key];
  return sum;
}, { files: 0, lines: 0, nonblank: 0, bytes: 0 });
console.log(JSON.stringify({ scope: "apps/web/{app,lib,workflows,scripts}; source only, excluding generated .well-known, tests, artifacts and migrations", totals, total, files }, null, 2));
