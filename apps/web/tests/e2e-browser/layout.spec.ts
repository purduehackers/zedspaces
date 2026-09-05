import { expect, test } from "@playwright/test";
import {
  api,
  BASE_URL,
  createFixtureRepo,
  createRunningWorkspace,
  destroyWorkspace,
  log,
  watchPage,
  type FixtureRepo,
  type WorkspaceView,
} from "./control-plane";
import { documentStamp, hooks, pollUntil, untilOrPanic, waitForHooks } from "./hooks";

test.skip(!BASE_URL, "ZS_E2E_BASE_URL is not set: run through scripts/dev-local.sh browser");
test.use({ screenshot: "off", trace: { mode: "retain-on-failure", screenshots: false } });

test("D47: first run opens the tree and a shell, trims the title bar, and preserves closed docks on reload", async ({ page }, info) => {
  const pageLog = watchPage(page);
  const network: string[] = [];
  const pageErrorStacks: string[] = [];
  const panicReports: string[] = [];
  page.on("pageerror", (error) => pageErrorStacks.push(error.stack ?? error.message));
  page.on("request", (request) => {
    if (!/\/api\/workspaces\/[^/]+\/client-errors$/.test(request.url())) return;
    const body = request.postData();
    if (!body) return;
    try {
      const report = JSON.parse(body) as { kind?: string };
      if (report.kind === "panic") panicReports.push(body);
    } catch { /* An invalid telemetry body is not a panic report. */ }
  });
  // A teardown panic can reach the server after Playwright detaches from the page.
  // Fill the existing report's empty stack at the synchronous fetch call, while the
  // initiating wasm frames are still on the stack. No editor/lifecycle behavior changes.
  await page.addInitScript(() => {
    const lifecycle: string[] = [];
    for (const type of ["beforeunload", "pagehide", "blur", "visibilitychange"]) {
      const target = type === "visibilitychange" ? document : window;
      target.addEventListener(type, () => {
        lifecycle.push(`${type} ${performance.now().toFixed(3)} ${document.visibilityState}`);
        if (lifecycle.length > 16) lifecycle.shift();
      }, { capture: true });
    }
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (typeof input === "string" && /\/client-errors$/.test(input) && typeof init?.body === "string") {
        try {
          const report = JSON.parse(init.body) as { kind?: string; stack?: string };
          if (report.kind === "panic" && !report.stack) {
            report.stack = `${lifecycle.join("\n")}\n${new Error("panic report call stack").stack ?? ""}`.slice(0, 16_000);
            init = { ...init, body: JSON.stringify(report) };
          }
        } catch { /* Preserve non-JSON/non-panic fetch calls unchanged. */ }
      }
      return originalFetch(input, init);
    };
  });
  let settingsPuts = 0;
  const settingsResponses: number[] = [];
  let releaseSettingsPut: () => void = () => undefined;
  const settingsGate = new Promise<void>((resolve) => { releaseSettingsPut = resolve; });
  page.on("requestfailed", (request) => {
    network.push(`${request.method()} ${request.url().split("?")[0]} ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) network.push(`HTTP ${response.status()} ${response.url().split("?")[0]}`);
  });
  let fixture: FixtureRepo | undefined;
  let workspace: WorkspaceView | undefined;
  let originalSettings: string | undefined;
  try {
    // This regression needs no particular files or Git mutations. An existing local
    // repository can seed a fresh workspace when fixture commits are not permitted.
    const existingRepo = process.env.ZS_E2E_LAYOUT_REPO;
    if (!existingRepo) fixture = await createFixtureRepo("e2e-layout");
    workspace = await createRunningWorkspace(fixture ?? { name: existingRepo! });
    const settingsRoute = `/api/workspaces/${workspace.id}/settings`;
    const settingsUrl = `${BASE_URL}/api/workspaces/${workspace.id}/settings`;
    // Documents are per user, not per workspace. Seed the isolated test user's document
    // explicitly so panel initialization must persist its dock settings through WasmFs.
    const original = await api<{ content: string; version: number }>("GET", settingsRoute);
    expect(original.status).toBe(200);
    originalSettings = original.body.content;
    const seed = await api("PUT", settingsRoute, { content: "{}", version: original.body.version });
    expect(seed.status, JSON.stringify(seed.body)).toBe(200);
    // Hold the actual WasmFs PUT while hidden flushing is in progress. Completion must
    // remain pending until this gate is released, not just until the client image is saved.
    await page.route(settingsUrl, async (route) => {
      if (route.request().method() === "PUT") {
        settingsPuts++;
        await settingsGate;
      }
      await route.continue();
    });
    page.on("response", (response) => {
      if (response.url() === settingsUrl && response.request().method() === "PUT") settingsResponses.push(response.status());
    });
    const navigationStarted = Date.now();
    await page.goto(`/w/${workspace.id}`);
    await waitForHooks(page, 120_000, pageLog);
    info.annotations.push({ type: "boot-to-ready-ms", description: String(Date.now() - navigationStarted) });
    const zs = hooks(page);
    await untilOrPanic(zs.waitIdle(), pageLog);

    const first = await untilOrPanic(
      pollUntil(async () => {
        const layout = await zs.workspaceLayout();
        return layout.docks.left.visible && layout.docks.left.active_panel === "Project Panel"
          && layout.docks.right.visible && layout.docks.right.active_panel === "TerminalPanel"
          ? layout : null;
      }, "the first-run project and terminal panels", { timeoutMs: 30_000 }),
      pageLog,
    );
    expect(first.titleBar).toMatchObject({
      show_branch_status_icon: true,
      show_branch_name: true,
      show_worktree_name: true,
      show_project_items: false,
      show_onboarding_banner: false,
      show_user_picture: false,
      show_sign_in: false,
      show_user_menu: false,
      show_menus: false,
    });
    const terminal = await untilOrPanic(
      pollUntil(async () => (await zs.terminals()).find((entry) => entry.id !== null),
        "the first-run shell to receive a remote terminal id", { timeoutMs: 30_000 }),
      pageLog,
    );
    // The panel opening must create a usable shell; this test never calls spawnTerminal().
    const marker = `d47-shell-${Date.now()}`;
    await zs.terminalInput(terminal.id!, `printf '%s\\n' '${marker}'\n`);
    await untilOrPanic(
      pollUntil(async () => (await zs.terminalScrollback(terminal.id!)).split(/\r?\n/).some((line) => line.trim() === marker),
        "the automatically created shell to execute a command", { timeoutMs: 30_000 }),
      pageLog,
    );
    await info.attach("first-run-layout", { body: JSON.stringify(first, null, 2), contentType: "application/json" });

    await untilOrPanic(zs.closeDocks(), pageLog);
    const closed = await zs.workspaceLayout();
    expect(Object.values(closed.docks).every((dock) => !dock.visible)).toBe(true);
    const before = await zs.clientStateStatus();
    expect(before).not.toBeNull();
    expect(before!.readOnly).toBe(false);
    const visibilityMark = (await zs.visibilityEvents()).length;
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => settingsPuts, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(settingsResponses).toEqual([]);
    const pending = (await zs.visibilityEvents()).slice(visibilityMark).find((event) => event.hidden);
    expect(pending).toBeDefined();
    expect(pending!.flushOk, "hidden flush must await the held document save").toBeNull();
    releaseSettingsPut();
    const flush = await untilOrPanic(
      pollUntil(async () => (await zs.visibilityEvents()).slice(visibilityMark)
        .find((event) => event.hidden && event.flushOk !== null),
      "the shell's hidden-tab client-state flush", { timeoutMs: 30_000 }),
      pageLog,
    );
    expect(flush.flushOk, flush.flushError).toBe(true);
    expect(settingsResponses.length, "hidden completion must cover the held settings PUT").toBeGreaterThan(0);
    expect(settingsResponses.every((status) => status === 200)).toBe(true);
    // The ordinary dirty timer may have saved closeDocks() before the hidden event.
    // The restored dock state below proves persistence even when this flush is a no-op.
    expect(flush.versionAfter).toBeGreaterThan(0);
    expect(flush.versionAfter).toBeGreaterThanOrEqual(before!.version);

    const previousDocument = await documentStamp(page);
    await page.reload();
    await waitForHooks(page, 120_000, pageLog, previousDocument);
    await untilOrPanic(zs.waitIdle(), pageLog);
    const restored = await zs.workspaceLayout();
    // Dock::apply_serialized_state restores active_panel only for visible docks.
    // A hidden dock may therefore have no active panel after reload; D47 promises
    // to preserve the closed layout, not an invisible in-memory selection.
    for (const position of ["left", "right", "bottom"] as const) {
      expect(restored.docks[position]).toMatchObject({
        visible: closed.docks[position].visible,
        zoom: closed.docks[position].zoom,
      });
    }
    expect(restored.titleBar).toEqual(first.titleBar);
    expect((await zs.clientStateStatus())!.version).toBeGreaterThanOrEqual(flush.versionAfter!);
    expect(pageLog.firstPanic).toBeNull();
    // The authoritative hidden flush also drains settings (D32). Reloading after its
    // completion must not abort a still-pending document PUT or report a save failure.
    expect(network.filter((entry) => /\/api\/workspaces\/[^/]+\/(settings|keymap)\b/.test(entry))).toEqual([]);
    expect(pageLog.console.filter((entry) => /(?:settings|keymap).*not saved/i.test(entry))).toEqual([]);
    await info.attach("restored-layout", { body: JSON.stringify(restored, null, 2), contentType: "application/json" });
    log(`D47 ${workspace.id}: first-run tree and shell verified; all docks stayed closed after restoring version ${flush.versionAfter}`);
  } finally {
    releaseSettingsPut();
    await page.close().catch(() => undefined);
    try {
      if (workspace && originalSettings !== undefined) {
        const route = `/api/workspaces/${workspace.id}/settings`;
        const current = await api<{ version: number }>("GET", route);
        expect(current.status).toBe(200);
        const restored = await api("PUT", route, { content: originalSettings, version: current.body.version });
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      }
    } finally {
      if (workspace) await destroyWorkspace(workspace.id).catch((error: unknown) => log(`cleanup: ${String(error)}`));
      fixture?.remove();
      // Keep observation alive through page.close and the server cleanup, not just
      // through the last ready assertion: Firefox can report a panic during unload.
      await info.attach("console", { body: pageLog.console.join("\n"), contentType: "text/plain" });
      await info.attach("page-errors", { body: pageLog.errors.join("\n"), contentType: "text/plain" });
      await info.attach("page-error-stacks", { body: pageErrorStacks.join("\n\n"), contentType: "text/plain" });
      await info.attach("panic-reports", { body: panicReports.join("\n"), contentType: "application/x-ndjson" });
      await info.attach("network", { body: network.join("\n"), contentType: "text/plain" });
    }
  }
  expect(pageLog.errors, "errors through final page close").toEqual([]);
  expect(panicReports, "panic reports through final page close").toEqual([]);
});
