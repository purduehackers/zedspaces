import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseConfig, dbReady, _resetDbForTests } from "@/lib/db";
import { _resetEnvForTests } from "@/lib/env";
const remote = vi.hoisted(() => {
  // The global test setup imports db.ts before this file's mocks are registered.
  vi.resetModules();
  return { enabled: 1, execute: vi.fn(), close: vi.fn() };
});
vi.mock("@libsql/client", async (original) => {
  const actual = await original<typeof import("@libsql/client")>();
  return { ...actual, createClient: (config: import("@libsql/client").Config) =>
    config.url.startsWith("libsql:") ? { protocol: "http", execute: remote.execute, close: remote.close } : actual.createClient(config) };
});
beforeEach(() => {
  _resetDbForTests();
  process.env.VERCEL_ENV = "production";
  process.env.TURSO_DATABASE_URL = "libsql://db.example.invalid";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  _resetEnvForTests();
  remote.enabled = 1;
  remote.execute.mockReset().mockImplementation(async () => ({ rows: [{ foreign_keys: remote.enabled }] }));
});

describe("remote database invariants", () => {
  it("requires remote persistent storage and a credential on Vercel", () => {
    process.env.TURSO_DATABASE_URL = "file:/tmp/db"; _resetEnvForTests();
    expect(databaseConfig).toThrow(/remote Turso/);
    delete process.env.TURSO_DATABASE_URL; _resetEnvForTests();
    expect(databaseConfig).toThrow(/TURSO_DATABASE_URL/);
    process.env.TURSO_DATABASE_URL = "libsql://db.example.invalid";
    delete process.env.TURSO_AUTH_TOKEN; _resetEnvForTests();
    expect(databaseConfig).toThrow(/TURSO_AUTH_TOKEN/);
  });
  it("verifies default foreign-key enforcement instead of setting a transient connection PRAGMA", async () => {
    await dbReady();
    expect(remote.execute.mock.calls).toEqual([["PRAGMA foreign_keys"]]);
  });
  it("fails closed when remote foreign keys are off and permits a later retry", async () => {
    remote.enabled = 0;
    await expect(dbReady()).rejects.toThrow(/foreign keys/);
    remote.enabled = 1;
    await expect(dbReady()).resolves.toBeDefined();
    expect(remote.execute).toHaveBeenCalledTimes(2);
  });
});
