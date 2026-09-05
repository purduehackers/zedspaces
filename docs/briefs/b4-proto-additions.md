# b4-proto-additions: Persistence, lifecycle, files, ports and extension messages

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` sections 5.2 (line 249), 5.3 (256), 5.4 (260), 5.5 (264), 5.6 (268), 5.7 (272), 6.2 (294), 6.3 (307), 7.3 (339), 7.5 (365), 7.6 (373), 9 (407), 10 (424), 13 (477), Appendix A (548). Binding cross-brief decisions: `/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md` (D1-D20, 2026-09-02), cited inline as `D<n>`; section 9 records what each one changed here. Fork under modification: `/Users/ray/Projects/play/wed/zed` (branch `zs`, upstream `c3cf80c`). All paths below are relative to that checkout unless stated otherwise.

Related briefs (all present in `docs/briefs` at the time of this revision; earlier revisions of this brief predated them and guessed at their shapes; line numbers are those of the sibling briefs as they stood before the D1-D20 reconciliation):

- b1 `b1-ws-transport.md` — the *client* WebSocket transport (`WebSocketRemoteConnection`); `upload_directory` returns a ready `Err` (b1:171, 549); takeover (4001), 4002, 4005 and `HelloAck.resumed == false` end in `State::ServerNotRunning` (b1:249, 297, 564); a failed reconnect budget ends in `State::ReconnectExhausted` (D2: 20 attempts, backoff capped at 8 s; `RefreshError::Stopped` short-circuits, `RefreshError::Unauthorized` is terminal). Both terminal states emit `RemoteClientEvent::Disconnected { server_not_running }` (`remote_client.rs:934-942`: `server_not_running` is `false` for `ReconnectExhausted`), which is why this brief's client stores stop on *every* `Disconnected`, not only on `server_not_running: true` (3.7, 3.16). Identity is `workspace_id` (D1); nothing in this brief keys on `session_id`.
- b2 `b2-serve-mode.md` — owns `zed-remote-server serve`: the hyper router (`/health`, `/rpc`, `/files`, else 404; b2:538-546), `files::handle_upload` on tokio, the session broker and attach algorithm (b2:374-384, 449), `is_input_envelope` (b2:431-440), `GpuiCommand { ResetForFreshSession { done }, Quit }` and the gpui command loop (b2:601-616), `ServeHooks::session_attached` called after **every** attach, fresh or reconnect (b2:381, 449, 620), `ControlRoutes` (b2:469-472) and `ServeState.control: Option<Arc<dyn ControlRoutes>>` (b2:483), `HeadlessProject::reset_for_new_client` (b2:665-675; keeps `sandbox`, `extensions` and the session's handler table, so `enable_sandbox` runs once per process — D3), `--allowed-origin` / `ZS_ALLOWED_ORIGINS` (b2:573; D5), and the `subtle` dependency (b2:76, 616). Every server-side hook this brief needs from `serve` is addressed to b2 in section 3.15; D20 adopts those six items as b2's contract.
- b3 `b3-terminals.md` — terminals; takes oneof tags 488-499 and adds `terminal.proto` (b3:86-99). b3:68 and b3:100 still say this brief takes "500-513"; 500-514 stands (review log R1 item 9; risk 1). D4 puts terminal ids, titles and working directories into workspace persistence, i.e. into the client-state image of 3.7 — no change on this side.
- b6 `b6-leaf-gates.md` — wasm gates for `sqlez`/`db`: single `Connection` per `ThreadSafeConnection`, `SQLITE_OMIT_SHARED_CACHE`, `wasm_lock_queue` as the default write queue on wasm (b6:169, 219-223, 756-790), the wasm arm of `open_db_with_image` (b6:286), the `wasm_lock` guard as the first line of 3.4's methods (b6:212), the scratch `:memory:` connection allowance (b6:223, 983(b)), `serialize()` awaited from `background_spawn` (b6:264, 983(a); now D7), and `GlobalKeyValueStore::init()` on wasm (b6:295-312), which D7 supersedes with the fold in 3.6a. b6 consumes this brief's 3.4-3.6 API unchanged.
- b7 `b7-edge-gates-entry.md` — the `zed_web` entry crate; calls `workspace::client_state::load_client_state`, `AppDatabase::open_with_image`, `ClientStateStore::new` (b7:8, 179, 755), forwards `project::Event::LifecycleNotice` to JS via `LifecycleKind::as_str()` (b7:594; defined in 3.16), and opens the workspace through `open_remote_project_in_new_window_with_client` (D16). D6 replaces its `Workspace::save_all(SaveIntent::Save)` on `Stopping` (b7:756, 1375) with 3.8's `snapshot_unsaved_buffers` + `flush_now`, and adds `restore_unsaved_buffers` after the workspace opens (section 9, b7 deltas).
- b8 `b8-supervisor-image.md` — the supervisor (`zs-agent`): mirrors `LifecycleBody`/`PortsBody` (b8:535-536), implements `POST /ports` / `DELETE /ports/{port}` on its loopback API (b8:677-678), re-posts `/control/ports` after every forward, stop sequence (b8:552-553; budget per D18), server environment (b8:516; no `ZS_CONTROL_SECRET` per D18), `HOME=/vercel` (b8:1427; section 2 "Paths" corrected). Its `LOCAL_API_PORT = 8446` (b8:146, 663) collides with D5's control listener — risk 20. Its `remote_extensions/pending.json` hand-off (b8:759-760, 1441) is superseded by `POST /control/extensions` (D5).
- b9 `b9-control-plane.md` — JS lifecycle toasts in the shell page (b9:787, 1211), manifest `extensions: string[]` (b9:1250; D19 fixture `docs/contracts/fixtures/manifest.example.json`), `workspaces.installed_extensions` fed by the supervisor's relay (D19), rebuild tarball now per D9 (`/workspaces` and `$HOME/.local/share/zed`; risk 18 closed), stop sequence waiting on the 5 s flush (b9:1317). Its request to autosave dirty buffers to disk inside `Stopping` (b9:1624) is replaced by D6 (snapshot into the image; the client never writes the workspace filesystem without the user saving).

## 1. Goal

Add the remaining upstream-shaped protocol messages from BUILD-SPEC 5.2 to 5.6 (client persistence, lifecycle notices, port forwarding, file-upload notification, registry-driven extension management) to `zed.proto`, with server handlers in `remote_server` and `extension_host::headless_host`, and minimal client wiring in `db`, `sqlez`, `project` and `workspace`. The server stores client state blobs under `paths::remote_server_state_dir()` and installed extensions under `paths::remote_extensions_dir()` (both inside `data_dir()`, so they live in the sandbox snapshot), receives lifecycle, port and extension-install events from the supervisor over an authenticated loopback-only control channel, and calls the supervisor over loopback HTTP to forward ports and to report the installed-extension set. Everything sandbox-specific is switched on by one call, `HeadlessProject::enable_sandbox`, that b2's `serve` makes after construction; the SSH `run` path and every existing `HeadlessAppState` construction site are untouched. The client-state image is one whole-database image of the `AppDatabase` with `GlobalKeyValueStore` folded into it (D7), serialized on `background_spawn` and flushed by exactly three triggers: the 15 s dirty timer, `visibilitychange` to hidden, and `LifecycleNotice STOPPING` (D7). On `STOPPING` the client also writes every dirty, path-backed buffer's path, text and on-disk version into the image (new table `unsaved_buffers`, D6) before that flush, and reopens those buffers dirty with the saved text on the next open; the client never writes to the workspace filesystem without the user saving (D6). The browser-only UI (ports panel, extensions panel, lifecycle toasts) is deliberately out of scope; this brief leaves typed stores and `project::Event`s for it to consume.

## 2. Existing code that matters

Protocol layer

- `crates/proto/proto/zed.proto:4-18` — imports of the per-domain proto files; a new `remote_session.proto` is added here.
- `crates/proto/proto/zed.proto:21-27` — `Envelope` and the `payload` oneof; `:519` is `GetOutgoingCallsResponse = 487; // current max`; `:522-547` reserved ranges (none above 430, so 488+ are free). b3 takes 488-499 (b3:86-99).
- `crates/proto/proto/zed.proto:556` — `message Ack {}`, the response type for fire-and-acknowledge requests.
- `crates/proto/proto/app.proto:43-62` — existing `Extension`, `SyncExtensions`, `SyncExtensionsResponse`, `InstallExtension { Extension extension = 1; string tmp_dir = 2; }`. The name `InstallExtension` is already taken by the SSH upload flow; the new registry install message therefore cannot use the spec's name verbatim (see section 4).
- `crates/proto/proto/worktree.proto:72-75` — `ProjectPath { worktree_id, path }`, reused by `FilesUploaded`; `:197-200` `UpdateUserSettings { project_id, contents }` (no keymap field; see risk 16).
- `crates/proto/proto/debugger.proto:549-553` — `ProcessInfo { pid, name, command }`, the precedent for `ListeningPort`.
- `crates/proto/proto/channel.proto:15` — `enum ChannelVisibility`; proto enum values share package scope, so new enums must not reuse value names like `Public`. No enum in `crates/proto/proto/*.proto` is named `Compression`, but this brief uses a `bool gzip` field rather than a new enum (4.1).
- `crates/proto/src/proto.rs:22-411` — `messages!(...)` block with `(Name, Foreground|Background)` priorities; `:151` `(InstallExtension, Background)`, `:276-277` SyncExtensions entries, `:406-410` last entries before the closing `);` at `:411`.
- `crates/proto/src/proto.rs:413-647` — `request_messages!(...)` pairs; `:581-582` `(SyncExtensions, SyncExtensionsResponse)`, `(InstallExtension, Ack)`; `:644-646` last three pairs before the closing `);` at `:647`.
- `crates/proto/src/proto.rs:681-877` — `entity_messages!({project_id, ShareProject}, ...)`; every message routed to a client-side entity by `project_id` must be listed here; `:875-876` last entries before `);` at `:877`.
- `crates/proto/src/proto.rs:1088-1089` — `#[cfg(test)] mod tests` (the module line is 1089).
- `crates/proto/src/macros.rs:2-49` — `messages!` generates `build_typed_envelope` and `EnvelopedMessage`; `:52-58` `request_messages!`; `:61-71` `entity_messages!` extracts `self.$id_field` as `u64`.
- `crates/proto/build.rs:3` — `protox::compile(["proto/zed.proto"], ["proto"])`: any file imported from `zed.proto` under `proto/` compiles without build-script changes. Generated Rust enum variants keep the proto value name in UpperCamelCase; prost strips a prefix only when the value is spelled `ENUM_NAME_...`, so `PortPrivate` stays `proto::PortVisibility::PortPrivate` and `IdleStopIn` stays `proto::LifecycleKind::IdleStopIn`.
- `crates/rpc/src/proto_client.rs:229-239` `AnyProtoClient::request`, `:258-261` `send`; `:450-484` `add_request_handler(weak_entity, handler)`; `:486-492` `add_entity_request_handler`; `:594-624` `add_entity_message_handler`; `:626-635` `subscribe_to_entity` keyed by `(TypeId::<E>, remote_id)` and panics on double subscription; `:117-129` registering two handlers for one message type panics (this is why `enable_sandbox` must run at most once).
- `crates/remote/src/remote_client.rs:538-546` `proto_client_from_channels`; `:1001` `RemoteClient::proto_client()`; `:340-343` `RemoteClientEvent { Disconnected { server_not_running: bool }, Reconnected }` (emitted at `:939` and `:761`; `:934-942` emits `Disconnected` for *both* terminal states, `is_reconnect_exhausted() || is_server_not_running()`, with `server_not_running` false for `ReconnectExhausted` — so "terminal" on the client side means any `Disconnected`, D2); `:1117` `simulate_disconnect` (test-support); `:1152-1159` `fake_server`, `:1185-1209` `connect_mock` (test harness); `:1861-1870` a message with no registered handler gets an error response (`"no handler registered for {type_name}"`) and is otherwise ignored, on either side of the channel; `:989-999` `upload_directory` (the SSH extension upload path that the WebSocket transport cannot serve).
- `crates/remote/src/remote_client.rs:1746-1748` — the `buffer` of sent envelopes is trimmed only by `ack_id`; `:1780` `max_received` is stored but never used to drop duplicates; `:1910-1925` `resync` re-sends the whole buffer after a reconnect; `:2036-2044` `send_buffered`. Consequence: a request whose response was lost in a disconnect is replayed verbatim, so server handlers must be idempotent under replay (3.9).
- `crates/remote/src/protocol.rs:9-10` — `MessageLen = u32`; the only framing limit is the 16 MiB WebSocket frame ceiling from BUILD-SPEC 4.4, which bounds `SaveClientState.sqlite`.

Server

- `crates/remote_server/src/server.rs:1-9` — module list (`mod headless_project;`, test module, `pub use headless_project::{HeadlessAppState, HeadlessProject}`); new modules are declared here.
- `crates/remote_server/src/server.rs:62-83` — `Commands { Run, Proxy, Version }`; b2 adds `Serve`.
- `crates/remote_server/src/server.rs:314-332` — `init_telemetry_forwarding(session, cx)`: precedent for a background task that owns a cloned `AnyProtoClient` and calls `session.send` from a background executor (the control channel does the same).
- `crates/remote_server/src/server.rs:334-385` — `handle_crash_files_requests(project, client)`: precedent for wiring behaviour onto a `HeadlessProject` outside `HeadlessProject::new`; `enable_sandbox` (3.14) follows it.
- `crates/remote_server/src/server.rs:403-410, 443-452` — `start_server` and its 10-minute `IDLE_TIMEOUT` (replaced in `serve` by b2; not touched here).
- `crates/remote_server/src/server.rs:542-558` — `init_paths()`: an array of `&'static PathBuf` (`paths::*_dir()` references). Not modified: the client-state directory is created lazily by `ClientStateStore` (3.9), so no owned `PathBuf` has to be threaded into this array.
- `crates/remote_server/src/server.rs:674` — `extension::init(cx)` runs before `HeadlessProject::new`; `crates/extension/src/extension.rs:27-30` calls `extension_events::init(cx)`, which `cx.set_global(GlobalExtensionEvents(..))` (`extension_events.rs:7-9`), so `ExtensionEvents::try_global` is `Some` in both `run` and `serve`.
- `crates/remote_server/src/server.rs:679-721` — construction of `HeadlessProject` with `HeadlessAppState { session, fs, http_client, node_runtime, languages, extension_host_proxy, startup_time }`; `:683-699` the `ReqwestClient` is built with the user's proxy settings (relevant: supervisor calls must bypass the proxy); `:723` `handle_crash_files_requests(&project, &session)`; `:731` `mem::forget(project)`.
- `HeadlessAppState { .. }` struct literals exist at 25 sites: `server.rs:709`, `remote_editing_tests.rs:228, 4717`, `crates/zed/src/zed.rs:3068`, `crates/recent_projects/src/remote_connections.rs:551, 633, 760, 852, 913`, `crates/sidebar/src/sidebar_tests.rs:402, 13512, 13679, 15181`, `crates/collab/tests/integration/remote_editing_collaboration_tests.rs:100, 262, 439, 715, 888, 1026, 1139, 1346, 1626`, plus the destructuring pattern in `HeadlessProject::new` (`headless_project.rs:93-101`). Adding a field to the struct breaks all of them; this brief therefore adds none.
- `crates/remote_server/src/headless_project.rs:52-74` — `HeadlessProject` fields; `:76-84` `HeadlessAppState`; `:269-276` `HeadlessExtensionStore::new(fs, http_client, paths::remote_extensions_dir(), proxy, node_runtime, cx)`; `:279-290` `subscribe_to_entity` calls; `:292-297` `add_request_handler(cx.weak_entity(), ...)` registrations; `:317-324` extension handler registrations; `:342-362` struct literal returned by `new`.
- `crates/remote_server/src/headless_project.rs:445-453` — sending `proto::Toast` with `project_id: REMOTE_SERVER_PROJECT_ID` (pattern for server-initiated messages).
- `crates/remote_server/src/headless_project.rs:568-580` — `handle_remove_worktree` (minimal `Result<proto::Ack>` handler shape); `:1232-1265` `handle_get_processes` (handler without entity state); `:1315-1333` `handle_get_directory_environment`.
- `crates/remote_server/src/remote_editing_tests.rs:200-262` — test that keeps `server_session` and calls `server_session.send(proto::TelemetryEvent{...})` to drive a server-to-client message; `:2780-2810` — `client.simulate_disconnect(cx)` followed by a request, asserting `RemoteClientEvent::Reconnected` (pattern for the replay test in section 6); `:4695-4740` `init_test(server_fs, cx, server_cx) -> (Entity<Project>, Entity<HeadlessProject>)`; `:4746-4771` `build_project` (constructs `Project::remote`).
- `crates/remote_server/Cargo.toml:24-76` — deps (has `futures`, `http_client`, `serde_json`, `uuid`, `watch`, `extension_host`, `paths`, `release_channel`; lacks `serde`, `postage`, `subtle`); `:82-105` dev-deps (has `fs`, `http_client`, `remote`, `project` with `test-support`, `tempfile`).
- `crates/remote_server/src/main.rs:6-22` — CLI struct; unchanged by this brief (b2 owns `ServeArgs`).

Extensions on the server

