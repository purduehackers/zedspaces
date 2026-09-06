import { randomUUID } from "node:crypto";
import { dbReady } from "./db";

/**
 * The small key-value interface every lock and counter in the system goes
 * through. libSQL in both production and local development.
 */
export interface KV {
  get(key: string): Promise<string | null>;
  /** Returns `false` when `nx` is set and the key already exists. */
  set(key: string, value: string, opts?: { exMs?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Atomic owner-checked release. */
  compareDelete(key: string, value: string): Promise<void>;
  /** Increments and, on the first increment, applies `exMs` as the TTL. */
  incr(key: string, exMs?: number): Promise<number>;
  /** Adds `delta` (negative allowed) and, when the key is created by this call, applies `exMs` as the TTL. */
  incrBy(key: string, delta: number, exMs?: number): Promise<number>;
  /** Sets or refreshes the TTL of an existing key; a missing key is left alone. */
  expire(key: string, exMs: number): Promise<void>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

/** One SQL statement (or atomic batch) per operation, shared across Vercel instances. */
export class SqlKv implements KV {
  private async run(sql: string, args: import("@libsql/client").InValue[]) {
    return (await dbReady()).$client.execute({ sql, args });
  }
  async get(key: string): Promise<string | null> {
    const r = await this.run("SELECT value FROM kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)", [key, Date.now()]);
    return r.rows[0] ? String(r.rows[0].value) : null;
  }
  async set(key: string, value: string, opts?: { exMs?: number; nx?: boolean }): Promise<boolean> {
    const now = Date.now();
    const r = await this.run(
      "INSERT INTO kv (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at" +
      (opts?.nx ? " WHERE kv.expires_at IS NOT NULL AND kv.expires_at<=?" : ""),
      [key, value, opts?.exMs !== undefined ? now + opts.exMs : null, ...(opts?.nx ? [now] : [])]);
    return r.rowsAffected > 0;
  }
  async del(key: string): Promise<void> {
    await this.run("DELETE FROM kv WHERE key=?", [key]);
  }
  async compareDelete(key: string, value: string): Promise<void> {
    await this.run("DELETE FROM kv WHERE key=? AND value=?", [key, value]);
  }
  async incr(key: string, exMs?: number): Promise<number> { return this.incrBy(key, 1, exMs); }
  async incrBy(key: string, delta: number, exMs?: number): Promise<number> {
    const now = Date.now();
    const r = await this.run(`INSERT INTO kv (key,value,expires_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET
        value=CAST(CAST(CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at<=?
          THEN ? ELSE CAST(kv.value AS INTEGER)+? END AS INTEGER) AS TEXT),
        expires_at=CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at<=?
          THEN excluded.expires_at ELSE kv.expires_at END RETURNING value`,
      [key, String(delta), exMs !== undefined ? now + exMs : null, now, delta, delta, now]);
    return Number(r.rows[0].value);
  }
  async expire(key: string, exMs: number): Promise<void> {
    const now = Date.now();
    await this.run("UPDATE kv SET expires_at=? WHERE key=? AND (expires_at IS NULL OR expires_at>?)", [now + exMs, key, now]);
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    const values = new Map<string, string>();
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const r = await this.run("SELECT key,value FROM kv WHERE key IN (" + chunk.map(() => "?").join(",") +
        ") AND (expires_at IS NULL OR expires_at>?)", [...chunk, Date.now()]);
      for (const row of r.rows) values.set(String(row.key), String(row.value));
    }
    return keys.map((key) => values.get(key) ?? null);
  }
}

/** Reads enforce expiry immediately; cron also reclaims abandoned rows. */
export async function sweepExpiredKv(now = Date.now()): Promise<void> {
  await (await dbReady()).$client.execute({ sql: "DELETE FROM kv WHERE expires_at<=?", args: [now] });
}
let kvInstance: KV | null = null;

/** Shared SQL KV. */
export function kv(): KV {
  if (kvInstance) return kvInstance;
  kvInstance = new SqlKv();
  return kvInstance;
}

/**
 * Runs `fn` while holding `SET NX PX` lock `key` for `ttlMs`. Resolves to
 * `undefined` without running `fn` when another holder has the lock.
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  const store = kv();
  const token = randomUUID();
  const acquired = await store.set(key, token, { nx: true, exMs: ttlMs });
  if (!acquired) return undefined;
  try {
    return await fn();
  } finally {
    // Release only our own lock; an expired-and-reacquired key belongs to someone else.
    await store.compareDelete(key, token);
  }
}

/** Every shared KV key the control plane uses. */
export const keys = {
  /** Last input unix ms (from activity pings). */
  activity: (ws: string) => `zs:activity:${ws}`,
  /** Last activity ping unix ms (TTL 120 s). */
  health: (ws: string) => `zs:health:${ws}`,
  /** Consecutive pings with no session and >80 % CPU (abuse rule, §4.10). */
  cpu: (ws: string) => `zs:cpu:${ws}`,
  /** JSON number[] from the last activity ping's listening[]. */
  listening: (ws: string) => `zs:listening:${ws}`,
  /** "<phase>" while the last ping reported busy || phase !== "ready" (D13; TTL 120 s). */
  busy: (ws: string) => `zs:busy:${ws}`,
  /** Keepalive unix ms (TTL idleMinutes). */
  keepalive: (ws: string) => `zs:keepalive:${ws}`,
  lock: (name: string) => `zs:lock:${name}`,
  /** Idempotency-Key → cached response (24 h). */
  idem: (userId: string, key: string) => `zs:idem:${userId}:${key}`,
  /** Child-run token → run id, so a retried step never starts a second child (workflows/child.ts). */
  childRun: (token: string) => `zs:child:${token}`,
} as const;
