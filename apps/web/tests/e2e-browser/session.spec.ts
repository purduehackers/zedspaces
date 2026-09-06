/** Shared-session lifecycle: join, dirty stop/resume, crash recovery, and deletion. */
import fs from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  api,
  BASE_URL,
  checkoutDir,
  createFixtureRepo,
  createRunningWorkspace,
  destroyWorkspace,
  log,
  overlayPhase,
  pollWorkspace,
  testLocal,
  testLocalOp,
  watchPage,
  type FixtureRepo,
  type PageLog,
  type WorkspaceView,
} from "./control-plane";
import { documentStamp, hooks, pollUntil, untilOrPanic, waitForHooks, type TerminalInfo } from "./hooks";

test.describe.configure({ mode: "serial" });
test.skip(!BASE_URL, "ZS_E2E_BASE_URL is not set: run through scripts/dev-local.sh browser");

let fixture: FixtureRepo;
let workspace: WorkspaceView;
let workspaceDir: string;
let first: { context: BrowserContext; page: Page; log: PageLog };
let second: { context: BrowserContext; page: Page; log: PageLog };

async function bootedPage(context: BrowserContext): Promise<{ page: Page; log: PageLog }> {
  const page = await context.newPage();
  const log = watchPage(page);
  await page.goto(`/w/${workspace.id}`);
  await waitForHooks(page, 120_000, log);
  await untilOrPanic(hooks(page).waitIdle(), log);
  return { page, log };
}

test.beforeAll(async ({ browser }) => {
  // D6 needs a genuinely unsaved buffer. D46's focus-change autosave remains the
  // product default; this repository alone opts out so focus changes cannot save the marker.
  fixture = await createFixtureRepo("e2e-session", { autosave: "off" });
  workspace = await createRunningWorkspace(fixture);
  workspaceDir = checkoutDir(await testLocal(workspace.id));
  const context = await browser.newContext();
  first = { context, ...(await bootedPage(context)) };
});

test.afterAll(async () => {
  await first?.context.close().catch(() => undefined);
  await second?.context.close().catch(() => undefined);
  if (workspace) await destroyWorkspace(workspace.id).catch((err: unknown) => log(`cleanup: ${String(err)}`));
  fixture?.remove();
});

test.afterEach(async ({}, info) => {
  for (const [index, peer] of [first, second].entries()) {
    if (!peer) continue;
    await info.attach(`peer-${index}-console`, { body: peer.log.console.join("\n"), contentType: "text/plain" });
    await info.attach(`peer-${index}-errors`, { body: peer.log.errors.join("\n"), contentType: "text/plain" });
  }
});

test("a second tab joins without replacing the first", async ({ browser }) => {
  const context = await browser.newContext();
  second = { context, ...(await bootedPage(context)) };
  await pollUntil(async () => (await hooks(first.page).collaborationStatus()).peers.length === 2, "both participants joined");
  expect(await overlayPhase(first.page)).toBe("ready");
  expect(await overlayPhase(second.page)).toBe("ready");
  await first.context.close();
});