- `crates/extension_host/src/headless_host.rs:29-35` `ExtensionVersion { id, version, dev, content_fingerprint }`; `:37-38` `STALE_UPLOAD_TTL = 3 × REMOTE_SYNC_TIMEOUT` (3 h; `extension_host.rs:83`); `:40-49` `HeadlessExtensionStore` fields (`fs`, `extension_dir`, `proxy`, `wasm_host`, `loaded_extensions: BTreeMap<Arc<str>, LoadedExtension>`, `failed_removals: HashSet<Arc<str>>`, `operation_lock`, `_stale_uploads_sweep: Task<()>`); `:51-60` `LoadedExtension`; `:71-79` the sweep task deletes entries of `remote_extensions_uploads_dir()` older than `STALE_UPLOAD_TTL` (so registry downloads must not stage there); `:84-89` `WasmHost::new(.., extension_dir.join("work"), cx)` — `extension_dir/work` is a subdirectory without a manifest, which the startup scan (3.13) must skip.
- `crates/extension_host/src/headless_host.rs:62-100` — `new(...)`: does not scan `extension_dir`; nothing on disk is loaded until a client sends `SyncExtensions`. In the sandbox (server restarts on every resume) this means installed extensions must be reloaded from disk at startup.
- `crates/extension_host/src/headless_host.rs:102-135` — `sync_extensions`: `to_remove` is every `loaded_extensions` key absent from the client's list, and `to_load` is every client entry that is new, has a different version, or is `dev`. Unchanged, a desktop connect over the WebSocket transport would uninstall every registry-installed extension and then fail to upload replacements (b1:171). Section 3.13 makes sync additive in sandbox mode.
- `crates/extension_host/src/headless_host.rs:206-249` `load_extension(store: WeakEntity<Self>, extension: &ExtensionVersion, cx: &mut AsyncApp) -> Result<bool>` (loads from `extension_dir/<id>`); `:251-312` `prepare_extension`; `:260` `ExtensionManifest::load(fs, &load_dir)`; `:262` `debug_assert!(!manifest.languages.is_empty() || manifest.allow_remote_load())` (asset-only extensions such as themes would trip this in debug builds); `:264-269` version equality check against `ExtensionVersion.version`.
- `crates/extension_host/src/headless_host.rs:486-510` `uninstall_extension(&Arc<str>)` (private; `extension_dir.join(extension_id)` then `fs.remove_dir(.., recursive: true)` — no validation of the id); `:512-619` `install_extension(ExtensionVersion, tmp_path, cx)` (spawned task: validates, removes the existing dir at `:565-572`, renames `tmp_path` into place at `:573`, commits, emits `ExtensionsInstalledChanged`); `:621-660` `handle_sync_extensions`; `:662-688` `handle_install_extension`; `:779-785` `notify_extensions_changed` emits `extension::Event::ExtensionsInstalledChanged` on the `ExtensionEvents` global.
- `crates/extension_host/src/extension_host.rs:3-4` `pub mod headless_host; pub mod wasm_host;`; `:66-69` imports `wasm_host::wit::wasm_api_version_range`; `:106` `CURRENT_SCHEMA_VERSION`; `:112-130` `SUPPRESSED_EXTENSIONS`; `:133-135` `pub fn schema_version_range()`.
- `crates/extension_host/src/extension_host.rs:216-222` — desktop `ExtensionIndex { extensions: BTreeMap<Arc<str>, ExtensionIndexEntry>, themes, icon_themes, languages }` persisted to `extensions_dir()/index.json` (`:378`, `:1750`). The headless store keeps no index file (3.13 derives everything from `extension.toml`).
- `crates/extension_host/src/extension_host.rs:786-822` `fetch_extensions_from_api(path, query)` (registry search: `build_zed_api_url`, GET, parse `GetExtensionsResponse`, filter suppressed) — desktop-only today, extracted to a free function by this brief; `:634-658` `fetch_extensions` query shape (`max_schema_version`, `filter`, `provides`); `:948-967` latest-version download URL (`/extensions/{id}/download` with schema and wasm-api ranges); `:999-1004` pinned-version URL (`/extensions/{id}/{version}/download`); `:861-923` download, `GzipDecoder` + `async_tar::Archive::unpack` into a `tempfile::tempdir_in(staging_dir)` held in the same async block until the rename at `:907-916` (the `TempDir` guard must outlive the rename).
- `crates/extension_host/src/extension_host.rs:2075-2157` `sync_extensions_to_remote` and `:2218-2283` `upload_extension_to_remote` (SSH flow using `upload_directory` then `InstallExtension`); `:2285-2325` `register_remote_client`. Left intact; see risk 3.
- `crates/extension_host/src/wasm_host/wit.rs:60` `pub fn wasm_api_version_range(release_channel)`.
- `crates/extension_host/Cargo.toml:20-21` `async-compression`, `async-tar`; `:24` `cloud_api_types`; `:32` `http_client`; `:41` `release_channel`; `:49` `tempfile` (workspace `tempfile = "3.20.0"`, `Cargo.toml:829`, which has `TempDir::keep()`); everything the registry installer needs is already there.
- `crates/extension_host/src/extension_store_test.rs:1679-1701` — `HeadlessExtensionStore::new(fs, FakeHttpClient::with_200_response(), PathBuf::from("/extensions"), proxy, NodeRuntime::unavailable(), cx)` plus a subscription on `extension::ExtensionEvents::try_global(cx)` counting `ExtensionsInstalledChanged` (test pattern to reuse).
- `crates/cloud_api_types/src/extension.rs:9-19` `ExtensionApiManifest`; `:38-53` `ExtensionProvides` (kebab-case `Display`); `:67-73` `ExtensionMetadata { id, manifest, published_at, download_count }`; `:76-78` `GetExtensionsResponse { data }`.
- `crates/extension/src/extension_manifest.rs:84-123` `ExtensionManifest` fields (`id: Arc<str>`, `name: String`, `version: Arc<str>`, `schema_version`, `description`, `repository`, `authors`, `themes`, `languages`, `grammars`, `language_servers`, ...); `:185-194` `allow_remote_load()` / `remote_load()`; `:390` `pub async fn load(fs: Arc<dyn Fs>, extension_dir: &Path) -> Result<Self>`. No extension-id validation exists in `crates/extension` or `crates/extension_host` (grep for `Regex::new`/`fn validate`: none).
- `crates/extension/src/extension_events.rs:36-41` `Event::{ExtensionInstalled, ExtensionUninstalled, ExtensionsInstalledChanged, ConfigureExtensionRequested}`.
- `crates/http_client/src/http_client.rs:123-169` `HttpClient` trait: `send(req)` at `:128`, `get` at `:133`, `post_json(uri, body)` at `:154-167` builds its own request (uri, `POST`, `Content-Type`) and accepts no headers; `:224-230` `#[derive(Deref)] HttpClientWithUrl { base_url, #[deref] client: HttpClientWithProxy }`; `:232-245` `HttpClientWithUrl::new(client, base_url, proxy_url)`; `:277-284` `build_zed_api_url` maps `https://zed.dev` to `https://api.zed.dev`; `:335` `impl HttpClient for HttpClientWithUrl` (this impl, not `Deref`, is what lets an `Arc<HttpClientWithUrl>` be passed as `Arc<dyn HttpClient>`); `:431` `FakeHttpClient::create(handler) -> Arc<HttpClientWithUrl>`.
- `crates/client/src/client.rs:59` `pub use rpc::*;` (how `workspace` reaches `proto`/`AnyProtoClient`, e.g. `crates/workspace/src/dock.rs:7` `use client::proto;`); `:63-64` `ZED_SERVER_URL` env override; the server mirrors it for the registry base URL.

Paths

