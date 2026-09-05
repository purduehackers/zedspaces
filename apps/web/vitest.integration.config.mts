import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Workflow integration tests (`*.integration.test.ts`): `@workflow/vitest`
 * builds the workflow and step bundles and runs them in-process. No
 * `vi.mock` here – fakes are selected through the environment
 * (`ZS_SANDBOX_DRIVER=fake`, `ZS_REDIS=memory`, `ZS_DB_DRIVER=pglite`).
 */
/**
 * Appends `tests/helpers/workflow-bundle-fix.ts` to `globalSetup` *after* the
 * workflow plugin's own build step, so the emitted bundles are patched for
 * Node's JSON import attributes before any worker imports them.
 */
const jsonImportAttributes = {
  name: "zs:workflow-json-import-attributes",
  config: () => ({ test: { globalSetup: [`${here}tests/helpers/workflow-bundle-fix.ts`] } }),
};

export default defineConfig({
  plugins: [tsconfigPaths(), ...workflow({ cwd: here, rootDir: here }), jsonImportAttributes],
  resolve: {
    alias: {
      "server-only": `${here}tests/helpers/server-only.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    testTimeout: 60_000,
    // PGlite boots a WASM Postgres and migrates it inside `beforeEach`.
    hookTimeout: 60_000,
    passWithNoTests: true,
  },
});