test("stop with a dirty buffer and a terminal; resume restores the text dirty and recreates the terminal", async () => {
  const page = second.page;
  const zs = hooks(page);
  const readme = `${workspaceDir}/README.md`;
  const marker = `unsaved across the stop ${Date.now()}`;
  const terminalCwd = `${workspaceDir}/src`;
  type ReadyTerminal = TerminalInfo & { id: string; cwd: string };
  const ready = (list: TerminalInfo[]): list is ReadyTerminal[] => list.every((entry) => entry.id !== null && !!entry.cwd);

  // D47 already opens a shell. Await panel initialization and that spawn before
  // adding the src shell, then capture every actual tab that the stop must persist.
  log(`second participant layout: ${JSON.stringify(await zs.workspaceLayout())}; terminals: ${JSON.stringify(await zs.terminals())}`);
  const initialTerminals = await pollUntil(async () => {
    const list = await zs.terminals();
    return list.length > 0 && ready(list) ? list : null;
  }, "the initial terminals to be ready", { timeoutMs: 60_000 });
  expect(initialTerminals.map(entry => entry.cwd)).toEqual([workspaceDir]);
  const terminal = await zs.spawnTerminal(terminalCwd);
  expect(terminal.id).toMatch(/^\d+$/);
  expect(terminal.cwd).toBe(terminalCwd);
  const beforeTerminals = await pollUntil(async () => {
    const list = await zs.terminals();
    return list.length === initialTerminals.length + 1 && ready(list) ? list : null;
  }, "all terminal tabs before the stop", { timeoutMs: 60_000 });
  const beforeIds = beforeTerminals.map((entry) => entry.id).sort();
  const beforeCwds = beforeTerminals.map((entry) => entry.cwd).sort();
  expect(new Set(beforeIds).size).toBe(beforeTerminals.length);
  expect(beforeIds).toEqual([...initialTerminals.map((entry) => entry.id), terminal.id].sort());
  log(`terminals before the stop: ${JSON.stringify(beforeTerminals)}`);

  await zs.openFile(readme);
  await zs.moveCursorEnd();
  const onDisk = fs.readFileSync(readme, "utf8");
  expect(onDisk).not.toContain(marker);
  await zs.insertText(`\n${marker}`);
  expect(await zs.isDirty(readme)).toBe(true);
  expect(await zs.bufferText(readme)).toContain(marker);
  expect(fs.readFileSync(readme, "utf8")).toBe(onDisk);

  const stop = await api<{ runId?: string; state?: string }>("POST", `/api/workspaces/${workspace.id}/stop`);
  expect([200, 202], JSON.stringify(stop.body)).toContain(stop.status);
  const events = await pollUntil(
    async () => {
      const list = await zs.lifecycleEvents();
      return list.some((event) => event.kind === "stopping") ? list : null;
    },
    "the STOPPING lifecycle notice",
    { timeoutMs: 60_000 },
  );
  log(`lifecycle: ${events.map((e) => `${e.kind}(${e.seconds})`).join(" ")}`);
  await expect(page.locator('[data-zs="overlay"]')).toHaveAttribute("data-phase", "stopped", { timeout: 90_000 });
  // D23: the server went away with 1001; the product names it `server_stopping` on the close
  // frame and as the `stopped` detail (the shell maps both to the stopped phase).
  const closed = await pollUntil(
    async () => {
      const state = await zs.connectionState();
      return state.closeCode !== null ? state : null;
    },
    "the close frame of the stop",
    { timeoutMs: 30_000 },
  );
  log(`after the stop: ${closed.phase} ${closed.detail} (close ${closed.closeCode} ${closed.closeReason})`);
  expect(closed.closeCode).toBe(1001);
  expect(closed.closeDetail).toBe("server_stopping");
  expect(closed.phase).toBe("stopped");
  expect(closed.detail).toBe("server_stopping");
  await pollWorkspace(workspace.id, (w) => w.state === "stopped" && !w.workflowRunId, 120_000, "stopped");
  expect(fs.readFileSync(readme, "utf8")).toBe(onDisk);

  // The overlay's dialog offers the resume (the top strip's button sits under the overlay).
  // `reconnect({ resume: true })` reloads; the stamp keeps the wait (and every hook call after
  // it) off the outgoing document, whose hooks are installed and whose session is `stopped`.
  const beforeResume = await documentStamp(page);
  await page.locator('[data-zs="overlay"]').getByRole("button", { name: "Resume" }).click();
  await waitForHooks(page, 240_000, second.log, beforeResume);
  const resumed = hooks(page);
  await untilOrPanic(resumed.waitIdle(), second.log);
  expect(await overlayPhase(page)).toBe("ready");
  await pollWorkspace(workspace.id, (w) => w.state === "running" && !w.workflowRunId, 60_000, "running after the resume");

  // D6: the unsaved text is back, still dirty, and still not on disk.
  const items = await pollUntil(
    async () => {
      const list = await resumed.openItems();
      const item = list.find((item) => item.path === "README.md");
      if (!item?.dirty || !(await resumed.isDirty(readme))) return null;
      return (await resumed.bufferText(readme)).includes(marker) ? list : null;
    },
    "the README item and unsaved text to be restored dirty",
    { timeoutMs: 60_000 },
  );
  expect(items.find((item) => item.path === "README.md")?.dirty).toBe(true);
  expect(await resumed.isDirty(readme)).toBe(true);
  expect(await resumed.bufferText(readme)).toContain(marker);
  expect(fs.readFileSync(readme, "utf8")).toBe(onDisk);

  // D28: one fresh shell per persisted terminal tab, in its working directory, with a new id.
  const terminals = await pollUntil(
    async () => {
      const list = await resumed.terminals();
      return list.length === beforeTerminals.length && ready(list) ? list : null;
    },
    "every persisted terminal tab to be recreated",
    { timeoutMs: 90_000 },
  );
  const restoredIds = terminals.map((entry) => entry.id).sort();
  expect(new Set(restoredIds).size).toBe(beforeTerminals.length);
  expect(restoredIds.every((id) => !beforeIds.includes(id))).toBe(true);
  expect(terminals.map((entry) => entry.cwd).sort()).toEqual(beforeCwds);
  log(`terminals recreated: ${JSON.stringify(terminals)}`);
  for (const entry of terminals) {
    const shellMarker = `resumed-shell-${Date.now()}-${entry.id}`;
    await resumed.terminalInput(entry.id, `printf '\\n%s\\n' '${shellMarker}'; pwd\n`);
    await pollUntil(async () => {
      const lines = (await resumed.terminalScrollback(entry.id)).split(/\r?\n/).map((line) => line.trim());
      const at = lines.indexOf(shellMarker);
      return at >= 0 && lines[at + 1] === entry.cwd;
    }, `pwd in recreated terminal ${entry.id}`, { timeoutMs: 60_000 });
  }
  // The count above is the first snapshot the poll accepted; the regression D28 guards against
  // (the D4 reattach and the D28 respawn both firing for the same persisted tab) shows up as a
  // duplicate terminal arriving a moment later. The shell round trips have since ordered
  // server round trips behind the restore, so this read would see it.
  const settled = await resumed.terminals();
  expect(settled.map((entry) => entry.id).sort()).toEqual(restoredIds);
  expect(settled.map((entry) => entry.cwd).sort()).toEqual(beforeCwds);
  expect(await resumed.isDirty(readme)).toBe(true);
  expect(fs.readFileSync(readme, "utf8")).toBe(onDisk);
  await second.context.close();
});

