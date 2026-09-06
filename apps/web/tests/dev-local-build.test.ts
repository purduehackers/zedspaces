import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync("scripts/dev-local.sh", "utf8");
const buildAll = script.match(/^build_all\(\) \{[\s\S]*?^\}/m)![0];

function build(mode: string, fail = "", skip = false) {
  // Run the actual build function. Stub every build/filesystem operation: no Rust
  // compilation or writes to the owner's server binaries happen in these tests.
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, MODE: mode, FAIL_BUILD: fail, ZS_SKIP_BUILD: skip ? "1" : "0", ZS_SERVER_BUILD_ID: "dev-ci" },
    input: `set -euo pipefail
      SUPERVISOR_DIR=/fixture/supervisor
      ZED_DIR=/fixture/zed
      SERVE_STASH=/fixture/stash
      AGENT_BIN=/bin/bash
      ZS_BUILD_ID=none
      log() { :; }
      die() { printf '%s\\n' "$*" >&2; exit 1; }
      cd() { :; }
      mkdir() { :; }
      rm() { :; }
      cp() { printf 'copy\\n'; }
      uname() { printf 'Linux\\n'; }
      check_serve_bin() { printf 'check-server\\n'; }
      serve_bin_is_test_build() { [ "$FAIL_BUILD" = test-only ]; }
      cargo() {
        printf 'cargo:%s:%s\\n' "$ZS_BUILD_ID" "$*"
        case "$*" in
          'build --locked') stage=agent ;;
          'build --locked -p remote_server --features serve') stage=server ;;
          'test --locked -p remote --test native_e2e --no-run') stage=native ;;
          *) exit 99 ;;
        esac
        [ "$FAIL_BUILD" != "$stage" ]
      }
      ${buildAll}
      build_all
    `,
  });
}

describe("local build selection and failure handling", () => {
  it.each(["browser", "dev"])("%s builds only the two runtime binaries", mode => {
    const result = build(mode);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cargo:dev-ci:build --locked -p remote_server --features serve");
    expect(result.stdout).not.toContain("native_e2e");
    expect(result.stdout).toContain("copy\ncheck-server");
  });
  it.each(["e2e", "build"])("%s also builds the native test", mode => {
    const result = build(mode);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("test --locked -p remote --test native_e2e --no-run");
  });
  it.each(["agent", "server", "test-only"])("stops on %s failure without using or replacing the stash", failure => {
    const result = build("browser", failure);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("copy");
    expect(result.stdout).not.toContain("check-server");
  });
  it("fails when the requested native test cannot build", () => {
    expect(build("e2e", "native").status).toBe(1);
  });
  it("uses an existing binary only when explicitly asked to skip builds", () => {
    const result = build("browser", "", true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("check-server\n");
  });
});
