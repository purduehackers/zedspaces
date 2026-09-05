import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertBuildId, assertServableBuild, isTestBuildId, pruneBundles, SERVED_FILES, unpackBundle } from "../scripts/fetch-editor-bundle";

const scratch: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zs-bundle-test-"));
  scratch.push(dir);
  return dir;
}

/** Packs b7's bundle layout (served files plus the dev harness) as `editor/<build>.tar`. */
function packBundle(build: string, buildId = build, testHooks = false): string {
  const src = tmpDir();
  const root = path.join(src, build);
  fs.mkdirSync(root);
  for (const file of SERVED_FILES) {
    if (file === "build.json") continue;
    fs.writeFileSync(path.join(root, file), `${file} of ${build}`);
  }
  fs.writeFileSync(path.join(root, "build.json"), JSON.stringify({ build_id: buildId, commit: "abc", wasm_bytes: 1, test_hooks: testHooks }));
  fs.writeFileSync(path.join(root, "index.html"), "<html>dev harness</html>");
  fs.writeFileSync(path.join(root, "loader.js"), "// dev harness");
  const tar = path.join(src, `${build}.tar`);
  execFileSync("tar", ["-cf", tar, "-C", src, build]);
  return tar;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scripts/fetch-editor-bundle (b9 §3.30)", () => {
  it("unpacks only the served files and drops b7's dev harness", () => {
    const tar = packBundle("c3cf80c-42");
    const dest = path.join(tmpDir(), "c3cf80c-42");
    unpackBundle(tar, dest, "c3cf80c-42");
    expect(fs.readdirSync(dest).sort()).toEqual([...SERVED_FILES].sort());
    expect(fs.readFileSync(path.join(dest, "zed_web.js"), "utf8")).toBe("zed_web.js of c3cf80c-42");
  });

  it("refuses a tar whose build.json names another build", () => {
    const tar = packBundle("c3cf80c-42", "c3cf80c-41");
    const dest = path.join(tmpDir(), "c3cf80c-42");
    expect(() => unpackBundle(tar, dest, "c3cf80c-42")).toThrow(/build_id/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("prunes bundles outside the keep set but never a local dev-* placeholder", () => {
    const dir = tmpDir();
    for (const name of ["a-1", "a-2", "a-3", "dev-0"]) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
    const removed = pruneBundles(dir, new Set(["a-1", "a-2"]));
    expect(removed).toEqual(["a-3"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["a-1", "a-2", "dev-0", "manifest.json"]);
  });

  it("only accepts path-safe build ids", () => {
    expect(assertBuildId("c3cf80c-42")).toBe("c3cf80c-42");
    expect(() => assertBuildId("../etc")).toThrow(/invalid build id/);
    expect(() => assertBuildId("")).toThrow(/invalid build id/);
  });

  it("names a test-hooks bundle by its id suffix", () => {
    expect(isTestBuildId("c3cf80c-42-test")).toBe(true);
    expect(isTestBuildId("c3cf80c-42-test-names")).toBe(true);
    expect(isTestBuildId("c3cf80c-42")).toBe(false);
    expect(isTestBuildId("c3cf80c-42-names")).toBe(false);
    expect(isTestBuildId("c3cf80c-42-testing")).toBe(false);
  });

  it("refuses a test-hooks bundle for delivery unless ZS_ALLOW_TEST_BUNDLE=1", () => {
    expect(() => assertServableBuild("c3cf80c-42-test", undefined, false)).toThrow(/test-hooks bundle/);
    expect(() => assertServableBuild("c3cf80c-42-test-names", undefined, false)).toThrow(/test-hooks bundle/);
    expect(() => assertServableBuild("c3cf80c-42", { test_hooks: true }, false)).toThrow(/test_hooks: true/);
    expect(assertServableBuild("c3cf80c-42", { test_hooks: false }, false)).toBe("c3cf80c-42");
    expect(assertServableBuild("c3cf80c-42", undefined, false)).toBe("c3cf80c-42");
    expect(assertServableBuild("c3cf80c-42-test", { test_hooks: true }, true)).toBe("c3cf80c-42-test");
  });

  it("refuses to unpack a tar whose build.json says test_hooks: true", () => {
    const tar = packBundle("c3cf80c-42", "c3cf80c-42", true);
    const dest = path.join(tmpDir(), "c3cf80c-42");
    const saved = process.env.ZS_ALLOW_TEST_BUNDLE;
    delete process.env.ZS_ALLOW_TEST_BUNDLE;
    try {
      expect(() => unpackBundle(tar, dest, "c3cf80c-42")).toThrow(/test_hooks: true/);
      expect(fs.existsSync(dest)).toBe(false);
      const testTar = packBundle("c3cf80c-42-test", "c3cf80c-42-test", true);
      expect(() => unpackBundle(testTar, path.join(tmpDir(), "c3cf80c-42-test"), "c3cf80c-42-test")).toThrow(/test-hooks bundle/);
    } finally {
      if (saved === undefined) delete process.env.ZS_ALLOW_TEST_BUNDLE;
      else process.env.ZS_ALLOW_TEST_BUNDLE = saved;
    }
  });
});
