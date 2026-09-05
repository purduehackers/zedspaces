import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve("scripts/dev-local-telemetry.sh");
const webDir = "/fixture/repo [one]/apps/web";
const flusher = "/fixture/node_modules/next/dist/telemetry/detached-flush.js";
const matching = `/fixture/bin/node ${flusher} dev ${webDir} _events_123.json`;

function reap(options: { command?: string; comm?: string; nextPid?: string; afterTerm?: string } = {}) {
  // All process discovery, signaling and sleeps are shell functions. No real process is
  // inspected or signaled by this harness, including the owner stack or this test's PID.
  return execFileSync("bash", ["-c", `
    set -euo pipefail
    source "$1"
    after_term=0
    ps() {
      if [ "$1" = -axww ]; then
        printf '4321 %s\\n' "$TEST_COMMAND"
      elif [ "$1" = -p ]; then
        printf '%s\\n' "$TEST_COMM"
      elif [ "$after_term" = 1 ]; then
        printf '%s\\n' "$TEST_AFTER_TERM"
      else
        printf '%s\\n' "$TEST_COMMAND"
      fi
    }
    kill() { printf '%s\\n' "$*"; after_term=1; }
    sleep() { :; }
    log() { :; }
    stop_next_telemetry "$TEST_NEXT_PID" "$TEST_WEB_DIR"
  `, "telemetry-test", helper], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_COMMAND: options.command ?? matching,
      TEST_COMM: options.comm ?? "/fixture/bin/node",
      TEST_NEXT_PID: options.nextPid ?? "123",
      TEST_AFTER_TERM: options.afterTerm ?? matching,
      TEST_WEB_DIR: webDir,
    },
  }).trim().split("\n").filter(Boolean);
}

describe("dev-local detached telemetry cleanup", () => {
  it("reaps only its exact Next PID's flusher with TERM then KILL", () => {
    expect(reap()).toEqual(["-s TERM 4321", "-s KILL 4321"]);
  });

  it.each([
    matching.replace("_events_123.json", "_events_74710.json"),
    matching.replace(webDir, `${webDir}-other`),
    matching.replace(webDir, "/other/repo/apps/web"),
    matching.replace("_events_123.json", "_events_1230.json"),
    `${matching}.backup`,
    `${matching} extra-argument`,
    matching.replace("detached-flush.js", "other-helper.js"),
    matching.replace(" dev ", " build "),
  ])("preserves an unrelated command: %s", (command) => {
    expect(reap({ command })).toEqual([]);
  });

  it.each(["", "0", "1", "-123", "123.*"])("does nothing without a valid recorded Next PID: %s", (nextPid) => {
    expect(reap({ nextPid })).toEqual([]);
  });

  it("does not signal a non-Node process containing matching text", () => {
    expect(reap({ comm: "/bin/bash" })).toEqual([]);
  });

  it("revalidates ownership after TERM before escalating to KILL", () => {
    expect(reap({ afterTerm: matching.replace("_events_123.json", "_events_74710.json") })).toEqual(["-s TERM 4321"]);
  });

  it("does not escalate after the flusher exits", () => {
    expect(reap({ afterTerm: "" })).toEqual(["-s TERM 4321"]);
  });
});
