import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleProblems, deploymentProblems } from "../scripts/deploy-preflight";

const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const good = {
  TURSO_DATABASE_URL: "libsql://wed.turso.io", TURSO_AUTH_TOKEN: "example",
  ZS_CONTROL_URL: "https://wed.example/api", ZS_JWT_PRIVATE_KEY: key,
  ZS_EDITOR_COOKIE_SECRET: Buffer.alloc(32, 1).toString("base64"),
  CRON_SECRET: "example-cron-secret", ZS_CLIENT_BUILD_ID: "commit-123", ZS_SERVER_BUILD_ID: "commit-123",
  ZS_IMAGE_REF: `vcr.vercel.com/team/project/workspace@sha256:${"a".repeat(64)}`,
  ZS_EDITOR_BUNDLE_SOURCE: "https://assets.example", ZS_EDITOR_BUNDLES: "commit-123",
  BLOB_READ_WRITE_TOKEN: "example",
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("deployment preflight (no external calls)", () => {
  it("accepts real-backend configuration without GitHub, Clerk or Redis credentials", () => {
    expect(deploymentProblems(good)).toEqual([]);
    expect(deploymentProblems({}).length).toBeGreaterThan(10);
  });
  it("refuses ephemeral storage and test/local backends", () => {
    for (const overrides of [{ TURSO_DATABASE_URL: "file:/tmp/db" }, { ZS_KV: "memory" },
      { ZS_SANDBOX_BACKEND: "local" }, { ZS_SANDBOX_DRIVER: "fake" }, { ZS_BLOB_DRIVER: "memory" },
      { ZS_TEST_ROUTES: "1" }, { ZS_ALLOW_TEST_BUNDLE: "1" }]) {
      expect(deploymentProblems({ ...good, ...overrides }).length).toBeGreaterThan(0);
    }
  });
  it("refuses stale/mismatched/test bundle IDs and unpinned images", () => {
    for (const overrides of [{ ZS_SERVER_BUILD_ID: "other-1" }, { ZS_CLIENT_BUILD_ID: "dev-0" },
      { ZS_CLIENT_BUILD_ID: "commit-123-test" }, { ZS_EDITOR_BUNDLES: "other-1" }, { ZS_IMAGE_REF: "zs-workspace:dev-0" }]) {
      expect(deploymentProblems({ ...good, ...overrides }).length).toBeGreaterThan(0);
    }
  });
  it("validates secret shapes and public callback URLs without printing secret values", () => {
    for (const overrides of [{ ZS_JWT_PRIVATE_KEY: "bad" }, { ZS_EDITOR_COOKIE_SECRET: "short" },
      { CRON_SECRET: "short" }, { ZS_CONTROL_URL: "http://localhost:3000/api" },
      { ZS_CONTROL_URL: "https://wed.example/not-api" }, { ZS_EDITOR_BUNDLE_SOURCE: "https://u:p@assets.example" }]) {
      expect(deploymentProblems({ ...good, ...overrides }).length).toBeGreaterThan(0);
    }
  });
  it("does not require custom-image builder credentials", () => {
    expect(deploymentProblems(good)).toEqual([]);
    expect(deploymentProblems(good).some((problem) => problem.includes("BUILDER"))).toBe(false);
  });
  it("checks actual bundle metadata, WASM bytes, missing assets, and test hooks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wed-preflight-")); dirs.push(dir);
    const root = path.join(dir, "commit-123"); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "zed_web.js"), "// real glue");
    fs.writeFileSync(path.join(root, "zed-assets.tar"), "assets");
    fs.writeFileSync(path.join(root, "zed_web_bg.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const meta = { build_id: "commit-123", test_hooks: false, wasm_bytes: 8 };
    fs.writeFileSync(path.join(root, "build.json"), JSON.stringify(meta));
    expect(bundleProblems(dir, ["commit-123"])).toEqual([]);
    fs.writeFileSync(path.join(root, "build.json"), JSON.stringify({ ...meta, test_hooks: true }));
    expect(bundleProblems(dir, ["commit-123"]).join()).toContain("test_hooks");
    expect(bundleProblems(dir, ["missing"]).length).toBe(1);
    fs.writeFileSync(path.join(root, "build.json"), JSON.stringify(meta));
    fs.writeFileSync(path.join(root, "zed_web_bg.wasm"), "wasm stub");
    expect(bundleProblems(dir, ["commit-123"]).join()).toContain("WebAssembly header");
  });
});
