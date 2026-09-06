import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve("../../.github/scripts/build-metrics.sh");

describe("CI build resource wrapper", () => {
  it.each([0, 17])("preserves command exit %s and reaps its monitor promptly", status => {
    const dir = mkdtempSync(path.join(tmpdir(), "zs-build-metrics-"));
    try {
      const result = spawnSync("bash", ["-c", `
        free() { printf 'fixture memory\\n'; }
        export -f free
        bash "$1" bash -c 'exit "$1"' build-command "$2"
      `, "metrics-test", helper, String(status)], { cwd: dir, encoding: "utf8", timeout: 3000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      expect(readFileSync(path.join(dir, "build-resources.log"), "utf8")).toContain("fixture memory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
