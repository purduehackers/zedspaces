import fs from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";

/**
 * Vitest `globalSetup` for the workflow integration config, run right after
 * `@workflow/vitest` has built `.workflow-vitest/{workflows,steps}.mjs`.
 *
 * `@workflow/builders` externalizes `node_modules` JSON files as plain
 * relative imports (`import x from "…/builtin-modules.json";`). Node 22+
 * refuses to load a JSON module without `with { type: "json" }`
 * (`ERR_IMPORT_ATTRIBUTE_MISSING`), which left the whole suite unrunnable.
 * Until the builder emits the attribute itself, this rewrites those imports
 * in the emitted bundles. It only touches `.json` specifiers and is a no-op
 * once the upstream fix lands.
 */
export async function setup(project: TestProject): Promise<void> {
  const outDir = path.resolve(project.config.root, ".workflow-vitest");
  for (const name of ["workflows.mjs", "steps.mjs"]) {
    const file = path.join(outDir, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const patched = source.replace(
      /^(import\s+[^;'"]+?\s+from\s+["'][^"']+\.json["'])(\s*;)/gm,
      (_match, statement: string, terminator: string) => `${statement} with { type: "json" }${terminator}`,
    );
    if (patched !== source) fs.writeFileSync(file, patched);
  }
}