- `crates/paths/src/paths.rs:144-160` `data_dir() -> &'static PathBuf` (Linux: `$XDG_DATA_HOME/zed`, else `$HOME/.local/share/zed`; in the sandbox image `HOME=/vercel`, so the server data dir is `/vercel/.local/share/zed` — b8:62, 1427, correcting an earlier `/home/ubuntu` claim of this brief; BUILD-SPEC 6.1 item 5 puts it on the persisted filesystem and D9 puts `$HOME/.local/share/zed` into the rebuild tarball); `:240-243` `remote_server_state_dir() = data_dir()/server_state` (reserved for the server's own state; b2:53 notes it is unused by `serve`) — the client-state directory goes under it; `:258-261` `database_dir()`; `:356-359` `remote_extensions_dir()`; `:364-367` `remote_extensions_uploads_dir()`; `:103-119` `set_custom_data_dir` (must be called before any `data_dir()` use; relevant if b2 adds `--data-dir`).

Client persistence

- `crates/db/src/db.rs:30-36` `DomainMigration { name, migrations, dependencies, should_allow_migration_change }`; `:41-43` `AppDatabase(pub ThreadSafeConnection)` global; `:63-67` `AppDatabase::new()` calls `gpui::block_on(open_db::<AppMigrator>(db_dir, *RELEASE_CHANNEL))` (blocking: native only); `:71-76` `test_new`; `:125-134` `CONNECTION_INITIALIZE_QUERY` / `DB_INITIALIZE_QUERY` — the latter runs `PRAGMA journal_mode=WAL`, so every native file database is in WAL mode and its serialized image carries WAL header bytes; `:140` `ALL_FILE_DB_FAILED` static; `:174-203` `open_db` (falls back to in-memory on failure); `:205-213` `open_main_db` uses `ThreadSafeConnection::builder::<M>(path, true)`; `:215-225` `open_fallback_db` ends in `.expect("Fallback in memory database failed...")` — any image-induced failure there would panic, which 3.6 prevents by validating the image before it touches either database; `:287-293` `write_and_log`.
- `crates/db/src/kvp.rs:12-18, 72-75` — `KeyValueStore` writes go through `ThreadSafeConnection::write`, as do the 12 write sites in `crates/workspace/src/persistence.rs` and the async arms of the `query!` macro (`crates/db/src/query.rs:20, 49, 65`). The sync arm (`query.rs:31-43`) runs `exec_bound` on the per-thread read connection, and `crates/sqlez/src/statement.rs:75` bails on any non-readonly statement prepared on a connection that `!can_write()`; that check, not the call sites, is what guarantees a write-generation counter inside `ThreadSafeConnection::write` observes every successful mutation.
- `crates/db/src/kvp.rs:15-17` `KeyValueStore::from_app_db(&AppDatabase)`; `:20-41` the `KeyValueStore` domain: step 0 `kv_store(key, value)`, step 1 `scoped_kv_store(namespace, key, value)` (`:30-37`), registered on the `AppDatabase` by `static_connection!(KeyValueStore, [])`; `:89-146` `ScopedKeyValueStore { store, namespace }` with `read`/`write`/`delete`/`delete_all` over `scoped_kv_store`. `:224-279` `GlobalKeyValueStore(ThreadSafeConnection)`: its own `Domain` (`kv_store` again, `:226-234`), opened as a *separate* database file under `GlobalDbScope` (`db.rs:153-159`, path `database_dir()/0-global/db.sqlite`) through a `LazyLock` + `gpui::block_on` (`:243-250`), `global() -> &'static Self` (`:253-255`), and `read_kvp`/`write_kvp`/`delete_kvp` (`:257-278`). Consumers: `crates/zed/src/main.rs:1383` (desktop only, excluded from the browser build) and `crates/prompt_store/src/rules_to_skills_migration.rs:108-124, 486-500` (the rules→skills migration flag; `prompt_store` is in the browser build, b6 3.5). Nothing dereferences `GlobalKeyValueStore` to run raw SQL, so D7's fold (3.6a) only has to keep those three methods.
- `crates/db/src/db.rs:247-285` `static_connection!(T, [deps])`: `Deref`/`Clone`, `T::global(cx) = T(AppDatabase::global(cx).clone())`, `open_test_db`, and the `inventory::submit!` of a `DomainMigration` (name, migrations, dependency names, `should_allow_migration_change`) — the mechanism 3.8's `UnsavedBuffersDb` uses; `crates/editor/src/persistence.rs:229` `static_connection!(EditorDb, [WorkspaceDb])` and `:132-140` the `editors` table (`workspace_id` foreign key to `workspaces(workspace_id)` `ON DELETE CASCADE ON UPDATE CASCADE`, `STRICT`) are the pattern the `unsaved_buffers` table copies.

Unsaved buffers (D6)

- `crates/project/src/project_settings.rs:92` `session.restore_unsaved_buffers: bool` (default `true`; `settings_content/src/project.rs:416`). `crates/editor/src/items.rs:1462-1534` `impl SerializableItem for Editor::serialize`: for a *singleton* editor with `BufferSerialization::All` it stores `SerializedEditor { abs_path, contents: Some(text) if dirty, language, mtime: buffer.saved_mtime() }` in the `editors` table (`crates/editor/src/persistence.rs:20-26`), triggered by `should_serialize` on `Saved | DirtyChanged | BufferEdited | FileHandleChanged` (`:1536-1544`) through the workspace's item queue, which is throttled by `SERIALIZATION_THROTTLE_TIME = 200 ms` (`crates/workspace/src/workspace.rs:174, 7543-7577`) and runs on `background_spawn`. `:1273-1460` `deserialize`: for `abs_path: Some, contents: Some` it opens the project path and calls `restore_serialized_buffer_contents` (`:2325-2340`: `buffer.did_reload(buffer.version(), buffer.line_ending(), mtime, cx)` so the stored mtime becomes `saved_mtime` and a newer on-disk file shows as a conflict, then `set_text(contents)`, then `forget_transaction` of the resulting undo entry so undo cannot revert to the disk text); untitled buffers (`abs_path: None, contents: Some`) are recreated with `create_buffer`. Consequences for D6: the existing mechanism already covers dirty buffers that have a singleton editor item, is throttled (the last 200 ms of edits before `STOPPING` may be missing), and covers nothing without an item; 3.8's `unsaved_buffers` table is the synchronous, item-independent snapshot taken at `STOPPING`, and its restore reuses exactly the `did_reload` + `set_text` + `forget_transaction` sequence (all three are `pub` on `language::Buffer`, so `workspace` needs no `editor` dependency).
- `crates/project/src/buffer_store.rs:1067` `BufferStore::buffers() -> impl Iterator<Item = Entity<Buffer>>`; `:1098` `get_by_path(&ProjectPath)`; `crates/project/src/project.rs:6370` `Project::buffer_store()`, `:3263` `open_buffer(path, cx) -> Task<Result<Entity<Buffer>>>` (returns `ErrorCode::Disconnected` when `is_disconnected`, `:3021`), `:3151` `open_path(ProjectPath, cx) -> Task<Result<(Option<ProjectEntryId>, Entity<Buffer>)>>`, `:4883` `find_worktree(abs_path, cx)`, `:5208` `absolute_path(&ProjectPath, cx)`, `:5233` `find_project_path(path, cx) -> Option<ProjectPath>`, `:2489` `worktree_for_id`. Worktree ids are assigned by the server per session and a fresh session resets the server's worktrees (D3), so the snapshot keys buffers by absolute path (as `editors.abs_path` does), never by `worktree_id`.
- `crates/language/src/buffer.rs:1492` `file()`, `:1497` `saved_version()` (a `clock::Global` — replica-scoped, meaningless across sessions), `:1502` `saved_mtime() -> Option<MTime>` (the on-disk version the edits were made against; this is D6's "version"), `:2494` `is_dirty()`, `:2516-2530` `has_conflict()` (`disk mtime > saved_mtime && has_unsaved_edits`), `:2785` `set_text(text, cx)` (a diffing edit; identical text is a no-op), `:2661` `forget_transaction`; `crates/text/src/text.rs:1305` `peek_undo_stack`. `crates/fs/src/fs.rs:366-378` `MTime::from_seconds_and_nanos` / `to_seconds_and_nanos_for_persistence` (what `editors.mtime_seconds/mtime_nanos` store).
- `crates/workspace/src/workspace.rs:726` `WorkspaceId(i64)`; `:7227` `Workspace::database_id() -> Option<WorkspaceId>`; `:2748` `project()`; `:4852-4875` `open_path` / `open_path_preview(path, pane, focus_item, allow_preview, activate, window, cx)` (`activate: false` adds a tab without changing the active item — used by the restore to make a dirty buffer that has no item visible); `:7368-7383` `serialize_workspace` (throttled) and `:7385` `serialize_workspace_internal(window, cx) -> Task<()>`. `crates/workspace/Cargo.toml` already depends on `language`, `fs`, `project`, `db`, `sqlez`, `serde`, so 3.8's additions need no manifest change (section 5).
- `crates/editor/src/persistence.rs:272, 322, 374` — `save_scroll_position`, `save_editor_selections`, `save_file_folds` write on scroll and selection changes, so the client database is dirty almost continuously while editing; the 15 s ticker and gzip (3.7, 3.8) bound the resulting traffic.
- `crates/db/Cargo.toml:18-30` — deps (`gpui`, `sqlez`, `paths`, `uuid`, ...; no `futures`).
- `crates/sqlez/src/connection.rs:12-17` `Connection { sqlite3: *mut sqlite3 (pub(crate)), persistent, write }`; `:46-52` `open`; `:56-58` `open_file` falls back to `open_memory(Some(uri))`; `:60-72` `open_memory` (shared-cache `file:<uri>?mode=memory&cache=shared`); `:82-94` `backup_main(&self, destination)` via `sqlite3_backup_*`; `:201-221` `last_error` returns `Ok(())` for `SQLITE_OK`/`SQLITE_ROW` (so a null pointer from `sqlite3_serialize` with `SQLITE_OK` must be handled explicitly); `:223-228` `with_write`; `:269-273` `Drop` closes the handle.
- `crates/sqlez/src/domain.rs:12-14` `trait Migrator { fn migrate(connection: &Connection) -> Result<()> }` (used by the dry-run in 3.5); `crates/sqlez/src/migrations.rs:37-90` `Connection::migrate` runs inside a savepoint, ignores completed steps beyond the code's list, and bails with `"Migration changed for {domain} at step {index}"` when a stored step's text differs unless `should_allow_migration_change` accepts it (`:77`).
- `crates/sqlez/src/thread_safe_connection.rs:34-39` `ThreadSafeConnection { uri, persistent, connection_initialize_query, connections: Arc<ThreadLocal<Connection>> }`; `:79-126` `ThreadSafeConnectionBuilder::build` calls `initialize_queues` then runs `db_initialize_query` and migrations inside one `write` (the restore hook must run before both); `:130-141` `initialize_queues` defaults to `background_thread_queue` (`:282-297`, a `std::thread`); `:306-314` `locking_queue` (inline, no thread; b6 makes it the wasm default); `:143-155` `builder`; `:169-190` `write(callback)` queues onto the per-URI write queue and returns through a `oneshot`; `:192-243` `create_connection` (per-thread read-only connections on native).
- `crates/sqlez/Cargo.toml:11-23` — `libsqlite3-sys.workspace = true`; workspace `Cargo.toml:674` pins `libsqlite3-sys = { version = "0.30.1", features = ["bundled"] }`. Bundled SQLite is 3.46.0 (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/libsqlite3-sys-0.30.1/sqlite3/bindgen_bundled_version.rs:27`), and `sqlite3_serialize` / `sqlite3_deserialize` are bound at `:2611` / `:2619` with `SQLITE_DESERIALIZE_FREEONCLOSE` / `SQLITE_DESERIALIZE_RESIZEABLE` at `:488-489`. No new C flags are needed. Semantics that matter (`libsqlite3-sys-0.30.1/sqlite3/sqlite3.h:10776-10778`): "The deserialized database should not be in WAL mode. If the database is in WAL mode, then any attempt to use the database file will result in an SQLITE_CANTOPEN error"; the documented workaround is to set header bytes 18-19 to 1 before deserializing. `sqlite3_serialize` (`sqlite3.c:53615-53690`) reads pages through the pager (so WAL frames are included) and returns a null pointer with size 0 for a database that has no pages yet.
- Community fork evidence (read-only, `/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad/zed-web/crates`): `db/src/db.rs:101-113` gates an async `prepare_web_database()` under `cfg(target_family = "wasm")` because `block_on` is unavailable there; `sqlez/src/lib.rs:3-29` swaps `connection`, `migrations`, `statement` modules by target and routes SQL to the server over an HTTP RPC (`remote_sql.rs`). We keep neither: b6 runs SQLite in the browser on `sqlite-wasm-rs`, and only the serialized image crosses the wire.

Client project and workspace

- `crates/project/src/project.rs:1-34` module list (`pub mod ...`), where new modules are added; `:113` `use remote::{RemoteClient, ...}`; `:230` `remote_client: Option<Entity<RemoteClient>>` field; `:331-334` `ToastLink`; `:336-337` `#[derive(Clone, Debug, PartialEq)] pub enum Event`; `:354-362` `Event::Toast` / `Event::HideToast`; `:446-449` `ProjectPath`; `:459` `ProjectPath::from_proto`, `:466` `to_proto`.
- `Project` struct literals: `local` at `:1364-1385` (`remote_client: None` at `:1385`), `remote` at `:1634`, `from_join_project_response` (the `in_room`/join path) at `:1910`. All three must set the new `Option` fields.
- `crates/project/src/project.rs:1413-1436` `Project::remote(...)` obtains `remote_proto` from `remote.read(cx).proto_client()`; `:1654-1663` `subscribe_to_entity(REMOTE_SERVER_PROJECT_ID, ...)` for each store; `:1665-1680` client-side `add_entity_message_handler` / `add_entity_request_handler` registrations (`handle_toast` at `:1670`, `handle_hide_toast` at `:1673`, `handle_find_search_candidates_cancel` at `:1680`); `:1681-1690` `Store::init(&remote_proto)` calls; `:2259` `remote_client()`; `:3067` `is_via_remote_server`. The remote-server handlers are registered only inside `Project::remote`; `Project::init` registers collab handlers on `Client`.
- `crates/project/src/project.rs:5497-5510` `handle_toast` (shape of an entity message handler that emits an `Event`); `:5597-5608` `handle_hide_toast`.
- `crates/project/src/worktree_store.rs:463-467` `find_worktree(abs_path, cx) -> Option<(Entity<Worktree>, Arc<RelPath>)>`.
- `crates/worktree/src/worktree.rs:769` `Worktree::as_local()`; `:1303` `impl LocalWorktree`; `:2113-2122` `LocalWorktree::refresh_entries_for_paths(paths) -> postage::barrier::Receiver` (forces a rescan of specific paths; used after an upload). `remote_server` has no `postage` dependency; the workspace pins `postage` with `features = ["futures-traits"]` (`Cargo.toml:752`), so the receiver is awaited with `futures::StreamExt::next`.
- `crates/workspace/Cargo.toml` — depends on `client` (`:34`), `db` (`:38`), `postage`, `remote` (`:55`), `serde`, `sqlez`; no `rpc`/`proto` line. `proto` and `AnyProtoClient` are reached through `client::proto` / `client::AnyProtoClient` (`client.rs:59`), as `dock.rs:7` does.
- `crates/project/Cargo.toml:80-81` — `project` depends on `remote` and `rpc` (so `PortStore` and `RemoteExtensionStore` can use `proto` directly) and has no `db` or `extension_host` dependency.
- `crates/gpui/src/global.rs:22` `pub trait Global: 'static {}` (no `Send + Sync` bound).
- `crates/fs/src/fs.rs:99, 113, 128, 135-138, 142` — `Fs::{create_dir, rename, remove_file, load_bytes, atomic_write, write, metadata}` used by the server-side stores so `FakeFs` works in tests.
- Workspace manifest: `serde = { version = "1.0.221", features = ["derive", "rc"] }` (`Cargo.toml:802`; `rc` is what lets `Arc<str>` fields derive `Serialize`/`Deserialize`); `async-compression = { version = "0.4", features = ["bzip2", "gzip", "futures-io"] }` (`:536`; its gzip backend is `flate2`'s pure-Rust `miniz_oxide`, so it builds for wasm32); `zstd = "0.11"` (`:912`, C-backed, not used here).

## 3. Change list

Dependency order: proto first, then sqlez/db (client persistence primitives), then server modules, then client stores and project events.

### 3.1 `crates/proto/proto/remote_session.proto` (new)

All messages of this brief, in one neutrally named file to keep the upstream diff to `zed.proto` to two lines (the name is not product-specific; a later upstream split by domain is a file move). Full text in section 4. Imports `worktree.proto` for `ProjectPath`.

### 3.2 `crates/proto/proto/zed.proto` (modify)

- Line 18: add `import "remote_session.proto";` after `import "worktree.proto";`.
- Lines 519-520: append the oneof entries below after `GetOutgoingCallsResponse get_outgoing_calls_response = 487;` (after b3's 488-499 block if b3 lands first) and move the `// current max` comment to the last one. This brief takes tags 500-514 (15 messages).

```proto
    SaveClientState save_client_state = 500;
    SaveClientStateResponse save_client_state_response = 501;
    LoadClientState load_client_state = 502;
    LoadClientStateResponse load_client_state_response = 503;
    LifecycleNotice lifecycle_notice = 504;
    PortsChanged ports_changed = 505;
    ForwardPort forward_port = 506;
    ForwardPortResponse forward_port_response = 507;
    UnforwardPort unforward_port = 508;
    FilesUploaded files_uploaded = 509;
    ListExtensions list_extensions = 510;
    ListExtensionsResponse list_extensions_response = 511;
    InstallRegistryExtension install_registry_extension = 512;
    UninstallExtension uninstall_extension = 513;
    ExtensionsChanged extensions_changed = 514; // current max
```

### 3.3 `crates/proto/src/proto.rs` (modify)

- In `messages!` (before the `);` at line 411), add:

```rust
    (SaveClientState, Background),
    (SaveClientStateResponse, Background),
    (LoadClientState, Background),
    (LoadClientStateResponse, Background),
    (LifecycleNotice, Foreground),
    (PortsChanged, Background),
    (ForwardPort, Background),
    (ForwardPortResponse, Background),
    (UnforwardPort, Background),
    (FilesUploaded, Foreground),
    (ListExtensions, Background),
    (ListExtensionsResponse, Background),
    (InstallRegistryExtension, Background),
    (UninstallExtension, Background),
    (ExtensionsChanged, Background),
```

- In `request_messages!` (before line 647):

```rust
    (SaveClientState, SaveClientStateResponse),
    (LoadClientState, LoadClientStateResponse),
    (ForwardPort, ForwardPortResponse),
    (UnforwardPort, Ack),
    (ListExtensions, ListExtensionsResponse),
    (InstallRegistryExtension, Ack),
    (UninstallExtension, Ack),
```

- In `entity_messages!({project_id, ShareProject}, ...)` (before line 877), add the four server-to-client notifications that the client routes to an entity subscribed under `REMOTE_SERVER_PROJECT_ID`: `LifecycleNotice, PortsChanged, FilesUploaded, ExtensionsChanged`. The request messages are handled on the server with `add_request_handler(weak_entity, ...)` (`headless_project.rs:292-297` style) and do not need `EntityMessage`.

### 3.4 `crates/sqlez/src/connection.rs` (modify)

Add three methods to `impl Connection` next to `backup_main` (after line 94):

```rust
/// Copies the `main` database into a standalone SQLite image (header + pages).
/// Returns `Ok(Vec::new())` for a database that has no pages yet (`sqlite3_serialize`
/// yields a null pointer with size 0 there; `last_error` would report `Ok`, so the
/// size is checked explicitly, and a null pointer with size > 0 is an allocation error).
pub fn serialize_main(&self) -> Result<Vec<u8>>;

/// Opens a private `:memory:` scratch connection and `sqlite3_deserialize`s `image`
/// into it (buffer from `sqlite3_malloc64`, flags FREEONCLOSE|RESIZEABLE). Before the
/// call, header bytes 18-19 (write/read file-format versions) are set to 1 on the
/// copied buffer: images produced from a WAL-mode file database carry 2 there and
/// SQLite refuses to use a deserialized WAL database (SQLITE_CANTOPEN;
/// sqlite3.h:10776-10778). Rejects images shorter than 100 bytes or without the
/// "SQLite format 3\0" magic before touching SQLite.
pub fn open_scratch_from_image(image: &[u8]) -> Result<Connection>;

/// Replaces the contents of `main` with the contents of `source` via `backup_main`.
/// `self` should be empty and not yet in WAL mode (the backup then adopts the source
/// page size); backing up into a non-empty WAL database with a different page size
/// fails with SQLITE_READONLY and is not supported here.
pub fn restore_main_from(&self, source: &Connection) -> Result<()>;   // source.backup_main(self)
```

`serialize_main` calls `sqlite3_serialize(self.sqlite3, "main", &mut size, 0)`, copies `size` bytes into a `Vec<u8>`, then `sqlite3_free`s the buffer. Going through a scratch connection plus `backup_main` (rather than `sqlite3_deserialize` on `self`) does two things: on native it keeps `self` attached to its file / shared-cache URI so the per-thread read connections in `ThreadSafeConnection` see the restored pages, and on every target it lets 3.5 validate the image (including a migration dry-run) before the application database is touched. All FFI is `unsafe` internally only. No change to `Drop` (line 269). On wasm, b6 prepends `#[cfg(target_family = "wasm")] let _guard = crate::wasm_lock::lock();` as the first statement of all three methods (b6:212, the same line its other FFI entry points get); whichever brief lands second adds the line. `open_scratch_from_image` opens a second private database beside the main one, which b6's `SQLITE_OMIT_SHARED_CACHE` build and URI-ignoring `open_memory` allow (b6:223, 983(b)); the scratch is dropped before `build_with_outcome` returns, so it never overlaps a main-connection write (b6:985).

### 3.5 `crates/sqlez/src/thread_safe_connection.rs` (modify)

- Line 34-39: add `write_generation: Arc<AtomicU64>` to `ThreadSafeConnection`; initialize in `builder` (line 147-152) and `new` (line 254).
- Line 169-190 `write`: after `callback(connection)` returns, `thread_safe_connection.write_generation.fetch_add(1, Ordering::Release)`.
- New methods on `impl ThreadSafeConnection`:

```rust
pub fn write_generation(&self) -> u64;
pub fn serialize(&self) -> impl Future<Output = Result<Vec<u8>>>;   // self.write(|c| c.serialize_main())
```

- `ThreadSafeConnectionBuilder` (line 44-49): add `restore_image: Option<Vec<u8>>` and

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestoreOutcome { NoImage, Restored, Skipped(String) }

pub fn with_restore_image(mut self, image: Vec<u8>) -> Self;
/// Like `build`, but also reports what happened to the restore image.
pub async fn build_with_outcome(self) -> anyhow::Result<(ThreadSafeConnection, RestoreOutcome)>;
```

`build` delegates to `build_with_outcome` and drops the outcome. In `build_with_outcome` (line 85-123), inside the same `write` closure and before `db_initialize_query` runs, if `restore_image` is `Some`:

1. `let scratch = Connection::open_scratch_from_image(&image)?` (header check, WAL bytes patched, deserialize);
2. dry-run the migrations on the scratch: `M::migrate(&scratch)?` (`domain.rs:12-14`). This is where a changed migration text (`migrations.rs:77-85`) or a corrupt page surfaces — on the scratch, not on the application database;
3. `connection.restore_main_from(&scratch)?` (backup into the still-empty, non-WAL `main`);
4. drop the scratch.

Any `Err` in steps 1-3 is logged at `warn`, recorded as `RestoreOutcome::Skipped(err.to_string())`, and the build continues with an empty database exactly as if no image had been given (`main` is untouched because the backup either completes or rolls back). `db_initialize_query` (which sets WAL on native) and `M::migrate(connection)` then run as today; after a successful restore the migrations are already recorded and are no-ops, and an image from an older build is upgraded because the dry-run applied the missing steps on the scratch before the copy. An image from a *newer* build opens too (extra completed steps are ignored by `migrate`) unless a step's text differs, in which case the dry-run fails and the outcome is `Skipped` (policy: never run an image the code cannot migrate; see risk 17).

Naming: D7 and b6:5 call the restore stage `restore_from()`; in this brief it is `Connection::restore_main_from` as executed by `build_with_outcome`, and there is no separate `ThreadSafeConnection::restore_from` — restoring into an already-migrated, WAL-mode database is exactly the unsupported case of 3.4. Both the restore (inside `AppDatabase::open_with_image`) and `serialize()` are awaited from `background_spawn` by their callers (3.7, 3.8; D7), so the builder's future and `serialize()`'s future must be `Send` (they are: `write` hands the closure to the queue and returns a `oneshot` receiver).

### 3.6 `crates/db/src/db.rs` (modify)

- Add after `AppDatabase::new` (line 63-67):

```rust
pub use sqlez::thread_safe_connection::RestoreOutcome;

/// Native: like `new`, but restores `image` (when `Some`) before migrating.
pub fn new_with_image(image: Option<Vec<u8>>) -> (Self, RestoreOutcome);
/// Async constructor for the browser (no `gpui::block_on`); b6 gates `new`/`new_with_image`
/// under `cfg(not(target_family = "wasm"))` and makes this the wasm entry point.
pub async fn open_with_image(image: Option<Vec<u8>>) -> (Self, RestoreOutcome);
```

- Generalize `open_db` (line 174) into `open_db_with_image<M>(db_dir, scope, image: Option<Vec<u8>>) -> (ThreadSafeConnection, RestoreOutcome)`, with `open_db` delegating with `None` and discarding the outcome; thread the image into `open_main_db` (line 205-213) and `open_fallback_db` (line 215-225) via `.with_restore_image(image)` and `build_with_outcome()`. Because 3.5 validates the image on a scratch connection first, an unusable image can no longer make `open_main_db` fail or `open_fallback_db` hit its `.expect` (line 221-224); both return `Skipped` and an empty database instead. On native, `open_fallback_db` receives the image only when `open_main_db` failed for reasons unrelated to the image (`ZED_STATELESS`, unwritable dir) — the same fallback semantics as today. On wasm, b6:229 routes `open_db_with_image` straight to `open_fallback_db::<M>(image)` on top of its single-connection `sqlez` with `locking_queue`; nothing in this brief makes `AppDatabase` browser-capable on its own (`background_thread_queue` at `thread_safe_connection.rs:282` needs `std::thread`), so `open_with_image` is a contract for b6/b7, not a working browser path in isolation.
- Add `pub mod client_state;` next to `pub mod kvp;` (line 1).

### 3.6a `crates/db/src/kvp.rs` (modify) — fold `GlobalKeyValueStore` into the `AppDatabase` image (D7)

Natively `GlobalKeyValueStore` is a second database file (`0-global/db.sqlite`, section 2) shared by every release channel; in the browser there is exactly one database and one image, and D7 requires the global store's rows to travel in it. The fold reuses the `scoped_kv_store` table that `KeyValueStore`'s migration step 1 already creates on the `AppDatabase` (`kvp.rs:30-37`), under the reserved namespace `GLOBAL_KVP_NAMESPACE = "global"` — no new table, no new migration and no change to any migration text (a changed step would be "Migration changed" on every existing desktop database, `migrations.rs:77-85`).

```rust
pub const GLOBAL_KVP_NAMESPACE: &str = "global";

impl GlobalKeyValueStore {
    /// All targets: a global store backed by the application database's `scoped_kv_store`
    /// (namespace `GLOBAL_KVP_NAMESPACE`). On wasm this is the only constructor.
    pub fn from_app_db(db: &AppDatabase) -> Self;
    /// wasm: installs the process-wide instance that `global()` returns; called once by the
    /// entry crate right after `AppDatabase::open_with_image` (replaces b6's `init()` that
    /// opened a separate fallback database). Idempotent (`OnceLock::set(..).ok()`).
    #[cfg(target_family = "wasm")]
    pub fn init(db: &AppDatabase);
    #[cfg(target_family = "wasm")]
    pub fn global() -> &'static Self;   // panics with "GlobalKeyValueStore::init must run before global()" if not initialised
}
```

- `GlobalKeyValueStore` gains a private `backing: Backing` where `enum Backing { OwnFile, AppDb }` (the native `LazyLock` path → `OwnFile`; `from_app_db` → `AppDb`). `read_kvp`/`write_kvp`/`delete_kvp` (`kvp.rs:257-278`) dispatch on it: `OwnFile` keeps today's `kv_store` queries verbatim; `AppDb` runs `SELECT value FROM scoped_kv_store WHERE namespace = 'global' AND key = (?)`, `INSERT OR REPLACE INTO scoped_kv_store(namespace, key, value) VALUES ('global', (?), (?))` and `DELETE FROM scoped_kv_store WHERE namespace = 'global' AND key = (?)` (the statements `ScopedKeyValueStore` uses at `:104-131`, with the namespace inlined). The `Domain` impl (`:226-234`) and the native `LazyLock` (`:243-250`) are untouched; on wasm the `LazyLock` and the native `global()` are `#[cfg(not(target_family = "wasm"))]`, as b6:310 already gates them.
- `KeyValueStore::scoped("global")` on the same database sees the same rows; the namespace is reserved for this purpose and documented on `ScopedKeyValueStore`.
- Consequence for b6: its wasm `GlobalKeyValueStore::init()` (b6:295-309) becomes `init(db: &AppDatabase)` and opens nothing; its boot line (b6:312) becomes `db::kvp::GlobalKeyValueStore::init(&db);` after `cx.set_global(db.clone())`. Consequence for the rules→skills migration (`rules_to_skills_migration.rs:108-124, 486-500`): its flag is now in the image, so it runs once per workspace rather than once per boot (b6:983(c) resolved).

### 3.7 `crates/db/src/client_state.rs` (new)

Transport- and codec-agnostic periodic saver, so `db` does not depend on `rpc` or on a compression crate:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SaveOutcome { pub accepted: bool, pub version: u64 }   // `version` = server's current version after the call

pub trait ClientStateSink: Send + Sync + 'static {
    /// Persist `image` as `version`. `accepted == false` means the server already holds
    /// `outcome.version >= version` (replayed request or superseded tab).
    fn save(&self, image: Vec<u8>, version: u64) -> BoxFuture<'static, anyhow::Result<SaveOutcome>>;
    /// The server's current version without the image (used after a reconnect).
    fn current_version(&self) -> BoxFuture<'static, anyhow::Result<u64>>;
}

pub struct ClientStateStore {
    db: ThreadSafeConnection,
    sink: Arc<dyn ClientStateSink>,
    version: u64,                 // last version known to be held by the sink
    saved_generation: u64,        // db.write_generation() at last accepted save
    interval: Duration,
    read_only: bool,              // true after RestoreOutcome::Skipped until allow_overwrite()
    stopped: bool,                // true after any `Disconnected` (takeover, server stopped, reconnect exhausted); cleared by `rebind`
    in_flight: Option<Shared<Task<Result<(), Arc<anyhow::Error>>>>>,
    _ticker: Task<()>,
}

pub const SAVE_INTERVAL: Duration = Duration::from_secs(15);
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;   // uncompressed; keeps even a 1:1 gzip under the 16 MiB frame

impl ClientStateStore {
    /// `loaded_version` is the version returned by `LoadClientState` (0 when none);
    /// `outcome` is what `AppDatabase::{new,open}_with_image` reported.
    pub fn new(db: &AppDatabase, sink: Arc<dyn ClientStateSink>, loaded_version: u64, outcome: RestoreOutcome, cx: &mut Context<Self>) -> Self;
    pub fn is_dirty(&self) -> bool;                       // db.write_generation() != saved_generation
    pub fn is_read_only(&self) -> bool;
    /// Lifts `read_only` (the entry crate decides when a skipped restore may be overwritten).
    pub fn allow_overwrite(&mut self);
    /// Serializes and sends now, dirty or not (a flush is the client saying "this is my final state").
    pub fn flush_now(&mut self, cx: &mut Context<Self>) -> Task<anyhow::Result<()>>;
    pub fn set_interval(&mut self, interval: Duration);   // entry crate shortens it while the tab is hidden
    /// Called on every `RemoteClientEvent::Disconnected { .. }` (both terminal states, `ServerNotRunning`
    /// and `ReconnectExhausted`, `remote_client.rs:934-942`; D2): stops the ticker; `flush_now` returns `Err` until `rebind`.
    pub fn stop(&mut self);
    /// Called on `RemoteClientEvent::Reconnected` (transport-level reconnect, same `RemoteClient`):
    /// re-queries `sink.current_version()`, adopts the max, marks dirty.
    pub fn resync(&mut self, cx: &mut Context<Self>) -> Task<anyhow::Result<()>>;
    /// Called when the host's `reconnect()` (D2) builds a new connection from scratch in the same page
    /// (a new `RemoteClient`, hence a new `AnyProtoClient`): replaces the sink, clears `stopped`, then `resync`.
    /// A shell that reloads the page instead never calls it (the boot sequence of 3.8 runs again).
    pub fn rebind(&mut self, sink: Arc<dyn ClientStateSink>, cx: &mut Context<Self>) -> Task<anyhow::Result<()>>;
    pub fn version(&self) -> u64;
}
impl EventEmitter<ClientStateEvent> for ClientStateStore {}
pub enum ClientStateEvent { Saved { version: u64 }, SaveFailed(String), Stale { server_version: u64 }, ReadOnly(String) }
```

Ticker: every `interval`, if `!read_only && !stopped`, dirty, and nothing in flight: capture `generation = db.write_generation()`, then `cx.background_spawn(async move { db.serialize().await })` — never awaited on the foreground: `serialize()` is `self.write(..)`, which runs the closure inline on the awaiting thread on wasm (b6:264, 983(a)), and D7 fixes `serialize()` on `background_spawn` for every trigger, `flush_now` included — refuse images over `MAX_IMAGE_BYTES` (emit `SaveFailed`), then `sink.save(image, version + 1)`. On `Ok(SaveOutcome { accepted: true, version })` set `self.version = version`, `saved_generation = generation`, emit `Saved`; on `accepted: false` set `self.version = max(self.version, outcome.version)`, leave `saved_generation` unchanged (still dirty) and emit `Stale` — the next tick retries with `version + 1` above the server's, which is what makes a replayed request after a lost response converge instead of being rejected forever (`remote_client.rs:1910-1925`); on `Err` emit `SaveFailed` and keep dirty. `flush_now` bypasses the interval and the dirty check (but not `read_only`/`stopped`, where it returns `Err`), and returns the save task; concurrent flushes await the in-flight `Shared` task. A `Skipped` outcome at construction sets `read_only`, emits `ReadOnly(reason)`, and nothing is ever sent until `allow_overwrite()`; migrations on the empty database bump `write_generation`, which is why `read_only` rather than the dirty flag is the guard.

Flush triggers (D7, exhaustive): the ticker above, `flush_now` from the entry crate on `visibilitychange` → hidden, and `flush_now` on `LifecycleKind::Stopping` (after 3.8's `snapshot_unsaved_buffers`, D6). No `pagehide`, `beforeunload` or `on_app_quit` trigger is part of the contract; b7 may keep a best-effort `pagehide` call, but nothing here relies on it. The image is the whole `AppDatabase`, which after 3.6a includes the global key-value rows and, per D4, b3's terminal restore rows in workspace persistence; it is not importable into desktop Zed's shared database (D7; BUILD-SPEC 5.4 amended, risk 13).

### 3.8 `crates/workspace/src/client_state.rs` (new) and `crates/workspace/src/workspace.rs` (modify)

The proto-aware half, placed in `workspace` because it already depends on `db` (`Cargo.toml:38`) and reaches `proto`/`AnyProtoClient` through `client` (`client.rs:59`; import as `use client::{proto, AnyProtoClient};` like `dock.rs:7`):

```rust
pub struct RemoteClientStateSink { client: AnyProtoClient, project_id: u64, client_build: String }
impl RemoteClientStateSink { pub fn new(client: AnyProtoClient, client_build: String) -> Arc<Self>; } // project_id = REMOTE_SERVER_PROJECT_ID
impl db::client_state::ClientStateSink for RemoteClientStateSink {
    // save: gzip the image (async_compression::futures::write::GzipEncoder, level 3), send
    //       proto::SaveClientState { sqlite: gz, version, gzip: true, client_build }, map the
    //       response to SaveOutcome. current_version: LoadClientState { metadata_only: true }.
}

/// Boot helper for zed_web: request the stored image before opening `AppDatabase`.
/// Decompresses when `gzip` is set, bounding the output at MAX_IMAGE_BYTES; logs `client_build`
/// when it differs from the running build.
pub async fn load_client_state(client: &AnyProtoClient) -> anyhow::Result<(Option<Vec<u8>>, u64)>;
```

Unsaved buffers (D6), in the same module:

```rust
pub const UNSAVED_SNAPSHOT_LIMIT_BYTES: usize = 8 * 1024 * 1024;   // sum of `text` over all rows; buffers past it are skipped with a warn

pub struct UnsavedBuffersDb(ThreadSafeConnection);
impl Domain for UnsavedBuffersDb {
    const NAME: &str = "UnsavedBuffersDb";
    const MIGRATIONS: &[&str] = &[sql!(
        CREATE TABLE unsaved_buffers(
            workspace_id INTEGER NOT NULL,
            abs_path TEXT NOT NULL,
            text TEXT NOT NULL,
            mtime_seconds INTEGER,              // Buffer::saved_mtime — the on-disk version the edits were made against (D6 "version")
            mtime_nanos INTEGER,
            snapshot_at_unix_ms INTEGER NOT NULL,
            PRIMARY KEY(workspace_id, abs_path),
            FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
            ON DELETE CASCADE
            ON UPDATE CASCADE
        ) STRICT;
    )];
}
db::static_connection!(UnsavedBuffersDb, [WorkspaceDb]);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsavedBufferRow { pub abs_path: PathBuf, pub text: String, pub mtime: Option<MTime>, pub snapshot_at_unix_ms: u64 }

impl UnsavedBuffersDb {
    /// One `write`: DELETE the workspace's rows, INSERT `rows`.
    pub async fn replace_for_workspace(&self, workspace_id: WorkspaceId, rows: Vec<UnsavedBufferRow>) -> Result<()>;
    pub fn rows_for_workspace(&self, workspace_id: WorkspaceId) -> Result<Vec<UnsavedBufferRow>>;
    pub async fn clear_for_workspace(&self, workspace_id: WorkspaceId) -> Result<()>;
}

/// D6, on `LifecycleKind::Stopping`, before `ClientStateStore::flush_now`: every dirty, path-backed buffer of
/// `workspace.project()` becomes one row. Returns the number of rows written.
pub fn snapshot_unsaved_buffers(workspace: &Entity<Workspace>, cx: &mut App) -> Task<Result<usize>>;
/// D6, once per boot, after the workspace's items have been restored: reopens each row's buffer dirty with the
/// stored text, makes it visible, then clears the rows. Returns the number of buffers restored.
pub fn restore_unsaved_buffers(workspace: &Entity<Workspace>, window: &mut Window, cx: &mut App) -> Task<Result<usize>>;
```

`snapshot_unsaved_buffers` (foreground part, synchronous): `workspace.read(cx).database_id()` (`None` → `Ok(0)`); iterate `project.read(cx).buffer_store().read(cx).buffers()`; keep buffers with `is_dirty()` and `file().is_some()`; compute `abs_path` exactly as `Editor::serialize` does (`items.rs:1487-1497`: `worktree_for_id(file.worktree_id(cx))` → `absolutize(file.path())`, else `find_project_path(full_path)` + `absolute_path`); `text = buffer.read(cx).text()`, `mtime = buffer.read(cx).saved_mtime()`, `snapshot_at_unix_ms = now`; then `cx.background_spawn(UnsavedBuffersDb::global(cx).replace_for_workspace(id, rows))`. Untitled buffers (`file() == None`) are skipped: `editors.contents` (`items.rs:1462-1534`, `abs_path: None`) already carries them and they need their item to be recreated. Buffers past `UNSAVED_SNAPSHOT_LIMIT_BYTES` in aggregate are skipped with a `warn` (the image must stay under `MAX_IMAGE_BYTES`). The write bumps `write_generation`, so the `flush_now` that follows always carries the rows. Nothing here touches the workspace filesystem (D6).

`restore_unsaved_buffers`: `rows_for_workspace(id)` (a read); for each row: `project.find_project_path(&row.abs_path, cx)` (`None` → the path's worktree is no longer open: `warn` and drop the row); `workspace.open_path_preview(project_path, None, /*focus_item*/ false, /*allow_preview*/ false, /*activate*/ false, window, cx).await` (opens or reuses the item without changing the active tab — a dirty buffer must be visible to be saved or discarded); `buffer = project.buffer_store().get_by_path(&project_path)`; if `buffer.text() != row.text`: `buffer.did_reload(buffer.version(), buffer.line_ending(), row.mtime, cx)` (the stored mtime becomes `saved_mtime`, so a file changed on disk while the workspace was stopped shows as a conflict, `buffer.rs:2516-2530`), `set_text(row.text)`, `forget_transaction(peek_undo_stack().transaction_id())` — the sequence of `items.rs:2325-2340`; identical text (the editor item already restored it from `editors.contents`, or the user saved before the stop) is a no-op. Finally `clear_for_workspace(id)`. Ordering: it runs after `finish_opening_remote_workspace`, i.e. after workspace deserialization has recreated the editor items, so the two mechanisms never race, and an `unsaved_buffers` row is always at least as new as `editors.contents` for the same path.

`workspace.rs`: add `pub mod client_state;` to the module list. No other change here. The entry crate (b7) boot sequence (b7 3.27 steps 3d-f; D16): `load_client_state` → `cx.background_spawn(AppDatabase::open_with_image(image))` (D7: the restore runs off the main thread) → `cx.set_global(db)` → `GlobalKeyValueStore::init(&db)` (3.6a) → `ClientStateStore::new` with the sink and outcome → `open_remote_project_in_new_window_with_client(remote, ..)` (D16) → `restore_unsaved_buffers(&workspace, window, cx)`. It subscribes to `RemoteClientEvent` to call `stop` on every `Disconnected` and `resync` on `Reconnected` (and `rebind` if its `reconnect()` re-dials in place, D2), calls `flush_now` on `visibilitychange` → hidden (optionally with `set_interval(5 s)` while hidden), and on `LifecycleKind::Stopping` runs `snapshot_unsaved_buffers(..).await` then `flush_now` — **not** `Workspace::save_all` (D6: the client never writes to the workspace filesystem without the user saving). These three are the only flush triggers (D7).

### 3.9 `crates/remote_server/src/client_state.rs` (new)

Server-side blob store, one per server process:

```rust
pub struct ClientStateStore {
    fs: Arc<dyn Fs>,
    dir: PathBuf,                              // paths::remote_server_state_dir().join("client_state"); created on first save
    current: Option<ClientStateMeta>,          // None until `loaded` resolves and when nothing is stored
    loaded: Shared<Task<()>>,                  // reads meta.json; every handler awaits it first
    saved_tx: watch::Sender<u64>,
    _saved_rx: watch::Receiver<u64>,           // keeps a receiver alive so `send` never returns NoReceiverError (watch.rs:62-70)
}

pub const IMAGE_FILE: &str = "db.sqlite";
pub const PREV_IMAGE_FILE: &str = "db.sqlite.prev";   // previous accepted image, for manual recovery after a bad overwrite
pub const META_FILE: &str = "meta.json";
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;   // on-the-wire bytes (compressed when `gzip`)

#[derive(Clone, Serialize, Deserialize)]
pub struct ClientStateMeta { pub version: u64, pub saved_at_unix_ms: u64, pub bytes: u64, pub gzip: bool, pub client_build: Option<String> }

impl ClientStateStore {
    pub fn new(fs: Arc<dyn Fs>, dir: PathBuf, cx: &mut Context<Self>) -> Self;
    pub fn saved_versions(&self) -> watch::Receiver<u64>;   // clone of the receiver; each awaiter clones again (changed() takes &mut self)

    pub async fn handle_save_client_state(this: Entity<Self>, envelope: TypedEnvelope<proto::SaveClientState>, cx: AsyncApp) -> Result<proto::SaveClientStateResponse>;
    pub async fn handle_load_client_state(this: Entity<Self>, envelope: TypedEnvelope<proto::LoadClientState>, cx: AsyncApp) -> Result<proto::LoadClientStateResponse>;
}
```

Both handlers first `this.read_with(&cx, |s, _| s.loaded.clone())?.await`, so a `LoadClientState`/`SaveClientState` that races startup sees the stored version rather than 0. Save semantics: reject empty images and images over `MAX_IMAGE_BYTES` with `Err`; if `version <= current.version` respond `SaveClientStateResponse { accepted: false, version: current.version }` (not an error: a replayed envelope after a lost response lands here and the client converges on the returned version); otherwise `fs.create_dir(dir)`, write `db.sqlite.tmp` with `fs.write`, `fs.rename(db.sqlite → db.sqlite.prev)` ignoring not-found, `fs.rename(db.sqlite.tmp → db.sqlite)`, `fs.atomic_write(meta.json)`, update `current`, `saved_tx.send(version).ok()`, respond `{ accepted: true, version }`. The server never inspects the image; it stores the bytes and the `gzip`/`client_build` metadata and echoes them on load. Load returns `sqlite: vec![], version: 0, gzip: false` when nothing is stored; with `metadata_only` it omits the bytes. Files sit under `data_dir()` so they are inside the sandbox snapshot (BUILD-SPEC 5.4) and, per D9, inside the rebuild tarball (`$HOME/.local/share/zed` is archived and extracted at `/`; risk 18 closed). One server process serves one workspace, so the store is per workspace by construction and keyed by nothing: the `workspace_id` identity of D1 is implicit, and `session_id` (per-connect, informational) never reaches it.

### 3.10 `crates/remote_server/src/control.rs` (new)

The control channel the supervisor pokes. It is HTTP-framework-agnostic so b2 can mount it on a loopback-only listener:

```rust
pub const LIFECYCLE_PATH: &str = "/control/lifecycle";
pub const PORTS_PATH: &str = "/control/ports";
pub const EXTENSIONS_PATH: &str = "/control/extensions";
pub const STOPPING_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

pub struct ControlChannel {
    session: AnyProtoClient,
    secret: Vec<u8>,
    last_ports: Mutex<(Vec<proto::ListeningPort>, Vec<proto::PortForward>)>,   // written only by POST /control/ports
    pending_resumed: AtomicBool,            // a Resumed that arrived while no session was attached
    saved_versions: watch::Receiver<u64>,   // from ClientStateStore; cloned per request
    events_tx: mpsc::UnboundedSender<ControlEvent>,
    executor: BackgroundExecutor,
}

pub enum ControlEvent { InstallExtensions(Vec<String>) }   // drained by HeadlessProject::enable_sandbox

pub struct ControlRequest<'a> {
    pub method: &'a str,          // "POST"
    pub path: &'a str,
    pub bearer: Option<&'a str>,  // value after "Bearer "
    pub peer_is_loopback: bool,
    pub session_attached: bool,   // ServeState::session().is_some() (b2:385)
    pub body: &'a [u8],
}

#[derive(Debug, PartialEq)]
pub enum ControlResponse { NoContent, BadRequest(String), Unauthorized, NotFound }

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LifecycleBody { IdleStopIn { seconds: u32 }, SessionCapIn { seconds: u32 }, Stopping, Resumed }

#[derive(Deserialize)]
pub struct PortsBody { pub ports: Vec<ListeningPortBody>, #[serde(default)] pub forwards: Vec<PortForwardBody> }
#[derive(Deserialize)] pub struct ListeningPortBody { pub port: u16, pub pid: u32, pub process_name: String }
#[derive(Deserialize)] pub struct PortForwardBody { pub port: u16, pub visibility: String /* "public"|"private" */, pub label: Option<String>, pub url: String }
#[derive(Deserialize)] pub struct ExtensionsBody { pub install: Vec<String> }

impl ControlChannel {
    pub fn new(session: AnyProtoClient, secret: Vec<u8>, saved_versions: watch::Receiver<u64>, executor: BackgroundExecutor)
        -> (Arc<Self>, mpsc::UnboundedReceiver<ControlEvent>);
    /// Async entry point for the HTTP router (runs on the router's task; nothing in it needs gpui).
    pub async fn handle(&self, request: ControlRequest<'_>) -> ControlResponse;
    /// Re-sends what a freshly attached session missed: the last PortsChanged and a pending Resumed.
    pub fn replay_after_attach(&self);
}
```

Auth: `peer_is_loopback` must be true and `bearer` must equal the secret under `subtle::ConstantTimeEq` (`subtle` is added to the workspace and to `remote_server` by b2 §5; if this brief lands first it adds the same two lines). The secret arrives from `serve` (3.15; `--control-secret-file`, D5/D18), never from this module's own environment reads. The listener is b2's second, loopback-only hyper listener on `--control-listen` (default `127.0.0.1:8446`, D5; the public listener never exposes `/control`), and the bridge to hyper is b2's: `serve` wraps the `Arc<ControlChannel>` in an adapter implementing `ControlRoutes` (b2 §3.8: `ControlRoutes::handle<'a>(&'a self, req: ControlRequest<'a>) -> BoxFuture<'a, ControlResponse>`, mirroring `ControlChannel::handle` so the production impl is one line); b2's hyper side (`route_control`) reads the body (capped at `MAX_CONTROL_BODY_BYTES` = 1 MiB, 413 above — b2's cap, adopted here), takes the `Authorization` header, fills `ControlRequest { method, path, bearer, peer_is_loopback, session_attached: state.session().is_some(), body }`, and maps `ControlResponse` to `204` / `400 {"error":"bad_request","message":"<msg>"}` (b2 §3.8 owns the adapter under D20; `<msg>` is the `BadRequest` payload) / `401 {"error":"unauthorized"}` / `404`. Request handling:

- `POST /control/lifecycle`: `IdleStopIn`/`SessionCapIn` → `session.send(LifecycleNotice{..})`. `Resumed` → send if `session_attached`, else set `pending_resumed`. `Stopping` → if `!session_attached` return `NoContent` immediately (nothing to flush; this is the idle-stop case); otherwise `let mut rx = self.saved_versions.clone(); let before = *rx.borrow();` (snapshot *before* the notice), send `LifecycleNotice{Stopping}`, then await `rx.changed()` until `*rx.borrow() > before` or `STOPPING_FLUSH_TIMEOUT` elapses (`executor.timer`), and return `NoContent` either way. Because `flush_now` always sends (3.7), a clean client still produces one `SaveClientState`, so the wait ends early in the common case.
- `POST /control/ports`: parse, store into `last_ports`, send `PortsChanged` with the full picture. This is the only writer of `last_ports`; the supervisor already re-posts after every forward/unforward (b8:561-562), so `PortForwarder` does not touch it.
- `POST /control/extensions`: parse `ExtensionsBody`, validate ids (3.13 `is_valid_extension_id`), push `ControlEvent::InstallExtensions`, return `NoContent` (installs are asynchronous; results surface as `ExtensionsChanged`).

`AnyProtoClient::send` (`proto_client.rs:258`) is synchronous and thread-safe, mirroring `init_telemetry_forwarding` (`server.rs:318-329`). The supervisor's stop sequence (BUILD-SPEC 6.2 "ask the server to flush client state") is therefore `POST /control/lifecycle {"kind":"stopping"}` and wait for 204, with a request timeout above `STOPPING_FLUSH_TIMEOUT` (D18: the supervisor's stopping request budget exceeds the 5 s flush; b8:504's 2.5 s is superseded). What the client does inside that window is 3.8: `snapshot_unsaved_buffers` (D6) then `flush_now`, so the one `SaveClientState` the wait ends on carries the dirty buffers.

### 3.11 `crates/remote_server/src/ports.rs` (new)

Server side of `ForwardPort` / `UnforwardPort`: a thin client for the supervisor's loopback API.

```rust
pub const DEFAULT_SUPERVISOR_URL: &str = "http://127.0.0.1:8445";   // BUILD-SPEC 6.2 supervisor port; overridden by --supervisor-url / ZS_SUPERVISOR_URL (3.15 item 1; risk 20)
pub const SUPERVISOR_PORTS_PATH: &str = "/ports";
pub const SUPERVISOR_EXTENSIONS_PATH: &str = "/extensions";

pub struct PortForwarder {
    http: Arc<dyn HttpClient>,   // proxy-less ReqwestClient; the session client at server.rs:685-699 may carry a user proxy
    base_url: String,
    secret: Vec<u8>,
}

#[derive(Serialize)] struct ForwardRequestBody<'a> { port: u16, visibility: &'a str, label: Option<&'a str> }
#[derive(Deserialize)] struct ForwardResponseBody { url: Option<String> }   // b8:677 answers `{"url": string|null}`; None → ""
#[derive(Serialize)] struct InstalledExtensionsBody<'a> { installed: &'a [&'a str] }

impl PortForwarder {
    pub fn new(http: Arc<dyn HttpClient>, base_url: String, secret: Vec<u8>) -> Arc<Self>;
    pub async fn forward(&self, port: u16, visibility: proto::PortVisibility, label: Option<String>) -> Result<String>; // POST {base}/ports -> 200 {url}
    pub async fn unforward(&self, port: u16) -> Result<()>;                                                             // DELETE {base}/ports/{port} -> 204
    pub async fn report_installed_extensions(&self, ids: &[&str]) -> Result<()>;                                        // POST {base}/extensions -> 204 (b8 relays to the control plane)

    pub async fn handle_forward_port(this: Entity<HeadlessProject>, envelope: TypedEnvelope<proto::ForwardPort>, cx: AsyncApp) -> Result<proto::ForwardPortResponse>;
    pub async fn handle_unforward_port(this: Entity<HeadlessProject>, envelope: TypedEnvelope<proto::UnforwardPort>, cx: AsyncApp) -> Result<proto::Ack>;
}
```

The handlers read `this.read_with(&cx, |p, _| p.sandbox.as_ref().map(|s| s.ports.clone()))` and return `anyhow!("port forwarding is not available on this server")` when it is `None` (the SSH `run` mode); they range-check `port` (`uint32` on the wire) to `1..=65535` before the `as u16` and reject anything else with `Err`. Requests are built with `http::Request::builder().method(..).uri(..).header("Authorization", "Bearer <secret>").header("Content-Type", "application/json").body(AsyncBody::from(json))` and sent with `HttpClient::send` (`http_client.rs:128`); `post_json` (`:154-167`) cannot carry the header and is not used. The supervisor is what calls the control plane (`POST /api/sandboxes/{name}/ports`, BUILD-SPEC 7.3) and returns the URL; the server never holds a control-plane credential. `url` is opaque to the server: for a public forward it is the slot's `https://<slot-host>` URL; for a private forward it is the control plane's `/open` link (`GET {origin}/api/workspaces/{id}/ports/{port}/open`), which redirects to `https://<slot-host>/__zs/auth?zs_port_token=...&next=/` to set the `zs_port_session` HMAC cookie that the supervisor's proxy on that slot validates (D8; b9:1119-1120). The control plane allocates one of four proxy slots (ports 8444-8447, declared at sandbox create) per private forward; when none is free it refuses, the supervisor relays the refusal as a non-2xx, and `forward` returns `Err` with the supervisor's `error` text, which reaches the client as the `ForwardPort` request error. A `null` `url` in a 200 (b8:677, 1415) is mapped to an empty string, never to an error. A `ForwardPort` replayed after a reconnect reaches the supervisor twice; b8's `forwards.insert` is a map insert, so it is idempotent per port (risk 8).

### 3.12 `crates/extension_host/src/extension_host.rs` (modify)

Extract the registry GET from `fetch_extensions_from_api` (lines 786-822) into a free function both stores can call, and expose the version-range helpers the headless installer needs:

```rust
pub async fn fetch_extensions_from_registry(
    http_client: &HttpClientWithUrl,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Vec<ExtensionMetadata>>;

pub fn latest_download_url(http_client: &HttpClientWithUrl, extension_id: &str, release_channel: ReleaseChannel) -> Result<Url>;   // body of lines 954-967
pub fn versioned_download_url(http_client: &HttpClientWithUrl, extension_id: &str, version: &str) -> Result<Url>;                 // body of lines 999-1004
pub fn is_suppressed_extension(id: &str) -> bool;                                                                                    // SUPPRESSED_EXTENSIONS.contains(id)
```

`ExtensionStore::fetch_extensions_from_api` (line 786), `install_latest_extension` (line 948) and `install_or_upgrade_extension` (line 991) become one-line callers. Also make `wasm_host::wit::wasm_api_version_range` reachable from `headless_host` (it already is within the crate via `crate::wasm_host::wit`).

### 3.13 `crates/extension_host/src/headless_host.rs` (modify)

Registry-driven install, startup reload from manifests (no index file), input validation, sandbox-mode sync, and the three new handlers:

```rust
pub struct RegistryConfig { pub http: Arc<HttpClientWithUrl>, pub release_channel: ReleaseChannel }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledExtensionRecord { pub id: Arc<str>, pub version: Arc<str>, pub name: String, pub description: Option<String>, pub provides: Vec<String>, pub dev: bool }

pub const MAX_REGISTRY_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// `^[a-z0-9][a-z0-9_-]{0,63}$` — the only shape the registry issues; rejects `..`, `/`, `\`, empty.
pub fn is_valid_extension_id(id: &str) -> bool;

impl HeadlessExtensionStore {
    pub fn set_registry(&mut self, registry: RegistryConfig);
    /// Scans `extension_dir/*/extension.toml` (skipping `work`, `staging` and any dir without a manifest),
    /// and loads each via `load_extension(ExtensionVersion { id, version: manifest.version, dev: false, .. })`.
    /// Called once by `enable_sandbox`; emits `ExtensionsInstalledChanged` once at the end (not per extension).
    pub fn load_installed_from_disk(&mut self, cx: &mut Context<Self>) -> Task<Result<()>>;
    pub fn installed_extension_records(&self) -> Vec<InstalledExtensionRecord>;   // from `manifests` + `dev_ids`
    pub fn search_registry(&self, search: Option<String>, cx: &Context<Self>) -> Task<Result<Vec<ExtensionMetadata>>>;
    pub fn install_from_registry(&mut self, id: Arc<str>, version: Option<Arc<str>>, cx: &mut Context<Self>) -> Task<Result<InstalledExtensionRecord>>;
    pub fn uninstall_by_id(&mut self, id: Arc<str>, cx: &mut Context<Self>) -> Task<Result<()>>;   // validates the id, then the private uninstall_extension (line 486)
    /// `extension_dir/<id>/<rel>` when `id` is valid, installed, and `rel` has only `Normal` components; for b2's asset route.
    pub fn asset_path(&self, id: &str, rel: &str) -> Option<PathBuf>;

    pub async fn handle_list_extensions(store: Entity<Self>, envelope: TypedEnvelope<proto::ListExtensions>, cx: AsyncApp) -> Result<proto::ListExtensionsResponse>;
    pub async fn handle_install_registry_extension(store: Entity<Self>, envelope: TypedEnvelope<proto::InstallRegistryExtension>, cx: AsyncApp) -> Result<proto::Ack>;
    pub async fn handle_uninstall_extension(store: Entity<Self>, envelope: TypedEnvelope<proto::UninstallExtension>, cx: AsyncApp) -> Result<proto::Ack>;
}
```

New fields on `HeadlessExtensionStore` (line 40-49): `registry: Option<RegistryConfig>`, `manifests: BTreeMap<Arc<str>, Arc<ExtensionManifest>>` (filled by `load_installed_from_disk`, `install_extension` and `install_from_registry`; cleared by uninstall), `dev_ids: BTreeSet<Arc<str>>` (ids whose last `install_extension` carried `dev: true`; in-memory only — the desktop re-syncs dev extensions on every connect, `sync_extensions` line 129). No `index.json`: everything except `dev` is derivable from `extension.toml`, and a scan is self-healing after a partial uninstall, whereas an index write after `fs.remove_dir` (line 495-509) could leave a phantom entry.

`install_from_registry`: `is_valid_extension_id` else `Err`; refuse `is_suppressed_extension`; build the URL with `latest_download_url` or `versioned_download_url`; download with a running byte count that aborts past `MAX_REGISTRY_DOWNLOAD_BYTES`; unpack exactly as `extension_host.rs:861-923` does (GzipDecoder + `async_tar::Archive::unpack`, whose `unpack_in` semantics skip entries with `..` or absolute paths) into `tempfile::tempdir_in(extension_dir.join("staging"))` — *not* `remote_extensions_uploads_dir()`, which the sweep at line 71-79 prunes — keeping the `TempDir` guard alive in the same async block until `install_extension`'s task has completed (or `TempDir::keep()` it first; the desktop code holds it at `extension_host.rs:900-921`); `ExtensionManifest::load` from the unpacked dir; require `manifest.id == id` and, when a version was pinned, `manifest.version == version`, else `Err` and drop the temp dir; then call the existing `install_extension(ExtensionVersion { id, version: manifest.version, dev: false, content_fingerprint: None }, tmp_path, cx)` (line 512), which validates, moves the directory into `extension_dir/<id>`, commits and emits `ExtensionsInstalledChanged`; finally record the manifest.

`sync_extensions` (line 102-135) in sandbox mode (`registry.is_some()`): sync is additive and version-tolerant — `to_remove` is empty, and ids already in `loaded_extensions` are dropped from `to_load` regardless of version unless `dev`. The desktop's list is not authoritative for a sandbox; without this a desktop "Open in desktop" connect (BUILD-SPEC §1) would uninstall every registry-installed extension and then fail to upload replacements over WebSocket (b1:171). Native SSH behaviour (`registry.is_none()`) is unchanged.

Touch `prepare_extension` (line 251-312): replace the `debug_assert!` at line 262 with an early return of a bare `LoadedExtension { version, languages: vec![], language_servers: vec![], debug_adapters: vec![], debug_locators: vec![], wasm_extension: None, content_fingerprint }` when `manifest.languages.is_empty() && !manifest.allow_remote_load()`. Theme, icon-theme, grammar and snippet-only extensions then install cleanly and stay on disk for the asset route (3.15, BUILD-SPEC section 9); `commit_extension` (line 314) with empty vectors registers nothing.

`handle_list_extensions`: `installed` from `installed_extension_records()`; when `include_available`, `search_registry(search)` mapped to `proto::AvailableExtension` (fields from `ExtensionMetadata` / `ExtensionApiManifest`, `cloud_api_types/src/extension.rs:9-19, 67-73`; `provides` via `ExtensionProvides`'s kebab-case `Display`). `handle_install_registry_extension` / `handle_uninstall_extension` validate the id first. `provides` for installed records is derived from the manifest (`languages`, `grammars`, `themes`, `icon_themes`, `language_servers`, `snippets`, ... non-empty → the matching `ExtensionProvides` name).

### 3.14 `crates/remote_server/src/headless_project.rs` (modify)

`HeadlessAppState` and `HeadlessProject::new` are **not** changed (25 construction sites, section 2). Everything sandbox-specific hangs off one method, following `handle_crash_files_requests` (`server.rs:334-385`, wired at `:723`):

```rust
pub struct SandboxConfig {
    pub control_secret: Vec<u8>,
    pub supervisor_url: String,                  // DEFAULT_SUPERVISOR_URL when unset
    pub supervisor_http: Arc<dyn HttpClient>,    // proxy-less ReqwestClient built by serve
    pub registry: extension_host::headless_host::RegistryConfig,
    pub client_state_dir: PathBuf,               // paths::remote_server_state_dir().join("client_state")
}

pub struct SandboxRuntime {
    pub client_state: Entity<ClientStateStore>,
    pub control: Arc<ControlChannel>,
    pub ports: Arc<PortForwarder>,
}

impl HeadlessProject {
    /// Called at most once, by `serve` right after construction. Returns the control channel for the router.
    pub fn enable_sandbox(&mut self, config: SandboxConfig, cx: &mut Context<Self>) -> Arc<ControlChannel>;
    /// Called by `serve` after every attach, fresh or reconnect (b2's `ServeHooks::session_attached`, b2:381, 449;
    /// after `RemoteStarted` is queued on a fresh attach): replays ports / pending Resumed, then sends the current
    /// `ExtensionsChanged`. Idempotent: every message it sends carries the full picture.
    pub fn on_session_attached(&mut self, cx: &mut Context<Self>);
    /// Called by `serve` after `/files` has written files (b2 `GpuiCommand::FilesUploaded`).
    pub fn notify_files_uploaded(this: WeakEntity<Self>, abs_paths: Vec<PathBuf>, cx: &mut AsyncApp) -> Task<Result<()>>;
}
```

- Imports: `crate::client_state::ClientStateStore`, `crate::control::{ControlChannel, ControlEvent}`, `crate::ports::PortForwarder`, `extension::ExtensionEvents`.
- `HeadlessProject` (line 52-74): add `pub sandbox: Option<SandboxRuntime>`; the struct literal (line 342-362) sets `sandbox: None`.
- `enable_sandbox`, in order: `debug_assert!(self.sandbox.is_none())`; `client_state = cx.new(|cx| ClientStateStore::new(fs, dir, cx))`; `(control, events_rx) = ControlChannel::new(session.clone(), secret, client_state.read(cx).saved_versions(), cx.background_executor().clone())`; `ports = PortForwarder::new(supervisor_http, supervisor_url, secret)`; `extensions.update(cx, |e, _| e.set_registry(registry))`; register the seven handlers (below); spawn `extensions.update(cx, |e, cx| e.load_installed_from_disk(cx)).detach_and_log_err(cx)`; spawn a task draining `events_rx`: `ControlEvent::InstallExtensions(ids)` → for each id not already installed, `install_from_registry(id, None)` (errors logged); subscribe to `ExtensionEvents::try_global(cx)` and on `extension::Event::ExtensionsInstalledChanged` send `proto::ExtensionsChanged { project_id: REMOTE_SERVER_PROJECT_ID, installed }` built from `installed_extension_records()` (same `session.send(...).log_err()` shape as line 445-453) and spawn `ports.report_installed_extensions(ids)` (logged on error); store `SandboxRuntime`.
- Registrations (inside `enable_sandbox`):

```rust
session.add_request_handler(client_state.downgrade(), ClientStateStore::handle_save_client_state);
session.add_request_handler(client_state.downgrade(), ClientStateStore::handle_load_client_state);
session.add_request_handler(cx.weak_entity(), PortForwarder::handle_forward_port);
session.add_request_handler(cx.weak_entity(), PortForwarder::handle_unforward_port);
session.add_request_handler(extensions.downgrade(), HeadlessExtensionStore::handle_list_extensions);
session.add_request_handler(extensions.downgrade(), HeadlessExtensionStore::handle_install_registry_extension);
session.add_request_handler(extensions.downgrade(), HeadlessExtensionStore::handle_uninstall_extension);
```

  In `run` (SSH) mode none of these are registered; a client that sends them gets the standard "no handler registered" error (`remote_client.rs:1861-1870`).
- `on_session_attached`: `control.replay_after_attach()` then the `ExtensionsChanged` send. b2 drains queued outgoing envelopes before a Fresh attach (`begin_fresh_session`, b2:376-379), so a `PortsChanged`/`Resumed` posted while detached and the `ExtensionsChanged` from startup would otherwise be lost; Reconnect attaches keep the queue, so the replay there is redundant but harmless (one extra `PortsChanged` + `ExtensionsChanged`, both full-picture; a pending `Resumed` is delivered at most once).
- Fresh sessions (D3): `reset_for_new_client` (b2:665-675) forgets shared buffers and removes every worktree but leaves `self.sandbox`, `self.extensions`, `self.session` and the handler table of the `AnyProtoClient` untouched (`begin_fresh_session` reuses `ChannelClient::reconnect` with a new channel pair, b2:955), so `enable_sandbox` runs exactly once per process and the `ClientStateStore`, `ControlChannel`, `PortForwarder`, registry config and loaded extensions survive every fresh session — the same shape as b2's server-level `PtyManager` for terminals (D3).
- `notify_files_uploaded`: for each path, `worktree_store.find_worktree(&abs_path, cx)` (`worktree_store.rs:463`) → `worktree.as_local()` (`worktree.rs:769`) → collect `rel_path`s per worktree → `refresh_entries_for_paths(paths)` (`worktree.rs:2113`) and await the barrier with `futures::StreamExt::next` → `session.send(proto::FilesUploaded { project_id: REMOTE_SERVER_PROJECT_ID, paths })` with `ProjectPath { worktree_id: worktree.id().to_proto(), path: rel_path.to_proto() }`. Paths outside every worktree are skipped with a `debug` log.

### 3.15 `crates/remote_server/src/server.rs` (modify) and the contract for b2's `serve`

- Line 1: add `pub mod client_state; pub mod control; pub mod ports;` (public so b2's `serve` module and tests reach them). `pub use headless_project::{SandboxConfig, SandboxRuntime}` next to line 9.
- `init_paths` (line 542-558): unchanged (`ClientStateStore` creates its directory; the array's element type is `&'static PathBuf` and would not accept an owned `join(..)`).
- `run` path (line 679-731): unchanged.
- Contract for b2's `serve` (not implemented here; each item is a b2 change, listed again in section 7):
  1. `ServeArgs` gains `--control-secret-file <path>` (required; D5, D18), `--supervisor-url <url>` (clap `env = "ZS_SUPERVISOR_URL"`, default `DEFAULT_SUPERVISOR_URL`; the URL is not a secret, so the environment form b8:40 relies on is honoured) and `--control-listen <addr>` (default `127.0.0.1:8446`, D5; must be a loopback address, validated). `serve` reads the secret file once at the top of `execute_serve`, before any thread or child is spawned. No `ZS_CONTROL_SECRET` exists anywhere (D18): the server's environment is inherited by every language server, task and PTY, so a secret left there would be readable by any code the user runs. D5 also fixes `--allowed-origin <origin>` (repeatable; b2:573 already has it, the supervisor passes `manifest.allowedOrigins`) — the asset route of item 4 needs it as much as `/files` does.
  2. After `build_headless_project`: build a proxy-less `ReqwestClient`, `RegistryConfig { http: Arc::new(HttpClientWithUrl::new(http_client.clone(), std::env::var("ZED_SERVER_URL").unwrap_or("https://zed.dev".into()), None)), release_channel: *RELEASE_CHANNEL }`, and call `project.update(cx, |p, cx| p.enable_sandbox(SandboxConfig { .. }, cx))`; keep the returned `Arc<ControlChannel>`.
  3. Bind a second, loopback-only hyper listener on `--control-listen` (D5) and route `POST /control/lifecycle`, `POST /control/ports`, `POST /control/extensions` to `ControlChannel::handle` through the `ControlRoutes` adapter of 3.10 (`peer_is_loopback` from the accepted socket, `session_attached: state.session().is_some()`). The public listener never mounts `/control/*` (b2:545's `state.control` branch moves to this listener; the public router answers 404 unconditionally).
  4. On the public listener, route `GET /extensions/{id}/assets/{rel}` (same auth and the same CORS handling as `/files`, since the browser fetches it cross-origin from the shell page — D5 `--allowed-origin`) to `HeadlessExtensionStore::asset_path` and stream the file (BUILD-SPEC section 9; previously unowned).
  5. `GpuiCommand` (b2:601-604) gains `SessionAttached` (sent by `GpuiHooks::session_attached` after every attach, b2:381, 449, 620 — b2's "no-op until b4 installs its ports replay") → `project.update(cx, |p, cx| p.on_session_attached(cx))`, and `FilesUploaded(Vec<PathBuf>)` (sent by `files::handle_upload` after its rename) → `HeadlessProject::notify_files_uploaded`. Adopted by D20.
  6. `is_input_envelope` (b2:431-440) excludes `SaveClientState`, `LoadClientState` and `ListExtensions` from the idle clock (otherwise a dirty tab's 15 s save keeps `last_input_at` fresh forever) — and, per D20, b3's `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal`. `Heartbeat` is a control (text) frame, never an envelope (D3), so it needs no exclusion. Add the three cases here to b2's `is_input_envelope_rules` test. `last_input_at` is what the supervisor reports as `lastInputAt` in the activity ping (D13), so these exclusions are what keeps a dirty but idle tab eligible for idle stop.
  7. Prebuild (D14, b8's `zs-agent prebuild`): a headless warm-up client that connects over `/rpc` must not run a `ClientStateStore` — a `SaveClientState` from it would seed `server_state/client_state/` in the snapshot and every user's first `LoadClientState` would restore a headless client's database. `POST /control/extensions` from the manifest during prebuild is fine and desirable (the extensions land in the snapshot). Addressed to b8 in section 7 item 8.

### 3.16 `crates/project/src/lifecycle.rs` (new), `crates/project/src/port_store.rs` (new), `crates/project/src/remote_extension_store.rs` (new), `crates/project/src/project.rs` (modify)

`lifecycle.rs`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleKind { IdleStopIn, SessionCapIn, Stopping, Resumed }
impl LifecycleKind {
    pub fn from_proto(kind: i32) -> Option<Self>;   // proto::LifecycleKind::from_i32
    pub fn to_proto(self) -> proto::LifecycleKind;  // IdleStopIn → proto::LifecycleKind::IdleStopIn, etc. (no prefix stripping, section 2)
    /// "idle_stop_in" | "session_cap_in" | "stopping" | "resumed" — the same snake_case tags as the supervisor
    /// JSON of 4.2 (`LifecycleBody`'s serde `rename_all`); what b7 forwards to the shell's `onLifecycle` (b7:594).
    pub fn as_str(self) -> &'static str;
}
```

No hooks global and no toast live in Rust: BUILD-SPEC 7.6 puts lifecycle toasts in the shell page and b9:622 implements them from `onLifecycle(notice)`; the entry crate forwards `project::Event::LifecycleNotice` to JS (and calls `ClientStateStore::flush_now` on `Stopping`). `seconds` is a countdown ("will stop in N seconds", BUILD-SPEC 7.5), which the consumer renders.

`port_store.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq)] pub struct ListeningPort { pub port: u16, pub pid: u32, pub process_name: String }
#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum PortVisibility { Private, Public }   // ↔ proto::PortVisibility::{PortPrivate, PortPublic}
#[derive(Clone, Debug, PartialEq, Eq)] pub struct PortForward { pub port: u16, pub visibility: PortVisibility, pub label: Option<String>, pub url: String }

pub struct PortStore { client: AnyProtoClient, project_id: u64, listening: Vec<ListeningPort>, forwards: BTreeMap<u16, PortForward> }
pub enum PortStoreEvent { Changed }
impl EventEmitter<PortStoreEvent> for PortStore {}

impl PortStore {
    pub fn remote(client: AnyProtoClient, project_id: u64) -> Self;
    pub fn init(client: &AnyProtoClient);   // client.add_entity_message_handler(Self::handle_ports_changed)
    pub fn listening_ports(&self) -> &[ListeningPort];
    pub fn forwards(&self) -> impl Iterator<Item = &PortForward>;
    pub fn forward_port(&self, port: u16, visibility: PortVisibility, label: Option<String>, cx: &mut Context<Self>) -> Task<Result<PortForward>>;
    pub fn unforward_port(&self, port: u16, cx: &mut Context<Self>) -> Task<Result<()>>;
    async fn handle_ports_changed(this: Entity<Self>, envelope: TypedEnvelope<proto::PortsChanged>, cx: AsyncApp) -> Result<()>;
}
```

The store relies on the server's attach replay (3.14) for its state after a takeover; a `PortsChanged` always carries the full picture and replaces both lists. `PortForward.url` is opened by the ports UI as a top-level navigation (`cx.open_url`, i.e. a new tab): for a private forward it is the control plane's `/open` link whose redirect sets the proxy cookie (D8), which an in-page `fetch` could not do; the store never interprets it.

`remote_extension_store.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq)] pub struct InstalledExtension { pub id: Arc<str>, pub version: Arc<str>, pub name: String, pub description: Option<String>, pub provides: Vec<String>, pub dev: bool }
#[derive(Clone, Debug, PartialEq, Eq)] pub struct AvailableExtension { pub id: Arc<str>, pub version: Arc<str>, pub name: String, pub description: Option<String>, pub authors: Vec<String>, pub repository: String, pub provides: Vec<String>, pub download_count: u64 }

pub struct RemoteExtensionStore { client: AnyProtoClient, project_id: u64, installed: Vec<InstalledExtension>, pending: BTreeSet<Arc<str>> }
pub enum RemoteExtensionEvent { InstalledChanged, OperationFinished { id: Arc<str>, error: Option<String> } }
impl EventEmitter<RemoteExtensionEvent> for RemoteExtensionStore {}

impl RemoteExtensionStore {
    pub fn remote(client: AnyProtoClient, project_id: u64) -> Self;
    pub fn init(client: &AnyProtoClient);   // add_entity_message_handler(Self::handle_extensions_changed)
    pub fn installed(&self) -> &[InstalledExtension];
    pub fn is_pending(&self, id: &str) -> bool;
    pub fn refresh(&self, cx: &mut Context<Self>) -> Task<Result<()>>;                                         // ListExtensions { include_available: false }
    pub fn search(&self, search: Option<String>, cx: &mut Context<Self>) -> Task<Result<Vec<AvailableExtension>>>; // ListExtensions { include_available: true }
    pub fn install(&mut self, id: Arc<str>, version: Option<Arc<str>>, cx: &mut Context<Self>) -> Task<Result<()>>;
    pub fn uninstall(&mut self, id: Arc<str>, cx: &mut Context<Self>) -> Task<Result<()>>;
    /// Fails every pending operation with `error: Some("disconnected")` and clears `pending`.
    pub fn fail_pending(&mut self, cx: &mut Context<Self>);
    async fn handle_extensions_changed(this: Entity<Self>, envelope: TypedEnvelope<proto::ExtensionsChanged>, cx: AsyncApp) -> Result<()>;
}
```

`install`/`uninstall` insert into `pending`, await the request, and always remove the id and emit `OperationFinished` whether the result is `Ok` or `Err` (so an error response after a replay does not leave a stuck spinner).

`project.rs`:

- Line 1-34: add `pub mod lifecycle; pub mod port_store; pub mod remote_extension_store;`.
- `Event` (line 337): add `LifecycleNotice { kind: lifecycle::LifecycleKind, seconds: u32 }` and `FilesUploaded(Vec<ProjectPath>)` (both `Clone + Debug + PartialEq`).
- `Project` struct (near line 230): add `port_store: Option<Entity<PortStore>>` and `remote_extension_store: Option<Entity<RemoteExtensionStore>>`; the struct literals in `local` (`:1364-1385`), `remote` (`:1634`) and `from_join_project_response` (`:1910`) set them (`None` in the first and third).
- `Project::remote` (line 1423-1691): create both stores with `remote_proto.clone()` and `REMOTE_SERVER_PROJECT_ID`; add `remote_proto.subscribe_to_entity(REMOTE_SERVER_PROJECT_ID, &port_store)` and `(..., &remote_extension_store)` next to line 1655-1663; add `remote_proto.add_entity_message_handler(Self::handle_lifecycle_notice)` and `(Self::handle_files_uploaded)` next to line 1670-1673; add `PortStore::init(&remote_proto); RemoteExtensionStore::init(&remote_proto);` next to line 1681-1690; `cx.subscribe(&remote, ..)` on `RemoteClientEvent`: `Disconnected { .. }` (either terminal state — `ServerNotRunning` or `ReconnectExhausted`, D2) → `remote_extension_store.fail_pending`; `Reconnected` → `remote_extension_store.refresh` (the entry crate does the same for `ClientStateStore::{stop, resync}`, which lives outside `project`).
- Handlers, next to `handle_toast` (line 5497):

```rust
async fn handle_lifecycle_notice(this: Entity<Self>, envelope: TypedEnvelope<proto::LifecycleNotice>, mut cx: AsyncApp) -> Result<()>;
async fn handle_files_uploaded(this: Entity<Self>, envelope: TypedEnvelope<proto::FilesUploaded>, mut cx: AsyncApp) -> Result<()>;
```

  `handle_lifecycle_notice` emits `Event::LifecycleNotice` (unknown `kind` values are logged and dropped). `handle_files_uploaded` maps `ProjectPath::from_proto` (line 459) and emits `Event::FilesUploaded`.
- Accessors: `pub fn port_store(&self) -> Option<&Entity<PortStore>>`, `pub fn remote_extension_store(&self) -> Option<&Entity<RemoteExtensionStore>>`.

### 3.17 `crates/workspace/src/workspace.rs`

No change beyond the `pub mod client_state;` line of 3.8. An earlier revision added a lifecycle toast arm and a `LifecycleHooks` global here; both are removed (see 3.16 and the review log). `FilesUploaded` is likewise not handled in `workspace`; the project panel (later work) subscribes to `project::Event::FilesUploaded` and calls its existing reveal-path logic.

## 4. New types and messages

### 4.1 `crates/proto/proto/remote_session.proto` (complete file)

```proto
syntax = "proto3";
package zed.messages;

import "worktree.proto";

// ---- 5.4 client persistence ----
message SaveClientState {
  uint64 project_id = 1;
  bytes sqlite = 2;                 // sqlite3_serialize image of the client's AppDatabase (gzip-compressed when `gzip`)
  uint64 version = 3;               // strictly increasing per workspace; server keeps the max it has seen
  bool gzip = 4;
  optional string client_build = 5; // build id of the writer, stored in meta.json for skew diagnostics
}
message SaveClientStateResponse {
  bool accepted = 1;                // false: server already holds `version` >= the request's
  uint64 version = 2;               // server's current version after the call
}
message LoadClientState {
  uint64 project_id = 1;
  bool metadata_only = 2;           // when true, `sqlite` is left empty
}
message LoadClientStateResponse {
  bytes sqlite = 1;                 // empty when nothing stored or metadata_only
  uint64 version = 2;               // 0 when nothing stored
  bool gzip = 3;
  optional string client_build = 4;
}

// ---- 5.5 lifecycle notices (server -> client) ----
// JSON/JS spelling of these values is snake_case ("idle_stop_in", ...): LifecycleKind::as_str (3.16) and LifecycleBody (4.2).
enum LifecycleKind {
  IdleStopIn = 0;
  SessionCapIn = 1;
  Stopping = 2;
  Resumed = 3;
}
message LifecycleNotice {
  uint64 project_id = 1;
  LifecycleKind kind = 2;
  uint32 seconds = 3;    // countdown for IdleStopIn / SessionCapIn; 0 otherwise
}

// ---- 5.2 port forwarding ----
enum PortVisibility {
  PortPrivate = 0;
  PortPublic = 1;
}
message ListeningPort {
  uint32 port = 1;
  uint32 pid = 2;
  string process_name = 3;
}
message PortForward {
  uint32 port = 1;
  PortVisibility visibility = 2;
  optional string label = 3;
  string url = 4;                      // opaque: the slot URL for public forwards, the control plane /open link for private ones (D8); "" when the supervisor returned null
}
message PortsChanged {
  uint64 project_id = 1;
  repeated ListeningPort ports = 2;
  repeated PortForward forwards = 3;   // current forwards, so a fresh session gets the full picture
}
message ForwardPort {
  uint64 project_id = 1;
  uint32 port = 2;                     // validated to 1..=65535 by the server
  PortVisibility visibility = 3;
  optional string label = 4;
}
message ForwardPortResponse { string url = 1; }   // same semantics as PortForward.url (D8)
message UnforwardPort {
  uint64 project_id = 1;
  uint32 port = 2;
}

// ---- 5.3 file transfer ----
message FilesUploaded {
  uint64 project_id = 1;
  repeated ProjectPath paths = 2;
}

// ---- 5.6 extensions ----
message InstalledExtension {
  string id = 1;
  string version = 2;
  string name = 3;
  optional string description = 4;
  repeated string provides = 5;   // ExtensionProvides kebab-case names
  bool dev = 6;
}
message AvailableExtension {
  string id = 1;
  string version = 2;
  string name = 3;
  optional string description = 4;
  repeated string authors = 5;
  string repository = 6;
  repeated string provides = 7;
  uint64 download_count = 8;
}
message ListExtensions {
  uint64 project_id = 1;
  optional string search = 2;
  bool include_available = 3;     // when false, `available` is left empty and no registry call is made
}
message ListExtensionsResponse {
  repeated InstalledExtension installed = 1;
  repeated AvailableExtension available = 2;
}
// Named `InstallRegistryExtension` because `InstallExtension` (app.proto:59) is the
// existing SSH upload-install message and stays for desktop-over-SSH compatibility.
message InstallRegistryExtension {
  uint64 project_id = 1;
  string id = 2;                  // validated against ^[a-z0-9][a-z0-9_-]{0,63}$ by the server
  optional string version = 3;    // absent = latest compatible
}
message UninstallExtension {
  uint64 project_id = 1;
  string id = 2;                  // same validation
}
message ExtensionsChanged {
  uint64 project_id = 1;
  repeated InstalledExtension installed = 2;
}
```

Enum value names are UpperCamelCase to match `ErrorCode` (`zed.proto:564-584`) and to avoid colliding with `ChannelVisibility` values in package scope. Generated Rust names: `proto::LifecycleKind::{IdleStopIn, SessionCapIn, Stopping, Resumed}` and `proto::PortVisibility::{PortPrivate, PortPublic}` (prost strips a prefix only for `ENUM_NAME_`-style values).

### 4.2 Supervisor-facing JSON (control channel and supervisor API)

`POST /control/lifecycle` (supervisor → server, the loopback control listener on `127.0.0.1:8446`, D5/D18), `Authorization: Bearer <control secret>` (the secret the supervisor wrote to the `--control-secret-file` path, D18):

```json
{ "kind": "idle_stop_in", "seconds": 300 }
{ "kind": "session_cap_in", "seconds": 1800 }
{ "kind": "stopping" }
{ "kind": "resumed" }
```

`POST /control/ports` (supervisor → server):

```json
{ "ports": [ { "port": 3000, "pid": 4242, "process_name": "node" } ],
  "forwards": [ { "port": 3000, "visibility": "public", "label": "web", "url": "https://x.vercel.run" } ] }
```

`POST /control/extensions` (supervisor → server, at startup from the manifest's `extensions` list — fixture `docs/contracts/fixtures/manifest.example.json`, D19 — and `devcontainer.json` `customizations.zed.extensions`, BUILD-SPEC 6.3, and again later whenever the list changes; D5): `{ "install": ["toml", "html"] }` → 204; installs already on disk are skipped. This is the extension re-install path after a rebuild and supersedes b8's `remote_extensions/pending.json` hand-off (b8:759-760, 1441); the server reads no such file.

`POST $SUPERVISOR_URL/ports` (server → supervisor): `{ "port": 3000, "visibility": "public", "label": "web" }` → `200 { "url": "https://…" | null }` (`url` per D8: the slot URL for a public forward, the control plane `/open` link for a private one; `null` → `""`); a refused private forward (no free proxy slot, D8) is a non-2xx `{ "error": "…" }` that the server surfaces to the client as the `ForwardPort` error. `DELETE $SUPERVISOR_URL/ports/3000` → `204`. `POST $SUPERVISOR_URL/extensions` (server → supervisor): `{ "installed": ["toml", "html"] }` → `204` (D18: b8 relays it to the control plane; D19: b9 consumes it into `workspaces.installed_extensions`). All carry the same bearer secret. Configuration contract for `serve` (D5, D18, D20): `--control-secret-file` (required), `--supervisor-url` (env `ZS_SUPERVISOR_URL`, default `http://127.0.0.1:8445`; risk 20), `--control-listen` (default `127.0.0.1:8446`), `--allowed-origin` (repeatable); no secret-bearing environment variable exists in the server's environment or reaches its children.

### 4.3 On-disk formats under `paths::data_dir()`

`paths::data_dir()` is `/vercel/.local/share/zed` in the sandbox image (`HOME=/vercel`, b8:1427) and the whole directory is in the rebuild tarball (D9).

- Inside the client-state image (the client's whole `AppDatabase`, D7): every registered domain's tables (workspace layout, `editors` including `editors.contents` for dirty singleton editors, b3's terminal restore rows per D4, ...), `scoped_kv_store` rows under namespace `global` (the folded `GlobalKeyValueStore`, 3.6a), and `unsaved_buffers` (D6, 3.8: `workspace_id, abs_path, text, mtime_seconds, mtime_nanos, snapshot_at_unix_ms`), which is non-empty only between a `STOPPING` snapshot and the next successful restore.
- `server_state/client_state/db.sqlite` — the stored bytes exactly as received (gzip when `meta.json` says so); `server_state/client_state/db.sqlite.prev` — the previously accepted image; `server_state/client_state/meta.json` — `{"version":17,"saved_at_unix_ms":1725300000000,"bytes":131072,"gzip":true,"client_build":"zs-2026.09.02"}`.
- `remote_extensions/<id>/` — extension payloads exactly where `HeadlessExtensionStore` expects them (`headless_host.rs:216, 518`); `remote_extensions/staging/` — registry download staging; `remote_extensions/work/` — `WasmHost` work dir (existing). No index file: the installed set is the set of subdirectories with an `extension.toml`.

Rust types are given inline in section 3 (`ClientStateStore` (server), `ClientStateMeta`, `ControlChannel`, `ControlEvent`, `ControlRequest`, `ControlResponse`, `LifecycleBody`, `PortsBody`, `ExtensionsBody`, `PortForwarder`, `RegistryConfig`, `InstalledExtensionRecord`, `SandboxConfig`, `SandboxRuntime`, `RestoreOutcome`, `SaveOutcome`, `ClientStateSink`, `ClientStateStore` (client), `ClientStateEvent`, `RemoteClientStateSink`, `UnsavedBuffersDb`, `UnsavedBufferRow`, `GLOBAL_KVP_NAMESPACE` / `GlobalKeyValueStore::{from_app_db, init}`, `LifecycleKind` (with `as_str`), `PortStore`, `PortForward`, `ListeningPort`, `PortVisibility`, `RemoteExtensionStore`, `InstalledExtension`, `AvailableExtension`).

## 5. Cargo/package changes

Checked against the workspace manifest (`Cargo.toml:273` `[workspace.dependencies]`). No new third-party crates; intra-workspace dependency lines only.

- `crates/remote_server/Cargo.toml` `[dependencies]`: add `serde.workspace = true` (the control-channel and supervisor JSON bodies derive `Serialize`/`Deserialize`; `serde_json`, `http_client`, `watch`, `extension_host`, `release_channel`, `paths`, `futures` are already present). `subtle.workspace = true` is added by b2 (b2:76, 616, which also adds the `[workspace.dependencies]` line); if this brief lands first it adds both lines itself. No `postage` (the barrier is awaited through `futures::StreamExt`).
- `crates/db/Cargo.toml` `[dependencies]`: add `futures.workspace = true` (for `BoxFuture` in `ClientStateSink` and `Shared`; workspace pins `futures = "0.3.32"` at `Cargo.toml:625`).
- `crates/workspace/Cargo.toml` `[dependencies]`: add `async-compression.workspace = true` (gzip for `RemoteClientStateSink` / `load_client_state`; workspace line `Cargo.toml:536` with `gzip` + `futures-io`; pure-Rust `miniz_oxide` backend, so b6/b7's wasm build of `workspace` is unaffected).
- D6 and D7 add no dependencies: `crates/workspace` already depends on `language`, `fs`, `project`, `db` and `sqlez` (section 2) for `UnsavedBuffersDb`, `snapshot_unsaved_buffers` and `restore_unsaved_buffers`, and 3.6a only reuses `scoped_kv_store` inside `crates/db`.
- `crates/proto`, `crates/sqlez`, `crates/extension_host`, `crates/project`: no manifest changes. `libsqlite3-sys` bundled 3.46.0 already exports serialize/deserialize; `extension_host` already has `async-compression`, `async-tar`, `tempfile`, `cloud_api_types`, `http_client`, `release_channel`; `project` already has `rpc`/`remote`; `workspace` already has `client`/`db`. `Arc<str>` fields deriving serde use the workspace's `serde` `rc` feature (`Cargo.toml:802`).
- Dev-dependencies: `crates/remote_server/Cargo.toml:82-105` already provides `fs`, `http_client`, `remote`, `project`, `gpui` with `test-support` and `tempfile`; `crates/sqlez` tests need nothing new; `crates/db` tests already have `gpui` test-support and `tempfile` (`db/Cargo.toml:32-34`).
- Package (TypeScript) changes: none in this brief. The control plane's `POST /api/sandboxes/{name}/ports` (BUILD-SPEC 7.3) is called by the supervisor, not by the server; the `installed_extensions` relay is a b8/b9 addition (section 7).

## 6. Tests

Unit tests (each in the crate it exercises):

- `crates/proto` (`proto.rs:1089` tests module): `test_remote_session_messages_round_trip` — every new message encodes to an `Envelope` via `into_envelope`, decodes with `Envelope::decode`, and `build_typed_envelope` returns the same payload; asserts `is_background()` per the priorities in 3.3 and that `proto::PortVisibility::PortPublic as i32 == 1`.
- `crates/sqlez` (`connection.rs` tests): `serialize_then_restore_preserves_rows` (insert rows, `serialize_main`, `open_scratch_from_image`, `restore_main_from` into a fresh in-memory connection, select equal rows); `serialize_empty_database_is_empty_vec` (fresh connection, no schema → `Ok(vec![])`, not an error); `restore_from_wal_image` (tempfile-backed connection with `PRAGMA journal_mode=WAL`, rows, `serialize_main`; assert header bytes 18-19 are 2 in the image; restore into a fresh connection succeeds and rows are visible — proves the header patch); `restore_visible_across_thread_local_connections` (restore through the builder's `with_restore_image` on a shared-memory URI, read from a second thread's connection); `restore_rejects_garbage` (`open_scratch_from_image(b"nope")` is `Err`); `write_bumps_generation` (`write_generation` increases by exactly one per `write`, unchanged by reads); `build_with_outcome_skips_unmigratable_image` (image whose `migrations` row for step 0 has different text; `build_with_outcome` returns `Skipped(..)`, the database is empty and usable, and `build` does not panic).
- `crates/db` (`db.rs` tests): `open_db_with_image_runs_missing_migrations` (image produced under domain with migration A only; open under A+B; table from B exists, rows from A survive, outcome `Restored`); `open_db_with_image_from_newer_build` (image with an extra completed step C beyond the code's list; opens with `Restored`; a differing step text yields `Skipped` — the policy of risk 17); `open_fallback_db_applies_image` (with `ZED_STATELESS`-style fallback, the image is applied; a bad image yields `Skipped` and no panic); `client_state_store_saves_only_when_dirty` (fake sink records calls; no write → no save after `SAVE_INTERVAL` via `cx.executor().advance_clock`; one write → exactly one save with `version == loaded + 1`; `flush_now` during an in-flight save coalesces to one sink call; `flush_now` on a clean store still sends; image over `MAX_IMAGE_BYTES` emits `SaveFailed` and does not bump `version`); `client_state_store_converges_after_stale` (fake sink answers `accepted: false, version: 7`; store adopts 7, stays dirty, next tick sends 8, `Stale` then `Saved` emitted); `client_state_store_read_only_after_skipped_restore` (constructed with `Skipped`; migrations dirty the db; no sink call after several intervals; `allow_overwrite` then one save); `client_state_store_sink_error_surfaces` (sink returns `Err` → `SaveFailed`, task resolves, no hang); `client_state_store_stop_and_resync` (`stop` → no further saves and `flush_now` resolves to `Err`; `resync` queries `current_version` and marks dirty); `client_state_store_rebind` (after `stop`, `rebind(new_sink)` queries `current_version` on the new sink, the ticker resumes, the old sink receives nothing more — the D2 from-scratch `reconnect()` path); `global_kvp_rows_travel_in_image` (D7, 3.6a: `GlobalKeyValueStore::from_app_db(&db).write_kvp("k", "v")`, `db.0.serialize()`, `open_with_image(Some(image))` on a fresh database → `from_app_db(&db2).read_kvp("k") == Some("v")` and `KeyValueStore::from_app_db(&db2).scoped("global").read("k")` sees the same row; a native `GlobalKeyValueStore` opened from its own file is unaffected).
- `crates/workspace` (`client_state.rs` tests, `#[gpui::test]` with `FakeFs` + `Project::test` + `Workspace::test_new`, D6): `snapshot_writes_dirty_path_backed_buffers_only` (three buffers: clean, dirty path-backed, dirty untitled → exactly one row with the absolute path, the full text, the buffer's `saved_mtime`, and `FakeFs` untouched); `snapshot_respects_limit` (a buffer over `UNSAVED_SNAPSHOT_LIMIT_BYTES` is skipped with a warning, the others are written); `restore_applies_text_and_marks_dirty` (a second workspace over the same `AppDatabase` and `FakeFs`: after `restore_unsaved_buffers` the buffer's text equals the row, `is_dirty()`, `peek_undo_stack()` holds no entry for the restore, the active pane has a non-active item for the path, `rows_for_workspace` is empty); `restore_skips_identical_text` (the editor item already restored the text from `editors.contents` → no edit is applied, the buffer stays dirty); `restore_marks_conflict_when_disk_changed` (the file's mtime is bumped after the snapshot → `has_conflict()` after restore); `restore_drops_rows_for_closed_worktrees` (a row whose path is outside every worktree is dropped with a warning; no panic, rows cleared).
- `crates/remote_server` (`client_state.rs` tests, `FakeFs`): `save_then_load_round_trips` (bytes, `gzip`, `client_build` and version equal); `stale_version_returns_current` (second save with the same version → `accepted: false, version == current`, file unchanged); `load_without_state_is_empty` (`sqlite.is_empty() && version == 0`); `state_survives_new_store_instance` (a second `ClientStateStore::new` over the same `FakeFs` reports the stored version); `load_immediately_after_new_sees_stored_version` (`FakeFs` with stored meta; `LoadClientState` issued before `run_until_parked` still returns the stored version — the `loaded` gate); `prev_image_kept` (two saves → `db.sqlite.prev` holds the first); `save_notifies_watch`; `metadata_only_omits_bytes`.
- `crates/remote_server` (`control.rs` tests, `RemoteClient::fake_server` from `remote_client.rs:1152`): `rejects_bad_secret_and_non_loopback` (`Unauthorized` in both cases, nothing sent); `lifecycle_body_reaches_client` (POST idle_stop_in 300 → the fake client `Project` emits `Event::LifecycleNotice { IdleStopIn, 300 }`); `ports_body_reaches_port_store` (POST ports → `PortStore::listening_ports()` equals body, `forwards()` equals body, `PortStoreEvent::Changed` emitted once); `stopping_without_session_returns_immediately` (`session_attached: false` → `NoContent` with no clock advance and nothing sent); `stopping_waits_for_save` (POST stopping with a session returns only after `ClientStateStore` accepts a save, or after `STOPPING_FLUSH_TIMEOUT` with `advance_clock`); `resumed_is_replayed_after_attach` (POST resumed with `session_attached: false`, then `replay_after_attach` → one `Resumed` notice and the last `PortsChanged`); `extensions_body_emits_event` (POST extensions → `ControlEvent::InstallExtensions(["toml"])`; an invalid id → `BadRequest`).
- `crates/remote_server` (`ports.rs` tests, request-capturing fake from `FakeHttpClient::create(handler) -> Arc<HttpClientWithUrl>` at `crates/http_client/src/http_client.rs:431`, passed as `Arc<dyn HttpClient>` through `impl HttpClient for HttpClientWithUrl` at `:335`): `forward_posts_expected_json_and_returns_url` (method POST, path `/ports`, bearer header present, body `{port,visibility:"public",label}`, response url propagated); `forward_maps_null_url_to_empty` (`200 {"url":null}` → `Ok("")`); `forward_refusal_surfaces_supervisor_error` (`409 {"error":"no_private_slot"}` → `Err` whose message contains `no_private_slot`; D8 slot exhaustion); `unforward_sends_delete`; `report_installed_extensions_posts_ids`; `supervisor_error_propagates` (500 → `Err`); `forward_without_sandbox_errors` (message contains "not available"); `forward_rejects_port_out_of_range` (0 and 70000 → `Err`, no HTTP call).
- `crates/extension_host` (`extension_store_test.rs`, pattern at `:1679-1701`): `headless_install_from_registry` (fake HTTP serves a gzip tarball of a fixture extension with `languages/foo`; after `install_from_registry("foo", None)` the dir `/extensions/foo` exists, `installed_extension_records()` lists the manifest version, `ExtensionsInstalledChanged` fired once, `loaded_extensions` contains `foo`); `headless_install_theme_only_extension` (manifest with only `themes`; no panic, dir present, `loaded_extensions["theme"]` has empty language/server vectors); `headless_install_pinned_version_uses_versioned_url` (captured request path is `/extensions/foo/1.2.3/download`; a tarball whose manifest says `1.2.4` is rejected); `headless_install_rejects_mismatched_manifest_id`; `headless_install_rejects_oversized_or_traversing_archive` (body over `MAX_REGISTRY_DOWNLOAD_BYTES` aborts; an entry `../escape` does not appear outside the temp dir); `headless_install_suppressed_id_rejected`; `install_rejects_traversal_id` / `uninstall_rejects_traversal_id` (`"../../.."` → `Err`, `FakeFs` untouched); `headless_uninstall_removes_dir_and_record`; `load_installed_from_disk_scans_manifests` (new store over the same `FakeFs` with `foo/extension.toml`, a `work/` dir and a `staging/` dir → loads `foo` only, emits `ExtensionsInstalledChanged` exactly once, no sync message needed); `test_desktop_sync_keeps_registry_extensions` (store with registry set and `foo` loaded; `sync_extensions([])` removes nothing and reports nothing missing; with registry unset it removes `foo` as today); `list_extensions_includes_available_when_requested` (fake registry returns one `ExtensionMetadata`; `include_available: false` makes no HTTP call); `asset_path_rejects_traversal`.
- `crates/project` (`port_store.rs`, `remote_extension_store.rs`, `lifecycle.rs` tests with `RemoteClient::fake_server` + `connect_mock`): `ports_changed_updates_store` and `extensions_changed_updates_store`; `install_marks_pending_until_response` (`is_pending` true while the fake server delays the `Ack`, false after; `OperationFinished` emitted with `error: None`; with a server error, `error: Some(..)`; `fail_pending` clears a hung request); `pending_fails_on_reconnect_exhausted` (a `Disconnected { server_not_running: false }` — the `ReconnectExhausted` shape, D2 — also fails pending operations); `lifecycle_kind_as_str_is_snake_case` (`as_str()` yields exactly `idle_stop_in`, `session_cap_in`, `stopping`, `resumed`, matching the `LifecycleBody` serde tags of 3.10).

Integration tests (`crates/remote_server/src/remote_editing_tests.rs`, using `init_test` at `:4695` plus `enable_sandbox` with a fake supervisor `HttpClientWithUrl` and a `RegistryConfig` over `FakeHttpClient`):

- `test_client_state_round_trip_over_session`: client `Project`'s `remote_client().proto_client()` sends `SaveClientState` (image from a real `AppDatabase::test_new` serialized through `ThreadSafeConnection::serialize`, gzipped by `RemoteClientStateSink`), then `load_client_state`; assert bytes equal after decompression and that `AppDatabase::new_with_image` over the returned bytes yields the same `kv_store` row written before saving.
- `test_save_survives_lost_response` (pattern at `:2780-2810`): `simulate_disconnect` after the server accepted version N+1 but before the client saw the response; on reconnect the replayed request gets `accepted: false, version: N+1`; assert the store's next save is N+2 and `accepted: true`.
- `test_lifecycle_notice_emits_project_event`: drive `server_session.send(proto::LifecycleNotice{...})` like the telemetry test at `:258-262`; assert `project::Event::LifecycleNotice { kind: Stopping, seconds: 0 }` is observed by a `cx.subscribe` on the project.
- `test_files_uploaded_refreshes_worktree`: insert a file into the server `FakeFs` under the worktree root after the initial scan, call `HeadlessProject::notify_files_uploaded`, assert the client worktree snapshot contains the entry and `Event::FilesUploaded` carried its `ProjectPath`.
- `test_extension_install_over_session`: client `RemoteExtensionStore::install("foo", None)` against a headless store with a fake registry; assert `Ack`, then `ExtensionsChanged` arrives and `installed()` contains `foo`; the fake supervisor saw `POST /extensions {installed:["foo"]}`; `uninstall` empties it.
- `test_session_attach_replays_state`: after `enable_sandbox`, `load_installed_from_disk` and a `POST /control/ports`, call `on_session_attached`; assert the client's `PortStore` and `RemoteExtensionStore` are populated without any client request.
- `test_old_server_rejects_save_client_state` (regression guard for version skew): a bare `RemoteClient::fake_server` + `connect_mock` with **no** `HeadlessProject` (so no handler is registered on the server side); the client `ClientStateStore` with a `RemoteClientStateSink` ticks once; assert the sink's `save` resolved to `Err` containing "no handler registered" (`remote_client.rs:1861-1870`), `SaveFailed` was emitted, and a subsequent `Ping` still round-trips.
- `test_stopping_snapshots_unsaved_buffers` (D6, end to end): open a buffer through the client `Project`, edit it without saving, `POST /control/lifecycle {"kind":"stopping"}` against the `ControlChannel` with `session_attached: true`; the test's stand-in for the entry crate handles `Event::LifecycleNotice { Stopping }` by running `snapshot_unsaved_buffers` then `flush_now`; assert the POST returned `NoContent` before `STOPPING_FLUSH_TIMEOUT` (no clock advance), the server's `db.sqlite` decompresses to an image whose `unsaved_buffers` table has the row, the server `FakeFs` file is byte-identical to before (the client wrote nothing to disk), and a second client `Project` + workspace opened from `LoadClientState` reopens the buffer dirty with the edited text after `restore_unsaved_buffers`.
- `test_sandbox_runtime_survives_fresh_session` (D3): after `enable_sandbox` and one accepted `SaveClientState`, call `project.update(cx, |p, cx| p.reset_for_new_client(cx))` (b2) and attach a new fake client; assert `LoadClientState` still returns the saved version, `POST /control/ports` still reaches the new client, and no "handler already registered" panic occurred (the handlers were registered once).

Wasm-side coverage (BUILD-SPEC 13 requires `wasm-bindgen-test` for SQLite-in-wasm): the `open_with_image` + `serialize` round trip in the browser belongs to b6's `wasm-bindgen-test` suite (b6:832-834), which already lists it; nothing here runs on the host.

## 7. Risks and open questions

1. Tag allocation. This brief claims oneof tags 500–514 and leaves 488–499 for the terminals brief (b3:86-99). Whichever lands second must re-home the `// current max` comment; a mismatch is caught at `protox::compile` (`build.rs:3`) as a duplicate tag, not silently.
2. Serve-side obligations (b2). All server hooks are addressed to b2 in 3.15: three `ServeArgs` flags, the secret read before any spawn, the loopback-only control listener with `/control/{lifecycle,ports,extensions}`, `GET /extensions/{id}/assets/*` on the public listener, `GpuiCommand::{SessionAttached, FilesUploaded}`, `enable_sandbox` after `build_headless_project`, `on_session_attached` after every attach, and the three `is_input_envelope` exclusions. **Decided:** D20 adopts these six contract items (flags, secret handling, control listener, asset route, `GpuiCommand` variants, `is_input_envelope` exclusions) as b2's contract alongside b1's 7.12 items; D5 fixes the listener address and adds `--allowed-origin`. What remains is implementation on b2's side (the `ControlRoutes` adapter of 3.10 and moving the `/control/*` branch off the public router).
3. `InstallExtension` name and the desktop sync path. BUILD-SPEC 5.7 says `SyncExtensions` and `upload_directory` are "replaced", but desktop Zed's `ExtensionStore::register_remote_client` (`extension_host.rs:2285`) still runs the SSH sync against any `RemoteClient`, and over the WebSocket transport `upload_directory` returns a ready `Err` (b1:171). This brief keeps the old messages, names the new one `InstallRegistryExtension`, and makes the server's `sync_extensions` additive in sandbox mode (3.13) so a desktop connect cannot wipe registry-installed extensions; the desktop still logs upload errors for extensions the sandbox lacks. A `RemoteConnection::supports_extension_upload()` gate in `register_remote_client` would silence that and belongs to b1 or a desktop follow-up.
4. SQLite restore semantics. Restore goes through a scratch `sqlite3_deserialize` (header bytes 18-19 patched to 1 because native images come from WAL-mode files, `db.rs:129-134`; `sqlite3.h:10776-10778`), a migration dry-run on the scratch, then `backup_main` into the application connection before `journal_mode=WAL` is set. Verified against bundled SQLite 3.46.0 bindings and source; the wasm run (single connection, `OMIT_SHARED_CACHE`, page size fixed by `sqlite-wasm-rs`, b6:87, 169) is b6's `wasm-bindgen-test`. Restoring into an existing WAL database with a different page size is unsupported (SQLITE_READONLY from `sqlite3_backup_step`), which only the deferred desktop-import case (risk 13) would hit.
5. `gpui::block_on` in `AppDatabase::new` (`db.rs:65`) cannot run on the wasm main thread; `open_with_image` (async) is the browser constructor, but it works there only on top of b6's `sqlez` gates (`locking_queue` default, one connection; b6:219-229). `open_with_image`/`new_with_image` return `(Self, RestoreOutcome)`, and `ClientStateStore::new` takes the outcome — b7:676 must destructure the tuple and pass it.
6. Blob size. `MessageLen` is `u32` (`protocol.rs:9`), but BUILD-SPEC 4.4 fixes a 16 MiB WebSocket frame ceiling; the client caps the uncompressed image at 12 MiB and the server caps the wire bytes at 12 MiB, and images are gzip-compressed (SQLite images are mostly zero pages; a 4 MB image typically shrinks under 500 KB), which also bounds the per-tab egress of the 15 s ticker while editing keeps the database dirty (`editor/src/persistence.rs:272, 322, 374`). Chunked `SaveClientState` is a follow-up if measurements show the cap is reached.
7. Version conflicts after replay or takeover. A stale save is `SaveClientStateResponse { accepted: false, version }`, not an error; the client adopts the returned version and retries above it, so a request replayed after a lost response (`remote_client.rs:1910-1925`) converges. A superseded tab is closed with 4001 → `Disconnected { server_not_running: true }`; an exhausted reconnect budget (D2: 20 attempts, 8 s cap, or `RefreshError::Unauthorized`/`Stopped`) → `Disconnected { server_not_running: false }`; both stop the ticker (`stop()` on any `Disconnected`, `remote_client.rs:934-942`), and the host's from-scratch `reconnect()` (D2) re-arms it either by reloading the page (the boot sequence of 3.8) or through `rebind`. The server keeps `db.sqlite.prev` so a bad overwrite is recoverable by hand.
8. Supervisor contract (b8) — **decided by D18**: no `ZS_CONTROL_SECRET` in the server environment (`--control-secret-file`), control calls target `127.0.0.1:8446`, `POST /extensions` relayed to the control plane, stopping request budget above the 5 s flush (b8:504's `STOPPING_POST_TIMEOUT = 2.5 s` and b8:1207's `http://127.0.0.1:8443` target are superseded). Still on b8's side after D18: `POST /control/extensions` at startup from the manifest's `extensions` (D5; replaces `remote_extensions/pending.json`, b8:759-760, 1441 — the server never reads it) and `devcontainer.json` `customizations.zed.extensions`; `forwards.insert` idempotent per port because `ForwardPort` can be replayed; a loopback API port that is not 8446 exported as `ZS_SUPERVISOR_URL` (risk 20); and the prebuild rule of 3.15 item 7 (D14: `zs-agent prebuild`'s headless client must not send `SaveClientState`). b8's risk 17 (dirty buffers on stop) is answered by D6 on the client side — no `data_dir/serve/dirty/` snapshot on the server.
9. Proxy leakage. The server's `ReqwestClient` may carry the user's proxy (`server.rs:683-699`); supervisor calls must use a proxy-less client or loopback traffic could be routed through the proxy. `SandboxConfig.supervisor_http` is therefore a separate client.
10. `ExtensionEvents` global on the server: resolved. `extension::init` (`extension.rs:27-30`) sets it via `extension_events::init` (`extension_events.rs:7-9`) before `HeadlessProject::new` (`server.rs:674`).
11. Registry base URL. The headless installer targets `https://zed.dev` (mapped to `api.zed.dev` by `build_zed_api_url`, `http_client.rs:277-284`) with the same `ZED_SERVER_URL` override as `client.rs:63`. Whether the sandbox's network policy (BUILD-SPEC 7.11) allows `api.zed.dev` by default is a control-plane decision.
12. Asset-only extensions. Relaxing the `debug_assert!` at `headless_host.rs:262` lets theme/grammar extensions install on the server; `HeadlessExtensionStore::asset_path` provides the guarded lookup, and the `GET /extensions/{id}/assets/*` route is assigned to b2's router (3.15 item 4). Until b2 adds it, installing a theme succeeds without visible effect in the browser.
13. Desktop reuse of client state — **decided by D7**: the image is one whole-database image of the `AppDatabase` (with `GlobalKeyValueStore` folded in, 3.6a) and is not importable into desktop Zed's shared database (`crates/zed/src/main.rs:342` is one database for every workspace); BUILD-SPEC 5.4 is amended so that workspace layout follows the workspace across resumes, not to desktop. A per-`WorkspaceId` export/import remains a possible follow-up; nothing here depends on it.
14. Later UI needs. The ports panel needs `Project::port_store()`, `PortStoreEvent::Changed`, `PortStore::{listening_ports, forwards, forward_port, unforward_port}`, plus an `open_url` for forward URLs; persistence of forwards per workspace is the control plane's (`forwards` table, BUILD-SPEC 7.2) via the supervisor, not the client. The extensions UI on wasm needs `Project::remote_extension_store()` and a gate in `extensions_ui` replacing `ExtensionStore::global` (`extensions_ui.rs:106, 171, 408, 485, 580`) with `RemoteExtensionStore`, since `extension_host` (wasmtime) is excluded from the browser build (BUILD-SPEC 3.1). Lifecycle toasts are JS (b9:622); a desktop toast, if wanted, is a `crates/zed` follow-up.
15. Test fakes. `FakeHttpClient::create` (`crates/http_client/src/http_client.rs:431`) returns `Arc<HttpClientWithUrl>`, which satisfies `RegistryConfig.http` directly and `Arc<dyn HttpClient>` through `impl HttpClient for HttpClientWithUrl` (`:335`). No unverified test-support API remains in section 6.
16. Keymap sync (BUILD-SPEC 5.7 "the keymap travels alongside" `UpdateUserSettings`). Cut from this brief: `UpdateUserSettings` keeps only `contents` (`worktree.proto:197-200`), BUILD-SPEC 3.7 routes settings through the in-memory Fs on the client, and no server-side consumer of keybindings exists. If one appears, add `optional string keymap = 3` handled by `SettingsObserver`.
17. Migration skew policy. Older image + newer build: the scratch dry-run applies the missing steps, then the copy (`Restored`). Newer image + older build: extra completed steps are ignored by `migrate`, so it opens (`Restored`) unless a step's text differs, in which case the outcome is `Skipped` and the client runs read-only until the entry crate calls `allow_overwrite()` (the server copy is never overwritten by an empty database on its own). `client_build` in `meta.json`/`SaveClientState` makes both cases diagnosable from logs; `should_allow_migration_change` (`domain.rs:7`) remains the escape hatch for known-benign text changes.
18. Rebuild — **decided by D9/D19**: the tarball includes `/workspaces` and `$HOME/.local/share/zed` (client state under `server_state/client_state`, `remote_extensions`, language-server downloads), extracted at `/`; `POST /control/extensions` from the manifest's `extensions` list (D5) additionally re-installs anything missing, and the supervisor's `POST /extensions` relay keeps `workspaces.installed_extensions` current (D18/D19). Closed.
19. Input validation is the server's only guard against a compromised tab (XSS is threat 3 in BUILD-SPEC 10): extension ids (`is_valid_extension_id`), manifest id/version checks, download cap, port range. The control channel's guard is the file-sourced secret plus the loopback-only listener; everything in the sandbox runs as uid 1000, so a Unix socket would add nothing over that.
20. Port map (not resolved by D1-D20). D5 puts the server's control listener on `127.0.0.1:8446`; b8's supervisor loopback API (`/ports`, `/git-token`, `/lifecycle`) is also `127.0.0.1:8446` (b8:146, 663, 1252), and two processes cannot bind it; D8's proxy slots 8444-8447 overlap BUILD-SPEC 6.2's 8445 health listener and 8446 (Linux refuses a loopback bind beside a wildcard bind on the same port, b8:663). This brief follows D5 for `--control-listen` and keeps `DEFAULT_SUPERVISOR_URL` at `http://127.0.0.1:8445` with `--supervisor-url`/`ZS_SUPERVISOR_URL` overriding it; b8 must move its loopback API to a port outside `{8443, 8444-8447}` and export it as `ZS_SUPERVISOR_URL`. Needs a tech-lead port map; listed as unresolved in section 9.
21. `onLifecycle` string form (not resolved by D1-D20). b7:594/955 forwards `LifecycleKind::as_str()` (`"idle_stop_in"`, ...), b9:787/1211 types the callback as `"IDLE_STOP_IN" | ...`. This brief defines `as_str()` as the snake_case tags (the supervisor JSON of 4.2 uses the same spelling, and b7 is the producer); b9's TypeScript type should adopt them.
22. D6 beside `editors.contents`. Two mechanisms now persist dirty text: the throttled per-item `editors.contents` (existing, gated by `session.restore_unsaved_buffers`, `items.rs:1462-1534`) and the synchronous `unsaved_buffers` snapshot at `STOPPING` (3.8). The restore order of 3.8 (items first, then `restore_unsaved_buffers`) makes them agree; if the snapshot restore ever ran before item deserialization, an editor could overwrite a newer snapshot with older `editors.contents`, so that order is normative for b7. Rows live for at most one boot: paths that no longer resolve to an open worktree are dropped with a warning rather than kept forever, and the snapshot is taken only on `STOPPING` (D6), not on every flush — a tab killed without a `STOPPING` notice (takeover, crash) still relies on `editors.contents`.
23. Global KVP fold (3.6a) on native is opt-in (`from_app_db`); desktop keeps its separate `0-global/db.sqlite`. If desktop Zed ever wants one database too, the same namespace works, but migrating existing global rows is out of scope.

## 8. Review log

Reviewer findings and disposition (R1 = first reviewer, "major"; R2 = second reviewer, "blocking"). Each was checked against the fork before acting.

R1 wrong claims

1. `HeadlessAppState` gains a field; only `server.rs:709-717` changes. **Accepted.** `grep "HeadlessAppState {"` finds 25 literals plus the destructure at `headless_project.rs:93-101`. Fix: the struct is untouched; `HeadlessProject::enable_sandbox` (3.14) carries the sandbox wiring, following `handle_crash_files_requests`.
2. `restore_main_from` ignores WAL header bytes. **Accepted.** `DB_INITIALIZE_QUERY` sets `journal_mode=WAL` (`db.rs:129-134`), `sqlite3_serialize` copies page 1 as-is, and `sqlite3.h:10776-10778` documents the `SQLITE_CANTOPEN` failure. 3.4 patches bytes 18-19 to 1 on the copied buffer; `restore_from_wal_image` tests it.
3. `init_paths` element type. **Accepted** (array of `&'static PathBuf`, `paths.rs:144`). Resolved by not touching `init_paths`: `ClientStateStore` creates its own directory.
4. `open_with_image`/`open_fallback_db` presented as the browser path. **Accepted with attribution.** `initialize_queues` defaults to a `std::thread` queue (`thread_safe_connection.rs:130-141, 282-297`); b6 (now present) swaps it for `locking_queue` on wasm and routes `open_db_with_image` to `open_fallback_db` (b6:219-229). 3.6 and risk 5 now say the browser path exists only on top of b6.
5. `post_json` cannot carry `Authorization`. **Accepted** (`http_client.rs:154-167`). 3.11 uses `Request::builder` + `send`.
6. `Deref` is not what makes the fake pass as `Arc<dyn HttpClient>`. **Accepted**; risk 15 cites `impl HttpClient for HttpClientWithUrl` (`:335`).
7. `handle` described as sync; `watch::Receiver::changed` needs `&mut`; `Sender::send` errors without receivers. **Accepted** (`watch.rs:62-70, 94, 153-165`). 3.10 clones the receiver per request and snapshots with `borrow()` before sending; 3.9 keeps a receiver alive in the store.
8. `test_unknown_message_does_not_break_session` used a non-existent `Project::init`-only path. **Accepted** (`project.rs:1665-1690` registers handlers only in `Project::remote`). Replaced by `test_old_server_rejects_save_client_state`, which drives a bare fake server with no `HeadlessProject`.
9. 500-515 vs 500-513. **Accepted.** With `SaveClientStateResponse` the range is 500-514 everywhere.
10. Missing `failed_removals` / `_stale_uploads_sweep` fields. **Accepted** (`headless_host.rs:46, 48, 71-79`); the sweep is why registry staging moved to `extension_dir/staging`.
11. `RemoteClientEvent::Disconnected { server_not_running }`. **Accepted** (`remote_client.rs:340-343`).
12. `project.rs:1680` is `handle_find_search_candidates_cancel`. **Accepted** (init calls are 1681-1690).
13. `proto.rs:1089` for `mod tests`. **Accepted.**
14. `sandbox/image` and `sandbox/supervisor` exist (empty). **Accepted**; risk 8 rewritten around b8, which now exists.
15. `extension::init` sets the global. **Accepted**; risk 10 closed.

R1 missing items: compile break (→ `enable_sandbox`); WAL restore (→ 3.4); `init_paths` type (→ untouched); wasm queue (→ b6 attribution); async meta load (→ `loaded` gate, test `load_immediately_after_new_sees_stored_version`); `TempDir` drop and uploads sweep (→ guard held across the install task, staging under `extension_dir/staging`); `barrier::Receiver` await (→ `futures::StreamExt::next`, no `postage` dep); Stopping with a clean client (→ `flush_now` always sends; 204 immediately when no session); `Project` constructors (→ `local`, `remote`, `from_join_project_response` at `:1385, :1634, :1910`); prost variant names (→ section 2 and 4.1); serde `rc` (→ section 5); `statement.rs:75` as the enforcing mechanism (→ section 2). All accepted.

R2 wrong claims

1. `HeadlessAppState` sites. **Accepted**, as above.
2. Lost response + replay makes stale rejection permanent. **Accepted** (`remote_client.rs:1746-1748, 1780, 1910-1925, 2036-2044`). `SaveClientStateResponse { accepted, version }`, client adopts `max`, `resync` on `Reconnected`; tests `client_state_store_converges_after_stale`, `test_save_survives_lost_response`.
3. Restore failure overwrites good state; changed migration panics in `open_fallback_db`. **Accepted, with a different mechanism.** Instead of retry-without-image, 3.5 validates the image on the scratch connection (including a migration dry-run) before the application database is touched, so neither `open_main_db` nor `open_fallback_db` (`db.rs:215-225`) can fail because of an image; `RestoreOutcome::Skipped` puts the client store in `read_only` until `allow_overwrite()`; the server keeps `db.sqlite.prev`. Tests added.
4. Lifecycle toasts in `workspace` duplicate b9's JS toasts and inject product UI upstream. **Accepted** (BUILD-SPEC 7.6; b9:622; `gpui/src/global.rs:22`). 3.17 and `LifecycleHooks` deleted; only `project::Event::LifecycleNotice` remains.
5. Cross-brief obligations addressed to the wrong briefs. **Accepted.** Header and 3.15 rewritten against the real b1/b2/b3 (b2 owns `serve`, router, `/files`, `GpuiCommand`, `is_input_envelope`; b3 is terminals with tags 488-499).
6. `sync_extensions` wipes registry-installed extensions on a desktop connect. **Accepted** (`headless_host.rs:112-135`; b1:171). Sandbox-mode sync is additive and version-tolerant; test `test_desktop_sync_keeps_registry_extensions`.
7. Control channel on the public listener; secret in the server environment; bespoke `ct_eq`. **Accepted** (b8:433). Loopback-only `--control-listen` (`127.0.0.1:8446`, later fixed by D5), `--control-secret-file` read before any spawn (later fixed by D5/D18: no `ZS_CONTROL_SECRET` anywhere), `subtle` from b2. A Unix socket was not adopted because everything in the sandbox runs as the same uid (risk 19).
8. `HeadlessExtensionIndex` duplicates `ExtensionIndex` and creates a two-phase write. **Accepted** (`extension_host.rs:216-222, 378, 1750`; `headless_host.rs:486-509`). Startup scans `extension.toml`; `dev` is in-memory only.
9. Async meta load race. **Accepted** (same as R1); `Shared<Task<()>>` gate rather than a synchronous read, because `FakeFs` has no synchronous read.
10. Backup indirection on wasm; page size; `serialize` on a schema-less DB. **Partially accepted.** The scratch+backup path is kept on both targets because the scratch is now the validation stage (dry-run migrate) — the second copy costs at most ~12 MiB transiently. Page-size constraint documented (restore runs before WAL on an empty destination; existing-WAL restore unsupported, only the deferred desktop import would hit it). `serialize_main` returns `Ok(vec![])` for a page-less database (`sqlite3.c:53615-53690`: null pointer, size 0), with an explicit test.
11. `record_forward` duplicates b8's re-post; 2 s Stopping wait; version snapshot ordering. **Accepted** (b8:561-562; `watch.rs:153-165`). `record_forward`/`remove_forward` removed; 204 immediately without a session; `STOPPING_FLUSH_TIMEOUT` raised to 5 s with b8's budget flagged (risk 8; D18 later confirmed 5 s and put the supervisor's budget above it); `borrow()` before the notice. A `ClientStateFlushed` message was not added because `flush_now` always sends, which achieves the same wake-up without a new tag.
12. `pagehide` flush is asynchronous; uncompressed 15 s uploads. **Accepted.** `visibilitychange` → hidden documented for b7/b9 (D7 later made the three triggers — 15 s dirty timer, `visibilitychange` to hidden, `STOPPING` — exhaustive), `set_interval` for the hidden state, `bool gzip` on the wire with `async-compression` in `workspace` (pure-Rust backend), cap semantics split between uncompressed (client) and wire bytes (server). A `Compression` enum was not added (a bool suffices and avoids package-scope enum-value naming).
13. `workspace` reaches `proto` via `client`, not `remote`. **Accepted** (`client.rs:59`; `dock.rs:7`); 3.8 imports `client::{proto, AnyProtoClient}`.

R2 missing items: id/port validation (→ 3.11, 3.13, tests); idle-clock exclusions (→ 3.15 item 6); attach replay (→ `replay_after_attach`, `on_session_attached`, `GpuiCommand::SessionAttached`, test); installed-extension reporting (→ `POST $SUPERVISOR_URL/extensions`, `POST /control/extensions`); rebuild loss (→ risk 18); directory choice (→ `remote_server_state_dir()/client_state`); newer-image skew (→ 3.5, risk 17, `client_build`, test); proto file/env naming (→ `remote_session.proto`, CLI flags, `zs-` id gone; the split across `app.proto`/`worktree.proto` was rejected to keep the `zed.proto` diff at two lines); client-store reconnect/takeover handling (→ `fail_pending`, `refresh` on `Reconnected`, `stop`/`resync`); registry install bounds (→ cap, manifest checks, test); asset route owner (→ `asset_path` + b2 route); keymap (→ risk 16, explicitly cut); BUILD-SPEC 5.4 desktop move (→ risk 13, spec amendment proposed; since decided by D7); test gaps 1-6 (→ section 6; the wasm round trip is delegated to b6's `wasm-bindgen-test`). All accepted except the proto split.

The tech-lead decisions D1-D20 and the deltas the sibling briefs addressed to this one are reconciled in section 9.

## 9. Reconciliation log

Applied on 2026-09-02 against `DECISIONS.md` and the sibling briefs as they stood at that time (sibling line numbers as cited). Every claim added in this pass was checked against the fork: `remote_client.rs:934-942` (`Disconnected` for both terminal states), `kvp.rs:1-279` (`KeyValueStore`/`scoped_kv_store`/`GlobalKeyValueStore`), `db.rs:247-285` (`static_connection!`), `editor/src/items.rs:1273-1544, 2325-2340` and `editor/src/persistence.rs:20-26, 132-140, 229` (existing dirty-buffer persistence), `buffer.rs:1492-1502, 2494, 2516-2530, 2661, 2785`, `text.rs:1305`, `fs.rs:366-378`, `buffer_store.rs:1067, 1098`, `project.rs:2489, 3021, 3151, 3263, 4883, 5208, 5233, 6370`, `workspace.rs:174, 726, 2748, 4852-4875, 7227, 7368-7400, 7543-7577`, `project_settings.rs:92`, `crates/workspace/Cargo.toml` (dependency lines). Consumers of `GlobalKeyValueStore` were enumerated by grep (`zed/src/main.rs:1383`, `prompt_store/src/rules_to_skills_migration.rs`). No file outside this brief was modified and nothing was built.

Decisions:

- **D1** (identity is `workspace_id`; `session_id` informational). Applied: header (b1 line); 3.9 states the server store is per workspace by construction and never keyed by `session_id`. No signature change — this brief never used `session_id`.
- **D2** (20 attempts, 8 s cap, `ReconnectExhausted`, host `reconnect()`, `RefreshError::{Stopped, Unauthorized}`). Applied: `ClientStateStore::stop` is now specified for *every* `RemoteClientEvent::Disconnected` (an exhausted budget emits `Disconnected { server_not_running: false }`, `remote_client.rs:934-942`), `flush_now` returns `Err` while stopped, and the new `ClientStateStore::rebind(sink, cx)` supports an in-place from-scratch reconnect (3.7); `RemoteExtensionStore::fail_pending` likewise on every `Disconnected` (3.16); risk 7 rewritten; tests `client_state_store_stop_and_resync` (extended), `client_state_store_rebind`, `pending_fails_on_reconnect_exhausted`.
- **D3** (fresh session resets `HeadlessProject`; PTYs in a server-level `PtyManager`; 4001/4005/1001; `Heartbeat` every 5 s; 16 MiB both sides). Applied: 3.14 records that `reset_for_new_client` (b2:665-675) leaves `sandbox`, `extensions`, `session` and the handler table intact, so `enable_sandbox` runs once per process and `SandboxRuntime` survives fresh sessions the way `PtyManager` does; `on_session_attached` is now called after every attach and documented idempotent; 3.15 item 6 notes `Heartbeat` is a control frame outside `is_input_envelope`; test `test_sandbox_runtime_survives_fresh_session`. The 16 MiB ceiling was already the bound behind `MAX_IMAGE_BYTES` (3.7, 3.9, risk 6).
- **D4** (terminal restore in b3 through workspace persistence). Applied: header, 3.7 and 4.3 note that b3's rows travel inside the image; no API change here.
- **D5** (loopback control listener `127.0.0.1:8446`, `--control-secret-file`, `POST /control/{lifecycle,ports,extensions}`, `/control` never public, `--allowed-origin`). Applied: 3.10 (listener, `ControlRoutes` adapter shape, response mapping), 3.15 items 1, 3, 4 (CORS on the asset route), 4.2 (routes and configuration contract). The earlier "accept `ZS_CONTROL_SECRET` for compatibility and scrub it" fallback is deleted (also D18).
- **D6** (dirty buffers into the image on `STOPPING`, new table `unsaved_buffers`, reopened dirty next open, no filesystem writes without the user saving). Applied: 3.8 gains `UnsavedBuffersDb` (domain + `static_connection!(UnsavedBuffersDb, [WorkspaceDb])`), `UnsavedBufferRow`, `UNSAVED_SNAPSHOT_LIMIT_BYTES`, `snapshot_unsaved_buffers`, `restore_unsaved_buffers`, with D6's "version" mapped to `Buffer::saved_mtime` (`mtime_seconds`/`mtime_nanos`) and the restore reusing the `did_reload` + `set_text` + `forget_transaction` sequence of `items.rs:2325-2340`; section 1, section 2 (new "Unsaved buffers" evidence), 4.3, section 5 (no new deps), section 6 (six `workspace` unit tests and `test_stopping_snapshots_unsaved_buffers`), risk 22; the boot/stop sequence for b7 no longer contains `Workspace::save_all`.
- **D7** (one whole-database image with `GlobalKeyValueStore` folded in; `serialize()`/`restore_from()` on `background_spawn`; triggers = 15 s dirty timer, `visibilitychange` hidden, `STOPPING`; not importable to desktop; BUILD-SPEC 5.4 amended). Applied: new 3.6a (`GLOBAL_KVP_NAMESPACE`, `GlobalKeyValueStore::{from_app_db, init}` over the existing `scoped_kv_store` — no migration change), 3.5 naming note (`restore_from()` is `restore_main_from` inside `build_with_outcome`; `Send` futures), 3.7 ticker and `flush_now` serialize under `cx.background_spawn` and the exhaustive trigger list, 3.8 boot sequence (`open_with_image` awaited under `background_spawn`, `GlobalKeyValueStore::init(&db)`), `pagehide` removed from the contract everywhere it was described as a trigger, 4.3, risk 13 closed, risk 23, test `global_kvp_rows_travel_in_image`.
- **D8** (four proxy slots 8444-8447; `zs_port_session` HMAC cookie; forward `url` is the control plane `/open` link redirecting to `/__zs/auth`). Applied: 3.11 (`url` semantics, slot-exhaustion error path, `ForwardResponseBody.url: Option<String>` with `null → ""`), 3.16 (`PortForward.url` opened as a top-level navigation, never interpreted), 4.1 comments on `PortForward.url`/`ForwardPortResponse`, 4.2 supervisor JSON, tests `forward_maps_null_url_to_empty`, `forward_refusal_surfaces_supervisor_error`. The port overlap with D5/BUILD-SPEC 6.2 is risk 20 (unresolved).
- **D9** (rebuild tarball = `/workspaces` + `$HOME/.local/share/zed`, extracted at `/`). Applied: 3.9, 4.3, header (b9 line), risk 18 closed.
- **D10** (vendored deps, no `<org>` placeholder). Not applicable: this brief references no vendored crate and contains no `<org>` placeholder (grep verified).
- **D11** (wasm home `/home/web`). Not applicable: nothing here reads client-side paths (the browser `AppDatabase` is in-memory through b6's `open_fallback_db` arm).
- **D12** (web keymap layer). Not applicable.
- **D13** (activity ping `lastInputAt`, `busy`, `phase`, `cpuBusyPct`). Applied: 3.15 item 6 ties the `is_input_envelope` exclusions to `lastInputAt`; nothing else here feeds the ping.
- **D14** (`zs-agent prebuild` owned by b8). Applied: 3.15 item 7 and risk 8 — the prebuild's headless client must not run a `ClientStateStore`; `POST /control/extensions` during prebuild is welcome.
- **D15** (AI proxy, b11). Not applicable.
- **D16** (`open_remote_project_in_new_window_with_client`). Applied: 3.8's boot sequence cites it and places `restore_unsaved_buffers` after it.
- **D17** (terminal ownership b3/b6). Not applicable.
- **D18** (supervisor contract: `--control-secret-file`, control calls to `127.0.0.1:8446`, `POST /extensions` relay, budget above the 5 s flush, `cpuBusyPct`, ...). Applied: 3.10 stop-sequence paragraph, 3.15 item 1, 4.2, risk 8 rewritten as "decided", review-log items 7 and 11 annotated.
- **D19** (control plane: consume the installed-extensions relay, manifest fixture `docs/contracts/fixtures/manifest.example.json`, tarball per D9). Applied: 4.2, header (b9 line), risk 18.
- **D20** (serve: exclude b3's four terminal messages from `is_input_envelope`; `detach_all` on detach; adopt this brief's six contract items and b1's 7.12). Applied: 3.15 item 6 lists the seven exclusions, item 5 marks the `GpuiCommand` variants adopted, risk 2 marks the six items decided; `detach_all` is b2/b3's and needs nothing here.

Sibling deltas addressed to this brief:

- **b2** (b2:80, 380, 545, 620, 955): b2 expected `current_ports_message()` after every attach, mounted `/control/*` on the public router behind `ControlRoutes`, and cited `ZS_CONTROL_SECRET`. Changed: `on_session_attached` is specified for every attach and idempotent (3.14); the `/control/*` branch moves to the loopback listener with a `ControlRoutes` adapter whose shape is written out (3.10, 3.15 item 3); the env variable is gone (D18); b2's `reconnect` reuse is recorded as what keeps the handler table across fresh sessions (3.14).
- **b3** (b3:68, 100): "b4 takes 500-513" is stale on b3's side; this brief's 500-514 stands (risk 1, R1 item 9). No change here beyond the note in the header.
- **b6** (b6:5, 212, 223, 264, 271, 286, 295-312, 983(a)-(c), 985): `restore_from` naming reconciled (3.5); the `wasm_lock` guard line and the scratch-connection allowance recorded (3.4); `serialize()` from `background_spawn` adopted (3.7, D7); `open_with_image`/`new_with_image` gating unchanged; b6's separate wasm `GlobalKeyValueStore::init()` is replaced by `init(db: &AppDatabase)` over the folded store (3.6a) — a delta back to b6.
- **b7** (b7:8, 179, 565, 594, 755-756, 834, 955, 1343, 1351, 1375, 1467, 1472): the consumed API is unchanged except: `Workspace::save_all` on `Stopping` is replaced by `snapshot_unsaved_buffers` + `flush_now` (D6); `restore_unsaved_buffers(&workspace, window, cx)` runs after the workspace opens (D6/D16); `GlobalKeyValueStore::init(&db)` after `set_global` (D7); `open_with_image` is awaited under `background_spawn` (D7); `stop` on every `Disconnected` and optional `rebind` (D2); `LifecycleKind::as_str()` now exists with the snake_case spelling b7 already assumed; `pagehide` is not a contract trigger (D7).
- **b8** (b8:37-43, 62, 146, 504, 516, 535-536, 663, 677, 759-760, 1207, 1252-1253, 1427, 1441, 1443, 1508): `data_dir()` corrected to `/vercel/.local/share/zed`; `ZS_SUPERVISOR_URL` is honoured as the env default of `--supervisor-url`; `{"url": string|null}` accepted; `pending.json`/`index.json` are not read by the server (D5 `POST /control/extensions`; no index file, R2 item 8); the `STOPPING` budget and the control target are per D18; `ZS_CONTROL_SECRET` is gone; the 8446 collision is risk 20; b8's risk 17 (dirty buffers) is answered by D6 on the client, so no server-side `serve/dirty/` snapshot.
- **b9** (b9:60, 787, 1211, 1250, 1317, 1624, 1694): consistent with this brief except the `onLifecycle` string spelling (risk 21) and the request to autosave dirty buffers inside `Stopping`, which D6 replaces with the in-image snapshot.

Unresolved after this pass (also listed in the return to the orchestrator):

1. Port map (risk 20): D5's `127.0.0.1:8446` control listener vs b8's supervisor loopback API on the same port, and D8's 8444-8447 slot range vs the 8445 health listener and 8446. This brief keeps D5 and a `--supervisor-url`/`ZS_SUPERVISOR_URL` override; b8 needs a new loopback port.
2. `onLifecycle` string spelling (risk 21): b7 snake_case (this brief's `as_str()`) vs b9 SCREAMING_SNAKE.
3. Whether the host `reconnect()` of D2 reloads the page or re-dials in place is b7's call; both are supported here (`rebind` for the latter).

### Contract pass (2026-09-02)

Cross-brief mismatches found by the CONTRACTS.md audit and fixed here (b2 owns the control-listener adapter under D20, so this brief adopts b2 §3.8's text):

- 3.10: the `400` body is `{"error":"bad_request","message":"<msg>"}` (b2 §3.8, §4), not `{"error":"bad_request"}` with the detail only logged.
- 3.10: the `ControlRoutes` seam is cited in its current shape, `ControlRoutes::handle<'a>(&'a self, ControlRequest<'a>) -> BoxFuture<'a, ControlResponse>` (mirrors `ControlChannel::handle`; b2 §3.8), replacing the stale `handle(req, peer_is_loopback) -> BoxFuture<Response>` citation.
- 3.10: the control body cap is b2's `MAX_CONTROL_BODY_BYTES = 1 MiB` (413 above); the 64 KiB figure is withdrawn (closes CONTRACTS M14).
