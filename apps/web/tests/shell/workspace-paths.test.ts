import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetEnvForTests } from "@/lib/env";
import { workspacePaths, workspacePathsFor } from "@/lib/shell";

/**
 * The path the shell hands the wasm client as `ZsBootConfig.workspace.paths`.
 * The client keys its persisted layout — and the D6 unsaved-buffer snapshot
 * under it — on the worktree's absolute path as the server canonicalises it,
 * so on the local backend the path must already be canonical: macOS's
 * `$TMPDIR` lives under `/var`, a symlink to `/private/var`, and a path
 * through the symlink never matched the previous session's row (every resume
 * came back with an empty layout and no unsaved buffers).
 */

const saved: Record<string, string | undefined> = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zs-shell-paths-"));

beforeEach(() => {
  for (const key of ["ZS_SANDBOX_BACKEND", "ZS_LOCAL_ROOT"]) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
  _resetEnvForTests();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("workspacePathsFor", () => {
  it("is the sandbox checkout on the Vercel backend", () => {
    process.env.ZS_SANDBOX_BACKEND = "vercel";
    _resetEnvForTests();
    expect(workspacePathsFor({ sandboxName: "sb-x" }, { name: "demo" })).toEqual(workspacePaths({ name: "demo" }));
    expect(workspacePaths({ name: "demo" })).toEqual(["/workspaces/demo"]);
  });

  it("is the relocated checkout in canonical form on the local backend", () => {
    const root = path.join(tmp, "sandboxes");
    const checkout = path.join(root, "sb-x", "workspaces", "demo");
    fs.mkdirSync(checkout, { recursive: true });
    process.env.ZS_SANDBOX_BACKEND = "local";
    process.env.ZS_LOCAL_ROOT = root;
    _resetEnvForTests();
    const [handed] = workspacePathsFor({ sandboxName: "sb-x" }, { name: "demo" });
    expect(handed).toBe(fs.realpathSync.native(checkout));
    // The canonical form has no symlink left to resolve.
    expect(fs.realpathSync.native(handed)).toBe(handed);
  });

  it("resolves a symlinked local root to its target", () => {
    const target = path.join(tmp, "real-root");
    const link = path.join(tmp, "linked-root");
    fs.mkdirSync(path.join(target, "sb-y", "workspaces", "demo"), { recursive: true });
    fs.symlinkSync(target, link);
    process.env.ZS_SANDBOX_BACKEND = "local";
    process.env.ZS_LOCAL_ROOT = link;
    _resetEnvForTests();
    const [handed] = workspacePathsFor({ sandboxName: "sb-y" }, { name: "demo" });
    expect(handed).toBe(fs.realpathSync.native(path.join(target, "sb-y", "workspaces", "demo")));
    expect(handed.startsWith(fs.realpathSync.native(link))).toBe(true);
  });

  it("hands back the relocated path unchanged while the checkout does not exist yet", () => {
    process.env.ZS_SANDBOX_BACKEND = "local";
    process.env.ZS_LOCAL_ROOT = path.join(tmp, "missing");
    _resetEnvForTests();
    expect(workspacePathsFor({ sandboxName: "sb-z" }, { name: "demo" })).toEqual([
      path.join(tmp, "missing", "sb-z", "workspaces", "demo"),
    ]);
  });
});
