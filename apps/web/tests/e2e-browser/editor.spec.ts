/**
 * Editing in the browser (BUILD-SPEC 13 "End to end", one workspace shared by
 * the serial cases below): boot to an editable buffer under the local budget,
 * edit and save to disk, completions from a TypeScript language server, a
 * remote terminal (a command, then a commit pushed to the fixture's origin),
 * the web keymap layer (D12), the two client-state flush triggers of D7 (the
 * hidden tab, the 15 s dirty timer), the lifecycle toasts (BUILD-SPEC 5.5)
 * driven through the server's control channel, a warm reconnect after the
 * server side drops the socket (D3/D24) and the `beforeunload` guard. Every wait
 * is on a state `window.__zs_test` or the API reports, or on a log of what
 * happened (`connectionEvents()`, `visibilityEvents()`, `clientStateEvents()`).
 */
import fs from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page, type Request, type Response } from "@playwright/test";
import {
  api,
  BASE_URL,
  checkoutDir,
  createFixtureRepo,
  createRunningWorkspace,
  destroyWorkspace,
  git,
  log,
  overlayPhase,
  postLifecycleNotice,
  recordTiming,
  testLocal,
  testLocalOp,
  typescriptLanguageServerOnPath,
  watchPage,
  type FixtureRepo,
  type PageLog,
  type WorkspaceView,
} from "./control-plane";
import { hooks, pollUntil, untilOrPanic, waitForHooks, type ZsTestHooks } from "./hooks";

/**
 * Boot budgets. The editor's own leg (hooks installed, i.e. the wasm is delivered, compiled and
 * `start()` running, → the first buffer editable) is what BUILD-SPEC 3.4's "warm" condition
 * measures and it does not depend on how the bundle was served, so it carries the hard
 * assertion: 10 s on Chromium (WebGPU on Metal, or SwiftShader elsewhere). Firefox and WebKit
 * are validated too (docs/status/round4.md), but software WebGL2 has a different timing profile:
 * their leg is recorded unless the environment names a budget
 * (`ZS_E2E_EDITOR_BUDGET_MS`, `..._FIREFOX`, `..._WEBKIT`). The whole navigation-to-editable
 * figure is dominated by the 75 MB wasm the local `next dev` serves `no-store` on every
 * navigation (next.config.ts), so it is asserted only against a budget the environment sets
 * explicitly (`ZS_E2E_BOOT_BUDGET_MS`, which `scripts/dev-local.sh browser` sets to the lane's
 * 15 s local bar with its reason; `ZS_E2E_BOOT_BUDGET_MS_FIREFOX`/`_WEBKIT` per project) and is
 * otherwise recorded for the status doc.
 */
function editorBudgetMs(project: string): number | null {
  const perProject = process.env[`ZS_E2E_EDITOR_BUDGET_MS_${project.toUpperCase()}`];
  if (perProject) return Number(perProject);
  if (process.env.ZS_E2E_EDITOR_BUDGET_MS) return Number(process.env.ZS_E2E_EDITOR_BUDGET_MS);
  return project === "chromium" ? 10_000 : null;
}

function bootBudgetMs(project: string): number | null {
  const perProject = process.env[`ZS_E2E_BOOT_BUDGET_MS_${project.toUpperCase()}`];
  if (perProject) return Number(perProject);
  if (project === "chromium" && process.env.ZS_E2E_BOOT_BUDGET_MS) return Number(process.env.ZS_E2E_BOOT_BUDGET_MS);
  return null;
}

test.describe.configure({ mode: "serial" });
test.skip(!BASE_URL, "ZS_E2E_BASE_URL is not set: run through scripts/dev-local.sh browser");
// These are worker-scoped options: the reused contention case must share this suite's
// worker and workspace. Keep its console/network-only diagnostics for the whole file.
test.use({ screenshot: "off", trace: { mode: "retain-on-failure", screenshots: false } });

let fixture: FixtureRepo;
let workspace: WorkspaceView;
let workspaceDir: string;
let context: BrowserContext;
let page: Page;
let pageLog: PageLog;
let zs: ZsTestHooks;
let readme: string;

async function openEditorPage(browser: Browser): Promise<void> {
  context = await browser.newContext();
  page = await context.newPage();
  pageLog = watchPage(page);
  zs = hooks(page);
}

