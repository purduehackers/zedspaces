/** Read-only Turso readiness check; --migrate explicitly applies pending Drizzle migrations first. */
import { createClient } from "@libsql/client";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "node:path";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !/^(https|libsql):\/\//.test(url) || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must name a remote database");
  const client = createClient({ url, authToken });
  try {
    const fk = await client.execute("PRAGMA foreign_keys");
    if (Number(fk.rows[0]?.foreign_keys) !== 1) throw new Error("Foreign key enforcement is off on new connections. Use a libSQL service with enforcement enabled by default.");
    if (process.argv.includes("--migrate")) {
      try { await migrate(drizzle(client), { migrationsFolder: path.resolve(process.cwd(), "drizzle-sqlite") }); }
      catch { throw new Error("Remote migration failed; deployment must not continue."); }
    }
    const migrations = readMigrationFiles({ migrationsFolder: path.resolve(process.cwd(), "drizzle-sqlite") });
    const applied = await client.execute("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1");
    if (applied.rows[0]?.hash !== migrations.at(-1)?.hash) throw new Error("The current SQLite migration has not been applied. Run pnpm db:migrate explicitly against the intended database.");
    const violations = await client.execute("PRAGMA foreign_key_check");
    if (violations.rows.length) throw new Error("Remote database contains foreign-key violations; no changes were made");
    const tx = await client.transaction("read");
    try {
      const check = await tx.execute("PRAGMA foreign_keys");
      if (Number(check.rows[0]?.foreign_keys) !== 1) throw new Error("Foreign keys are not enforced inside transactions");
      await tx.execute("SELECT key FROM kv LIMIT 1");
      await tx.execute("SELECT key,member FROM kv_zset LIMIT 1");
      await tx.execute("SELECT id FROM workspaces LIMIT 1");
      await tx.rollback();
    } finally { tx.close(); }
    console.log(`Remote libSQL schema, KV tables, and foreign-key enforcement verified. ${process.argv.includes("--migrate") ? "Pending Drizzle migrations applied." : "Read-only; no rows or schema changed."}`);
  } finally { client.close(); }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
