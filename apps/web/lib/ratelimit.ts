import { dbReady } from "./db";
import { sql } from "drizzle-orm";
import { ApiError } from "./api";
export type LimitName = keyof typeof LIMITS;

/** Sliding-window budgets: `tokens` requests per `windowSec`. */
export const LIMITS = {
  "sandbox.manifest": { tokens: 60, windowSec: 60 },
  "sandbox.git-token": { tokens: 30, windowSec: 60 },
  "sandbox.ports": { tokens: 30, windowSec: 60 },
  "sandbox.activity": { tokens: 40, windowSec: 60 },
  "sandbox.logs": { tokens: 120, windowSec: 60 },
  "sandbox.client-errors": { tokens: 60, windowSec: 60 },
  "sandbox.extensions": { tokens: 30, windowSec: 60 },
  /** Per client ip: unauthenticated calls to `/api/sandboxes/*` (a real supervisor never fails auth). */
  "sandbox.auth-failures": { tokens: 20, windowSec: 60 },
  "user.workspaces.create": { tokens: 10, windowSec: 600 },
  "user.connect": { tokens: 60, windowSec: 60 },
  "user.keepalive": { tokens: 30, windowSec: 60 },
  "user.export": { tokens: 3, windowSec: 60 },
  "user.client-errors": { tokens: 60, windowSec: 60 },
  "user.repos": { tokens: 30, windowSec: 60 },
} satisfies Record<string, { tokens: number; windowSec: number }>;

function rateLimited(retryAfterSec: number): ApiError {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSec));
  return new ApiError(429, "rate_limited", "Too many requests", { retryAfterSec: retryAfter }, {
    "Retry-After": String(retryAfter),
  });
}

/**
 * Consumes one token of `name` for `subject` (a user id, sandbox name or
 * ip). Throws `ApiError(429, "rate_limited")` carrying `Retry-After` when the
 * window is exhausted.
 */
export async function limit(name: LimitName, subject: string): Promise<void> {
  const { tokens, windowSec } = LIMITS[name];
  // libSQL write transactions serialize this read/modify/write across instances.
  const db = await dbReady();
  await db.transaction(async (tx) => {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const key = `zs:rl:${name}:${subject}`;
    const rows = await tx.all<{ value: string }>(sql`SELECT value FROM kv WHERE key=${key} AND expires_at>${now}`);
    const hits = (rows[0] ? JSON.parse(rows[0].value) as number[] : []).filter((at) => at > now - windowMs);
    if (hits.length >= tokens) throw rateLimited((hits[0] + windowMs - now) / 1000);
    hits.push(now);
    await tx.run(sql`INSERT INTO kv (key,value,expires_at) VALUES (${key},${JSON.stringify(hits)},${now + windowMs})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`);
  });
}