test.beforeAll(async ({ browser }) => {
  fixture = await createFixtureRepo("e2e-editor");
  log(`fixture local/${fixture.name} at ${fixture.dir}`);
  workspace = await createRunningWorkspace(fixture);
  const info = await testLocal(workspace.id);
  workspaceDir = checkoutDir(info);
  readme = `${workspaceDir}/README.md`;
  log(`workspace ${workspace.id}: checkout ${workspaceDir}, sandbox ${info.sandbox.dir} (rpc proxy ${JSON.stringify(info.sandbox.rpcProxy)})`);
  await warmDevServerRoutes();
  await openEditorPage(browser);
});

/**
 * `next dev` compiles a route on its first request (5-10 s for the editor document and
 * `/connect` on this machine) and serves a `public/` file cold the first time, which is
 * dev-server cost, not editor boot: the timed boot below runs against compiled routes and a
 * bundle the dev server has already read once, the "warm" condition of BUILD-SPEC 3.4. The
 * connect warm-up sends an invalid body (400) so no session is minted.
 */
async function warmDevServerRoutes(): Promise<void> {
  const startedAt = Date.now();
  const bundle = (file: string) =>
    fetch(`${BASE_URL}/editor/${encodeURIComponent(workspace.clientBuild)}/${file}`).then(async (r) => {
      if (!r.ok) throw new Error(`warm-up: ${file} answered HTTP ${r.status}`);
      await r.arrayBuffer();
      return r.headers.get("content-length");
    });
  const [, , , , buildJson, glue, wasm, assets] = await Promise.all([
    fetch(`${BASE_URL}/w/${workspace.id}`, { headers: { "sec-fetch-dest": "empty" } }).then((r) => r.text()),
    api("POST", `/api/workspaces/${workspace.id}/connect`, {}),
    api("GET", `/api/workspaces/${workspace.id}/settings`),
    api("GET", `/api/workspaces/${workspace.id}/keymap`),
    bundle("build.json"),
    bundle("zed_web.js"),
    bundle("zed_web_bg.wasm"),
    bundle("zed-assets.tar"),
  ]);
  log(
    `dev-server routes warmed in ${Date.now() - startedAt} ms (build.json ${buildJson} B, zed_web.js ${glue} B, zed_web_bg.wasm ${wasm} B, zed-assets.tar ${assets} B)`,
  );
}

test.afterAll(async () => {
  await context?.close().catch(() => undefined);
  if (workspace) await destroyWorkspace(workspace.id).catch((err: unknown) => log(`cleanup: ${String(err)}`));
  fixture?.remove();
});

// The page's console during each case (boot progress, warnings, errors) goes into the report,
// on failure too: it is the evidence a stalled boot or a panic is diagnosed from.
let consoleMark = 0;
test.beforeEach(() => {
  consoleMark = pageLog?.console.length ?? 0;
});
test.afterEach(async ({}, info) => {
  if (!pageLog) return;
  await info.attach("console", { body: pageLog.console.slice(consoleMark).join("\n"), contentType: "text/plain" });
});

interface WasmResourceTiming {
  durationMs: number;
  transferSize: number;
  decodedBodySize: number;
}

/** Resource-timing entries of the wasm fetch, so the delivery leg is reported on its own. */
async function wasmResourceTiming(): Promise<WasmResourceTiming[]> {
  return page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("zed_web_bg.wasm"))
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return { durationMs: Math.round(resource.duration), transferSize: resource.transferSize, decodedBodySize: resource.decodedBodySize };
      }),
  );
}

test("boots to an editable buffer within the local budget", async ({}, info) => {
  const startedAt = Date.now();
  await page.goto(`/w/${workspace.id}`);
  await waitForHooks(page, 120_000, pageLog);
  const hooksAt = Date.now();
  await untilOrPanic(zs.waitIdle(), pageLog);
  const readyAt = Date.now();
  const opened = await zs.openFile(readme);
  const editableAt = Date.now();
  expect(opened.kind).toBe("editor");
  expect(await overlayPhase(page)).toBe("ready");
  await expect(page.locator("canvas")).toHaveCount(1);

  const total = editableAt - startedAt;
  const editorLeg = editableAt - hooksAt;
  const wasm = await wasmResourceTiming();
  await recordTiming(info, "boot-to-editable-ms", total, {
    hooksInstalledMs: hooksAt - startedAt,
    readyMs: readyAt - startedAt,
    editorLegMs: editorLeg,
    wasmFetch: wasm,
    editorBudgetMs: editorBudgetMs(info.project.name),
    bootBudgetMs: bootBudgetMs(info.project.name),
  });
  log(
    `boot to editable: ${total} ms (hooks ${hooksAt - startedAt} ms, ready ${readyAt - startedAt} ms, editor leg ${editorLeg} ms; wasm fetch ${JSON.stringify(wasm)})`,
  );
  const editorLegBudget = editorBudgetMs(info.project.name);
  if (editorLegBudget !== null) {
    expect(editorLeg, `hooks installed → editable took ${editorLeg} ms`).toBeLessThan(editorLegBudget);
  }
  const budget = bootBudgetMs(info.project.name);
  if (budget !== null) expect(total, `navigation → editable took ${total} ms`).toBeLessThan(budget);

  const state = await zs.connectionState();
  expect(state.phase).toBe("ready");
  expect(state.connection).toBe("connected");
  expect(state.epoch).not.toBeNull();

  // Bug (b): the editor document's CSP must not report Next's dev-mode inline styles.
  const cspStyleViolations = pageLog.errors.filter((e) => /Content Security Policy/.test(e) && /style-src/.test(e));
  expect(cspStyleViolations).toEqual([]);
  expect(pageLog.firstPanic).toBeNull();
  expect(pageLog.errors.filter((e) => /\[zed-web\] panic|pageerror: unreachable/.test(e))).toEqual([]);
});

