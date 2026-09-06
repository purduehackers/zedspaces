import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { api, BASE_URL, checkoutDir, createFixtureRepo, createRunningWorkspace, destroyWorkspace,
  log as report, pollWorkspace, testLocal, testLocalOp, watchPage, type PageLog } from "./control-plane";
import { documentStamp, hooks, pollUntil, untilOrPanic, waitForHooks } from "./hooks";

test.skip(!BASE_URL, "Run through scripts/dev-local.sh browser");

test("two anonymous peers edit, see cursors, own separate terminals and reload independently", async ({ browser }, info) => {
  test.setTimeout(300_000);
  const repo = await createFixtureRepo("e2e-multiplayer", { autosave: "off" });
  const workspace = await createRunningWorkspace(repo);
  const contexts: BrowserContext[] = [];
  const logs: PageLog[] = [];
  const dir = checkoutDir(await testLocal(workspace.id));
  const path = `${dir}/README.md`;
  const settingsPath = `/api/workspaces/${workspace.id}/settings`;
  const originalSettings = await api<{ content: string; version: number }>("GET", settingsPath);
  const readDisk = async () => (await testLocalOp<{ content: string }>(workspace.id, { op: "read_file", path: "README.md" })).body.content;
  const originalText = await readDisk();
  const start = async (): Promise<{ page: Page; log: PageLog }> => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const log = watchPage(page);
    logs.push(log);
    await page.goto(`/w/${workspace.id}`);
    await waitForHooks(page, 120_000, log);
    await untilOrPanic(hooks(page).waitIdle(), log);
    await hooks(page).openFile(path);
    return { page, log };
  };
  try {
    // This recovery case needs unsaved text even while a reloading editor has no
    // active project path yet. A repository override alone doesn't cover that
    // interval: Zed then uses the user's global focus-change autosave setting.
    expect(originalSettings.status).toBe(200);
    expect((await api("PUT", settingsPath, { content: JSON.stringify({ autosave: "off" }), version: originalSettings.body.version })).status).toBe(200);
    const a = await start(), b = await start();
    const za = hooks(a.page), zb = hooks(b.page);
    const peers = await pollUntil(async () => {
      const [first, second] = await Promise.all([za.collaborationStatus(), zb.collaborationStatus()]);
      return first.peers.length === 2 && second.peers.length === 2 ? [first, second] : null;
    }, "both peers in Zed's roster");
    expect(peers[0].replica).not.toBe(peers[1].replica);
    expect(peers[0].replica).toBeGreaterThanOrEqual(8);
    // Create and exercise terminals before making the unsaved draft. The product
    // deliberately autosaves on focus change; opening a terminal may save an editor.
    const [termA, termB] = await Promise.all([za.spawnTerminal(dir), zb.spawnTerminal(dir)]);
    expect(termA.id).not.toEqual(termB.id);
    expect(termA.id).toBeTruthy();
    expect(termB.id).toBeTruthy();
    await Promise.all([za.terminalInput(termA.id!, "printf 'terminal-alpha\\n'\n"), zb.terminalInput(termB.id!, "printf 'terminal-beta\\n'\n")]);
    await pollUntil(async () => (await za.terminalScrollback(termA.id!)).includes("terminal-alpha"), "first participant terminal output");
    await pollUntil(async () => (await zb.terminalScrollback(termB.id!)).includes("terminal-beta"), "second participant terminal output");
    expect(await za.terminalScrollback(termA.id!)).not.toContain("terminal-beta");
    expect(await zb.terminalScrollback(termB.id!)).not.toContain("terminal-alpha");
    const [listA, listB] = await Promise.all([za.terminals(), zb.terminals()]);
    expect(listA.map(t => t.id).filter(id => id && listB.some(t => t.id === id))).toEqual([]);
    report("multiplayer: terminal streams are separate");
    await Promise.all([za.openFile(path), zb.openFile(path)]);
    const before = await za.bufferText(path);
    await Promise.all([za.moveCursorEnd(), zb.moveCursorEnd()]);
    await Promise.all([za.insertText("\npeer-alpha"), zb.insertText("\npeer-beta")]);
    const text = await pollUntil(async () => {
      const [first, second] = await Promise.all([za.bufferText(path), zb.bufferText(path)]);
      return first === second && first.includes("peer-alpha") && first.includes("peer-beta") ? first : null;
    }, "concurrent CRDT edits converge");
    expect(text.length).toBe(before.length + "\npeer-alpha\npeer-beta".length);
    report(`multiplayer: concurrent edits converged; replicas ${peers.map(peer => peer.replica).join(", ")}`);
    await pollUntil(async () => (await za.collaborationStatus()).remoteSelections > 0, "remote cursor in first editor");
    await pollUntil(async () => (await zb.collaborationStatus()).remoteSelections > 0, "remote cursor in second editor");
    report("multiplayer: remote cursors present in both editors");
    const marks = await Promise.all([za.connectionEvents(), zb.connectionEvents()]);
    expect((await testLocalOp<{ dropped: number }>(workspace.id, { op: "drop_socket" })).body.dropped).toBeGreaterThanOrEqual(2);
    await Promise.all([za, zb].map((zs, index) => pollUntil(async () =>
      (await zs.connectionEvents()).slice(marks[index].length).some(event => event.kind === "reconnected"), "participant warm reconnect", { timeoutMs: 90_000 })));
    expect(await za.bufferText(path)).toBe(text);
    expect(await zb.bufferText(path)).toBe(text);
    report("multiplayer: warm reconnect preserved both dirty buffers");
    expect(await za.isDirty(path)).toBe(true);
    expect(await zb.isDirty(path)).toBe(true);
    expect(await za.bufferText(path)).toBe(text);
    expect(await zb.bufferText(path)).toBe(text);

    // Reload while dirty: no takeover, no VM/project reset, same replica and text.
    const stamp = await documentStamp(a.page);
    await a.page.reload();
    await waitForHooks(a.page, 120_000, a.log, stamp);
    await untilOrPanic(za.waitIdle(), a.log);
    await za.openFile(path);
    expect((await za.collaborationStatus()).replica).toBe(peers[0].replica);
    expect(await za.bufferText(path)).toBe(text);
    expect(await zb.bufferText(path)).toBe(text);

    // Both participants flush dirty drafts; a later join cannot overwrite edits
    // made by the first returning participant after the sandbox resumes.
    expect(await za.isDirty(path)).toBe(true);
    expect(await zb.isDirty(path)).toBe(true);
    expect(await readDisk()).toBe(originalText);
    expect((await api("POST", `/api/workspaces/${workspace.id}/stop`, {})).status).toBe(202);
    await pollWorkspace(workspace.id, row => row.state === "stopped" && !row.workflowRunId, 90_000, "all participants stopped");
    const resumeStamp = await documentStamp(b.page);
    await b.page.reload();
    await waitForHooks(b.page, 120_000, b.log, resumeStamp);
    await untilOrPanic(zb.waitIdle(), b.log);
    await zb.openFile(path);
    expect(await zb.bufferText(path)).toBe(text);
    expect(await zb.isDirty(path)).toBe(true);
    expect(await readDisk()).toBe(originalText);
    report("multiplayer: stop/resume restored the dirty shared draft");
    await zb.moveCursorEnd();
    await zb.insertText("\nafter-resume");
    const resumedText = `${text}\nafter-resume`;
    expect(await zb.bufferText(path)).toBe(resumedText);
    report(`multiplayer: first returning peer ${JSON.stringify(await zb.collaborationStatus())} edited the draft`);
    const lateStamp = await documentStamp(a.page);
    await a.page.reload();
    await waitForHooks(a.page, 120_000, a.log, lateStamp);
    await untilOrPanic(za.waitIdle(), a.log);
    await za.openFile(path);
    report(`multiplayer: returning rosters ${JSON.stringify(await za.collaborationStatus())} / ${JSON.stringify(await zb.collaborationStatus())}; bytes ${(await za.bufferText(path)).length} / ${(await zb.bufferText(path)).length}`);
    expect(await za.bufferText(path)).toBe(resumedText);
    expect(await zb.bufferText(path)).toBe(resumedText);
    report("multiplayer: later returning participant did not overwrite newer text");
    await contexts[0].close();
    await pollUntil(async () => (await zb.collaborationStatus()).peers.length === 1, "first participant leaves without ending the project");
    await zb.moveCursorEnd();
    await zb.insertText("\npeer-beta-still-here");
    await zb.save();
    // Zed inserts the configured final newline on save.
    const saved = `${resumedText}\npeer-beta-still-here\n`;
    expect((await testLocalOp<{ content: string }>(workspace.id, { op: "read_file", path: "README.md" })).body.content).toBe(saved);
    for (const log of logs) expect(log.firstPanic).toBeNull();
  } finally {
    await Promise.all(logs.map((log, index) => info.attach(`peer-${index}-console`, { body: log.console.join("\n"), contentType: "text/plain" })));
    await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
    const currentSettings = await api<{ version: number }>("GET", settingsPath);
    expect((await api("PUT", settingsPath, { content: originalSettings.body.content, version: currentSettings.body.version })).status).toBe(200);
    await destroyWorkspace(workspace.id);
    repo.remove();
  }
});
