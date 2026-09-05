import type { Db } from "@/lib/db";

/** Child-first deletes preserve FK enforcement (SQLite has no TRUNCATE CASCADE). */
export async function clearTestDb(db: Db): Promise<void> {
  const tables = ["ai_key_exports", "ai_keys", "ai_usage", "audit_log", "forwards", "invoices",
    "memberships", "secrets", "sessions", "settings_docs", "usage_ledger", "webhook_deliveries",
    "workspaces", "prebuilds", "image_builds", "repo_access", "repos", "github_installations", "orgs", "users", "kv_zset", "kv"];
  await db.$client.batch(tables.map((table) => "DELETE FROM " + table), "write");
}
