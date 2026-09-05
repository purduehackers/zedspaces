import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The browser end-to-end suite (BUILD-SPEC 13 "End to end"), driven by
 * `scripts/dev-local.sh browser`: a real control plane in local mode
 * (`ZS_AUTH_MODE=dev`, `ZS_SANDBOX_BACKEND=local`, `ZS_TEST_ROUTES=1`,
 * `ZS_LOCAL_RPC_PROXY=1`), a real supervisor and `zed-remote-server serve`
 * per workspace, and the test-hooks wasm bundle (`script/build-web
 * --test-hooks`, `window.__zs_test`) the shell page loads. The script sets:
 *
 * - `ZS_E2E_BASE_URL`       the control plane origin (`http://127.0.0.1:3110`)
 * - `ZS_E2E_LOCAL_ROOT`     `ZS_LOCAL_ROOT` of the dev server
 * - `ZS_E2E_REPOS_DIR`      `ZS_LOCAL_REPOS_DIR` of the dev server (fixture repositories go here)
 * - `ZS_E2E_BUILD_ID`       the test-hooks bundle new workspaces load
 * - `ZS_E2E_LSP_TOOLS_BIN`  `node_modules/.bin` with the TypeScript language servers (optional)
 * - `ZS_E2E_CI=1`           CI reporters and one retry
 *
 * Nothing here sleeps for a fixed time: every wait is on a state the hooks or
 * the API report. One worker: the specs are serial and each creates its own
 * workspace (a supervisor and a server process each).
 *
 * Round 4 exercised all four projects together (docs/status/round4.md). The default local
 * and nightly CI selection remains `chromium` plus `smoke`; name all four explicitly for
 * the full matrix. Firefox and WebKit render through software WebGL2 in Playwright;
 * cross-origin isolation and wasm threads are exercised in those projects too. Their
 * boot/editor budgets are recorded, not asserted
 * (editor.spec.ts), unless `ZS_E2E_BOOT_BUDGET_MS_FIREFOX` / `_WEBKIT` /
 * `ZS_E2E_EDITOR_BUDGET_MS_FIREFOX` / `_WEBKIT` set one.
 *
 * Not covered here yet (BUILD-SPEC 13 / 3.6 / 5.2 / 5.3 / 5.6, round-5 gaps): forwarding a
 * port and loading it, running a task, rebuild, IME/composition, clipboard, file
 * upload/download through `/files`, extensions.
 */
// Playwright loads this file as CommonJS (no "type": "module"), so `__dirname`, never `import.meta`.
const here = __dirname;
const webDir = path.resolve(here, "../..");
const ci = process.env.CI === "true" || process.env.ZS_E2E_CI === "1";

/**
 * Headless Chromium has no GPU by default. On macOS WebGPU on Metal is available headless and
 * boots the editor in about 4 s (docs/status/round3c.md) against about 12 s on SwiftShader,
 * which is what the boot budget is measured against; elsewhere software WebGL2 has to be
 * asked for explicitly. `ZS_E2E_CHROMIUM_ARGS` (space-separated) replaces either list.
 */
const chromiumArgs = process.env.ZS_E2E_CHROMIUM_ARGS
  ? process.env.ZS_E2E_CHROMIUM_ARGS.split(/\s+/).filter(Boolean)
  : process.platform === "darwin"
    ? ["--enable-unsafe-webgpu", "--use-angle=metal"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: here,
  testIgnore: ["fixtures/**"],
  fullyParallel: false,
  workers: 1,
  retries: ci ? 1 : 0,
  timeout: 6 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(webDir, "test-results/e2e-browser-report"), open: "never" }],
    ["json", { outputFile: path.join(webDir, "test-results/e2e-browser-results.json") }],
    ...(ci ? [["github"] as const] : []),
  ],
  outputDir: path.join(webDir, "test-results/e2e-browser"),
  use: {
    baseURL: process.env.ZS_E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1280, height: 800 },
    // Dev auth answers loopback requests only; every navigation is same-origin.
    ignoreHTTPSErrors: false,
  },
  // A project's `testIgnore` REPLACES the config-level one (Playwright takes the first of
  // project, config, []), so every project repeats `fixtures/**`: without it the fixture
  // repository and the language-server install under `fixtures/` are collected as tests.
  //
  // No project spreads a `devices[...]` preset: `Desktop Chrome` and `Desktop Firefox` pin a
  // `Windows NT 10.0` user agent, which makes `navigator.userAgentData.platform` "Windows" and
  // sends the D12 keymap test down the ctrl- family on every host, leaving the cmd- family
  // (`cmd-q: null`, `cmd-shift-[`/`]`, …) untested. With the browser's own user agent the run
  // exercises the family of the machine it runs on: cmd- on macOS, ctrl- on Linux CI.
  projects: [
    {
      name: "chromium",
      testIgnore: ["fixtures/**", "smoke.spec.ts"],
      use: { browserName: "chromium", launchOptions: { args: chromiumArgs } },
    },
    { name: "firefox", testIgnore: ["fixtures/**", "smoke.spec.ts"], use: { browserName: "firefox" } },
    { name: "webkit", testIgnore: ["fixtures/**", "smoke.spec.ts"], use: { browserName: "webkit" } },
    {
      // b7 §6 "Boot smoke" (smoke.spec.ts): the newest production bundle of
      // `public/editor/manifest.json` under its own static server and b7's dev harness, no
      // control plane (`pnpm test:browser` runs just this project). Chromium on SwiftShader, the
      // spec's own `test.use`.
      name: "smoke",
      testIgnore: ["fixtures/**"],
      testMatch: ["smoke.spec.ts"],
      use: { browserName: "chromium" },
    },
  ],
});