test("a running row over a dead sandbox is reconciled by /connect and resumed", async () => {
  const before = await testLocal(workspace.id);
  expect(before.workspace.state).toBe("running");
  expect(before.sandbox.alive).toBe(true);

  const killed = await testLocalOp<{ killed: number[] }>(workspace.id, { op: "kill_sandbox" });
  expect(killed.status, JSON.stringify(killed.body)).toBe(200);
  expect(killed.body.killed.length).toBeGreaterThan(0);
  const dead = await testLocal(workspace.id);
  expect(dead.sandbox.alive).toBe(false);
  expect(dead.workspace.state).toBe("running");
  log(`killed ${killed.body.killed.join(", ")}; row still ${dead.workspace.state}`);

  // A reconnecting tab learns the workspace is stopped (never `sandbox_unhealthy`, never a
  // resume). This is D2 (`RefreshError::Stopped`) and Appendix B, and it is deliberately not
  // "reconcile, then resume and carry on": a reconnect must not restart a workspace behind the
  // user's back, so the reconciliation stops at `stopped` and the resume below is an explicit
  // open. `tests/routes/connect-reconcile.test.ts` pins the same rule at the route level.
  const reconnect = await api<{ error?: { code: string } }>("POST", `/api/workspaces/${workspace.id}/connect`, {
    tabId: `e2e-reconcile-${Date.now()}`,
    reason: "reconnect",
  });
  expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(409);
  expect(reconnect.body.error?.code).toBe("workspace_stopped");
  const reconciled = await api<{ workspace: WorkspaceView }>("GET", `/api/workspaces/${workspace.id}`);
  expect(reconciled.body.workspace.state).toBe("stopped");
  expect(reconciled.body.workspace.stateReason).toMatch(/^lost:/);
  log(`reconciled: ${reconciled.body.workspace.state} ${reconciled.body.workspace.stateReason}`);

  // An explicit open resumes it through the ordinary path.
  const open = await api<{ status?: string; wsUrl?: string; error?: { code: string } }>(
    "POST",
    `/api/workspaces/${workspace.id}/connect`,
    { tabId: `e2e-reconcile-open-${Date.now()}`, reason: "open" },
  );
  expect([200, 202], JSON.stringify(open.body)).toContain(open.status);
  if (open.status === 202) expect(open.body.status).toBe("resuming");
  await pollWorkspace(workspace.id, (w) => w.state === "running" && !w.workflowRunId, 4 * 60_000, "running after the reconcile");
  const alive = await testLocal(workspace.id);
  expect(alive.sandbox.alive).toBe(true);
  expect(alive.supervisor?.running).toBe(true);

  const again = await api<{ wsUrl?: string }>("POST", `/api/workspaces/${workspace.id}/connect`, {
    tabId: `e2e-reconcile-open-${Date.now()}`,
    reason: "open",
  });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/);
});

