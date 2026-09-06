import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client, type ResultSet } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { env, EnvError } from "./env";
import * as schema from "./schema";
import { localClientQueue } from "./db-local-client";

// Resolve from the app root. Do not use a module-relative URL:
// Turbopack would try to import the directory. Remote databases migrate explicitly.
const MIGRATIONS_DIR = path.resolve(process.cwd(), "drizzle-sqlite");
export type Db = LibSQLDatabase<typeof schema> & { $client: Client };
export type DbLike = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

interface DbState { instance: Db | null; ready: Promise<Db> | null }
// Workflow steps are bundled separately but must share the same local DB.
const STATE_KEY = "__zsLibsqlDbState" as const;
type GlobalWithDb = typeof globalThis & { [STATE_KEY]?: DbState };
function state(): DbState {
  const g = globalThis as GlobalWithDb;
  return g[STATE_KEY] ??= { instance: null, ready: null };
}

/** Turso in deployment; a local file for development. */
export function databaseConfig(): { url: string; authToken?: string } {
  const e = env();
  const deployed = Boolean(e.VERCEL_ENV && e.VERCEL_ENV !== "development");
  if (deployed && !e.TURSO_DATABASE_URL) throw new EnvError(["TURSO_DATABASE_URL"]);
  let url = e.TURSO_DATABASE_URL ?? e.ZS_DB_URL;
  if (!url) {
    const root = e.ZS_LOCAL_ROOT ?? path.join(os.tmpdir(), "zs-local");
    mkdirSync(root, { recursive: true });
    url = "file:" + path.join(root, "control.db");
  }
  if (deployed && !/^(libsql|https):\/\//.test(url)) {
    throw new EnvError(["TURSO_DATABASE_URL"], "Deployments require a remote Turso database, not ephemeral local storage");
  }
  if (deployed && !e.TURSO_AUTH_TOKEN) throw new EnvError(["TURSO_AUTH_TOKEN"]);
  return { url, authToken: e.TURSO_AUTH_TOKEN };
}

export function getDb(): Db {
  const s = state();
  return s.instance ??= drizzle(localClientQueue(createClient(databaseConfig())), { schema });
}

/** Local DBs auto-migrate once; Turso is migrated by pnpm db:migrate before deployment. */
export function dbReady(): Promise<Db> {
  const s = state();
  if (s.ready) return s.ready;
  const db = getDb();
  const local = /^(file:|:memory:$)/.test(databaseConfig().url);
  const ready = (async () => {
    if (local) {
      await db.$client.execute("PRAGMA foreign_keys = ON");
      await migrateDb(db);
    } else {
      // HTTP operations open fresh server connections: setting a connection PRAGMA
      // once cannot configure later requests. Require enforcement in the service.
      const result = await db.$client.execute("PRAGMA foreign_keys");
      if (Number(result.rows[0]?.foreign_keys) !== 1) throw new EnvError(["TURSO_DATABASE_URL"],
        "The remote libSQL service must enable foreign keys on every connection; run pnpm deploy:check:db");
    }
    return db;
  })();
  s.ready = ready;
  ready.catch(() => { if (s.ready === ready) s.ready = null; });
  return ready;
}

export async function migrateDb(db: Db, opts?: { migrationsFolder?: string }): Promise<void> {
  await migrate(db, { migrationsFolder: opts?.migrationsFolder ?? MIGRATIONS_DIR });
}

/** SQLite constraint errors may be wrapped in a Drizzle query error. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const { code, message } = current as { code?: string; message?: string };
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        (code === "SQLITE_CONSTRAINT" && /UNIQUE constraint failed/.test(message ?? ""))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function closeDb(): Promise<void> {
  const s = state();
  s.instance?.$client.close();
  s.instance = null;
  s.ready = null;
}
