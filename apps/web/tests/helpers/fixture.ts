import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shared manifest fixture both b8 and b9 pin the contract with (D19):
 * `docs/contracts/fixtures/manifest.example.json` at the monorepo root — never
 * a local copy. A missing file fails the suite loudly rather than skipping.
 */
export const MANIFEST_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "docs",
  "contracts",
  "fixtures",
  "manifest.example.json",
);

/** Reads and parses the fixture; throws a descriptive error naming the path when it is absent. */
export function loadManifestFixture(): unknown {
  if (!fs.existsSync(MANIFEST_FIXTURE_PATH)) {
    throw new Error(
      `The shared manifest fixture is missing at ${MANIFEST_FIXTURE_PATH} (D19: b8 §3.26 creates it from b9 §4.7)`,
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST_FIXTURE_PATH, "utf8")) as unknown;
}