test("delete: the workspace is stopped, DELETE is accepted, and the row is gone", async () => {
  // A running workspace is stopped first (`DELETE` answers 409 `workspace_busy` while a run is
  // in flight, so the stop is awaited).
  const current = await api<{ workspace: WorkspaceView }>("GET", `/api/workspaces/${workspace.id}`);
  expect(current.status).toBe(200);
  if (current.body.workspace.state !== "stopped") {
    const stop = await api("POST", `/api/workspaces/${workspace.id}/stop`);
    expect([200, 202], JSON.stringify(stop.body)).toContain(stop.status);
    await pollWorkspace(workspace.id, (w) => w.state === "stopped" && !w.workflowRunId, 120_000, "stopped before the delete");
  }
  const sandboxDir = (await testLocal(workspace.id)).sandbox.dir;

  const del = await api<{ runId?: string }>("DELETE", `/api/workspaces/${workspace.id}`);
  expect(del.status, JSON.stringify(del.body)).toBe(202);
  expect(del.body.runId).toBeTruthy();
  const gone = await pollUntil(
    async () => {
      const res = await api<{ error?: { code: string } }>("GET", `/api/workspaces/${workspace.id}`);
      return res.status === 404 || res.status === 410 ? res : null;
    },
    "the workspace row to be gone",
    { timeoutMs: 90_000, intervalMs: 1_000 },
  );
  // `pollUntil` returns only on 404/410 and otherwise throws, so its result carries the
  // assertion; repeating it here would be a check that cannot fail.
  log(`after DELETE: GET ${gone.status} ${JSON.stringify(gone.body)}`);

  // The connect route refuses it with the same status, and the sandbox directory is removed
  // (the local backend `rm -rf`s it on delete).
  const connect = await api<{ error?: { code: string } }>("POST", `/api/workspaces/${workspace.id}/connect`, {
    tabId: `e2e-deleted-${Date.now()}`,
    reason: "open",
  });
  expect([404, 410], JSON.stringify(connect.body)).toContain(connect.status);
  await pollUntil(async () => !fs.existsSync(sandboxDir), "the sandbox directory to be removed", { timeoutMs: 60_000, intervalMs: 1_000 });
  const listing = await api<{ workspaces: WorkspaceView[] }>("GET", "/api/workspaces");
  expect(listing.status).toBe(200);
  expect(listing.body.workspaces.some((w) => w.id === workspace.id)).toBe(false);
});
