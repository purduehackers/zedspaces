/** Packages a validated local build for an artifact host. Does not publish anything. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertBuildId, editorDir, SERVED_FILES } from "./fetch-editor-bundle";
import { bundleProblems } from "./deploy-preflight";

export function packEditorBundle(build: string, output: string): string {
  assertBuildId(build);
  if (/^dev|(?:-test|-names)$/.test(build)) throw new Error("Choose a production build");
  const problems = bundleProblems(editorDir(), [build]);
  if (problems.length) throw new Error(problems.join("\n"));
  const dest = path.resolve(output);
  if (fs.existsSync(dest)) throw new Error(`Output already exists: ${dest}. Choose a new directory; existing assets are never overwritten.`);
  const editor = path.join(dest, "editor");
  fs.mkdirSync(editor, { recursive: true });
  execFileSync("tar", ["-cf", path.join(editor, `${build}.tar`), "-C", editorDir(), ...SERVED_FILES.map((file) => `${build}/${file}`)]);
  fs.writeFileSync(path.join(editor, "manifest.json"), JSON.stringify({ builds: [build] }, null, 2) + "\n");
  return dest;
}

if (process.argv[1]?.endsWith("pack-editor-bundle.ts")) {
  try {
    const [build, output] = process.argv.slice(2);
    if (!build || !output) throw new Error("Usage: pnpm editor:pack <build-id> <new-output-directory>");
    console.log(`Prepared ${packEditorBundle(build, output)}. Not published; host its editor/ directory at ZS_EDITOR_BUNDLE_SOURCE/editor/.`);
  } catch (err) { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}
