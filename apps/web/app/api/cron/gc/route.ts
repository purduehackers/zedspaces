import { handler, json } from "@/lib/api";
import { requireCronSecret } from "@/lib/cron";
import { startRun } from "@/lib/lifecycle";
import { keys, withLock } from "@/lib/kv";

export const runtime = "nodejs";
export const maxDuration = 300;

/** How long the gc trigger holds its lock; the run itself is asynchronous. */
const LOCK_MS = 60_000;

/**
 * `GET /api/cron/gc` – starts the nightly `gc` workflow (b9 §4.8): retention
 * warnings, expired workspaces and orphaned sandboxes.
 */
export const GET = handler(async (req: Request) => {
  requireCronSecret(req);
  const started = await withLock(keys.lock("gc"), LOCK_MS, () =>
    startRun("gc", { now: new Date().toISOString() }),
  );
  return started ? json({ ran: true, runId: started.runId }) : json({ ran: false, reason: "locked" });
});