test.describe("Shared notifier", () => {
  test("D42: a worker-held Shared notifier uses the main-thread parker and preserves completion", async ({}, info) => {
    // Reuse this suite's workspace: a dedicated fixture per engine pushes the full matrix
    // beyond the real create budget (10/10min). The probe owns no project/editor state.
    const network: string[] = [];
    const requestFailed = (request: Request) => {
      network.push(`${request.method()} ${request.url().split("?")[0]} ${request.failure()?.errorText}`);
    };
    const responseReceived = (response: Response) => {
      if (response.status() >= 400) network.push(`HTTP ${response.status()} ${response.url().split("?")[0]}`);
    };
    page.on("requestfailed", requestFailed);
    page.on("response", responseReceived);
    try {
      // Preserve focused `-g D42` runs, where the preceding boot case is not selected.
      if (page.url() === "about:blank") {
        await page.goto(`/w/${workspace.id}`);
        await waitForHooks(page, 120_000, pageLog);
      }
      await untilOrPanic(zs.waitIdle(), pageLog);
      // The worker releases only after the exact Shared poll enters the real D42 parker.
      // Repetition verifies cleanup between probes; no timer manufactures contention.
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await untilOrPanic(zs.sharedContentionProbe(), pageLog);
        await info.attach(`shared-contention-${attempt + 1}`, {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
        expect(result.mainThreadParks).toBeGreaterThan(0);
        expect(result.completionWakes).toBeGreaterThan(0);
        expect(result).toMatchObject({
          workerObservedPark: true,
          workerPending: true,
          mainPending: true,
          wakersReleased: true,
          completionValue: 47,
          completedCloneValue: 47,
        });
      }
      await untilOrPanic(zs.waitIdle(), pageLog);
      expect(pageLog.errors).toEqual([]);
      expect(pageLog.firstPanic).toBeNull();
      log(`D42 ${workspace.id}: three forced Shared notifier contentions completed without a trap`);
    } finally {
      page.off("requestfailed", requestFailed);
      page.off("response", responseReceived);
      // The suite's afterEach attaches console evidence; keep the probe's errors/network too.
      await info.attach("page-errors", { body: pageLog.errors.join("\n"), contentType: "text/plain" });
      await info.attach("network", { body: network.join("\n"), contentType: "text/plain" });
    }
  });
});

test("types into the file and saves it to disk", async () => {
  const marker = `e2e-browser edit ${Date.now()}`;
  const before = fs.readFileSync(readme, "utf8");
  expect(before).not.toContain(marker);

  await zs.openFile(readme);
  await zs.moveCursorEnd();
  await zs.insertText(`\n${marker}\n`);
  expect(await zs.isDirty(readme)).toBe(true);
  expect(await zs.activeBufferText()).toContain(marker);

  await zs.save();
  await pollUntil(async () => fs.readFileSync(readme, "utf8").includes(marker), "the save to reach the disk", { timeoutMs: 30_000 });
  expect(await zs.isDirty(readme)).toBe(false);

  // The same bytes through the local backend's test route (the checkout the server writes to).
  const viaRoute = await testLocalOp<{ content: string }>(workspace.id, { op: "read_file", path: "README.md" });
  expect(viaRoute.status).toBe(200);
  expect(viaRoute.body.content).toBe(`${before}\n${marker}\n`);
});

test("shows completions from typescript-language-server in a TypeScript file", async () => {
  const binary = typescriptLanguageServerOnPath();
  test.skip(
    binary === null,
    "typescript-language-server is not on PATH (scripts/dev-local.sh browser installs it into tests/e2e-browser/fixtures/lsp-tools unless ZS_SKIP_LSP_TOOLS=1 or the install failed)",
  );
  log(`typescript-language-server: ${binary}`);

  const file = `${workspaceDir}/ts/index.ts`;
  await zs.openFile(file);
  await zs.moveCursorEnd();
  await zs.insertText("\nconst probe = greeting.");
  // The language server starts on the first TypeScript buffer: wait for the project to report
  // one running before asking for a menu.
  const servers = await pollUntil(
    async () => {
      const list = await zs.languageServers();
      return list.some((server) => /typescript|vtsls/i.test(server.name)) ? list : null;
    },
    "a TypeScript language server to be running",
    { timeoutMs: 120_000, intervalMs: 500 },
  );
  log(`language servers: ${servers.map((server) => `${server.name}(${server.language ?? "-"})`).join(", ")}`);
  // One request, then the menu is polled; a server still initialising answers nothing, so the
  // request is repeated on a bounded schedule (every 5 s), never on every poll.
  let lastTrigger = 0;
  // `contextMenu()` names which menu is up: `completionsVisible()` alone would also accept a
  // code-action menu, and the assertion is that *completions* arrived. `pollUntil` throws when
  // the predicate never holds, so its result needs no second `expect`.
  const menu = await pollUntil(
    async () => {
      if (Date.now() - lastTrigger >= 5_000) {
        await zs.triggerCompletion();
        lastTrigger = Date.now();
      }
      const current = await zs.contextMenu();
      return current?.kind === "completions" && current.rows > 0 ? current : null;
    },
    "a completions menu with at least one row",
    { timeoutMs: 60_000, intervalMs: 250 },
  );
  log(`completions menu: ${menu.rows} rows`);
  expect(await zs.completionsVisible()).toBe(true);
  // Leave the buffer as it was: the probe line is never saved.
  expect(await zs.isDirty(file)).toBe(true);
});

test("spawns a terminal, runs a command, then commits and pushes to the fixture's origin", async () => {
  const terminal = await zs.spawnTerminal(workspaceDir);
  expect(terminal.id).toMatch(/^\d+$/);
  expect(terminal.cwd).toBe(workspaceDir);
  const id = terminal.id as string;
  expect((await zs.terminals()).some((t) => t.id === id)).toBe(true);

  // The nonce is minted here, so the assertion is shell-agnostic (dash has no $RANDOM); the quotes
  // keep the echoed command line (`… echo zs-e2e-"<nonce>"`) from satisfying the line-anchored
  // match even where the terminal wraps it.
  const nonce = `zs-e2e-${Date.now()}`;
  await zs.terminalInput(id, `echo zs-e2e-"${nonce.slice("zs-e2e-".length)}"\n`);
  const lineRe = new RegExp(`^${nonce}\\s*$`, "m");
  await pollUntil(async () => lineRe.test(await zs.terminalScrollback(id)), "the echo output in the scrollback", { timeoutMs: 60_000 });
  log(`terminal ${id}: ${nonce}`);

  // BUILD-SPEC 13 "commit and push": the README edit saved above goes to the fixture repository
  // the sandbox cloned from (`file://`, so a new branch is pushable without a bare remote).
  const branch = `e2e-push-${Date.now()}`;
  const done = `zs-push-done-${Date.now()}`;
  const message = "e2e-browser: README edited in the browser";
  await zs.terminalInput(
    id,
    `git switch -q -c ${branch} && git add -A && git -c user.name=e2e -c user.email=e2e@localhost commit -q -m '${message}' && git push -q origin ${branch} && echo zs-push-"done"-${done.slice("zs-push-done-".length)}\n`,
  );
  const doneRe = new RegExp(`^${done}\\s*$`, "m");
  await pollUntil(async () => doneRe.test(await zs.terminalScrollback(id)), "the commit and push to finish", { timeoutMs: 60_000 });
  const pushed = await git(fixture.dir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  expect(pushed).toMatch(/^[0-9a-f]{40}$/);
  expect(await git(fixture.dir, ["log", "-1", "--format=%s", branch])).toBe(message);
  expect(await git(fixture.dir, ["show", "--stat", "--format=", branch])).toContain("README.md");
  log(`pushed ${branch} = ${pushed.slice(0, 12)} to ${fixture.dir}`);
});

test("the web keymap layer (D12): Alt+W closes the tab, Alt+Shift+T reopens it, the reserved chord runs Zed's own binding, the host's pane-navigation chord walks the tabs and the quit chord is a no-op", async () => {
  const relative = "README.md";
  const readmeOpen = async () => (await zs.openItems()).some((item) => item.path === relative);

  // Focus the browser's IME target first. The click may land in a dock (D46 puts the
  // terminal on the right), so restore the editor's GPUI focus through openFile afterwards.
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await zs.openFile(readme);
  expect((await zs.openItems()).some((item) => item.path === relative && item.active)).toBe(true);

  // The remapped close and reopen (web.json: alt-w, alt-shift-t).
  await page.keyboard.press("Alt+w");
  try {
    await pollUntil(async () => !(await readmeOpen()), "Alt+W to close the tab", { timeoutMs: 15_000 });
  } catch (err) {
    log(
      `ZSDIAG alt-w: hostOs=${await zs.hostOs()} items=${JSON.stringify(await zs.openItems())} dirty=${await zs.isDirty(readme)} tail=${JSON.stringify((await zs.activeBufferText()).slice(-60))} menu=${JSON.stringify(await zs.contextMenu())} errors=${JSON.stringify(pageLog.errors.slice(-5))}`,
    );
    throw err;
  }
  await page.keyboard.press("Alt+Shift+t");
  await pollUntil(readmeOpen, "Alt+Shift+T to reopen the tab", { timeoutMs: 15_000 });

  // The chord the browser owns (Cmd+W on a macOS host, Ctrl+W elsewhere; the family follows the
  // host OS the shell told the keymap layer). A real browser hands it to the page only under
  // keyboard-lock fullscreen (BUILD-SPEC 3.6); the harness's synthetic key event always reaches
  // the page, which is that locked case, and the observable outcome is deterministic: the
  // original binding stays bound (web.json) and Zed closes the item. The page itself keeps
  // running either way.
  const hostOs = await zs.hostOs();
  expect(hostOs).not.toBeNull();
  const closeChord = hostOs === "mac" ? "Meta+w" : "Control+w";
  await page.keyboard.press(closeChord);
  await pollUntil(async () => !(await readmeOpen()), `${closeChord} (host ${hostOs}) to run pane::CloseActiveItem`, { timeoutMs: 15_000 });
  expect(page.isClosed()).toBe(false);
  expect((await zs.connectionState()).phase).toBe("ready");
  await page.keyboard.press("Alt+Shift+t");
  await pollUntil(readmeOpen, "Alt+Shift+T to reopen the tab after the reserved chord", { timeoutMs: 15_000 });
  log(`${closeChord} (host ${hostOs}) delivered to the page: Zed closed the item, Alt+Shift+T brought it back`);

  // Pane item navigation, which the layer has to leave reachable because Ctrl+Tab belongs to the
  // browser. The chord is the host's, not one spelling for all of them:
  //   * Linux/Windows host: ctrl-pageup / ctrl-pagedown (the default keymap binds them in `Pane`,
  //     web.json the same actions in `Workspace`).
  //   * macOS host: cmd-{ / cmd-} (`Pane`, default-macos.json). Not ctrl-pageup, which macOS binds
  //     in the deeper `Editor` context to editor::LineUp/LineDown - gpui ranks a match by the depth
  //     its context reaches before load order, so with the editor focused the platform's own scroll
  //     wins over any Workspace binding. And not `Meta+Shift+[` either: a browser reports the
  //     shifted character, so that chord arrives as cmd-shift-{ and matches nothing (web.json's
  //     `cmd-shift-[`/`]` entries are dead in a tab for the same reason).
  // Two items in the pane, so either direction lands on the other one and a second press comes back.
  const mainRs = "src/main.rs";
  await zs.openFile(`${workspaceDir}/${mainRs}`);
  const activePath = async () => (await zs.openItems()).find((item) => item.active)?.path ?? null;
  expect(await activePath()).toBe(mainRs);
  const navigationChords = hostOs === "mac" ? ["Meta+{", "Meta+}"] : ["Control+PageUp", "Control+PageDown"];
  for (const chord of navigationChords) {
    const from = await activePath();
    await page.keyboard.press(chord);
    const to = await pollUntil(
      async () => {
        const now = await activePath();
        return now !== from ? now : null;
      },
      `${chord} to activate the other item (active: ${from})`,
      { timeoutMs: 15_000 },
    );
    expect([relative, mainRs]).toContain(to);
    log(`${chord}: ${from} -> ${to}`);
  }

  // The quit chord is unbound in a tab (web.json: ctrl-q / cmd-q null): nothing happens. A no-op
  // has no state to wait on, and only the *dispatch* is synchronous — a chord bound to a
  // deferred action (`pane::CloseActiveItem` spawns a task to check for unsaved changes) would
  // land after a hook that only read the item list. So the settle point is a keystroke whose
  // effect is observable, pressed after it and through the same dispatch path: by the time
  // Alt+W has closed the active item and Alt+Shift+T brought it back, anything the quit chord
  // deferred has run.
  //
  // `zed::Quit` is the slow case this guards: its handler flushes the settings, snapshots the
  // unsaved buffers and saves the client state before it reports `stopped` (`quit`), so a chord
  // that really fires it lands seconds later, in whatever test is running by then. That is what a
  // `Workspace`-scoped `null` against a context-less default binding used to do here; the fast
  // guard for it is `keymap_editor`'s `web_keymap_nulls_reach_a_default_binding` unit test.
  const quitChord = hostOs === "mac" ? "Meta+q" : "Control+q";
  const itemsBefore = await zs.openItems();
  const activeBefore = await activePath();
  await page.keyboard.press(quitChord);
  await page.keyboard.press("Alt+w");
  await pollUntil(
    async () => (await zs.openItems()).every((item) => item.path !== activeBefore),
    `Alt+W after ${quitChord} to close ${activeBefore}`,
    { timeoutMs: 15_000 },
  );
  await page.keyboard.press("Alt+Shift+t");
  await pollUntil(
    async () => (await zs.openItems()).some((item) => item.path === activeBefore),
    `Alt+Shift+T to reopen ${activeBefore}`,
    { timeoutMs: 15_000 },
  );
  const itemsAfter = await zs.openItems();
  expect(itemsAfter.map((item) => item.path).sort()).toEqual(itemsBefore.map((item) => item.path).sort());
  expect(page.isClosed()).toBe(false);
  expect((await zs.connectionState()).phase).toBe("ready");
  expect(await overlayPhase(page)).toBe("ready");
  log(`${quitChord} (host ${hostOs}): no-op, ${itemsBefore.length} items unchanged across a close/reopen round trip`);
});

test("a hidden tab shortens the save interval and flushes the client state at once (D7)", async () => {
  const before = await zs.clientStateStatus();
  expect(before).not.toBeNull();
  expect(before!.hidden).toBe(false);
  expect(before!.intervalMs).toBe(15_000);
  const visibilityMark = (await zs.visibilityEvents()).length;
  const savesMark = (await zs.clientStateEvents()).length;

  // A layout change that dirties the store, then the visibilitychange the shell listens to.
  await zs.openFile(`${workspaceDir}/src/main.rs`);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // The store was told: the interval dropped to 5 s and a flush started (set_hidden → flush_now).
  const hidden = await pollUntil(
    async () => {
      const status = await zs.clientStateStatus();
      return status?.hidden && status.intervalMs === 5_000 ? status : null;
    },
    "the store to be told the tab is hidden",
    { timeoutMs: 10_000 },
  );
  const flush = await pollUntil(
    async () => {
      const events = await zs.visibilityEvents();
      const event = events[visibilityMark];
      return event && event.hidden && event.flushOk !== null ? event : null;
    },
    "the hidden flush to resolve",
    { timeoutMs: 30_000 },
  );
  expect(flush.flushOk, flush.flushError).toBe(true);
  expect(flush.versionAfter).toBeGreaterThan(before!.version);
  // The save that advanced the version was accepted while the store reported hidden, i.e. it is
  // the hidden trigger's flush and not the visible 15 s ticker.
  const saves = (await zs.clientStateEvents()).slice(savesMark);
  const hiddenSave = saves.find((event) => event.kind === "saved" && event.hidden && event.at >= flush.at);
  expect(hiddenSave, JSON.stringify(saves)).toBeDefined();
  expect(hiddenSave!.version).toBe(flush.versionAfter);
  log(`hidden: version ${before!.version} -> ${flush.versionAfter} in ${(flush.flushedAt ?? 0) - flush.at} ms (interval ${hidden.intervalMs} ms)`);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const visible = await pollUntil(
    async () => {
      const status = await zs.clientStateStatus();
      return status && !status.hidden && status.intervalMs === 15_000 ? status : null;
    },
    "the store to be told the tab is visible again",
    { timeoutMs: 10_000 },
  );
  expect(visible.version).toBeGreaterThanOrEqual(flush.versionAfter!);
  const shown = await pollUntil(
    async () => {
      const event = (await zs.visibilityEvents())[visibilityMark + 1];
      return event && !event.hidden && event.flushOk !== null ? event : null;
    },
    "the visible call to resolve",
    { timeoutMs: 10_000 },
  );
  expect(shown.flushOk).toBe(true);
});

test("the 15 s dirty timer saves the client state while the tab stays visible (D7)", async () => {
  const before = await zs.clientStateStatus();
  expect(before).not.toBeNull();
  expect(before!.hidden).toBe(false);
  expect(before!.intervalMs).toBe(15_000);
  const savesMark = (await zs.clientStateEvents()).length;
  const visibilityMark = (await zs.visibilityEvents()).length;

  // A layout change (a file not opened before) dirties the store; nothing hides the tab, so the
  // only trigger left is the ticker, which fires within one 15 s interval of the write.
  const dirtiedAt = Date.now();
  await zs.openFile(`${workspaceDir}/package.json`);
  const saved = await pollUntil(
    async () =>
      (await zs.clientStateEvents())
        .slice(savesMark)
        .find((event) => event.kind === "saved" && !event.hidden && (event.version ?? 0) > before!.version) ?? null,
    "the dirty timer's save",
    { timeoutMs: 45_000, intervalMs: 500 },
  );
  const after = await zs.clientStateStatus();
  const latency = saved.at - dirtiedAt;
  log(`dirty timer: version ${before!.version} -> ${saved.version} after ${latency} ms (interval ${after?.intervalMs} ms)`);
  // The claim is that the *ticker* saved it, not the visibility trigger, and that is proved
  // without a clock: no visibility event fired, the tab is still visible and the interval is
  // still the visible one. The bound on "the ticker is alive at all" is the poll's own 45 s
  // timeout above; a wall-clock assertion on top of a whole-database serialise plus a
  // SaveClientState round trip would only add a loaded-machine failure, so the latency is
  // recorded instead.
  test.info().annotations.push({ type: "dirty-timer-save-ms", description: `${latency} ms` });
  expect((await zs.visibilityEvents()).length).toBe(visibilityMark);
  expect(after?.hidden).toBe(false);
  expect(after?.intervalMs).toBe(15_000);
  // A second ticker save may have landed between the poll's hit and this read.
  expect(after?.version).toBeGreaterThanOrEqual(saved.version!);
});

test("lifecycle notices become toasts: idle_stop_in offers Keep alive, session_cap_in counts down, resumed clears them (BUILD-SPEC 5.5)", async () => {
  const info = await testLocal(workspace.id);
  const mark = (await zs.lifecycleEvents()).length;
  const toasts = page.locator('[data-zs="toasts"]');
  await expect(toasts).toHaveCount(0);

  /**
   * Everything the client can say about why it is where it is. The shell leaves `ready` only
   * on a `stopping` notice or a terminal boot progress (a close frame), and both are logged,
   * so a phase that is not `ready` here names its own cause instead of an unexplained diff.
   */
  const why = async (): Promise<string> =>
    JSON.stringify({
      overlay: await overlayPhase(page),
      connection: await zs.connectionState(),
      lifecycle: (await zs.lifecycleEvents()).slice(mark),
      transport: (await zs.connectionEvents()).slice(-8),
      errors: pageLog.errors.slice(-5),
    });

  // What the supervisor posts two minutes before an idle stop (D29 snake_case kinds).
  expect(await postLifecycleNotice(info, { kind: "idle_stop_in", seconds: 120 })).toBe(204);
  await pollUntil(
    async () => (await zs.lifecycleEvents()).slice(mark).some((event) => event.kind === "idle_stop_in" && event.seconds === 120),
    "the idle_stop_in notice to reach the client",
    { timeoutMs: 30_000 },
  );
  await expect(toasts).toContainText("stops in 120s");
  // "Keep alive" posts /keepalive through the editor cookie and drops the toast.
  await toasts.getByRole("button", { name: "Keep alive" }).click();
  await expect(toasts).toHaveCount(0);

  expect(await postLifecycleNotice(info, { kind: "session_cap_in", seconds: 300 })).toBe(204);
  await expect(toasts).toContainText("restarts in 300s");
  expect(await overlayPhase(page), await why()).toBe("ready");

  // `resumed` clears every toast; the session was never stopped, so the phase stays `ready`.
  expect(await postLifecycleNotice(info, { kind: "resumed" })).toBe(204);
  await expect(toasts).toHaveCount(0);
  expect(await overlayPhase(page), await why()).toBe("ready");
  // The lifecycle log is process-wide and append-only: the live supervisor posts its own
  // notices from the `ActivityDirective` (D13/D29) and one of those landing inside this window
  // is legitimate, so the assertion is that the three posted here arrived, in order, and not
  // that nothing else did.
  const kinds = (await zs.lifecycleEvents()).slice(mark).map((event) => `${event.kind}(${event.seconds})`);
  const posted = ["idle_stop_in(120)", "session_cap_in(300)", "resumed(0)"];
  expect(kinds.filter((kind) => posted.includes(kind))).toEqual(posted);
  log(`lifecycle notices seen by the client: ${kinds.join(" ")}`);
  expect(pageLog.errors.filter((e) => /keepalive/.test(e))).toEqual([]);
});

test("reconnects after the server side drops the socket and keeps the unsaved buffer", async () => {
  const marker = `survives the drop ${Date.now()}`;
  await zs.openFile(readme);
  await zs.moveCursorEnd();
  await zs.insertText(`\n${marker}`);
  expect(await zs.isDirty(readme)).toBe(true);
  const before = await zs.connectionState();
  expect(before.connection).toBe("connected");
  const eventsMark = (await zs.connectionEvents()).length;

  const dropped = await testLocalOp<{ dropped: number }>(workspace.id, { op: "drop_socket" });
  expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
  expect(dropped.body.dropped).toBeGreaterThanOrEqual(1);

  // The transport noticed: a transition out of `connected` is in the log whatever the backoff
  // (the in-between state itself is never sampled).
  await pollUntil(
    async () => {
      const events = (await zs.connectionEvents()).slice(eventsMark);
      return events.some((event) => event.kind === "state" && event.from === "connected") ? events : null;
    },
    "the transport to notice the drop",
    { timeoutMs: 60_000, intervalMs: 100 },
  );

  const waited = await untilOrPanic(zs.waitIdle(90_000), pageLog);
  const events = (await zs.connectionEvents()).slice(eventsMark);
  log(`connection events after the drop: ${events.map((e) => (e.kind === "state" ? `${e.from}->${e.to}` : `${e.kind}(${e.closeCode ?? "-"})`)).join(" ")}`);
  expect(events.filter((event) => event.kind === "reconnected")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "disconnected")).toHaveLength(0);
  expect(events.some((event) => event.kind === "state" && event.to === "connected")).toBe(true);

  const after = await zs.connectionState();
  expect(after.connection).toBe("connected");
  expect(after.phase).toBe("ready");
  // A warm reattach: the same server epoch, and the server said so; the drop itself was an
  // abnormal closure (no close frame), never a D23 code.
  expect(after.epoch).toBe(before.epoch);
  expect(after.resumed).toBe(true);
  expect(after.closeCode === null || after.closeCode < 4000).toBe(true);
  expect(await overlayPhase(page)).toBe("ready");
  expect(await zs.isDirty(readme)).toBe(true);
  expect(await zs.activeBufferText()).toContain(marker);
  log(`reconnected in ${waited} ms (last close ${after.closeCode} ${after.closeReason ?? ""})`);
});

test("beforeunload: a dirty buffer summons the dialog; once everything is saved the page unloads freely", async () => {
  // The README still carries the unsaved marker of the reconnect case, and ts/index.ts the
  // completions probe.
  await zs.openFile(readme);
  expect(await zs.isDirty(readme)).toBe(true);
  // Chromium shows the prompt only for a document with a user gesture behind it.
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });

  // `Page.close` with the unload handlers: the shell's listener calls `has_unsaved_changes()`
  // and cancels the unload, the browser asks, the test dismisses, and the page lives on.
  await page.close({ runBeforeUnload: true });
  await pollUntil(async () => dialogs.length > 0, "the beforeunload dialog", { timeoutMs: 15_000, intervalMs: 100 });
  expect(dialogs).toEqual(["beforeunload"]);
  expect(page.isClosed()).toBe(false);
  expect(await zs.isDirty(readme)).toBe(true);
  expect((await zs.connectionState()).phase).toBe("ready");
  log("beforeunload with a dirty buffer: the dialog appeared, dismissed, the page stayed");

  // Save every dirty item, then the same close goes through without a dialog.
  for (const item of (await zs.openItems()).filter((entry) => entry.dirty && entry.path)) {
    await zs.openFile(`${workspaceDir}/${item.path}`);
    await zs.save();
  }
  expect((await zs.openItems()).filter((item) => item.dirty)).toEqual([]);
  expect(fs.readFileSync(readme, "utf8")).toContain("survives the drop");
  await page.close({ runBeforeUnload: true });
  await pollUntil(async () => page.isClosed(), "the page to close without a dialog", { timeoutMs: 15_000, intervalMs: 100 });
  expect(dialogs).toEqual(["beforeunload"]);
  log("beforeunload with everything saved: no dialog, the page closed");
});
