/** Publish a built bundle, then repoint explicitly named stopped local workspaces only. */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { closeDb, databaseConfig, dbReady } from "../lib/db";
import { workspaces } from "../lib/schema";
import { assertBuildId, assertServableBuild, editorDir, SERVED_FILES } from "./fetch-editor-bundle";

async function main() {
  const [rawBuild, ...ids] = process.argv.slice(2);
  if (!rawBuild) throw new Error("Usage: scripts/dev-repoint.sh <build-id> [stopped-workspace-id ...]. No IDs means publish only.");
  const build = assertServableBuild(assertBuildId(rawBuild), undefined, false);
  if (build.endsWith("-names")) throw new Error("Debug name-section bundles are not serving artifacts");
  const dest = path.join(editorDir(), build);
  const source = fs.existsSync(path.join(dest, "build.json")) ? dest
    : path.resolve(process.cwd(), "../../zed/target/web-bundle", build);
  const meta = JSON.parse(fs.readFileSync(path.join(source, "build.json"), "utf8"));
  assertServableBuild(build, meta, false);
  if (meta.build_id !== build) throw new Error("Bundle metadata does not match its ID");
  for (const file of SERVED_FILES) if (!fs.statSync(path.join(source, file)).isFile()) throw new Error(`Missing ${file}`);
  if (source !== dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of SERVED_FILES) fs.copyFileSync(path.join(source, file), path.join(dest, file));
  }
  const manifestPath = path.join(editorDir(), "manifest.json");
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).builds as string[] : [];
  fs.writeFileSync(manifestPath, JSON.stringify({ builds: [build, ...previous.filter((id) => id !== build)] }, null, 2) + "\n");
  console.log(`Published ${build}. No old bundles removed.`);
  if (!ids.length) { console.log("No workspace IDs supplied; no database or running workspace touched."); return; }
  if (!process.env.ZS_DB_URL?.startsWith("file:") || !databaseConfig().url.startsWith("file:")) throw new Error("Repointing requires an explicit local ZS_DB_URL=file:/absolute/path/control.db");
  const db = await dbReady();
  try {
    await db.transaction(async (tx) => {
      const selected = await tx.select().from(workspaces).where(inArray(workspaces.id, ids));
      for (const id of ids) {
        const ws = selected.find((row) => row.id === id);
        if (!ws || ws.deletedAt || ws.state !== "stopped" || ws.workflowRunId) throw new Error(`${id} is missing, deleted, active or busy; stop it through the API first`);
        if (!ws.serverBuild.startsWith("dev") && ws.serverBuild !== build) throw new Error(`${id} needs a matching server image before repointing`);
      }
      await tx.update(workspaces).set({ clientBuild: build }).where(and(inArray(workspaces.id, ids), eq(workspaces.state, "stopped"), isNull(workspaces.deletedAt)));
    });
    console.log(`Repointed ${ids.join(", ")}; left stopped, URLs and saved state preserved.`);
  } finally { await closeDb(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
