/**
 * Database chores of `scripts/dev-local.sh` (local mode only; the script
 * exports the environment `lib/db.ts` reads before running this):
 *
 *   tsx scripts/dev-local-db.ts mark-stopped   every live workspace row → stopped (see lib/dev-local-admin.ts)
 *   tsx scripts/dev-local-db.ts list           one line per non-deleted workspace
 *
 * Runs only against a local libSQL file: it is the fallback for when `next dev` is already down,
 * never a production tool.
 */
import { isNull } from "drizzle-orm";
import { markLocalWorkspacesStopped } from "../lib/dev-local-admin";
import { closeDb, dbReady, databaseConfig } from "../lib/db";
import { workspaces } from "../lib/schema";

function assertLocalDatabase(): void {
  const { url } = databaseConfig();
  if (url.startsWith("file:")) return;
  throw new Error("dev-local-db: refusing to touch a non-file database");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  assertLocalDatabase();
  const db = await dbReady();
  try {
    switch (command) {
      case "mark-stopped": {
        const changed = await markLocalWorkspacesStopped(db);
        for (const row of changed) console.log(`[dev-local-db] ${row.id}: ${row.from} -> stopped`);
        console.log(`[dev-local-db] ${changed.length} workspace(s) marked stopped`);
        return;
      }
      case "list": {
        const rows = await db
          .select({ id: workspaces.id, state: workspaces.state, reason: workspaces.stateReason, run: workspaces.workflowRunId })
          .from(workspaces)
          .where(isNull(workspaces.deletedAt));
        for (const row of rows) console.log(`${row.id}\t${row.state}\t${row.reason ?? ""}\t${row.run ?? ""}`);
        return;
      }
      default:
        throw new Error(`usage: dev-local-db.ts mark-stopped|list (got ${command ?? "nothing"})`);
    }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
