import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const appDir = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The native end-to-end suite (`tests/e2e-native/flow.test.ts`): a real
 * control plane (`next dev` with `ZS_SANDBOX_BACKEND=local`), a real
 * supervisor, a real `zed-remote-server serve` and the native Rust client.
 * Started by `scripts/dev-local.sh e2e`, which sets `ZS_E2E_BASE_URL`; no
 * fakes, no setup file, one worker.
 */
export default defineConfig({
  root: appDir,
  plugins: [tsconfigPaths({ root: appDir })],
  test: {
    environment: "node",
    include: ["tests/e2e-native/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 25 * 60_000,
    hookTimeout: 5 * 60_000,
    passWithNoTests: false,
  },
});
