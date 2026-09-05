import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { _resetDbForTests } from "@/lib/db";
import { _resetEnvForTests } from "@/lib/env";
import { kv, _resetKvForTests, withLock, sweepExpiredKv } from "@/lib/kv";
import { limit, _resetRatelimitForTests } from "@/lib/ratelimit";

describe.each(["sql", "memory"])("%s KV", (driver) => {
  let now = 100_000;
  beforeEach(() => {
    now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    process.env.ZS_KV = driver;
    process.env.ZS_DB_URL = ":memory:";
    _resetEnvForTests(); _resetDbForTests(); _resetKvForTests(); _resetRatelimitForTests();
  });
  afterEach(() => { vi.restoreAllMocks(); _resetDbForTests(); });

  it("atomically admits one NX holder and increments every concurrent counter", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => kv().set("lock", String(i), { nx: true, exMs: 100 })));
    expect(results.filter(Boolean)).toHaveLength(1);
    await Promise.all(Array.from({ length: 50 }, () => kv().incr("counter", 100)));
    expect(await kv().get("counter")).toBe("50");
    now += 100;
    expect(await kv().get("lock")).toBeNull();
    expect(await kv().incrBy("counter", -2, 500)).toBe(-2);
    expect(await kv().set("lock", "new", { nx: true })).toBe(true);
  });

  it("keeps counter TTL from the first increment, and supports mget/expire", async () => {
    await kv().incrBy("n", 2, 100);
    now += 50;
    await kv().incrBy("n", -2, 1000);
    await kv().incrBy("n", 3, 1000);
    expect(await kv().mget(["missing", "n", "n"])).toEqual([null, "3", "3"]);
    now += 50;
    expect(await kv().get("n")).toBeNull();
    await kv().set("k", "v");
    await kv().expire("k", 20);
    now += 20;
    expect(await kv().get("k")).toBeNull();
  });

  it("never releases a successor's lock after its own lease expired", async () => {
    await withLock("lease", 10, async () => {
      now += 10;
      expect(await kv().set("lease", "successor", { nx: true, exMs: 100 })).toBe(true);
    });
    expect(await kv().get("lease")).toBe("successor");
  });

  it("treats an explicit zero TTL as immediate expiry", async () => {
    await kv().set("zero", "v", { exMs: 0 });
    expect(await kv().get("zero")).toBeNull();
    await kv().incr("zero", 0);
    expect(await kv().get("zero")).toBeNull();
    await sweepExpiredKv(now);
  });

  it("enforces the sliding window atomically across concurrent requests", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => limit("user.workspaces.create", "shared")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429 });
    now += 600_000;
    await expect(limit("user.workspaces.create", "shared")).resolves.toBeUndefined();
  });
});
