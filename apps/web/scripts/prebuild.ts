import { fetchEditorBundles, editorDir } from "./fetch-editor-bundle";
import { deploymentProblems, preflight } from "./deploy-preflight";

async function main() {
const deployed = process.env.VERCEL === "1" || ["production", "preview"].includes(process.env.VERCEL_ENV ?? "");
if (deployed) {
  const errors = deploymentProblems(process.env);
  if (errors.length) throw new Error(`Deployment configuration:\n${errors.join("\n")}`);
}
const source = process.env.ZS_EDITOR_BUNDLE_SOURCE?.replace(/\/+$/, "");
const build = process.env.ZS_CLIENT_BUILD_ID;
if (source && build) {
  await fetchEditorBundles({ source, build, keep: Number(process.env.ZS_EDITOR_BUNDLES_KEEP ?? "5"), dir: editorDir() });
} else {
  console.log("[prebuild] Local compilation: existing editor assets left untouched (not a deployment validation).");
}
if (deployed) preflight();
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
