import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Unit and route tests. Two projects: `node` for everything that talks to the
 * database, KV or the sandbox, and `dom` (jsdom) for the editor shell's
 * component tests, which do not need a database. Workflow integration tests use
 * vitest.integration.config.mts.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` throws outside React Server Components; tests import server modules directly.
      "server-only": `${here}tests/helpers/server-only.ts`,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/*.e2e.test.ts", "**/node_modules/**", "**/.next/**"],
          setupFiles: ["tests/helpers/setup.ts"],
          // Allow crypto/workflow setup time on a loaded development machine.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "**/.next/**"],
          setupFiles: ["tests/helpers/dom-setup.ts"],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
