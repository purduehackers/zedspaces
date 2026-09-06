# Multiplayer: the sandbox hosts Zed's shared project

Deployed 2026-09-06 as `648cf2f80-34054725092.1` at
[code.purduehackers.com](https://code.purduehackers.com). Two live Chromium sessions
exchanged exact edits, and the survivor saved after the first closed; VM readback
matched. See [deployment evidence and limits](../status/deployment.md).
Existing workspaces need recreation. The owner explicitly chose
a breaking replacement, with no single-editor mode or old-build compatibility.

Historical local validation before test removal: the full Chromium suite passed (19/19), including first-run
terminal working directories, saved dock layout, dirty stop/resume, crash recovery
and deletion. Layout restoration and the two-browser case pass on Chromium,
Firefox and WebKit: concurrent edits, cursors,
isolated terminal streams, warm reconnect, dirty reload/stop/resume, later-returning
stale drafts, and continued editing/saving after another tab closes. App checks:
395 unit tests, six workflow integration tests, lint, typecheck and the production
web build passed. Rust:
215 server, 69 remote, three proto and 41 web-core unit tests passed, including the
saved-version recovery regression and required participant isolation. These are
historical results, not tests rerun for the production release above.

Evidence: `apps/web/.zs-dev/mp-browser-full-3.log` (19/19),
`mp-browser-cross-2.log` (Firefox/WebKit layout passed; its WebKit multiplayer case
exposed a fixture autosave), and `mp-browser-cross-3.log` (3/3 multiplayer with
explicit test-user autosave off and unchanged-disk assertions). The final test
bundle is `dev-multiplayer-final-test`; the native binary is
`zed/target/zs-multiplayer-20260906/server-13`. `mp-rust-tests-8.log` and
`mp-webcore-tests-9.log` record the Rust passes. Optional native subprocess tests
guarded by `ZED_RUN_SERVE_INTEGRATION` were not run. The fork implementation is
published as `648cf2f801`; the app and release-gate changes accompany this revision.
The production release above uses that fork commit.

- Each signed anonymous participant gets a Zed replica ID, independent RPC
  sequence/replay broker, and saved layout. Identity survives reload and stop/resume.
- One sandbox-owned HeadlessProject holds buffers, worktrees, Git and language
  servers. It forwards Zed CRDT text/selection operations and participant presence.
  Closing the first tab does not reset or terminate the shared project.
- Terminals are participant-owned: output, input, resize and attachment are routed
  to that participant. They are not shared terminals or a permission boundary;
  everyone still has access to the same sandbox filesystem and processes.
- Both editor-tab restoration and stopping snapshots ask the server to restore
  dirty text atomically. An older draft cannot overwrite newer edits or saves;
  conflicting drafts become adjacent `.zedspaces-recovered-<uuid>.txt` files.
- Drizzle's open-session index is `(workspace_id, holder_tab_id)`. No extra
  participant database, login, feature flag, singleton broker, takeover handshake
  or UI. The handshake requires a replica ID; client state requires a registered peer.
- The owner subsequently removed all Zedspaces tests and test release gates.
  The verification above records historical results; CI now checks source and builds only.

## Bounds and remaining limits

The VM accepts 32 distinct tab identities over its lifetime; restarting it resets
that count. Each peer's replay is bounded to 4,096 envelopes / 16 MiB. Overflow
requires an explicit fresh join instead of silently reloading unsynced edits.
Dirty buffers stay in the running VM; stop recovery also depends on the browser
snapshot flush. Continuous server-side journaling of unsaved text is not implemented,
so closing every tab before a later idle stop is not a durability guarantee.

Names are anonymous Guest numbers, assigned for that VM lifetime. There is no
follow-user mode, terminal sharing, voice/video, private collaboration or access
control. Existing old editor generations must be recreated after the breaking
release; release manifests contain only the current bundle.

WebRTC is not needed for this version: files, terminals and language servers
already live in the sandbox, and Zed's CRDT works over the existing WebSockets.
No upstream hosted collab service, LiveKit, Postgres or second CRDT was added.
