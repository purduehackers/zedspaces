# b7-edge-gates-entry: Edge gates and the `zed_web` entry crate

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` sections 3.1 (line 78), 3.2 (86, the "Dependency-edge gates" paragraph and per-crate table), 3.4 (155), 3.5 (166), 3.6 (174), 3.7 (187), 7.6 (373), 11.2 (453), 12 (467). Fork under modification: `/Users/ray/Projects/play/wed/zed` (branch `zs`, upstream `c3cf80c`); all paths below are relative to that checkout unless stated. Reference fork (read-only, RPC design deliberately not copied): `/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad/zed-web`, cited as `zed-web/...`.

Binding decisions: `/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md` (D1-D20). Every decision that touches this brief is applied below and itemized in section 9; the decision ids are cited inline where they change a signature, message, flag, route, env var, file path or constant.

Briefs this one depends on (all present in `docs/briefs/`; the exact items consumed are listed so a change on their side is visible here):

- **b1** `b1-ws-transport.md` (its §3 is amended to the decisions; its §4.1, §4.6 and §7 still carry pre-decision text, so this brief cites the §3 lines): `remote::WebSocketConnectionOptions::new(url, workspace_id, session_id, token).with_takeover(bool).with_refresh(Arc<dyn WebSocketSessionRefresh>)` with identity (`Hash`/`Eq`, persistence, pool key) = `workspace_id` and `session_id` per-connect and informational (D1; b1 §3.3 lines 164-176, §3.10 line 322, §3.11 lines 349-350), the trait `WebSocketSessionRefresh::refresh(&self, workspace_id: &str, reason: RefreshReason, cx: &mut AsyncApp) -> Task<Result<WebSocketSession, RefreshError>>` returning `WebSocketSession { url, token, session_id }` with `RefreshError::{Unauthorized, Stopped, Other}` — `Unauthorized` and `Stopped` are terminal and short-circuit the retry budget (D2; b1:165-168, :244-245), `remote::WebSocketClientDelegate::new(on_status)` (b1:232-236), `remote::connect(options.into(), delegate, cx)` (the pool arm, b1 §3.5 line 311), `workspace::open_remote_project_in_new_window_with_client(remote: Entity<RemoteClient>, app_state, paths, window_options, cx) -> Task<Result<OpenedRemoteProject { window, workspace, items }>>` (D16; b1 §3.12 lines 367-408), `WebSocketConnectionOptions::last_close()` and the close-code → outcome table (b1 §3.3 step 5, lines 276-283; D3: 4001 taken over, 4005 session active, 4002/4006 incompatible, 1001 server going away — 4004 is retired, and 4003 is a refresh-and-redial code that only becomes terminal through `RefreshError::Unauthorized`), the `remote::websocket_wire` constants (b1 §3.2 lines 128-149), token placement in `Sec-WebSocket-Protocol` on both targets (b1 §4.3), `max_reconnect_attempts()` = 20 with the backoff capped at 8 s, then `ReconnectExhausted` (D2; b1:224, §3.5 line 313), the client → server `Heartbeat` text frame every 5 s (D3; b1 §3.3 step 4).
- **b2** `b2-serve-mode.md`: the server side of the same close-code table (b2 §4 lines 895-899; b2 §7 item 19 records how D3's list maps onto it), `Hello.identifier` is logs-only (b2:392, b2:908), CORS for `/files` from the shell origin through `--allowed-origin` fed by `manifest.allowedOrigins` (D5; b2:540-546, :670), the server → client heartbeat kept beside the client's (b2 §7 item 18) and `is_input_envelope` never counting a client `Heartbeat` as input (b2:913, D13).
- **b3** `b3-terminals.md`: terminal restore (D4) runs inside b3's terminal-panel deserialization, i.e. inside the open task of 3.27 step 3f, and needs only what this brief already guarantees — the client-state image is restored before the workspace deserializes (3.27 step 3d) and PTYs outlive a fresh session in the server-level `PtyManager` (D3, D17). Nothing else is consumed.
- **b4** `b4-proto-additions.md`: `db::AppDatabase::open_with_image(image) -> (Self, RestoreOutcome)` awaited under `cx.background_spawn` (D7; b4 §3.6, §3.8 line 417), `db::kvp::GlobalKeyValueStore::init(&db)` right after `cx.set_global` (D7; b4 §3.6a lines 264-288), `db::client_state::ClientStateStore::new(&db, sink, loaded_version, outcome, cx)`, `flush_now`, `set_interval`, `stop` (on every `Disconnected`), `resync`, `allow_overwrite`, `is_read_only`, `ClientStateEvent::{Saved, SaveFailed, Stale, ReadOnly}`, `SAVE_INTERVAL` (b4 §3.7, lines 289-350; the flush triggers are exactly the 15 s dirty ticker, `visibilitychange` → hidden and `STOPPING`, D7), `workspace::client_state::{RemoteClientStateSink::new(client, client_build) -> Arc<Self>, load_client_state(&AnyProtoClient) -> Result<(Option<Vec<u8>>, u64)>, snapshot_unsaved_buffers(&Entity<Workspace>, &mut App) -> Task<Result<usize>>, restore_unsaved_buffers(&Entity<Workspace>, &mut Window, &mut App) -> Task<Result<usize>>}` (D6; b4 §3.8 lines 351-418, restore order normative per b4 §7 item 22), `project::Event::LifecycleNotice { kind: project::lifecycle::LifecycleKind, seconds }` and `LifecycleKind::as_str()` = `"idle_stop_in" | "session_cap_in" | "stopping" | "resumed"` (b4 §3.16 lines 673-690; b4 deleted its earlier `LifecycleHooks` global).
- **b5** `b5-wasm-build-env.md`: the `[target.wasm32-unknown-unknown] rustflags` block and `[env]` C toolchain in `.cargo/config.toml` (b5 §3 item 2, lines 118-149; this brief's one extra line is recorded there as b7-owned), `script/wasm-cc` (item 1), `script/check-wasm` with `ZS_WASM_MODE=build` and its `default_packages` layer list, which is where CI's crate list lives (item 3, lines 151-215; item 16, line 461), the smol shim's `smol::runtime::{Runtime, Runnable, install_runtime, runtime_installed}` and the `GpuiSmolRuntime` adapter that lives in `zed_web` (b5 §4 `crates/zs_smol_shim/src/runtime.rs`, lines 532-573; b5 §7 item 6), the `vendor/<name>` layout for path patches (D10; b5 §3 items 4 and 19, §9 contract list), the `time` `wasm-bindgen` feature request (b5 item 15) and the invariant that `zed_web` enables no `test-support` feature reaching `grammars` (b5 item 12).
- **b6** `b6-leaf-gates.md`: `fs::WasmFs::new(BackgroundExecutor) -> Arc<WasmFs>`, `WasmFs::insert_file(&self, &Path, Vec<u8>)`, `WasmFs::insert_dir(&self, &Path)` and `WasmFs::take_dirty(&self) -> Vec<DirtyFile { path, contents: Option<Vec<u8>> }>` (b6 §3.2, lines 141-201), the full `Fs` table including `canonicalize` (b6 §4.1), `fs::JobInfo.start` becoming `web_time::Instant` on wasm (b6 §3.2 line 156, §7 item 5 — the `activity_indicator` swap is owned here, 3.10), `db::registered_migration_count()` (b6 §3.4, §4.7 — the boot assertion of 3.27 step 2), the `client` crate gates (b6 §3.8, lines 521-559: `async-tungstenite` feature-less in `[dependencies]`, TLS blocks at `client/Cargo.toml:81-86` re-gated with `not(target_family = "wasm")`, wasm twins of `establish_websocket_connection`/`authenticate_with_browser`, `authenticate_as_admin` gated, `Client::sign_in_supported()` at b6:547/§4.6), `db`/`sqlez` wasm shape (b6 §3.3-3.4), the wasm `home_dir` = `/home/web` being this brief's (D11; b6:30), and b6 §7 item 8 (the "which documents does the control plane store" decision, taken here in 3.24; b6's `take_dirty` is wired by 3.24/3.27).
- **b9** `b9-control-plane.md`: the consumer of the loader contract (b9 §3.26 lines 743-793, §4.6 lines 1196-1221, §4.9 `ZS_CSP_UNSAFE_EVAL`); its requested host additions are accepted or declined item by item in 4.2 and section 9. b9's copies of the contract (b9:59, :786, :1198-1220) predate the three-argument `start(config_json, assets, host)` form and the `onLifecycle` callback; 4.2 is authoritative.

## 1. Goal

Make the browser dependency closure drop the native subtrees that BUILD-SPEC 3.2 names (LiveKit/WebRTC via `call`, the AWS SDK via `bedrock`, wasmtime via `extension_host`, tokio via `gpui_tokio`, rustls/aws-lc via `http_client_tls`, the updater via `auto_update`, docker via `dev_container`, plus the `audio` (cpal/rodio) edge discovered in review) using Cargo target-conditional dependencies plus `cfg(target_family = "wasm")` source gates at every use site, in upstream-shaped form so the same crates keep compiling and testing natively. Then add `crates/zed_web`, the browser analogue of `crates/zed` that wires registries, panels, keymaps, themes, assets and the workspace in the desktop order (minus excluded crates), seeds settings and keymap from JS-provided JSON into the in-memory `WasmFs`, opens the remote project over the b1 transport, and exposes a wasm-bindgen bridge for connect info, boot progress, session refresh, lifecycle notices and save-back. Deliverables also include a host-testable `zed_web_core` crate for the pure boot logic, the loader-page contract, a `web` keymap layer (`assets/keymaps/web.json`, loaded last and only on wasm, D12), the `PlatformStyle` runtime override in `ui` that D12 permits, the vendored `wasm_thread` patch that removes `js_sys::eval` (D10), and a `cargo xtask web-bundle` build pipeline. Unsaved buffers are never written to the workspace filesystem by the client: on `STOPPING` they go into the client-state image and come back dirty on the next open (D6).

## 2. Existing code that matters

### 2.1 Edge gates (verified use sites)

`title_bar` → `call`, `livekit_client`, `channel`, `auto_update`

- `crates/title_bar/Cargo.toml:19` `"call/test-support"` in the `test-support` feature (stays: Cargo accepts a `dep/feature` entry for a dependency that only exists in a target table and ignores it where the dependency is inactive; verified with a scratch workspace, section 8); `:34` `auto_update.workspace = true`; `:37` `call.workspace = true`; `:38` `channel.workspace = true`; `:46` `gpui = { workspace = true, features = ["screen-capture"] }` (feature only needed by `collab.rs`); `:48` `livekit_client.workspace = true`; `:50` `recent_projects.workspace = true` and `:52` `remote_connection.workspace = true` (used by non-collab code, so they stay in the closure); `:68` dev-dep `call` with `test-support`.
- `crates/title_bar/src/title_bar.rs:2` `pub mod collab;`; `:6` `mod update_version;`; `:24` `use auto_update::AutoUpdateStatus;`; `:25` `use call::ActiveCall;`; `:40` `use remote::RemoteConnectionOptions;`; `:53` `use update_version::UpdateVersion;`; `:128-137` `SimulateUpdateAvailable` handler calling `toggle_update_simulation`; `:220` field `update_version: Entity<UpdateVersion>`; `:222` `_diagnostics_subscription` (fed by `call::Room::diagnostics`); `:354` `children.push(self.render_collaborator_list(window, cx)...)`; `:383` `.child(self.render_call_controls(window, cx))`; `:385` `.child(self.update_version.clone())`; `:389-390` `.when(..., |this| this.child(self.render_sign_in_button(cx)))`; `:462` `let active_call = ActiveCall::global(cx);`; `:485` `cx.observe(&active_call, ...)`; `:513` `let update_version = cx.new(|cx| UpdateVersion::new(cx));`; `:548-552` `fn toggle_update_simulation`; `:614-660` the remote-connection status indicator (`project.remote_connection_options(cx)`, `remote::ConnectionState::{Connecting, Connected, HeartbeatMissed, Reconnecting, Disconnected}`) — wanted on the web; `:664`, `:848`, `:900` `recent_projects::{RemoteServerProjects, RecentProjects}::popover`; `:1116-1132` `active_call_changed` / `observe_diagnostics`; `:1134-1148` `share_project` / `unshare_project` (only called from `collab.rs`); `:1167-1194` the `client::Status::UpgradeRequired` arm (`:1176` "Please update Zed to Collaborate") reading `auto_update::AutoUpdater` and calling `auto_update::check`; `:1198` `pub fn render_sign_in_button`.
- `crates/title_bar/src/collab.rs:4` `use call::{ActiveCall, Room};`; `:5` `use channel::ChannelStore;`; `:13` `use livekit_client::ConnectionQuality;`; `:15` `use remote_connection::RemoteConnectionModal;`; `:37` `pub fn toggle_screen_sharing`; `:93` `pub fn toggle_mute`; `:113` `pub fn toggle_deafen` (these three are only called from `crates/collab_ui/src/collab_panel.rs:148-149`, an excluded crate); `:145-150` `pub(crate) fn render_collaborator_list(&self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement`; `:336-340` `pub(crate) fn render_call_controls(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement`.
- `crates/title_bar/src/update_version.rs:4` `use auto_update::{AutoUpdateStatus, AutoUpdater, UpdateCheckType};`; `:9-13` `pub struct UpdateVersion { status, update_check_type, dismissed_status }`; `:16` `pub fn new(cx)`; `:40` `pub fn update_simulation`; `:66` `pub fn show_update_in_menu_bar`; `:91` `impl Render`; `:140-177` `#[cfg(test)] mod tests` (file is 177 lines).
- `crates/title_bar/src/title_bar.rs:463-474` chooses `ApplicationMenu` by `PlatformStyle::platform()`; `crates/ui/src/styles/platform.rs:16-24` is a `const fn` on `cfg!(target_os)` that falls to `Mac` on wasm. Call sites (grep `PlatformStyle::platform()`, this checkout; none in a `const`/`static` position, so a runtime override is possible and D12 permits it — 3.2a): `crates/ui/src/components/keybinding.rs:100, 110, 228, 495, 511, 527` (the ⌘/⌥ versus Ctrl/Alt glyphs every rendered key binding uses, including the command palette), `crates/platform_title_bar/src/platform_title_bar.rs:40, 126, 158`, `crates/title_bar/src/title_bar.rs:464`, `crates/sidebar/src/sidebar.rs:2923`, `crates/editor/src/split.rs:499`, `crates/editor/src/edit_prediction.rs:2156, 2169, 2192, 2204`, `crates/keymap_editor/src/ui_components/keystroke_input.rs:379`, `crates/zed/src/zed.rs:1031` (desktop only), plus agent eval fixtures under `crates/agent/src/tools/evals/fixtures/` (not compiled).
- `title_bar::init` is called from `crates/collab_ui/src/collab_ui.rs:25` (`collab_ui::init`, invoked at `crates/zed/src/main.rs:771`), from `crates/zed/src/visual_test_runner.rs:187` and from `crates/collab/tests/integration/following_tests.rs:2250`; `crates/zed` never calls it directly, so `zed_web` must (3.26 step 31).

`git_ui` → `call` (already feature-gated upstream)

- `crates/git_ui/Cargo.toml:17` `call = ["dep:call"]`; `:25` `call = { workspace = true, optional = true }`.
- `crates/git_ui/src/git_panel.rs:1151-1152` `#[cfg_attr(not(feature = "call"), allow(dead_code))] local_committer`; `:4770-4773` `#[cfg(not(feature = "call"))] fn potential_co_authors` (returns empty); `:4775-4815` `#[cfg(feature = "call")]` real version; `:4817-4828` `#[cfg(feature = "call")] fn local_committer`; `:8932-8947` both arms of `has_co_authors` in `Render`.
- Only `crates/zed/Cargo.toml:125` enables it: `git_ui = { workspace = true, features = ["call"] }`. `collab`, `project_panel`, `vim` enable only `test-support`.

`language_models` → `bedrock` (AWS SDK), `extension_host`, `gpui_tokio`

- `crates/language_models/Cargo.toml:19` `aws-config`; `:20` `aws-credential-types`; `:21` `aws-sigv4`; `:22` `aws_http_client`; `:24` `bedrock = { workspace = true, features = ["schemars"] }`; `:31-32` `copilot_chat`, `copilot_ui` (unconditional — see "copilot" below); `:36` `extension_host.workspace = true`; `:41` `gpui_tokio.workspace = true`; `:64` `tokio = { workspace = true, features = ["rt", "rt-multi-thread"] }`.
- `crates/language_models/src/provider.rs:8` `pub mod bedrock;`.
- `crates/language_models/src/language_models.rs:19` `use crate::provider::bedrock::BedrockLanguageModelProvider;`; `:50-103` the `if let Some(extension_store) = extension_host::ExtensionStore::try_global(cx)` block (closes at `:103`; subscribes to `extension_host::Event::{ExtensionInstalled, ExtensionUninstalled, ExtensionsUpdated}`); `:296-302` `registry.register_provider(Arc::new(BedrockLanguageModelProvider::new(...)), cx)`; `:396` `gpui_tokio::init(cx)` inside `#[cfg(test)] mod tests` (`:347`).
- `crates/language_models/src/settings.rs:8` imports `bedrock, bedrock::AmazonBedrockSettings`; `:20` field `pub bedrock: AmazonBedrockSettings`; `:54` `let bedrock = language_models.bedrock.unwrap();`; `:96-112` the `bedrock: AmazonBedrockSettings { ... }` literal (`:102` `bedrock::RESERVED_HEADER_NAMES` sits inside it, so one attribute on the field initializer covers it; no other `.bedrock`/`extension_host` use exists in the crate).
- `crates/language_models/src/provider/bedrock.rs:37` `use gpui_tokio::Tokio;`; `:136-149` `pub struct AmazonBedrockSettings`; `:548` and `:725` `handle: tokio::runtime::Handle` fields; `:571`, `:816`, `:1785` `Tokio::{handle, spawn, spawn_result}`.
- `crates/language_models/src/provider/cloud.rs:627` `gpui_tokio::init(cx)` inside `#[cfg(test)] mod tests` (`:606`).
- `crates/settings_content/src/language_model.rs:15` `pub bedrock: Option<AmazonBedrockSettingsContent>` (pure content type, stays). `crates/settings_macros/src/settings_macros.rs:85-105` `RegisterSetting` only uses the type name, so cfg-ing a field is safe.

`copilot` (kept in the closure, not gated here)

- `grep -ln '^copilot' crates/*/Cargo.toml`: `copilot_ui` (`:24` `copilot`, `:25` `copilot_chat`), `edit_prediction` (`:28-29`), `edit_prediction_ui` (`:22-24`), `settings_ui` (`:30-31`), `language_models` (`:31-32`), `zed`. All are unconditional normal dependencies of crates `zed_web` needs, so `copilot`, `copilot_chat` and `copilot_ui` are in the browser closure regardless of any `zed_web` feature and must compile on wasm (their local LSP spawn is a leaf gate owned by the copilot/agent brief; BUILD-SPEC 8 routes Copilot through the sandbox language server anyway).

`agent_ui`, `settings_ui`, `recent_projects` → `extension_host`

- `crates/agent_ui/Cargo.toml:54` `extension_host.workspace = true`; `:62` `gpui_tokio.workspace = true`; `:25` `audio = ["dep:audio"]` and `:40` `audio = { workspace = true, optional = true }` (feature enabled by `crates/sidebar/Cargo.toml:24` and `crates/zed/Cargo.toml:80`; use sites `crates/agent_ui/src/agent_panel.rs:64`, `:2664`, `:2936` are already `#[cfg(feature = "audio")]`).
- `crates/agent_ui/src/agent_panel.rs:71` `use extension_host::ExtensionStore;`; `:1174` field `_extension_subscription: Option<Subscription>`; `:1529-1535` `let extension_subscription = ExtensionStore::try_global(cx).map(|store| cx.subscribe(&store, ...ExtensionUninstalled...))`; `:1588` `_extension_subscription: extension_subscription`; `:2726` `cx.open_window(...)` (pop-out; errors with `WebWindowError::AlreadyOpen` in the browser, section 7).
- `crates/agent_ui/src/agent_configuration/configure_context_server_modal.rs:6` `use extension_host::ExtensionStore;`; `:381-386` `let extension = ExtensionStore::global(cx).read(cx).installed_extensions()...map(|(id, entry)| (id.clone(), entry.manifest.clone()));`; `:396-398` `extension.and_then(|(_, manifest)| manifest.repository.clone()...)`.
- `crates/agent_ui/src/conversation_view.rs:3007` `.open_window(...)` (second pop-out).
- `crates/agent_ui/src/inline_assistant.rs:1798` `#[cfg(all(test, feature = "unit-eval"))]` module containing the only `gpui_tokio::init` at `:1863`.
- `crates/settings_ui/Cargo.toml:37` `extension_host.workspace = true`; `:23` `audio.workspace = true`, `:32` `cpal.workspace = true`, `:57` `rodio.workspace = true` (gated in 3.7 now); `:30-31` `copilot`, `copilot_ui` (stay).
- `crates/settings_ui/src/pages/mcp_servers_page.rs:6` import; `:254-268` `fn resolve_extension_display_name(id, cx) -> Option<SharedString>`; `:628-651` `fn uninstall_server` with the `ExtensionStore::global(cx).update(.. uninstall_extension ..)` block at `:638-640` (`manifest` is still used at `:637` by `extension_only_provides_context_server(&manifest)`); `:655-665` `fn resolve_extension_for_context_server(id, cx) -> Option<(Arc<str>, Arc<extension::ExtensionManifest>)>`; `:667-676` `extension_only_provides_context_server` (pure).
- `crates/settings_ui/src/pages.rs:1-2` `mod audio_input_output_setup; mod audio_test_window;`; `:13-16` re-exports `render_input_audio_device_dropdown`, `render_output_audio_device_dropdown`, `open_audio_test_window`; `crates/settings_ui/src/pages/audio_test_window.rs:1-9` uses `audio`, `cpal`, `rodio`; `pages/audio_input_output_setup.rs:1-2` uses `audio`, `cpal`; consumers `crates/settings_ui/src/settings_ui.rs:61-62` (import) and `:674-675` (`add_basic_renderer::<settings::AudioInputDeviceName>` / `AudioOutputDeviceName`), `crates/settings_ui/src/page_data.rs:16` (import) and `:8288` (`open_audio_test_window(window, cx)`).
- `crates/settings_ui/src/settings_ui.rs:455` `cx.on_action(|_: &OpenSettings, cx| ...)`; `:468` `register_action(|_, action: &OpenSettingsAt, ...)`; `:477` `OpenSettingsPage`; `:486` `OpenSettings` (workspace-scoped); `:844-926` `fn open_settings_editor_with` ending in `cx.open_window(...)` at `:889` — a second top-level window, which `gpui_web` refuses (`crates/gpui_web/src/platform.rs:379` `WebWindowError::AlreadyOpen`; doc at `gpui_web.rs:2-6`).
- `crates/recent_projects/Cargo.toml:24` `dev_container.workspace = true`; `:26` `extension_host.workspace = true`; `:22` `askpass`; `:34` `node_runtime`.
- `crates/recent_projects/src/remote_servers.rs:15` `use extension_host::ExtensionStore;`; the only use is `:2276` inside `open_dev_container` (`:2234-2320`).
- `crates/recent_projects/src/remote_connections.rs:557, 639, 766, 858, 919` `extension_host_proxy:` are `HeadlessAppState` literals inside `#[cfg(test)]` (dev-dep `remote_server`), untouched.
- `crates/recent_projects/src/disconnected_overlay.rs:43-47` `DisconnectedOverlay::register(workspace, window, cx)` subscribes to `project::Event::{DisconnectedFromHost, DisconnectedFromRemote}` and renders an in-canvas "Reconnect" modal that re-dials with the options snapshot; registered at `crates/recent_projects/src/recent_projects.rs:504` (`cx.observe_new(DisconnectedOverlay::register)`; import at `:24`). After a 4001 "taken over" close its Reconnect would steal the session back (b1 §7 item 6), so 3.8 gates it on wasm.

`recent_projects` → `dev_container`

- `crates/recent_projects/src/recent_projects.rs:1` `mod dev_container_suggest;`; `:41` `use dev_container::{DevContainerContext, find_devcontainer_configs};`; `:506-540` `cx.on_action(|_: &OpenDevContainer, cx| ...)` (calls `RemoteServerProjects::new_dev_container`); `:543-570` `cx.observe_new(... dev_container_suggest::suggest_on_worktree_updated ...)`.
- `crates/recent_projects/src/dev_container_suggest.rs:2` `use dev_container::find_configs_in_snapshot;`.
- `crates/recent_projects/src/remote_servers.rs:10-13` `use dev_container::{DevContainerConfig, DevContainerContext, find_devcontainer_configs, start_dev_container_with_config};`; `:66` field `dev_container_picker: Option<Entity<Picker<DevContainerPickerDelegate>>>`; `:94-99` `enum DevContainerCreationProgress`; `:101-105` `struct CreateRemoteDevContainer`; `:107-108` its `new`; `:181-186` `struct DevContainerPickerDelegate`; `:187` `impl DevContainerPickerDelegate`; `:201` `impl PickerDelegate for DevContainerPickerDelegate`; `:262` `edit_in_dev_container_json` call; `:273-274` `open_dev_container` / `view_in_progress_dev_container` calls; `:792-801` `enum Mode` with `:798` `CreateRemoteDevContainer(CreateRemoteDevContainer)`; `:1158` `init_dev_container_mode` call; `:1426-1460` `pub fn new_dev_container`; `:1543` `dev_container_picker: None`; `:1765` `fn view_in_progress_dev_container`; `:1893` and `:1931` `Mode::CreateRemoteDevContainer` match arms; `:2141` `fn edit_in_dev_container_json`; `:2201` `fn init_dev_container_mode` (assigns `self.dev_container_picker` at `:2209`); `:2234` `fn open_dev_container`; `:2321` `fn render_create_dev_container` (calls `render_config_selection` at `:2416`); `:2456-2470` `fn render_config_selection` (reads `self.dev_container_picker` at `:2461`); `:3102` render match arm. 89 lines match `dev_container|DevContainer` (case-insensitive).
- `crates/dev_container/Cargo.toml:8-31` depends on `async-tar`, `walkdir`, `project`, `workspace` (no wasm target sections).

`gpui_tokio` at its dependents

- `crates/gpui_tokio/Cargo.toml:19` `tokio = { workspace = true, features = ["rt", "rt-multi-thread"] }` (the multi-thread runtime does not build for `wasm32-unknown-unknown`).
- `crates/cloud_api_client/Cargo.toml:28-29` `[target.'cfg(not(target_family = "wasm"))'.dependencies] gpui_tokio.workspace = true` — the precedent to copy.
- `crates/client/Cargo.toml:34` `gpui_tokio`; `crates/client/src/client.rs:1357` `gpui_tokio::Tokio::spawn_result(cx, ...)` inside `fn establish_websocket_connection(self: &Arc<Self>, credentials: &Credentials, cx: &AsyncApp) -> Task<Result<Connection, EstablishConnectionError>>` (`:1326-1330`). Owned by b6 §3.8.
- `crates/agent/Cargo.toml:102` `gpui_tokio` is a dev-dependency (block starts `:87`); the source uses at `crates/agent/src/tools/evals/*.rs` and `crates/agent/src/tests/mod.rs:4175, 4927` are under `#[cfg(all(test, feature = "unit-eval"))] mod evals;` (`crates/agent/src/tools.rs:11-12`) and `#[cfg(test)]` (`crates/agent/src/agent.rs:8`). No normal-target change needed.
- `crates/agent_ui/Cargo.toml:62` normal dep, only used in the test-gated module above.
- `crates/livekit_client/Cargo.toml:30`, `crates/extension_host/Cargo.toml:31`, `crates/call/Cargo.toml:35`: these crates leave the browser closure entirely once `title_bar`, `language_models`, `agent_ui`, `settings_ui`, `recent_projects`, `activity_indicator` are gated; no change inside them.
- `crates/language_models/Cargo.toml:41` covered above.

`http_client_tls` and the rest of `client` (owned by b6 §3.8; listed so this brief's forbidden-crate list is right)

- `crates/http_client_tls/Cargo.toml:19-22` `log`, `rustls`, `rustls-platform-verifier`, `webpki-roots`; `crates/http_client_tls/src/http_client_tls.rs:8-30` `pub fn tls_config() -> ClientConfig` installing the `aws_lc_rs` provider.
- Dependents: `crates/client/Cargo.toml:36`; `crates/livekit_client/Cargo.toml:31`; `crates/reqwest_client/Cargo.toml:29-30` already under `[target.'cfg(not(target_family = "wasm"))'.dependencies]` (precedent).
- Use sites: `crates/client/src/client.rs:1414-1419` `async_tungstenite::tokio::client_async_tls_with_connector_and_config(...)`; `crates/client/src/proxy.rs:11` `use tokio::net::TcpStream;`, `:82-92` `connect_tls_to_proxy` (itself `cfg(not(any(windows, macos)))`) using `http_client_tls::tls_config()`; `crates/livekit_client/src/livekit_client.rs:58` (excluded crate).
- Related native-only items in `client`: `crates/client/Cargo.toml:21` `async-tungstenite` (tokio features), `:41` `proxy_handshake` (tokio), `:57` `tiny_http`, `:58` `tokio`, `:81-82` `[target.'cfg(any(target_os = "windows", target_os = "macos"))'.dependencies] tokio-native-tls` (inactive on wasm), `:84-86` `[target.'cfg(not(any(target_os = "windows", target_os = "macos")))'.dependencies] rustls-pki-types`, `tokio-rustls` (**active** on wasm32-unknown-unknown, where `target_os = "unknown"`; b6 re-gates both blocks with `not(target_family = "wasm")`); `crates/client/src/client.rs:5` `mod proxy;`, `:11-15` `use async_tungstenite::tungstenite::{client::IntoClientRequest, error::Error as WebsocketError, http::{HeaderValue, Request, StatusCode}}`, `:33` `use proxy::{...}`, `:54` `use tokio::net::TcpStream;`, `:244-258` `enum EstablishConnectionError { UpgradeRequired, Unauthorized, Other, InvalidHeaderValue, Io, Websocket }` (never empty on wasm), `:260-271` `impl From<WebsocketError> for EstablishConnectionError` (uses `WebsocketError` and `StatusCode`), `:1430` `authenticate_with_browser` (`:1470` `tiny_http::Server::http`), `:1561-1607` `authenticate_as_admin` (`:1581` `Request::post`).

`auto_update` → `title_bar`, `remote_connection`, `activity_indicator`

- Dependents (`grep '^auto_update' crates/*/Cargo.toml`): `activity_indicator`, `auto_update_ui`, `remote_connection`, `title_bar`, `zed`.
- `crates/remote_connection/Cargo.toml:21` `auto_update.workspace = true`; `crates/remote_connection/src/remote_connection.rs:5` `use auto_update::AutoUpdater;`; `:462` `impl remote::RemoteClientDelegate for RemoteClientDelegate`; `:488-518` `fn download_server_binary_locally(&self, platform, release_channel, version, cx) -> Task<anyhow::Result<PathBuf>>` calling `AutoUpdater::download_remote_server_release` at `:497`; `:520-537` `fn get_download_url(...) -> Task<Result<Option<String>>>` calling `AutoUpdater::get_remote_server_release_url` at `:528`; `:639` `impl remote::RemoteClientDelegate for BackgroundRemoteClientDelegate` with the same two methods at `:663` and `:694`.
- `crates/remote/src/remote_client.rs:135-158` the `RemoteClientDelegate` trait (`ask_password`, `get_download_url`, `download_server_binary_locally`, `set_status`); `:166` `pub const MAX_RECONNECT_ATTEMPTS: usize = 3` (b1 §3.5 adds `max_reconnect_attempts()` = 20 for WebSocket); `:340-342` `pub enum RemoteClientEvent { Disconnected {..}, Reconnected }` (`Reconnected` emitted at `:761`); `:1020` `pub fn connection_state(&self) -> ConnectionState`; `:1597` `pub trait RemoteConnection: Send + Sync`.
- `crates/activity_indicator/Cargo.toml:20` `auto_update`, `:22` `extension_host`; `crates/activity_indicator/src/activity_indicator.rs` has exactly nine use lines: `:1` `use auto_update::DismissMessage;`, `:3` `use extension_host::{ExtensionOperation, ExtensionStore};`, `:328` `fn dismiss_message(&mut self, _: &DismissMessage, ...)` (action handler), `:561` and `:586` `this.dismiss_message(&DismissMessage, window, cx)` (click handlers), `:678` `ExtensionStore::try_global(cx).map(|extension_store| extension_store.read(cx))`, `:683`, `:687`, `:691` `ExtensionOperation::{Install, Upgrade, Remove}` arms. No keymap binds `auto_update::DismissMessage`.

`dev_container` covered above; `node_runtime` local paths in `workspace`

- `crates/workspace/Cargo.toml:51` `node_runtime.workspace = true`; `crates/workspace/src/workspace.rs:79` `use node_runtime::NodeRuntime;`; `:1195-1204` `pub struct AppState { languages, client, user_store, workspace_store, fs, build_window_options: fn(Option<Uuid>, &mut App) -> WindowOptions, node_runtime: NodeRuntime, session }`; `:1301` `node_runtime: NodeRuntime::unavailable()` in `AppState::test`; `:1998-2007` `Project::local(...)` in `Workspace::new_local`; `:10656-10667` `Project::local` in `open_workspace_by_id`; `:11070-11080` `Project::remote(session, client, node_runtime, user_store, languages, fs, true, cx)` in `open_remote_project_with_existing_connection` (`:11099-11126`); `crates/workspace/src/multi_workspace.rs:1138-1147` same call. `crates/node_runtime/src/node_runtime.rs:77` `pub fn unavailable() -> Self`. The `NodeRuntime` type is a parameter of `Project::remote` (`crates/project/src/project.rs:1413-1422`), so the `node_runtime` crate stays in the wasm closure and the edge is not gated; only its value is `unavailable()`.

`channel` (discovered)

- `crates/file_finder/Cargo.toml:17` and `crates/file_finder/src/file_finder.rs:9` `use channel::ChannelStore;`; `crates/notifications/Cargo.toml:25`. `crates/channel/Cargo.toml:18-32` depends only on `client`, `clock`, `collections`, `futures`, `gpui`, `language`, `log`, `postage`, `release_channel`, `rpc`, `settings`, `text`, `util` — it stays in the closure and is initialized (`crates/zed/src/main.rs:747`).

`audio` (discovered in review)

- `cargo tree -i audio --target wasm32-unknown-unknown`: `agent_ui` (via its `audio` feature, enabled by `sidebar/Cargo.toml:24`, which `zed_web` depends on), `settings_ui` (`Cargo.toml:23` normal), `call`, `livekit_client` (excluded), `zed`. `cpal`/`rodio` come with it. Gated in 3.7 and 3.13.

### 2.2 Desktop entry crate (`crates/zed`)

`crates/zed/src/main.rs` (2061 lines), in order:

- `:30` `use git::GitHostingProviderRegistry;` (the type lives in `git`, not `git_hosting_providers`); `:86-93` `build_application()` → `gpui_platform::current_platform(false)`; `:282` `init_paths()` (creates config/extensions/languages/debug_adapters/database/logs/temp/hang_traces dirs, `:1656-1673`); `:288` `zlog::init()`; `:299` `ztracing::init()`; `:304` `AppVersion::load(env!("CARGO_PKG_VERSION"), option_env!("ZED_BUILD_ID"), sha)`; `:338-340` `build_application().with_assets(Assets).with_restart_arguments(...)`; `:342` `db::AppDatabase::new()` (blocking); `:343-350` `system_id`, `installation_id`, `Session::new(session_id, KeyValueStore::from_app_db(&app_db))` spawned on `app.background_executor()`; `:356-379` single-instance check; `:385-417` crash handler; `:419-432` `GitHostingProviderRegistry::new()` and `RealFs::new(git_binary_path, executor)`; `:433-437` `watch_config_file(&executor, fs, paths::keymap_file())`; `:439-450` login-shell env; `:452-473` `on_open_urls` / `on_reopen`.
- Inside `app.run` (`:475`): `:476` `cx.set_global(app_db)`; `:477-484` `trusted_worktrees::init(WorkspaceDb::global(cx).fetch_trusted_worktrees())`; `:485` `menu::init()`; `:486` `zed_actions::init()`; `:488` `release_channel::init(app_version, cx)`; `:489` `gpui_tokio::init(cx)`; `:493` `settings::init(cx)`; `:494` `zlog_settings::init(cx)`; `:495` `zed::watch_settings_files(fs, cx)`; `:496` `handle_keymap_file_changes(rx, watcher, cx)`; `:498-511` `ReqwestClient` + `cx.set_http_client`; `:513` `<dyn Fs>::set_global(fs, cx)`; `:515-516` `GitHostingProviderRegistry::set_global` + `git_hosting_providers::init(cx)`; `:518` `OpenListener::set_global`; `:520-521` `extension::init(cx)` + `ExtensionHostProxy::global(cx)`; `:523-524` `Client::production(cx)` + `cx.set_http_client(client.http_client())`; `:525-527` `LanguageRegistry::new(executor)` + `set_language_server_download_dir`; `:528-555` node options observer + `NodeRuntime::new(http, Some(shell_env_rx), rx)`; `:557` `debug_adapter_extension::init(proxy, cx)`; `:558` `languages::init(languages, fs, node_runtime, cx)`; `:559-560` `UserStore::new`, `WorkspaceStore::new`; `:562-579` `language_extension::init(LspAccess::ViaWorkspaces(...), proxy, languages)`; `:581` `Client::set_global`; `:583` `zed::init(cx)`; `:586` `Project::init(&client, cx)`; `:587` `debugger_ui::init`; `:588` `debugger_tools::init`; `:589` `client::init(&client, cx)`; `:590` `FeatureFlagStore::init(cx)`; `:592-637` ids + telemetry start; `:639` `AppSession::new(session, cx)`; `:641-651` `AppState { languages, client, user_store, fs, build_window_options, workspace_store, node_runtime, session }` + `AppState::set_global`; `:653` `auto_update::init`; `:654` `dap_adapters::init(cx)`; `:655` `auto_update_ui::init`; `:656` `reliability::init`; `:657-663` `extension_host::init(...)`; `:665` `theme_settings::init(LoadThemes::All(Box::new(Assets)), cx)`; `:666` `eager_load_active_theme_and_icon_theme(fs, cx)`; `:667-671` `theme_extension::init(proxy, ThemeRegistry::global(cx), executor)`; `:672` `command_palette::init`; `:673-687` `copilot_chat::init(http, credentials_provider, config, cx)`; `:688` `copilot_ui::init(&app_state, cx)`; `:689` `language_model::init`; `:690-694` `RefreshLlmTokenListener::register(client, user_store, cx)`; `:695` `language_models::init(user_store, client, cx)`; `:696` `acp_tools::init`; `:697-698` `zed::telemetry_log::init`, `zed::remote_debug::init`; `:699` `edit_prediction_ui::init`; `:700-701` `web_search::init`, `web_search_providers::init(client, user_store, cx)`; `:702` `snippet_provider::init`; `:703` `edit_prediction_registry::init(client, user_store, cx)` (a `crates/zed` module); `:704` `PromptBuilder::load(fs, stdout_is_a_pty(), cx)`; `:705-709` `AgentRegistryStore::init_global(cx, fs, http)`; `:710-717` `agent_ui::init(fs, prompt_builder, languages, is_new_install, false, cx)`; `:718` `zed::watch_user_agents_md(app_state.fs.clone(), cx)`; `:720` `repl::init(fs, cx)`; `:721` `recent_projects::init(cx)`; `:722` `dev_container::init(cx)`; `:724` `load_embedded_fonts(cx)` (`:1822-1846`, uses `block_on(executor.scoped(..))`); `:728-731` `editor::init`, `image_viewer::init`, `repl::notebook::init`, `diagnostics::init`; `:733` `audio::init`; `:734` `workspace::init(app_state, cx)`; `:735` `ui_prompt::init`; `:737-746` `go_to_line`, `file_finder`, `tab_switcher`, `outline`, `call_hierarchy`, `project_symbols`, `project_panel`, `outline_panel`, `tasks_ui`, `snippets_ui`; `:747` `channel::init(&client, user_store, cx)`; `:748-749` `search::init`, `lsp_locations::init`; `:750-758` `cx.set_global(workspace::PaneSearchBarCallbacks { setup_search_bar, wrap_div_with_search_actions })`; `:759` `vim::init`; `:760` `terminal_view::init`; `:761` `journal::init`; `:762-768` `encoding_selector`, `language_selector`, `line_ending_selector`, `toolchain_selector`, `theme_selector`, `settings_profile_selector`, `language_tools`; `:769` `call::init`; `:770` `notifications::init(client, user_store, cx)`; `:771` `collab_ui::init` (which calls `title_bar::init`); `:772` `git_ui::init`; `:773` `feedback::init`; `:774-776` `markdown_preview`, `tabular_data_preview`, `svg_preview`; `:777` `onboarding::init`; `:778` `settings_ui::init`; `:779` `keymap_editor::init`; `:780` `extensions_ui::init`; `:781` `edit_prediction::init`; `:782` `inspector_ui::init`; `:783` `json_schema_store::init`; `:784` `miniprofiler_ui::init(startup_time, cx)`; `:785` `which_key::init`; `:789-817` `SettingsStore` observer (window background appearance, text rendering mode, server URL change); `:822-828` `languages.set_theme` + `GlobalTheme` observer; `:845-849` `load_user_themes_in_background`, `watch_themes`, `watch_languages`; `:850-851` `app_menus(cx)` + `cx.set_menus`; `:871` `initialize_workspace(app_state.clone(), cx)`; `:873` `cx.activate(true)`; `:875-878` `authenticate` spawn (`:1367` `async fn authenticate`); `:881-1000` open-request handling and workspace restore.

`crates/zed/src/zed.rs` (8101 lines):

- `:50` `use language_onboarding::BasedPyrightBanner;` (toolbar item, so `language_onboarding` is a `zed_web` dependency).
- `:192-333` `pub fn init(cx)` — `Quit`, `RestoreBanner`, `OpenLog`, `OpenLicenses`, `OpenKeymapFile`, `OpenSettingsFile`, `OpenAccountSettings`, `OpenTasks`, `OpenDebugTasks`, `ShowDefaultSemanticTokenRules`, `OpenDefaultSettings`, `OpenDefaultKeymap`, `About` handlers.
- `:359-426` `pub fn build_window_options(display_uuid: Option<Uuid>, cx: &mut App) -> WindowOptions` (titlebar transparent, `traffic_light_position` 9,9, `app_owns_titlebar_drag`, `window_min_size` 360x240, decorations from settings).
- `:428-665` `pub fn initialize_workspace(app_state, cx)`: `:437-440` `init_cursor_hide_mode`, `init_app_appearance`, `init_reduce_motion`, `init_global_config_error_notifications`; `:442-548` `MultiWorkspace` observer (window-close hook at `:492-500`, `ActiveWorkspaceChanged` → agent panel at `:502-528`, sidebar registration at `:535-546`); `:550-663` `Workspace` observer: `initialize_pane` on center pane and `PaneAdded`; `:575` `initialize_file_watcher` (non-macOS); `:577-583` GPU specs warning; `:585-599` edit prediction button; `:601-635` status-bar items (`SearchButton`, `DiagnosticIndicator`, `ActiveFileName`, `ActivityIndicator`, `ActiveBufferEncoding`, `ActiveBufferLanguage`, `ActiveToolchain`, `vim::ModeIndicator`, `ImageInfo`, `LspButton`, `CursorPosition`, `LineEndingIndicator`, `GitBlameStatus`, `MergeConflictIndicator`); `:636-652` `status_bar.add_left_item/add_right_item` order; `:654-656` `initialize_panels` + `register_actions`.
- `:777-818` `fn initialize_panels(window, cx) -> Task<Result<()>>`: loads `ProjectPanel`, `OutlinePanel`, `TerminalPanel`, `GitPanel`, `CollabPanel`, `DebugPanel`, then `initialize_agent_panel` (`:880-912`, registers `AgentPanel::{toggle_focus, focus, toggle}` and `InlineAssistant::inline_assist` at `:903-909`), then `finish_dock_restoration`.
- `:914-1472` `fn register_actions(app_state, workspace, window, cx)`; verified head `:921-923` (`OpenDocs`, `OpenStatusPage`, `GetMerch`).
- `:1474-1541` `fn initialize_pane(workspace, pane, window, cx)`: toolbar items in order `MultibufferHint`, `SoloDiffStyleToolbar`, `Breadcrumbs`, `BufferSearchBar`, `QuickActionBar`, `diagnostics::ToolbarControls`, `ProjectSearchBar`, `LspLogToolbarItemView`, `DapLogToolbarItemView`, `AcpToolsToolbarItemView`, `TelemetryLogToolbarItemView`, `SyntaxTreeToolbarItemView`, `MigrationBanner`, `HighlightsTreeToolbarItemView`, `ProjectDiffToolbar`, `StagedDiffToolbar`, `UnstagedDiffToolbar`, `BranchDiffToolbar`, `SoloDiffGitToolbar`, `CommitViewToolbar`, `AgentDiffToolbar`, `BasedPyrightBanner`, `ImageViewToolbarControls`.
- `:2125-2144` `pub fn watch_settings_files(fs, cx)` (calls `SettingsStore::watch_settings_files` with an error-notifying callback); `:2146-2262` `pub fn handle_keymap_file_changes(rx, watcher, cx)` (observes `BaseKeymap`, vim/helix, `disable_ai`, keyboard layout; `:2205` `load_default_keymap(cx)`; `:2213` `let mut migrating_in_memory = false;` then the loop reloading the user keymap with `migrate_keymap`); `:2334-2353` `fn reload_keymaps` (clear, defaults at `:2336`, user bindings with `KeybindSource::User`, menus, `KeymapEventChannel::trigger_keymap_changed`); `:2355-2388` `pub fn load_default_keymap(cx)`: `DEFAULT_KEYMAP_PATH` as `Default`, `base_keymap.asset_path()` as `Base`, `VIM_KEYMAP_PATH` as `Vim` when vim/helix on, `SPECIFIC_OVERRIDES_KEYMAP_PATH` as `Default` — all through the strict `KeymapFile::load_asset`; `:2411-2419` `filter_disabled_ai_bindings`.
- `:2761-2849` `eager_load_active_theme_and_icon_theme` (needs `ExtensionStore` and `block_on`).

`crates/remote_server/build.rs:1-16` derives `ZED_PKG_VERSION` from `crates/zed/Cargo.toml` (`include_str!("../zed/Cargo.toml")` parsed with `cargo_toml`/`toml`; build-deps at `crates/remote_server/Cargo.toml:107-109`), and `crates/remote_server/src/server.rs:648-652` calls `AppVersion::load(env!("ZED_PKG_VERSION"), option_env!("ZED_BUILD_ID"), app_commit_sha)` — the precedent for a crate whose own `version` (`remote_server/Cargo.toml:5` `0.1.0`) is not Zed's (`crates/zed/Cargo.toml:5` `1.19.0`).

### 2.3 Web platform and build tooling

- `crates/gpui_platform/src/gpui_platform.rs:13-20` `application()` (wasm arm calls `application_with_web_backend(Auto)`); `:28` `pub use gpui_web::WebBackendPreference;`; `:31-38` `pub fn application_with_web_backend(backend_preference) -> Application` (also installs `platform.fetch_http_client()` via `with_http_client`); `:42-47` `single_threaded_web()`; `:51-55` `pub fn web_init()` (`console_error_panic_hook::set_once`, `gpui_web::init_logging`); `:76-80` wasm arm of `current_platform`. `crates/gpui_platform/Cargo.toml:37-39` `[target.'cfg(target_family = "wasm")'.dependencies] gpui_web`, `console_error_panic_hook`.
- `crates/gpui_web/Cargo.toml` (92 lines): `:12-14` `[features] default = ["multithreaded"]`, `multithreaded = ["dep:wasm_thread", "scheduler/wasm-threads"]`; `:18` `[target.'cfg(target_family = "wasm")'.dependencies]` — every dependency is in the wasm table; `:36-38` `wasm_thread` git fork rev `0cf96c7…` with `es_modules`; `:40-90` `web-sys` feature list (no `Navigator.keyboard`).
- `crates/gpui_web/src/gpui_web.rs:1` `#![cfg(target_family = "wasm")]` — the crate is empty on native, which is how it stays a workspace member without breaking `cargo check --workspace`; `:2-6` doc: one document-owned canvas, one top-level window, a second `open_window` returns `WebWindowError`; `:18-25` exports `WebDispatcher`, `WebDisplay`, `WebBackendPreference`, `FetchCredentials`, `FetchHttpClient`, `WebKeyboardLayout`, `init_logging`, `WebPlatform`, `WebWindowError`, `WebWindow`.
- `crates/gpui_web/src/platform.rs:96` `WebWindowError::AlreadyOpen` (`:110-111` "GPUI web supports only one top-level window"); `:145-147` `WebPlatform::new(allow_multi_threading)`; `:149-197` `new_with_backend` (`:161-163` `CosmicTextSystem::new_without_system_fonts("IBM Plex Sans")` — no system fonts, so fonts must be added before first paint); `:200-202` `fetch_http_client()`; `:205-210` `fetch_http_client_with_user_agent`; `:307-330` `Platform::run` spawns `initialize_graphics` with `wasm_bindgen_futures::spawn_local` and returns immediately; `:359-392` `open_window` (rejects `AnchoredPopup`/`PopUp`/`Floating`/`Dialog` kinds at `:366-376`, `AlreadyOpen` at `:379`, `ReopeningUnsupported` at `:381`); `:440-444` `open_url` → `window.open`; `:454-478` `prompt_for_paths` / `prompt_for_new_path` return errors; `:488-490` `on_quit` only stores the callback (no `beforeunload`/`pagehide` listener anywhere in the crate, so `cx.on_app_quit` hooks never run in the browser); `:784` a `visibilitychange` listener is already installed (`add_listener(document_target, "visibilitychange")`).
- `crates/gpui_web/src/dispatcher.rs:145-152` `WebDispatcher`; `:164-175` `supports_threads = multithreaded && allow && shared_memory_supported() && wait_async_supported()` with single-thread fallback; `:178-205` `wasm_thread::Builder::new().name(..).spawn(..)` per `hardware_concurrency` (workers never return to their event loop, b5 §7 item 6).
- `crates/gpui_web/src/events.rs:1247-1255` `modifiers_from_keyboard_event` maps `ctrl_key`→`control`, `meta_key`→`platform`; `:1294-1309` `pub(crate) fn is_mac_platform(browser_window) -> bool` via `navigator.platform` / user agent.
- `crates/gpui_web/src/keyboard.rs:1-12` `WebKeyboardLayout` implements only `id()` → `"us"` and `name()` → `"US"`; no key-equivalent mapping, so macOS `alt-` chords are not remapped (section 7).
- `crates/gpui_web/src/logging.rs:33-40` `init_logging` (console logger via `log::set_logger`).
- `crates/gpui/src/app.rs:234-245` `Application::run` (drops the `Application` after `platform.run` returns); `:255-266` `run_embedded(...) -> ApplicationHandle` (documented for "GPUI compiled into a Wasm guest"). `crates/gpui/src/app/async_context.rs:188` `AsyncApp::open_window`. `crates/gpui/src/executor.rs:444-445` `ForegroundExecutor::block_on` is `#[cfg(not(target_family = "wasm"))]`.
- `crates/gpui/Cargo.toml:112-114` wasm target deps `getrandom = { version = "0.3.4", features = ["wasm_js"] }`, `uuid` with `js`.
- `crates/gpui/src/platform/keystroke.rs:127` `ctrl` → `control`; `:152-157` `cmd`/`super`/`win` → `platform`.
- `crates/scheduler/Cargo.toml:16-26` `wasm-threads = ["dep:wasm_thread", "flume/spin"]`; `:38-43` the same `wasm_thread` fork under the wasm target table.
- `crates/gpui_web/examples/hello_web/Cargo.toml:1` `[workspace]` — the example is a standalone package outside the root workspace; `hello_web/.cargo/config.toml:1-14` — upstream's authoritative wasm flags: `-C target-feature=+atomics,+bulk-memory,+mutable-globals`, link args `--shared-memory`, `--max-memory=1073741824`, `--import-memory`, `--export=__wasm_init_tls`, `--export=__tls_size`, `--export=__tls_align`, `--export=__tls_base`; `[unstable] build-std = ["std,panic_abort"]`. `hello_web/rust-toolchain.toml` pins `nightly` with `rust-src` and `wasm32-unknown-unknown`. `hello_web/main.rs:410-429` `requested_backend()` from `?backend=webgpu|webgl`; `:431-455` `main` (`web_init`, `application_with_web_backend(..).run(|cx| { add_fonts(include_bytes!(IBMPlexSans-Regular.ttf)); open_window; cx.activate(true) })`). `hello_web/index.html` is a trunk page with `data-bindgen-target="web"`; `hello_web/trunk.toml:7` serves COOP `same-origin` / COEP `require-corp`.
- Root `rust-toolchain.toml:1-9` pins `1.97.1` with `rust-src` and the `wasm32-unknown-unknown` target; `.cargo/config.toml:1-3` `[build] rustflags = ["-C", "symbol-mangling-version=v0", "--cfg", "tokio_unstable"]` (no crate under `crates/` uses `cfg(tokio_unstable)`), `:11-17` a Windows `target.'cfg(...)'` rustflags table (the precedent for a target table that repeats the build flags), `:19-21` aarch64 Linux, `:23-24` `[env] MACOSX_DEPLOYMENT_TARGET`. Cargo precedence: a matching `target.<triple>.rustflags`/`target.<cfg>.rustflags` set replaces `[build].rustflags` for that target; `target.*` entries are concatenated with each other (`.cargo/ci-config.toml:11-12` relies on this for `[target.'cfg(all())'] -D warnings`). b5 §3 item 2 owns the wasm table.
- CI: `tooling/xtask/src/tasks/workflows/run_tests.rs:493-525` generates `check_wasm` (`:494-497` installs nightly with `rust-src` + target; `:500-509` `cargo -Zbuild-std=std,panic_abort check --target wasm32-unknown-unknown -p gpui_platform -p cloud_api_client` with `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS=-C target-feature=+atomics,+bulk-memory,+mutable-globals` and `RUSTC_BOOTSTRAP=1`); the emitted job is `.github/workflows/run_tests.yml:637-680`. b5 item 16 replaces the env var with `script/check-wasm`.
- `tooling/xtask/src/main.rs:15-34` `enum CliCommand`, `:36-53` dispatch; `tooling/xtask/src/tasks.rs:1-11` module list; `tooling/xtask/src/tasks/web_examples.rs:11-18` `WebExamplesArgs`, `:20-25` `fn check_program(binary, install_hint)` (private), `:50-76` cargo build with `RUSTC_BOOTSTRAP=1`, `:98-118` `wasm-bindgen --target web --no-typescript --out-dir --out-name`, `:150-175` python COOP/COEP dev server. `tooling/xtask/Cargo.toml:12-30` deps (`anyhow`, `clap`, `cargo_metadata`, `serde_json`, `toml`).
- `script/download-wasi-sdk:1-60` installs wasi-sdk 25 into `./target/wasi-sdk`.
- Workspace `Cargo.toml:97` member `crates/gpui_platform`, `:101` `crates/gpui_web`; `:354` `git = { path = "crates/git" }`; `:365` `gpui_platform = { path = ..., default-features = false }`; `:369` `gpui_web`; `:393` `language_onboarding`; `:583` `console_error_panic_hook = "0.1.7"`; `:667` `js-sys = "0.3"`; `:831-836` `time = { version = "0.3", features = ["macros", "parsing", "serde", "serde-well-known", "formatting", ...] }` (no `wasm-bindgen` feature); `:898` `wasm-bindgen = "0.2.120"` (`Cargo.lock:20054-20055`); `:899` `wasm-bindgen-futures = "0.4"`; `:902` `web-time = "1.1.0"`; `:546` `async-tar` (git fork); no sync `tar` dep; `:1083-1090` `[profile.release]` (`debug = "limited"`, `lto = "thin"`, `codegen-units = 1`).
- wasm_thread fork (`~/.cargo/git/checkouts/wasm_thread-586cb4b723c583fe/0cf96c7`): `src/wasm32/js/web_worker_module.js` (`import init, { wasm_thread_entry_point } from "WASM_BINDGEN_SHIM_URL"`, then `init({ module_or_path, memory })`); `src/wasm32/utils.rs:33-39` `get_wasm_bindgen_shim_script_path` evaluates `js/script_path.js` (throws an `Error` and regex-matches the script URL out of `e.stack`); `:41-72` `get_worker_script` builds a `blob:` URL; `:15`, `:26`, `:34` and `src/wasm32/mod.rs:60`, `:300` use `js_sys::eval`; `mod.rs:144-146` `Builder::wasm_bindgen_shim_url(url)`; `mod.rs:301` `WorkerType::Module`; `mod.rs:337-338` posts `wasm_bindgen::module()` and `wasm_bindgen::memory()` to the worker.
- `dirs` 6.0.0 (`Cargo.lock:5150`; `~/.cargo/registry/src/*/dirs-6.0.0/src/lib.rs:28-30` `#[cfg(target_arch = "wasm32")] mod wasm;` returning `None` everywhere) and `tar` 0.4 with `default-features = false` both `cargo check` for `wasm32-unknown-unknown` (scratch crates, section 8).

### 2.4 Settings, keymaps, assets, paths

- `crates/settings/src/settings.rs:121-127` `util::fs_embed! { pub struct SettingsAssets, include = ["settings/*", "keymaps/*"] }`; `:129-133` `pub fn init(cx)` = `SettingsStore::new(cx, &default_settings())`, `cx.set_global`, `SettingsStore::observe_active_settings_profile_name(cx).detach()`; `:135-137` `default_settings()`; `:144-150` `DEFAULT_KEYMAP_PATH` chosen by `cfg(target_os)` — on wasm this resolves to `"keymaps/default-linux.json"`; `:152-154` `default_keymap()`; `:156` `VIM_KEYMAP_PATH`; `:168-171` `SPECIFIC_OVERRIDES_KEYMAP_PATH` (`-macos` variant on macOS); `:185-187` `initial_keymap_content()`.
- `crates/settings/src/base_keymap_setting.rs:98-125` `BaseKeymap::asset_path(&self) -> Option<&'static str>`: `keymaps/macos/*.json` under `cfg(target_os = "macos")`, else `keymaps/linux/*.json` (`TextMate` is macOS-only).
- `crates/settings/src/keymap_file.rs:173` `KeymapFile::parse(content)`; `:180-202` `load_asset(asset_path, source: Option<KeybindSource>, cx) -> Result<Vec<KeyBinding>>` — `bail!`s on `KeymapFileLoadResult::SomeFailedToLoad` (`:194-196`), i.e. on any binding whose action is not registered; `:204-222` `load_asset_allow_partial_failure`; `:258` `load(content, cx) -> KeymapFileLoadResult`; `:556-560` action resolution is `cx.build_action(name, ..)` at runtime (a missing action is a runtime error, never a compile error); `:877` `load_keymap_file(fs)`; `:1405-1413` `enum KeybindSource { User, Vim, Base, Default, Unknown }` with `meta()`.
- `assets/keymaps/default-linux.json` binds actions from crates the browser build excludes: `:917` `collab_panel::ToggleFocus`, `:1173-1189` `collab_panel::{Remove, MoveChannelUp, MoveChannelDown, OpenSelectedChannelNotes, ToggleSelectedChannelFavorite, InsertSpace}`, `:1432-1434` `onboarding::{Finish, SignIn, OpenAccount}`, `:1446` `welcome::OpenRecentProject` (the macOS file has the same set). Strict `load_asset` on these files therefore fails at boot in the browser (3.23).
- `crates/settings/src/settings_file.rs:171-185` `watch_config_file(executor, fs, path) -> (UnboundedReceiver<String>, Task<()>)` — `fs.canonicalize(&path).await.unwrap_or_else(|_| path)` (`:178`; `WasmFs::canonicalize` returns `Err` for a missing file, b6 §4.1, so the raw path is used), then `fs.watch(&path, 100ms)`, then `fs.load(&path)`.
- `crates/settings/src/settings_store.rs:338` `pub fn observe_active_settings_profile_name(cx: &mut App) -> gpui::Subscription` (public); `:353-378` `SettingsStore::watch_settings_files(&mut self, fs, cx, settings_changed)` — after creating the two watchers it does `cx.foreground_executor().block_on(global_settings_file_rx.next())` and `block_on(user_settings_file_rx.next())` (`:370-377`), which does not compile on wasm (`executor.rs:444-445`); `:545-556` `pub async fn load_settings(fs) -> Result<String>` returns `crate::initial_user_settings_content().to_string()` on `NotFound` (not an empty string).
- `crates/project/src/project_settings.rs:971` `SettingsObserver::new_remote` (called from `crates/project/src/project.rs:1569` and `:1845`, i.e. by `Project::remote`) calls `Self::subscribe_to_global_task_file_changes(fs, paths::tasks_file(), cx)` at `:1013`; that function (`:1475-1482`) does `cx.foreground_executor().block_on(user_tasks_file_rx.next())` at `:1482` — the same wasm compile break on the remote-project boot path (3.17).
- `crates/keymap_editor/src/keymap_editor.rs:180` `KeymapEventChannel::trigger_keymap_changed(cx)`; `:1949` `impl Item for KeymapEditor` (a pane item, fine in one window); `:3739-3749` `collect_contexts_from_assets` reads `DEFAULT_KEYMAP_PATH`, `VIM_KEYMAP_PATH` and every `BaseKeymap::asset_path()`. Other users of the constants: `crates/editor/src/edit_prediction_tests.rs:920`, `crates/terminal_view/src/terminal_view.rs:2522` (tests).
- `script/check-keymaps:5-10` greps `cmd-` over `assets/keymaps/` excluding `default-macos.json`, `specific-overrides-macos.json` and `macos/*.json` (the new `web.json` carries `cmd-` chords for macOS hosts and must be added to that exclusion list, 3.3); `:18-26` rejects `super-|win-|fn-`.
- `crates/gpui/src/keymap/context.rs:30-46` `KeyContext::new_with_defaults()` sets an `os` key from `cfg!(target_os)` — `macos`, `linux`, `windows`, else `"unknown"`, which is what a wasm build gets; `assets/keymaps/vim.json:442, 448` are the only in-tree users (`os == windows` sections, dead on wasm). A keymap therefore cannot select the browser host OS with a context predicate today, which is why the single `web.json` of D12 carries both the `ctrl-` (Windows/Linux hosts) and `cmd-` (macOS hosts) chord families (4.6): on a given host only one family is reachable from the keyboard, and the `null` unbindings of the other family are no-ops because those chords are not bound in the same contexts on that host (verified against `default-macos.json` and `default-linux.json` in 4.6). A runtime `os` override in gpui would be a second upstream change and is a follow-up (section 7 item 24).
- Chords the web layer's alternatives collide with in the desktop files (4.6 discusses each): `default-linux.json:291, 524` `alt-w` → `search::ToggleWholeWord` (search-bar contexts, deeper than `Workspace`, so the search bar keeps it while focused); `:731-732` `alt-t` → `task::Rerun`, `alt-shift-t` → `task::Spawn` (`Workspace` context; the web layer, loaded last, overrides them on Linux/Windows hosts); `vim.json:511` `alt-n` → `editor::SelectNextSyntaxNode` (`Editor` context, deeper, so vim keeps it inside editors); `default-macos.json:87, 93` `ctrl-pageup`/`ctrl-pagedown` → `editor::LineUp`/`LineDown` (`Editor` context) and `vim.json:348-349, 416-417`, `default-linux.json:497-498` already bind them to `pane::ActivatePreviousItem`/`ActivateNextItem`.
- `assets/keymaps/`: `default-linux.json`, `default-macos.json`, `default-windows.json`, `vim.json`, `specific-overrides.json`, `specific-overrides-macos.json`, `initial.json`, `linux/`, `macos/`. Browser-reserved chords bound today — `default-linux.json:25` `ctrl-shift-w` → `workspace::CloseWindow`, `:35` `ctrl-q` → `zed::Quit`, `:502` `ctrl-w` → `pane::CloseActiveItem`, `:663` `ctrl-n` → `workspace::NewFile`, `:665` `ctrl-shift-n` → `workspace::NewWindow`, `:693` `ctrl-shift-t` → `pane::ReopenClosedItem`, `:699` `ctrl-t` → `project_symbols::Toggle`, `:701-702` `ctrl-shift-tab`/`ctrl-tab` → `tab_switcher::Toggle`, `:740` `ctrl-w` → `workspace::CloseActiveDock`, `:1287` terminal `ctrl-w` → `terminal::SendKeystroke`, `:1294` terminal `ctrl-shift-w` → `pane::CloseActiveItem`, `:1362` `ctrl-tab` → `pane::ActivateNextItem`; `default-macos.json:29` `cmd-shift-w` → `CloseWindow`, `:37` `cmd-q` → `zed::Quit`, `:38` `cmd-h` → `zed::Hide`, `:40` `cmd-m` → `zed::Minimize`, `:546` `cmd-w` → `pane::CloseActiveItem`, `:719` `cmd-shift-n` → `NewWindow`, `:746` `cmd-shift-t` → `ReopenClosedItem`, `:752` `cmd-t` → `project_symbols::Toggle`, `:754-755` `ctrl-shift-tab`/`ctrl-tab` → `tab_switcher::Toggle`, `:778` `cmd-w` → `CloseActiveDock`, `:785` `cmd-n` → `NewFile`, `:1330` `cmd-n` → `NewTerminal`, `:1448-1449` `ctrl-tab`/`ctrl-shift-tab` → pane item navigation, `:1557`, `:1716`, `:1726` `cmd-w` → `CloseWindow`.
- `crates/assets/src/assets.rs:10-24` `fs_embed!` of `fonts/**/*`, `icons/**/*`, `images/**/*`, `themes/**/*`, `sounds/**/*`, `prompts/**/*`, `*.md`; `:26-44` `impl AssetSource for Assets` (`:33-43` `list` iterates the embedded `Self::iter()`); `:48-62` `pub fn load_fonts(&self, cx: &App) -> Result<()>` — enumerates `self.list("fonts")` (the **embedded** set) and only the per-file byte load goes through `cx.asset_source()`, so with fonts removed from the wasm embed it finds nothing (3.14); `:64-70` `load_test_fonts`; dependents `editor`, `markdown`, `prompt_store`, `component_preview`, `zed`, `benchmarks` (none of `editor`, `markdown`, `prompt_store` calls `Assets::get`/`asset_str::<Assets>` directly — grep, section 8). `assets/fonts/ibm-plex-sans/*.ttf` (4), `assets/fonts/lilex/*.ttf` (4).
- `crates/util/src/util.rs:633-638` `asset_str::<A: RustEmbed>(path)`; `:737-755` `__fs_embed` under `feature = "debug-embed"` (always embeds); `:758-800` default arm: embeds only when `not(debug_assertions)`, otherwise `__fs_embed_get` (`:717-733`) reads from `dev_repo_root()` on the real filesystem — impossible on wasm, so wasm debug builds need `util/debug-embed` (`crates/util/Cargo.toml:20`).
- `crates/util/src/paths.rs:23-39` `pub fn home_dir()` is `#[cfg(not(target_family = "wasm"))]` (its `cfg(any(test, feature = "test-support"))` arm returns `/home/zed`); `crates/paths/src/paths.rs:8` `pub use util::paths::home_dir;` and `:138`, `:149`, `:173`, `:217` call it, so `paths` does not compile on wasm today. `paths.rs:122-141` `config_dir()` falls to `home_dir().join(".config").join(APP_NAME_LOWERCASE)` when no `target_os` matches; `:144-166` `data_dir()` (`:152-158` Linux `dirs::data_local_dir()`, `:163-165` the `config_dir().clone()` fallback that wasm takes); `:278-281` `settings_file()`; `:296-299` `keymap_file()`; `:103-119` `set_custom_data_dir` (uses `std::fs::create_dir_all` + `canonicalize`, unusable on wasm).
- `crates/fs/src/fs.rs:98` `pub trait Fs`; `:99` `create_dir`; `:132` `load`; `:136` `atomic_write(path, text)`; `:138` `write(path, bytes)`; `:139` `canonicalize`; `:149` `watch`; `:264` `<dyn Fs>::set_global`. b6 §4.1 implements all of them for `WasmFs`.

### 2.5 Remote open path, app state, database

- `crates/remote/src/remote_client.rs:349-352` `pub enum ConnectionIdentifier { Setup(u64), Workspace(i64) }`, `:357` `ConnectionIdentifier::setup()` (a process-local counter), `:359-375` `to_string(&self, cx)` builds the SSH socket name `setup-N`/`workspace-N` and needs `ReleaseChannel::global` — for the WebSocket transport the identifier only feeds `Hello.identifier`, which the server logs and never keys on (b1 §3.3 step 2, b1:408; b2:392, :908), so the RemoteClient of 3.28 uses `setup()` and the stable identity of D1 lives in `WebSocketConnectionOptions.workspace_id`; `:168-196` `enum State { Connecting, Connected, HeartbeatMissed, Reconnecting, ReconnectFailed, ReconnectExhausted, ServerNotRunning }` (`ReconnectExhausted` is D2's terminal state; `remote_connection()` at `:213-225` returns `None` there, which is why `last_close()` is read through the options snapshot); `:340-342` `pub enum RemoteClientEvent { Disconnected { server_not_running: bool }, Reconnected }` — `Disconnected` is emitted for both terminal states (`:934-942`, b4 §3.7); `:410-416` `RemoteClient::new(unique_identifier, remote_connection: Arc<dyn RemoteConnection>, cancellation: oneshot::Receiver<()>, delegate: Arc<dyn RemoteClientDelegate>, cx) -> Task<Result<Option<Entity<Self>>>>`; `:1001` `proto_client()`; `:1330-1336` `pub enum RemoteConnectionOptions { Ssh, Wsl, Docker, Mock }` (b1 adds `WebSocket(WebSocketConnectionOptions)`). `crates/remote/src/remote.rs:1-6` module list (`mod transport;` with `docker.rs`, `mock.rs`, `ssh.rs`, `wsl.rs`; b1 adds `websocket.rs`).
- `crates/project/src/project.rs:1171` `Project::init(client, cx)`; `:1413-1422` `Project::remote(remote: Entity<RemoteClient>, client, node: NodeRuntime, user_store, languages, fs, init_worktree_trust: bool, cx) -> Entity<Self>`; `:367` `Event::WorktreeAdded(WorktreeId)`, emitted at `:3937-3939` when the worktree **entity** is created (before its snapshot streams, and never when there are no paths).
- `crates/workspace/src/workspace.rs:855` `pub fn init(app_state, cx)`; `:1565-1571` `Workspace::new(workspace_id: Option<WorkspaceId>, project, app_state, window, cx)` — `:1610` `cx.subscribe_in(&project, window, ...)`, so two `Workspace`s on one `Project` double every project subscription; `:1266-1268` `AppState::set_global`; `:11099-11126` `pub fn open_remote_project_with_existing_connection(connection_options: RemoteConnectionOptions, project, paths, app_state, window: WindowHandle<MultiWorkspace>, provisional_project_group_key, source_workspace, cx: &mut AsyncApp) -> Task<Result<(Entity<Workspace>, Vec<Option<Box<dyn ItemHandle>>>)>>` (needs `connection_options` for `deserialize_remote_project`); `:11128-11241` `open_remote_project_inner` (creates a second `Workspace` with the persisted id at `:11162-11178` and calls `multi_workspace.activate(new_workspace, source_workspace, window, cx)` at `:11188`); `:11243-11262` `fn deserialize_remote_project(connection_options, paths, cx)` (private; `db.get_or_create_remote_connection(connection_options)`). `crates/workspace/src/multi_workspace.rs:341` `MultiWorkspace::new(workspace, window, cx)`; `:1310` `pub fn activate` — `hold`s (`:1328`) and pins the previously active workspace when multi-workspace is enabled, which is why a placeholder workspace lingers in the sidebar. b1 §3.12 adds `open_remote_project_in_new_window` precisely to avoid the placeholder.
- `crates/recent_projects/src/remote_connections.rs:128-134` `pub async fn open_remote_project(connection_options, paths, app_state, open_options, cx) -> Result<WindowHandle<MultiWorkspace>>`; `:207-241` opens the window with a placeholder `Project::local` (`:222-236`) + `Workspace::new(None, ...)` + `MultiWorkspace::new`; `:244-260` shows `RemoteConnectionModal` and calls `remote_connection::connect` (`crates/remote_connection/src/remote_connection.rs:706-712`).
- `crates/client/src/client.rs:558-562` `Client::new(clock, http: Arc<HttpClientWithUrl>, cx) -> Arc<Self>`; `:584-590` `Client::production(cx)` (uses `ClientSettings.server_url` and `cx.http_client()`); b6 adds `sign_in_supported()` after `:590`.
- `crates/release_channel/src/lib.rs:99-127` `AppVersion::load(pkg_version, build_id, commit_sha) -> Version`; `:161-164` `init(app_version, cx)`.
- `crates/theme_settings/src/theme_settings.rs:71-74` `init(themes_to_load: LoadThemes, cx)`; `crates/theme/src/theme.rs:108-114` `LoadThemes::{JustBase, All(Box<dyn AssetSource>)}`.
- `crates/languages/src/lib.rs:58-60` `init(languages, fs, node, cx)` registers native grammars under `load-grammars`; `crates/languages/Cargo.toml:12-19` `load-grammars` feature; `:62` `tree-sitter = { ..., features = ["wasm"] }` (BUILD-SPEC 3.2 shim decision, another brief).
- `crates/db/src/db.rs:37` `inventory::collect!(DomainMigration)`; `:41` `AppDatabase`; `:63-67` `AppDatabase::new()` via `gpui::block_on`; b4 §3.6 adds `pub async fn open_with_image(image: Option<Vec<u8>>) -> (Self, RestoreOutcome)`; b4 §3.7-3.8 add `ClientStateStore::new(&db, sink, loaded_version, outcome, cx)` and `workspace::client_state::{RemoteClientStateSink, load_client_state}`. `inventory` is also used by `crates/settings/src/settings_store.rs`, `crates/settings/src/keymap_file.rs`, `crates/gpui/src/action.rs` (static constructors must run on wasm; section 7).
- `crates/db/src/kvp.rs:15-17` `KeyValueStore::from_app_db(&AppDatabase)` (`Self(db.0.clone())`, the shape b4 §3.6a copies for `GlobalKeyValueStore::from_app_db`); `:23-38` `KeyValueStore`'s migration creates `kv_store` and `scoped_kv_store`, the table the folded global store reuses under namespace `"global"` (D7); `crates/session/src/session.rs:15-38` `Session::new(session_id, db).await` (Zed's own app-session UUID, unrelated to D1's `session_id`); `:70` `AppSession::new(session, cx)`.
- `crates/miniprofiler_ui/src/miniprofiler_ui.rs:1-6` `use std::{..., time::{Duration, Instant}}`; `:83` `pub fn init(startup_time: Instant, cx: &mut App)` — `std::time::Instant::now()` panics at runtime on `wasm32-unknown-unknown`, and the crate has no `web-time` dependency, so it is skipped in v0 (3.26 step 30).
- `crates/agent_settings/src/agent_settings.rs:27` `pub use crate::user_agents_md::{UserAgentsMd, UserAgentsMdState, init as init_user_agents_md};` — `init(fs, cx, on_change: impl Fn(&UserAgentsMdState, &mut App))`, the port target for `zed::watch_user_agents_md`.

### 2.6 Fork evidence (read-only)

- `zed-web/web/static/workspace.html`: single `<script type="module">` importing `./zed_web_workspace.js`, a `#boot` overlay removed after `await init()`, and a `globalThis.__zedOpenExternalUrl` hook.
- `zed-web/crates/zed_web_workspace/src/main.rs:55-118` `#[wasm_bindgen(inline_js = ...)] extern "C"` bridge (asset-pack fetch, URL sync, external URL); `:263-297` `load_web_assets` reads a tar into a `BTreeMap<String, Vec<u8>>`; `:300-343` `WebAssets: AssetSource` layered over `assets::Assets`; `:346-370` `web_window_options`; `:671-731` `load_keymaps` using `load_asset_allow_partial_failure` and a fork-only `settings::default_keymap_path()` (`zed-web/crates/settings/src/settings.rs:150-158`, backed by a fork-only `gpui::operating_system()`; upstream gpui has no such API); `:733-773` `watch_user_keymap`; `:1095-1156` `web_default_settings()` (JSON merge of overrides: `telemetry` off, `use_system_path_prompts: false`, `use_system_prompts: false`, dock defaults); `:1158-1176` `load_user_settings`; `:1178-1507` `init_app_state` (settings store → Fs → languages → `Client::new` → in-memory `AppDatabase` → session/stores → `NodeRuntime` → `languages::init` → `AppState` → `menu::init`, `zed_actions::init`, `release_channel::init` → `theme_settings::init` → `load_fonts` → `client::init` → `PlatformTitleBar::init` → editor/panels/tools inits → `language_models::init` → `agent_ui::init` → `settings_ui::init` → `keymap_editor::init` → keymaps → menus → `PaneSearchBarCallbacks` → theme observer); `:1509-1741` `install_workspace_chrome` (status bar mirror of `zed.rs:602-656`); `:1927-2032` `load_core_panels`; `:2105-2162` `#[wasm_bindgen(start)] main` (calls `globalThis.__zedCallCtors` first, comment at `:2107-2113` explains the wasm-bindgen threads transform skips `__wasm_call_ctors`); `:2164-2233` `launch` (`gpui_platform::web_init()`, `single_threaded_web().with_assets(..).run_embedded(..)`, `std::mem::forget(handle)`).
- `zed-web/crates/settings_ui/src/settings_ui.rs:440-460`: the fork gates the `OpenSettings`/`OpenSettingsAt`/`OpenSettingsPage` OS-window handlers with `cfg(not(target_family = "wasm"))` and the web entry crate registers its own in-window popup handlers (evidence for 3.7).
- `zed-web/web/build.sh:14` `wasm_bindgen_version="${WASM_BINDGEN_VERSION:-0.2.127}"` (the fork's lock resolves `wasm-bindgen 0.2.127`, `zed-web/Cargo.lock:21133-21134`; this workspace pins `0.2.120`); `:44` `export CARGO_TARGET_DIR`; `:45` `RUSTFLAGS` (`--cfg getrandom_backend="wasm_js"`, `+atomics,+bulk-memory,+mutable-globals`, `--shared-memory`, `--import-memory`, `--initial-memory=134217728`, `--max-memory=4294967296`, exports `__heap_base`, `__stack_pointer`, `__tls_size`, `__tls_align`, `__tls_base`, `__wasm_init_tls`, `__wasm_call_ctors`); `:47-51` wasi-sdk download + `CC_wasm32_unknown_unknown=<wasi-sdk>/bin/clang`, `CFLAGS_wasm32_unknown_unknown=-isystem <wasi-sdk>/share/wasi-sysroot/include/wasm32-wasi`; `:53-58` `rustup run nightly cargo build -p zed_web_workspace --target wasm32-unknown-unknown --profile web-release -Z build-std=std,panic_abort`; `:60-66` wasm-bindgen-cli version check; `:68-74` `wasm-bindgen --target web --no-typescript` + `scripts/patch-wasm-bindgen-memory.sh`; `:76-80` `tar -cf zed-assets.tar fonts icons images themes sounds prompts`. `zed-web/.cargo/config.toml` adds `[target.wasm32-unknown-unknown] rustflags = ["--cfg", "getrandom_backend=\"wasm_js\""]`. `zed-web/Cargo.toml:1104-1110` `[profile.web-release]` (`inherits = "release"`, `debug = false`, `strip = "symbols"`, `opt-level = "z"`, `lto = "thin"`, `codegen-units = 1`).
- `zed-web/web/scripts/patch-wasm-bindgen-memory.sh` rewrites the generated glue in three ways: the memory accessor falls back to `globalThis.__wbgSharedMemory` (and the shared memory the glue allocates is stashed there), `globalThis.__zedCallCtors` is added next to `wasm.__wbindgen_start(thread_stack_size)` to call `wasm.__wasm_call_ctors` once, and the cached `DataView` accessors are wrapped in `accessDataViewMemory0` which retries on `RangeError` after shared memory grows. `zed-web/web/README.md:269-274` says the patch "prevents normal startup from repeatedly growing shared memory" and that `test-patch-wasm-bindgen-memory.sh` must pass before the browser suite.

## 3. Change list

Dependency order: leaf gates first (each keeps native builds byte-identical), then the two async-first-load refactors, then workspace/build config, then `zed_web_core`, then the entry crate, then tooling and CI. `WASM` below abbreviates `cfg(target_family = "wasm")` and `NATIVE` abbreviates `cfg(not(target_family = "wasm"))`. Items owned by b1/b4/b5/b6 are cited, not restated.

### 3.1 `crates/util/src/paths.rs` (modify)

After line 39 add the wasm arm so `paths` compiles:

```rust
/// Browser builds have no home directory; every `paths::*` location resolves
/// under this fixed root, which the in-memory `WasmFs` populates at boot.
#[cfg(target_family = "wasm")]
pub fn home_dir() -> &'static PathBuf {
    static HOME_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    HOME_DIR.get_or_init(|| PathBuf::from("/home/web"))
}
```

`/home/web` is fixed by D11 (b6:30 now records the same value; it is deliberately distinct from the native test fixture root `/home/zed` at `util/paths.rs:29-36`, so browser paths never coincide with `FakeFs` fixtures; b6's `WasmFs` tests use `/home/web/...` literals). No change in `crates/paths/src/paths.rs`: `config_dir()` (`:138`) becomes `/home/web/.config/zed`, `data_dir()` (`:163-165`) falls back to it, `settings_file()`/`keymap_file()` (`:278-299`) resolve to `/home/web/.config/zed/settings.json` and `/home/web/.config/zed/keymap.json` — Zed's usual relative paths under the home directory, as D11 requires. `dirs` 6 compiles for wasm (2.3), so `paths` needs nothing else. `zed_web` must never call `set_custom_data_dir` (`:103-119`).

### 3.2 `crates/settings/src/settings.rs` and `crates/settings/src/base_keymap_setting.rs` (modify)

Add a runtime-OS variant of the compile-time keymap path selection so the browser can pick the host's keymap. Touches `settings.rs:144-171` and `base_keymap_setting.rs:98-125`; the existing constants and `asset_path()` stay and delegate.

```rust
// settings.rs, next to DEFAULT_KEYMAP_PATH (line 144)
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum KeymapOs { Mac, Windows, Linux }

impl KeymapOs {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") { Self::Mac }
        else if cfg!(target_os = "windows") { Self::Windows }
        else { Self::Linux }
    }
}

pub fn default_keymap_path_for(os: KeymapOs) -> &'static str {
    match os {
        KeymapOs::Mac => "keymaps/default-macos.json",
        KeymapOs::Windows => "keymaps/default-windows.json",
        KeymapOs::Linux => "keymaps/default-linux.json",
    }
}

pub fn specific_overrides_keymap_path_for(os: KeymapOs) -> &'static str {
    match os {
        KeymapOs::Mac => "keymaps/specific-overrides-macos.json",
        _ => "keymaps/specific-overrides.json",
    }
}

/// Browser-only layer that remaps the chords the browser reserves (Cmd/Ctrl+W, T, N, Q,
/// Shift+T, Ctrl+Tab; BUILD-SPEC 3.6, D12). One file for every host OS (2.4 explains why);
/// loaded by zed_web last, after vim and specific-overrides, and only on wasm.
pub const WEB_KEYMAP_PATH: &str = "keymaps/web.json";
```

(`web_keymap_path_for(os)` and a `web-macos.json` variant from an earlier revision are gone: D12 names one file, and 2.4 shows the two chord families coexist in it without loss.) `DEFAULT_KEYMAP_PATH` (`:144-150`) and `SPECIFIC_OVERRIDES_KEYMAP_PATH` (`:168-171`) keep their `cfg` definitions (they are `const` items used by tests). In `base_keymap_setting.rs` add

```rust
impl BaseKeymap {
    pub fn asset_path_for(&self, os: KeymapOs) -> Option<&'static str> { /* table of lines 98-125 keyed by os */ }
    pub fn asset_path(&self) -> Option<&'static str> { self.asset_path_for(KeymapOs::current()) }
}
```

replacing the two `cfg`-ed bodies at `:98-125` with one match on `os` (`TextMate` → `Some("keymaps/macos/textmate.json")` only for `Mac`, else `None`, preserving current behaviour).

### 3.2a `crates/ui/src/styles/platform.rs` (modify — the `PlatformStyle` runtime override D12 permits)

`PlatformStyle::platform()` (`:16-24`) is a `const fn` on `cfg!(target_os)` and returns `Mac` on wasm, so a Windows/Linux user in the browser would see ⌘/⌥ glyphs on every rendered key binding (`ui/src/components/keybinding.rs:100-527`, 2.1) and the macOS title-bar layout. Upstream-shaped change, wasm-only in effect:

```rust
#[cfg(target_family = "wasm")]
static PLATFORM_STYLE_OVERRIDE: std::sync::OnceLock<PlatformStyle> = std::sync::OnceLock::new();

impl PlatformStyle {
    /// Returns the [`PlatformStyle`] for the current platform.
    #[cfg(not(target_family = "wasm"))]
    pub const fn platform() -> Self { /* existing body, lines 17-23 */ }

    /// Browser builds report the host's style once `set_platform_style` has run (the entry
    /// crate calls it from the boot config before the first frame); `Mac` until then.
    #[cfg(target_family = "wasm")]
    pub fn platform() -> Self {
        PLATFORM_STYLE_OVERRIDE.get().copied().unwrap_or(Self::Mac)
    }

    /// Wasm only: install the host platform style. Idempotent; the first call wins.
    #[cfg(target_family = "wasm")]
    pub fn set_platform_style(style: PlatformStyle) { PLATFORM_STYLE_OVERRIDE.set(style).ok(); }
}
```

Native code is byte-identical (the `const fn` stays); every call site listed in 2.1 is a plain expression, so the non-`const` wasm arm compiles. `zed_web` calls `ui::PlatformStyle::set_platform_style(host_os.into())` (`HostOs::{Mac, Windows, Linux}` → `PlatformStyle::{Mac, Windows, Linux}`) in 3.26 step 2, before any window exists.

### 3.3 `assets/keymaps/web.json` (create) and `script/check-keymaps` (modify)

One JSONC keymap (same schema as `specific-overrides.json`), embedded through the existing `SettingsAssets` include `keymaps/*` (`settings.rs:125`). Contents in section 4.6. It is never loaded natively: `load_default_keymap` (`zed.rs:2355`) does not reference it. Because it carries the macOS-host chords (`cmd-q`, `cmd-h`, `cmd-m`, `cmd-shift-n`, `cmd-shift-]`, `cmd-shift-[`), `script/check-keymaps:8-10` gets `':(exclude)assets/keymaps/web.json'` added to the `cmd-` exclusion list; the `super-|win-|fn-` check (`:18-26`) still applies to it.

### 3.4 `crates/client` (no change in this brief — owned by b6 §3.8)

b6 §3.8 (b6:521-559) and its §5 block (b6:915-925) move `gpui_tokio`, `http_client_tls`, `proxy_handshake`, `tiny_http`, `tokio` into the NATIVE table, keep a feature-less `async-tungstenite` in `[dependencies]` (its `http` error types compile on wasm, so `EstablishConnectionError::{InvalidHeaderValue, Websocket}` at `client.rs:253/:257` and `impl From<WebsocketError>` at `:260-271` stay ungated), re-gate the TLS tables at `client/Cargo.toml:81-86` with `not(target_family = "wasm")` (the `:84-86` block is otherwise active on wasm because `target_os = "unknown"` there), gate `mod proxy;`, `authenticate_with_browser` (`:1430`) and `authenticate_as_admin` (`:1561-1607`, `Request::post` at `:1581`), add wasm twins that return `EstablishConnectionError::other(anyhow!(..))`, and add `Client::sign_in_supported()`. This brief consumes `sign_in_supported()` in 3.11 and lists the crates that must then be absent from the wasm closure in section 6 (`tokio`, `tokio-rustls`, `tokio-native-tls`, `tiny_http`, `gpui_tokio`, `http_client_tls`, `rustls-platform-verifier`, `aws-lc-sys`).

### 3.5 `crates/language_models/Cargo.toml`, `src/provider.rs`, `src/settings.rs`, `src/language_models.rs` (modify)

Cargo: move `:19-22` (`aws-config`, `aws-credential-types`, `aws-sigv4`, `aws_http_client`), `:24` `bedrock`, `:36` `extension_host`, `:41` `gpui_tokio`, `:64` `tokio` into `[target.'cfg(not(target_family = "wasm"))'.dependencies]` (exact lines in section 5). `copilot_chat`/`copilot_ui` (`:31-32`) stay.

- `provider.rs:8` → `#[cfg(not(target_family = "wasm"))] pub mod bedrock;`
- `settings.rs:6-14` import: drop `bedrock, bedrock::AmazonBedrockSettings` from the shared `use` and add `#[cfg(not(target_family = "wasm"))] use crate::provider::bedrock::{self, AmazonBedrockSettings};`; `:20` → `#[cfg(not(target_family = "wasm"))] pub bedrock: AmazonBedrockSettings,`; `:54` and `:96-112` wrapped in `#[cfg(not(target_family = "wasm"))]` (the struct-literal field initializer gets the attribute, which also covers `bedrock::RESERVED_HEADER_NAMES` at `:102`; `let bedrock = ...` at `:54` gets it too). `settings_content` keeps its `bedrock` field, so user JSON still parses; `RegisterSetting` (`settings_macros.rs:85-105`) only names the type, so the cfg-ed field is safe.
- `language_models.rs:19` import NATIVE; `:296-302` `registry.register_provider(Arc::new(BedrockLanguageModelProvider::new(...)))` wrapped in `#[cfg(not(target_family = "wasm"))]`; `:50-103` extension-store block (the whole `if let Some(extension_store) = ...` statement, which closes at `:103`) wrapped in `#[cfg(not(target_family = "wasm"))]` (extension-provided model providers arrive via the b4 `RemoteExtensionStore` later; on wasm the registry simply has no extension providers).

`init` signature is unchanged: `pub fn init(user_store: Entity<UserStore>, client: Arc<Client>, cx: &mut App)`.

### 3.6 `crates/agent_ui/Cargo.toml`, `src/agent_panel.rs`, `src/agent_configuration/configure_context_server_modal.rs` (modify)

Cargo: `:54` `extension_host` and `:62` `gpui_tokio` → `[target.'cfg(not(target_family = "wasm"))'.dependencies]`. The `audio` feature (`:25`, `:40`) is untouched here; 3.13 stops `sidebar` from enabling it on wasm.

- `agent_panel.rs:71` NATIVE import; `:1529-1535` becomes

```rust
#[cfg(not(target_family = "wasm"))]
let extension_subscription = ExtensionStore::try_global(cx).map(|store| { /* unchanged body */ });
#[cfg(target_family = "wasm")]
let extension_subscription: Option<Subscription> = None;
```

(`:1174` field and `:1588` initializer unchanged.)
- `configure_context_server_modal.rs:6` NATIVE import; `:381-386` becomes

```rust
#[cfg(not(target_family = "wasm"))]
let extension = ExtensionStore::global(cx).read(cx).installed_extensions().iter()
    .find(|(_, entry)| entry.manifest.context_servers.contains_key(&id.0))
    .map(|(id, entry)| (id.clone(), entry.manifest.clone()));
#[cfg(target_family = "wasm")]
let extension: Option<(Arc<str>, Arc<extension::ExtensionManifest>)> = None;
```

(`extension` is already a dependency at `Cargo.toml:53`.)
- The two pop-out windows (`agent_panel.rs:2726`, `conversation_view.rs:3007`) are left as they are: `cx.open_window` returns `Err(WebWindowError::AlreadyOpen)` in the browser and both sites already handle `Err` (`let Ok(..) = ... else`, `.log_err()`); they stay reachable from the command palette until a follow-up hides them (section 7).

### 3.7 `crates/settings_ui/Cargo.toml`, `src/pages/mcp_servers_page.rs`, `src/pages.rs`, `src/pages/audio_web.rs` (new), `src/settings_ui.rs`, `src/page_data.rs` (modify + create)

Cargo: `:37` `extension_host`, `:23` `audio`, `:32` `cpal`, `:57` `rodio` → NATIVE target block.

`mcp_servers_page.rs`:

- `:6` NATIVE import.
- `:254-268` `resolve_extension_display_name`: keep the native body; add `#[cfg(target_family = "wasm")] fn resolve_extension_display_name(_: &ContextServerId, _: &App) -> Option<SharedString> { None }`.
- `:655-665` `resolve_extension_for_context_server`: same pattern returning `None`.
- `:638-640` (`ExtensionStore::global(cx).update(.. uninstall_extension ..)`) wrapped in `#[cfg(not(target_family = "wasm"))]`; the enclosing `if let Some((ext_id, manifest))` (`:634-642`) stays — `manifest` is still used at `:637` on both targets, only `ext_id` becomes unused on wasm, so add `#[cfg(target_family = "wasm")] let _ = &ext_id;` inside the inner block.

Audio pages (the `cpal`/`rodio` edge):

- `pages.rs:1-2` → `#[cfg(not(target_family = "wasm"))] mod audio_input_output_setup;` and `#[cfg(not(target_family = "wasm"))] mod audio_test_window;`, plus `#[cfg(target_family = "wasm")] mod audio_web;`.
- `pages.rs:13-16` → the three re-exports come from the native modules under NATIVE and from `audio_web` under WASM.
- `pages/audio_web.rs` (new): `render_input_audio_device_dropdown` / `render_output_audio_device_dropdown` with the same signatures as `audio_input_output_setup.rs` returning a disabled `Label::new("Audio devices are not available in the browser")`, and `pub(crate) fn open_audio_test_window(_: &mut Window, _: &mut App) {}` with the native signature.
- `settings_ui.rs:61-62` (import) and `:674-675` (`add_basic_renderer::<settings::AudioInputDeviceName>` / `AudioOutputDeviceName`) and `page_data.rs:16` (import) / `:8288` (`open_audio_test_window(window, cx)`) compile unchanged against the stubs.

Second-window actions (`gpui_web` refuses a second `open_window`, 2.3):

- `settings_ui.rs:455` `cx.on_action(|_: &OpenSettings, cx| ...)` and the workspace `register_action`s at `:468` (`OpenSettingsAt`), `:477` (`OpenSettingsPage`), `:486` (`OpenSettings`) get `#[cfg(not(target_family = "wasm"))]` (the fork did exactly this, `zed-web/crates/settings_ui/src/settings_ui.rs:440-460`). `open_settings_editor_with` (`:844-926`) itself stays compiled on both targets.
- The wasm handlers are registered by `zed_web::workspace_chrome` (3.29): they build the same `SettingsWindow` entity that `open_settings_editor_with` builds inside `cx.open_window` (`:889-926`; make its constructor `pub` if it is not) and host it in a full-canvas modal through `Workspace::toggle_modal` with a thin `ModalView` wrapper. The wrapper's exact shape is an implementation detail; the contract is that `OpenSettings`, `OpenSettingsAt` and `OpenSettingsPage` work in the browser without a second window.

### 3.8 `crates/recent_projects/Cargo.toml`, `src/recent_projects.rs`, `src/remote_servers.rs` (modify)

Cargo: `:24` `dev_container` and `:26` `extension_host` → NATIVE target block.

`recent_projects.rs`: `:1` `#[cfg(not(target_family = "wasm"))] mod dev_container_suggest;`; `:41` NATIVE import; `:506-540` (`OpenDevContainer` handler) and `:543-570` (suggest observer) each wrapped in `#[cfg(not(target_family = "wasm"))] { ... }` blocks. `zed_actions::OpenDevContainer` stays importable (no gate in `zed_actions`), so the wasm build simply has no handler. `:504` `cx.observe_new(DisconnectedOverlay::register).detach();` → NATIVE (and `:24` import NATIVE): in the browser the terminal-disconnect UI belongs to the shell page, which reads the close code (3.28) — the in-canvas overlay's "Reconnect" would re-dial with the options snapshot and take a session back after a 4001 (b1 §7 item 6).

`remote_servers.rs` — gate the dev-container mode as a unit:

- `:10-13` and `:15` imports NATIVE.
- `:66` field `dev_container_picker` NATIVE; `:1543` initializer NATIVE.
- `:94-99`, `:101-105`, `:107-…` (`DevContainerCreationProgress`, `CreateRemoteDevContainer`, its `impl`), `:181-186` (`struct DevContainerPickerDelegate`), `:187` (`impl DevContainerPickerDelegate`), `:201` (`impl PickerDelegate for DevContainerPickerDelegate`): NATIVE.
- `:798` `Mode::CreateRemoteDevContainer(CreateRemoteDevContainer)` → `#[cfg(not(target_family = "wasm"))]` on the variant (same style as `:799-800` `AddWslDistro`); match arms at `:1893`, `:1931`, `:3102` get the same attribute.
- `:1426-1460` `new_dev_container`, `:1765` `view_in_progress_dev_container`, `:2141` `edit_in_dev_container_json`, `:2201` `init_dev_container_mode` (writes `self.dev_container_picker` at `:2209`), `:2234-2320` `open_dev_container`, `:2321` `render_create_dev_container`, `:2456-2470` `render_config_selection` (reads `self.dev_container_picker` at `:2461`; only called from `render_create_dev_container` at `:2416`): NATIVE. Call sites `:262`, `:273-274`, `:1158` sit inside code paths reachable only from the gated variants; wrap each call site in `#[cfg(not(target_family = "wasm"))]` as well (they are single statements).

Result: `ExtensionStore` (`:2276`) is gone with `open_dev_container`, and no ungated function references the gated field.

### 3.9 `crates/remote_connection/Cargo.toml` and `src/remote_connection.rs` (modify)

Cargo: `:21` `auto_update` → NATIVE target block.

- `:5` NATIVE import.
- In both delegate impls (`:462` and `:639`), keep the two method signatures and gate the bodies:

```rust
fn download_server_binary_locally(&self, platform: RemotePlatform, release_channel: ReleaseChannel,
    version: Option<Version>, cx: &mut AsyncApp) -> Task<anyhow::Result<PathBuf>> {
    #[cfg(not(target_family = "wasm"))]
    { /* existing body, lines 495-517 / 662-683 */ }
    #[cfg(target_family = "wasm")]
    { let _ = (platform, release_channel, version, cx);
      Task::ready(Err(anyhow::anyhow!("the remote server is provisioned by the sandbox; nothing to download"))) }
}
fn get_download_url(&self, platform: RemotePlatform, release_channel: ReleaseChannel,
    version: Option<Version>, cx: &mut AsyncApp) -> Task<Result<Option<String>>> {
    #[cfg(not(target_family = "wasm"))]
    { /* existing body, lines 527-536 / 693-702 */ }
    #[cfg(target_family = "wasm")]
    { let _ = (platform, release_channel, version, cx); Task::ready(Ok(None)) }
}
```

### 3.10 `crates/activity_indicator/Cargo.toml` and `src/activity_indicator.rs` (modify)

Cargo: `:20` `auto_update`, `:22` `extension_host` → NATIVE target block. Source (all nine use lines, 2.1):

- `:1` → `#[cfg(not(target_family = "wasm"))] use auto_update::DismissMessage;` plus `#[cfg(target_family = "wasm")] gpui::actions!(auto_update, [DismissMessage]);` — the local action has the same fully-qualified name `auto_update::DismissMessage`, so a user keymap binding keeps working and there is no double registration (`auto_update` is not compiled on wasm). `:328` (handler), `:561` and `:586` (click handlers) then compile unchanged on both targets.
- `:3` NATIVE import; the `if let Some(extension_store) = ExtensionStore::try_global(cx).map(..)` statement at `:678-691` (the only use of `ExtensionStore`/`ExtensionOperation`) wrapped in `#[cfg(not(target_family = "wasm"))]` — on wasm the indicator simply reports no extension activity.
- `:23` `time::{Duration, Instant}` → `time::Duration` plus `use web_time::Instant;` (identical type natively); `:477` `Instant::now() - job_info.start` and `:489` `Instant::now().duration_since(fs_job.start)` then compile unchanged against `fs::JobInfo.start`, which b6 §3.2 (line 156) makes `web_time::Instant` on wasm (b6 §7 item 5 assigns this swap here). Cargo: add `web-time.workspace = true` to `[dependencies]` (section 5).

The status-bar item itself stays (LSP download/indexing progress comes from the remote project and is wanted on the web).

### 3.11 `crates/title_bar/Cargo.toml`, `src/title_bar.rs`, `src/collab.rs`, `src/update_version.rs`, plus `src/collab_web.rs` and `src/update_version_web.rs` (modify + create)

Cargo: `:34` `auto_update`, `:37` `call`, `:38` `channel`, `:48` `livekit_client` → NATIVE target block; `:46` becomes `gpui.workspace = true` and the NATIVE table adds `gpui = { workspace = true, features = ["screen-capture"] }` (the feature is only needed by `collab.rs`; features declared in a target table are merged on that target only). `:19` `"call/test-support"` stays as-is (Cargo accepts a `dep/feature` entry for a target-specific dependency and ignores it where the dependency is inactive; verified, section 8). `:50` `recent_projects` and `:52` `remote_connection` stay (non-collab uses at `title_bar.rs:40`, `:614-660`, `:664`, `:848`, `:900`), so those crates and `askpass` remain in the closure and must compile on wasm (section 7).

`title_bar.rs`:

- `:2` → `#[cfg(not(target_family = "wasm"))] pub mod collab;` and `#[cfg(target_family = "wasm")] #[path = "collab_web.rs"] pub mod collab;`
- `:6` → same pattern with `update_version_web.rs`.
- `:24-25` imports NATIVE.
- `:222` `_diagnostics_subscription: Option<gpui::Subscription>` stays; `:462` and `:485` (`ActiveCall::global` + observe) NATIVE; `:1116-1132` `active_call_changed`/`observe_diagnostics` NATIVE, with a wasm `fn observe_diagnostics(&mut self, _: &mut Context<Self>) {}` so the call at `:539` (`this.observe_diagnostics(cx)`) compiles.
- `:1134-1148` `share_project`/`unshare_project` NATIVE (only `collab.rs` calls them).
- `:389-390`: the sign-in button is rendered only when `self.client.sign_in_supported()` (b6 §4.6) in addition to the existing condition, so the browser shows no "Sign In" (BUILD-SPEC 3.2 "sign-in disabled").
- `:1167-1194` the `UpgradeRequired` arm: NATIVE body; wasm arm returns `Empty` (the "Please update Zed to Collaborate" button is meaningless in a browser tab whose build is pinned by the shell).
- `:128-137` `SimulateUpdateAvailable` handler stays (the web stub's `update_simulation` is a no-op).
- `client::Status::ReconnectionError { next_reconnection }` becomes `web_time::Instant` on wasm (b6 §3.8, §7 item 5); `title_bar.rs:1160` matches it with `{ .. }` and never reads the field, so no change here.

`src/collab_web.rs` (new):

```rust
use gpui::{AnyElement, Empty, IntoElement, Window};
use ui::prelude::*;
use crate::TitleBar;

impl TitleBar {
    pub(crate) fn render_collaborator_list(&self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement { Empty }
    pub(crate) fn render_call_controls(&self, _: &mut Window, _: &mut Context<Self>) -> AnyElement { Empty.into_any_element() }
}
```

`src/update_version_web.rs` (new):

```rust
use gpui::{Context, Empty, IntoElement, Render, Window};

pub struct UpdateVersion;
impl UpdateVersion {
    pub fn new(_: &mut Context<Self>) -> Self { Self }
    pub fn update_simulation(&mut self, _: &mut Context<Self>) {}
    pub fn show_update_in_menu_bar(&self) -> bool { false }
}
impl Render for UpdateVersion {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement { Empty }
}
```

`collab.rs` and `update_version.rs` are untouched (they are simply not compiled on wasm).

### 3.12 `crates/git_ui` (no change)

The `call` feature already gates every use (`git_panel.rs:1151`, `:4770-4828`, `:8932-8947`). `zed_web` depends on `git_ui` without features (section 5); nothing in the browser set enables `git_ui/call`.

### 3.13 `crates/sidebar/Cargo.toml` (modify) and `crates/workspace` (no change in this brief)

`sidebar/Cargo.toml:24` `agent_ui = { workspace = true, features = ["audio"] }` → `agent_ui.workspace = true` in `[dependencies]` plus `agent_ui = { workspace = true, features = ["audio"] }` in a new `[target.'cfg(not(target_family = "wasm"))'.dependencies]` table. `agent_ui`'s own `#[cfg(feature = "audio")]` sites (`agent_panel.rs:64`, `:2664`, `:2936`) already compile without the feature, and `zed` keeps enabling it (`zed/Cargo.toml:80`), so desktop is unchanged and `audio`/`cpal`/`rodio` leave the browser closure together with 3.7.

`workspace`: `AppState.node_runtime` (`workspace.rs:1202`) is constructed as `NodeRuntime::unavailable()` by `zed_web`. Gating `Workspace::new_local` (`:1989`), `open_workspace_by_id` (`:10650`), `open_paths` (`:10765`), `open_new` (`:10964`), `create_and_open_local_file` (`:10991`) is the workspace leaf brief (BUILD-SPEC 3.2 "gate node_runtime and local file opens"); the entry crate never calls them. `open_remote_project_in_new_window_with_client` comes from b1 §3.12 (D16); `workspace::client_state::{snapshot_unsaved_buffers, restore_unsaved_buffers}` from b4 §3.8 (D6).

### 3.14 `crates/assets/src/assets.rs` (modify)

Split the embed so the wasm binary carries only what the tarball does not (BUILD-SPEC 3.5 ships fonts/icons/themes/sounds in the tarball). Replace `:10-24` with two invocations:

```rust
#[cfg(not(target_family = "wasm"))]
util::fs_embed! { pub struct Assets, crate_relative = "../../assets", root_relative = "assets",
    include = ["fonts/**/*", "icons/**/*", "images/**/*", "themes/**/*", "sounds/**/*", "prompts/**/*", "*.md"],
    exclude = ["themes/src/*", "*.DS_Store"] }

#[cfg(target_family = "wasm")]
util::fs_embed! { pub struct Assets, crate_relative = "../../assets", root_relative = "assets",
    include = ["prompts/**/*", "*.md"],
    exclude = ["*.DS_Store"] }
```

`Assets::load_fonts` (`:48-62`) is left as is but is **not** called on wasm: it enumerates `self.list("fonts")`, i.e. the embedded `Assets::iter()` set, and only the per-file byte load goes through `cx.asset_source()`, so after this split it would find zero fonts. The browser loads fonts through `WebAssets::load_fonts` (3.22), which enumerates the tarball. `load_test_fonts` (`:64-70`) is only used by native tests.

### 3.15 Workspace `Cargo.toml` (modify)

- Add members `"crates/zed_web"` and `"crates/zed_web_core"` in the alphabetical members list (near `:97`/`:101`).
- Add `[profile.web-release]` after `[profile.release.package]` (`:1088-1089`) — section 5.
- Add `tar = { version = "0.4", default-features = false }` to `[workspace.dependencies]` (sync tar reader for the asset pack; compiles for wasm32-unknown-unknown, 2.3; fork evidence `zed-web/crates/zed_web_workspace/Cargo.toml` `tar = "0.4"`).
- Add `zed_web_core = { path = "crates/zed_web_core" }` to `[workspace.dependencies]`.

### 3.16 `.cargo/config.toml` (modify — one line on top of b5)

b5 §3 item 2 owns the `[target.wasm32-unknown-unknown] rustflags` block (which repeats `-C symbol-mangling-version=v0` and `--cfg tokio_unstable` because a target table replaces `[build].rustflags`, and adds `getrandom_backend`, atomics, shared/imported memory, the 128 MiB / 4 GiB limits and the TLS exports) and the `[env]` C-toolchain entries. This brief adds exactly one flag to that list:

```toml
    "-C", "link-arg=--export=__wasm_call_ctors",
```

so the loader can run static constructors (3.30, section 7 item 3). b5 §3 item 2 (b5:135) and b5 §2 (b5:21) record this line as b7-owned so it is not dropped when the block is edited. The fork additionally exported `__heap_base` and `__stack_pointer` (`zed-web/web/build.sh:45`); they are not carried unless the wasm-bindgen memory patch (3.31 step 4b) proves to need them in the first bundle. No `[unstable] build-std` in config (b5's `script/check-wasm` passes `-Zbuild-std`), and `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS` is never set (`script/check-wasm` exits 2 if it is, b5:170-175).

### 3.17 `crates/settings/src/settings_store.rs` and `crates/project/src/project_settings.rs` (modify — async first load on wasm)

Both use `ForegroundExecutor::block_on`, which is `cfg(not(target_family = "wasm"))` (`executor.rs:444-445`); native behaviour is unchanged.

- `settings_store.rs:370-380` (`watch_settings_files`): wrap the two `block_on` calls and the synchronous first `set_global_settings`/`set_user_settings` + `settings_changed` calls in `#[cfg(not(target_family = "wasm"))] { ... }`. The spawned loop that follows already applies every received document with the same calls, so on wasm the initial contents (the first message `watch_config_file` sends, `settings_file.rs:182-185`) are applied on its first iteration. `zed_web` does not rely on that timing: 3.24 calls `store.set_user_settings(&settings_json, cx)` synchronously before starting the watcher, since the shell already supplies the document.
- `project_settings.rs:1482` (`subscribe_to_global_task_file_changes`, reached from `new_remote` at `:1013`, i.e. `Project::remote`): replace `let user_tasks_content = cx.foreground_executor().block_on(user_tasks_file_rx.next());` with

```rust
#[cfg(not(target_family = "wasm"))]
let initial = Some(cx.foreground_executor().block_on(user_tasks_file_rx.next()));
#[cfg(target_family = "wasm")]
let initial: Option<Option<String>> = None;
cx.spawn(async move |settings_observer, cx| {
    let _watcher_task = watcher_task;
    let user_tasks_content = match initial { Some(c) => c, None => user_tasks_file_rx.next().await };
    /* existing body from :1484 on, unchanged */
})
```

On wasm the global `tasks.json` is applied on the first tick instead of synchronously; nothing on the boot path reads it before that.

### 3.18 `crates/zed_web_core` (create) — host-testable boot logic

An `rlib` that compiles on both targets with only pure dependencies (`anyhow`, `serde`, `serde_json`, `serde_json_lenient`, `tar`, `collections`) so `cargo test -p zed_web_core` runs on the host; `zed_web` re-exports it. Modules and signatures:

```rust
// boot_config.rs — section 4.1 types (serde only, no JS)
pub fn parse_boot_config(json: &str) -> anyhow::Result<BootConfig>;

// asset_pack.rs — in-memory tarball
pub struct AssetPack { files: BTreeMap<String, Vec<u8>> }
impl AssetPack {
    /// Entries are files only, "./" stripped. Rejects absolute paths, any ".." component,
    /// more than 8192 entries or more than 64 MiB total (defense in depth; the pack is
    /// same-origin and content-hashed, BUILD-SPEC 3.5).
    pub fn from_tar(bytes: &[u8]) -> anyhow::Result<Self>;   // tar::Archive<Cursor<&[u8]>>::entries()
    pub fn get(&self, path: &str) -> Option<&[u8]>;
    pub fn list(&self, prefix: &str) -> Vec<String>;
    pub fn len(&self) -> usize;
}

// host_os.rs
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum HostOs { Mac, Windows, Linux }
impl HostOs {
    pub fn from_override(s: &str) -> Option<Self>;                        // "mac" | "windows" | "linux"
    pub fn from_platform(platform: &str, user_agent: &str) -> Self;       // same heuristic as gpui_web/src/events.rs:1294-1309
}

// web_settings.rs
pub const WEB_SETTINGS_OVERRIDES: &str = /* section 4.5 */;
/// Deep-merges WEB_SETTINGS_OVERRIDES over `base_json` (both JSONC via serde_json_lenient).
pub fn merge_web_defaults(base_json: &str) -> anyhow::Result<String>;
```

### 3.19 `crates/zed_web/Cargo.toml` (create)

Full manifest in section 5. It follows the `gpui_web` pattern (`gpui_web/Cargo.toml:18`, `gpui_web.rs:1`): every dependency except `zed_web_core` lives in `[target.'cfg(target_family = "wasm")'.dependencies]` and the crate root is `#![cfg(target_family = "wasm")]`, so `cargo check --workspace`, `script/clippy` and `cargo shear` on native see an empty crate.

### 3.20 `crates/zed_web/src/zed_web.rs` (create) — crate root and wasm-bindgen exports

```rust
#![cfg(target_family = "wasm")]

mod assets;        // WebAssets: AssetPack-backed AssetSource layered over assets::Assets
mod boot;          // async boot sequence (3.27)
mod bridge;        // JS <-> Rust: JsHost, progress, JsSessionRefresh, save-back, lifecycle
mod connect;       // dial, RemoteClient, state observation, open the workspace (3.28)
mod init;          // registry/panel/action init in desktop order (3.26)
mod keymap;        // web layer, keymap reload loop (3.23)
mod settings;      // seed WasmFs from JSON, web defaults, save-back (3.24)
mod window;        // build_window_options for the web (3.25)
mod workspace_chrome; // status bar, pane toolbar, panels, actions (3.29)

pub use zed_web_core::{BootConfig, BootError, BootStage, ConnectInfo, HostOs};
use wasm_bindgen::prelude::*;

/// Entry point called by the shell page after `init()`. Single-shot: a second call rejects.
/// Resolves once the workspace window is open and the remote project has opened its paths
/// (3.27 step 3g), or rejects with a `BootError` object `{ code, message }` (4.1).
#[wasm_bindgen]
pub async fn start(config_json: String, assets: js_sys::Uint8Array, host: JsValue) -> Result<(), JsValue> {
    gpui_platform::web_init();                                   // gpui_platform.rs:51
    let config = zed_web_core::parse_boot_config(&config_json).map_err(bridge::boot_error("bad_config"))?;
    let host = bridge::JsHost::from_js(host).map_err(bridge::boot_error("bad_host"))?;
    boot::run(config, assets.to_vec(), host).await.map_err(bridge::js_error)
}

/// Flush the client SQLite image now (shell calls it on `visibilitychange` → hidden and on
/// `pagehide`; best-effort on `pagehide`, b4 §3.8).
#[wasm_bindgen]
pub async fn flush_client_state() -> Result<(), JsValue> { boot::flush_client_state().await.map_err(bridge::js_error) }

/// `document.hidden` changed; shortens/restores the ClientStateStore interval (b4 `set_interval`).
#[wasm_bindgen]
pub fn set_hidden(hidden: bool) { boot::set_hidden(hidden) }

/// For the loader's `beforeunload` guard (BUILD-SPEC 13 "stop with unsaved buffers").
#[wasm_bindgen]
pub fn has_unsaved_changes() -> bool { boot::has_unsaved_changes() }

/// Build identity baked at compile time (`ZS_BUILD_ID`, BUILD-SPEC 11.2), for the shell's version check.
#[wasm_bindgen]
pub fn build_id() -> String { option_env!("ZS_BUILD_ID").unwrap_or("dev").to_string() }
```

`assets` is passed as a separate `Uint8Array` (copied once with `to_vec()`) rather than as a property of a config object, so the 6.5 MB pack is never run through `JSON.stringify`. Design note: no `#[wasm_bindgen(start)]`; the shell controls when boot begins so it can fetch connect info, assets and documents in parallel (BUILD-SPEC 3.4 step 2).

`crates/zed_web/build.rs` (create): copy of `crates/remote_server/build.rs:1-16` — `ZED_PKG_VERSION` from `crates/zed/Cargo.toml` via `cargo_toml`/`toml` build-deps, so the reported Zed version never drifts from the desktop crate (BUILD-SPEC 11.2).

### 3.21 `crates/zed_web/src/bridge.rs` (create)

Types in section 4.1-4.3. Responsibilities:

- `JsHost::from_js(JsValue)`: reads the five required `js_sys::Function`s (`bootProgress`, `refreshConnectInfo`, `saveDocument`, `reportError`, `onLifecycle`) plus the optional `onClosed` (b9 §4.6; absent → `None`), and stores them in a `thread_local! static HOST: RefCell<Option<JsHost>>` (JS values are main-thread only; every caller below runs on the GPUI foreground executor, which is the main thread — `dispatcher.rs:145-152`).
- `progress(stage: BootStage, detail: &str)` → `host.boot_progress.call2(stage.as_str(), detail)`; `ready_once()` emits `Ready` at most once per connection episode.
- `struct JsSessionRefresh; impl remote::WebSocketSessionRefresh for JsSessionRefresh` (b1 §3.3/§4.1 as amended by D1/D2): `fn refresh(&self, workspace_id: &str, reason: RefreshReason, cx: &mut AsyncApp) -> Task<Result<WebSocketSession, RefreshError>>` does `cx.spawn(async move |_| { ... })` on the foreground executor: calls `refreshConnectInfo()`, awaits the promise with `wasm_bindgen_futures::JsFuture`, converts the object with `ConnectInfo::from_js`, stores it in `thread_local! SESSION: RefCell<Option<ConnectInfo>>`, and returns `WebSocketSession { url: ws_url, token, session_id }` — the per-connect `session_id` is informational (telemetry, logs, `Hello.session_id`) and never an identity (D1); the `workspace_id` argument is ignored because the host already knows its workspace. A rejection whose object has `code === "unauthorized"` maps to `RefreshError::Unauthorized` (terminal; b1 synthesizes `CloseInfo{4003}`), `code === "stopped"` (b9's `409 workspace_stopped`) maps to `RefreshError::Stopped` (terminal, short-circuits the retry budget at once, D2), anything else to `RefreshError::Other` (retried up to the budget). The last terminal refresh error is remembered in `thread_local! LAST_REFRESH_ERROR` so `connect::observe` (3.28) can name `workspace_stopped`/`unauthorized` regardless of the close code b1 synthesizes. Because b1 hands `refresh` an `AsyncApp`, no channel pump and no `Send + Sync` wrapper around JS values is needed.
- `current_session() -> Option<ConnectInfo>` (latest `{ws_url, token, session_id, session_expires_at}`) for HTTPS calls to the sandbox made by later briefs — `/files` (b2 §3.6) and `/extensions/{id}/assets/*` (b2/b4); those are cross-origin fetches from the shell origin, so they rely on b2's CORS from `--allowed-origin` = `manifest.allowedOrigins` (D5) and on b9's `connect-src https://*.vercel.run` (b9 §4.9), nothing on this side. Port forwarding is not an HTTP call from the client: it is proto (`ForwardPort`, b4 §3.16) and the forward `url` is the control plane's `/open` link opened as a top-level navigation (D8). `ensure_fresh_token(cx) -> Task<Result<()>>` refreshes through `JsSessionRefresh` when `session_expires_at` is within 60 s (BUILD-SPEC 4.3). The token is never exported to the shell (BUILD-SPEC 10 item 3).
- `save_document(kind: DocumentKind, json: String) -> impl Future<Output = Result<()>>`; `lifecycle(kind: project::lifecycle::LifecycleKind, seconds: u32)` → `host.on_lifecycle.call2(kind.as_str(), seconds)` with b4 §3.16's snake_case tags (`"idle_stop_in" | "session_cap_in" | "stopping" | "resumed"`; the shell renders toasts and posts keep-alive, b4 §3.16 / b9); `on_closed(code: u16, reason: &str)` → `host.on_closed.call1({ code, reason })` when the host supplied it (b9 §4.6; emitted by `connect::observe` on every terminal `Disconnected` next to the `Stopped` progress event, so the shell can branch on the raw code without parsing `detail`); `report_error(kind: &str, message: &str, stack: &str)`.
- Host additions b9 §4.6/§7 item 6 asked for and this brief does **not** take: `keepAlive`/`stop` (no wasm-side caller in v0 — the "Keep alive" and Stop affordances live in the shell, BUILD-SPEC 7.6), `setDirty` (the loader's `beforeunload` handler calls the synchronous `has_unsaved_changes()` export instead, 3.20/3.30), `onExtensionsChanged` (installed-extension reporting goes supervisor → control plane per D18/D19, and `extensions_ui` is not wired on wasm in v0), `openExternal` (`gpui_web` already opens URLs with `window.open`, `platform.rs:440-444`; intercepting `cx.open_url` would need a gpui hook that does not exist).
- Panic hook (installed in `boot::run` step 1): chains `console_error_panic_hook` (already installed by `web_init`) rather than replacing it; on the main thread (`wasm_thread::is_main_thread()`) it calls `report_error("panic", ..)` directly; on a `wasm_thread` worker (parsing, search) JS host values are unreachable, so it writes to `console.error` and sets an `AtomicBool` that the main thread reports on its next foreground tick.
- `boot_error(code) -> impl Fn(anyhow::Error) -> JsValue` and `js_error(BootError) -> JsValue` build the `{ code, message }` object the shell branches on (4.1).

### 3.22 `crates/zed_web/src/assets.rs` (create)

```rust
#[derive(Clone)]
pub struct WebAssets { pack: Arc<zed_web_core::AssetPack> }

impl WebAssets {
    pub fn new(pack: zed_web_core::AssetPack) -> Self;
    /// `cx.text_system().add_fonts(all "fonts/**/*.ttf" in the pack)` — the browser replacement for
    /// assets::Assets::load_fonts (assets.rs:48-62), which only sees the embedded set.
    pub fn load_fonts(&self, cx: &gpui::App) -> anyhow::Result<()>;
}

impl gpui::AssetSource for WebAssets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>>;   // pack first, then assets::Assets::load (prompts, *.md)
    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>>;            // union of both
}
```

Parsing runs before `Application` starts, on the main thread, and is bounded by the ~6.5 MB pack (BUILD-SPEC 3.4).

### 3.23 `crates/zed_web/src/keymap.rs` (create)

```rust
pub fn host_os(config: &BootConfig) -> HostOs;   // override from BootConfig.host_os, else navigator.platform / user agent (2.3 events.rs:1294-1309, pub(crate) there — reimplemented via web_sys)
fn keymap_os(os: HostOs) -> settings::KeymapOs;

/// Port of zed.rs:2355-2388 with (a) the host OS chosen at runtime, (b) the web layer and
/// (c) lenient loading for the desktop files. Order: default → base → vim/helix (if enabled) →
/// specific-overrides → web (last, D12); the user keymap follows in `reload_keymaps`.
/// Returns the names of bindings dropped from the lenient layers (logged once at `warn`).
pub fn load_default_keymap(os: HostOs, cx: &mut App) -> Vec<String>;

/// Port of zed.rs:2334-2353 (clear, defaults, user bindings as KeybindSource::User,
/// KeymapEventChannel::trigger_keymap_changed); no menus/dock menu on the web.
pub fn reload_keymaps(os: HostOs, user_key_bindings: Vec<KeyBinding>, cx: &mut App);

/// Port of zed.rs:2146-2262: observes BaseKeymap / VimModeSetting / HelixModeSetting / DisableAiSettings
/// and the keyboard mapper, consumes the user keymap watcher, runs `migrator::migrate_keymap`
/// in memory, shows a workspace notification on parse errors. Drops the Windows-only branch.
pub fn install(os: HostOs, user_keymap_file_rx: UnboundedReceiver<String>, watcher: Task<()>, cx: &mut App);

fn filter_disabled_ai_bindings(bindings: Vec<KeyBinding>, cx: &App) -> Vec<KeyBinding>; // copy of zed.rs:2404-2419
```

`load_default_keymap` loads `settings::default_keymap_path_for(os)` as `Default`, `base.asset_path_for(os)` as `Base` and `VIM_KEYMAP_PATH` as `Vim` with `KeymapFile::load_asset_allow_partial_failure` (`keymap_file.rs:204-222`): the desktop files bind `collab_panel::*`, `onboarding::*` and `welcome::*` actions (2.4) that the browser build does not register, and the strict loader would turn that into a boot failure at runtime — `cx.build_action` resolves names at load time, so no `cargo check` can catch it. `settings::specific_overrides_keymap_path_for(os)` and then `settings::WEB_KEYMAP_PATH` (the same file for every host OS, loaded last so its alternatives and `null` unbindings win over every layer below them, D12) are loaded with the strict `load_asset` as `Default`, so a typo in the web layer fails loudly. A `wasm-bindgen-test` asserts the dropped set equals an allow-list (section 6).

### 3.24 `crates/zed_web/src/settings.rs` (create)

```rust
/// zed_web_core::merge_web_defaults(settings::default_settings()); parsed once.
pub fn web_default_settings() -> &'static str;

/// Create `/home/web/.config/zed/{settings.json,keymap.json}` (paths::settings_file()/keymap_file(), D11)
/// in the WasmFs from the shell-provided documents with `WasmFs::insert_file` (b6 §3.2, synchronous),
/// empty strings meaning "absent" (the file is still created, empty), and create the empty
/// snippets/prompts/tasks dirs with `WasmFs::insert_dir` (b6 §3.2, synchronous `mkdir -p`) so
/// their watchers start cleanly. No async `Fs` call happens before the app loop runs.
pub fn seed_config_files(fs: &Arc<fs::WasmFs>, settings_json: &str, keymap_json: &str);

/// settings::init equivalent (settings.rs:129-133) with web defaults, then
/// `store.set_user_settings(settings_json, cx)` synchronously (so boot never waits for a watcher tick),
/// then SettingsStore::watch_settings_files (3.17 form) so user/global/profile files stay live through
/// the WasmFs watcher; parse errors surface with workspace notifications (zed.rs:2125-2144 minus MigrationNotification).
pub fn init(fs: Arc<dyn Fs>, settings_json: &str, cx: &mut App);

/// Save-back of the two documents the control plane stores in v0 — settings.json and keymap.json
/// (decision for b6 §7 item 8; snippets, prompt overrides, tasks.json and the global AGENTS.md
/// live only in WasmFs for the tab's lifetime). Watches paths::config_dir() at 500 ms (b6 §7 item 8),
/// filters events to the two files, debounces 750 ms per document, loads the text and calls
/// JsHost::save_document(kind, json). A rejected save is logged and shown as a workspace
/// notification ("Settings were not saved: edited elsewhere — reload to pick up the latest");
/// v0 is last-writer-wins at the control plane.
pub fn install_save_back(fs: Arc<fs::WasmFs>, cx: &mut App);

/// Drains `WasmFs::take_dirty()` (b6 §3.2; synchronous) and saves any settings.json/keymap.json
/// entry immediately, cancelling that document's pending 750 ms debounce, so a write made inside
/// the debounce window is not lost when the tab is hidden or the workspace stops. Called by
/// `boot::flush_client_state`, `set_hidden(true)` and the `Stopping` handler before
/// `ClientStateStore::flush_now` (b6 §7 item 8 left this open for b7; wired here). Entries for
/// other files are dropped (they are not stored anywhere in v0).
pub fn flush_pending_saves(cx: &mut App) -> Task<()>;
```

Delivery of the user settings to the server (`UpdateUserSettings`, BUILD-SPEC 3.7) is the existing `SettingsObserver` path in `project` and needs nothing here. Telemetry is off through the web defaults (4.5), which is the policy b6 §7 item 10 asks this brief to set.

### 3.25 `crates/zed_web/src/window.rs` (create)

```rust
/// AppState.build_window_options for the web (zed.rs:359-426 minus display/decorations/tabbing/icon).
pub fn build_window_options(_display: Option<uuid::Uuid>, cx: &mut App) -> WindowOptions {
    WindowOptions {
        titlebar: Some(TitlebarOptions { title: None, appears_transparent: true, traffic_light_position: Some(point(px(9.0), px(9.0))) }),
        window_bounds: None, focus: true, show: true, kind: WindowKind::Normal, is_movable: false,
        app_owns_titlebar_drag: false,
        window_background: cx.theme().window_background_appearance(),
        app_id: Some("zed-web".into()),
        window_min_size: Some(gpui::Size { width: px(360.0), height: px(240.0) }),
        ..Default::default()
    }
}
```

### 3.26 `crates/zed_web/src/init.rs` (create) — the init sequence

`pub struct Initialized { pub app_state: Arc<AppState>, pub extension_host_proxy: Arc<ExtensionHostProxy>, pub client: Arc<Client> }`

`pub fn init_before_connect(fs: Arc<dyn Fs>, assets: &WebAssets, host_os: HostOs, settings_json: &str, build: &BuildInfo, cx: &mut App) -> anyhow::Result<(Arc<Client>, Arc<ExtensionHostProxy>)>` runs, in this order (desktop anchors in parentheses; "skip" items are listed so reviewers can diff against `main.rs`):

1. `assets.load_fonts(cx)?` (replaces `load_embedded_fonts`, `main.rs:724`; must precede the first frame because the text system has no system fonts, `platform.rs:161-163`).
2. `ui::PlatformStyle::set_platform_style(host_os.into())` (3.2a, D12 — before any window or key-binding element exists); `menu::init(); zed_actions::init();` (`:485-486`).
3. `release_channel::init(AppVersion::load(env!("ZED_PKG_VERSION"), Some(build.id), build.commit_sha), cx)` (`:304`, `:488`; the version comes from `build.rs`, 3.20). `gpui_tokio::init` skipped (b1 §4.6 step 0 gates it the same way).
4. `settings::init(fs.clone(), settings_json, cx)` from 3.24 (replaces `:493-495`); `zlog_settings::init` skipped.
5. `keymap::install(host_os, user_keymap_file_rx, watcher, cx)` (`:496`), where the watcher comes from `settings::watch_config_file(&cx.background_executor(), fs.clone(), paths::keymap_file().clone())` (`:433-437`).
6. `<dyn Fs>::set_global(fs.clone(), cx)` (`:513`).
7. `git::GitHostingProviderRegistry::set_global(Arc::new(git::GitHostingProviderRegistry::new()), cx); git_hosting_providers::init(cx);` (`:30`, `:419`, `:515-516`; the type is in the `git` crate).
8. `extension::init(cx); let proxy = ExtensionHostProxy::global(cx);` (`:520-521`).
9. `let client = Client::production(cx); cx.set_http_client(client.http_client());` (`:523-524`; the base HTTP client is already `FetchHttpClient` from `application_with_web_backend`, `gpui_platform.rs:31-38`). `Client::set_global(client.clone(), cx)` (`:581`). Telemetry, ids and `authenticate` (`:592-637`, `:875-878`) skipped; `ReqwestClient` (`:498-511`) skipped. Telemetry is additionally off through the web default settings (4.5; b6 §7 item 11).
10. `Project::init(&client, cx); client::init(&client, cx); feature_flags::FeatureFlagStore::init(cx);` (`:586`, `:589-590`).

Returns `(client, proxy)`; the caller then connects (3.28) and opens the database (3.27), because `trusted_worktrees::init` and `workspace::init` need `AppDatabase`.

`pub fn init_after_db(client: Arc<Client>, fs: Arc<dyn Fs>, assets: WebAssets, proxy: Arc<ExtensionHostProxy>, session: Session, cx: &mut App) -> Arc<AppState>`:

11. `trusted_worktrees::init(WorkspaceDb::global(cx).fetch_trusted_worktrees().unwrap_or_default(), cx)` (`:477-484`).
12. `let mut languages = LanguageRegistry::new(cx.background_executor().clone()); languages.set_language_server_download_dir(paths::languages_dir().clone()); let languages = Arc::new(languages);` (`:525-527`).
13. `let node_runtime = NodeRuntime::unavailable();` (replaces `:528-555`).
14. `debug_adapter_extension::init(proxy.clone(), cx); languages::init(languages.clone(), fs.clone(), node_runtime.clone(), cx);` (`:557-558`).
15. `user_store`, `workspace_store` (`:559-560`); `language_extension::init(LspAccess::ViaWorkspaces(<closure of :563-575>), proxy.clone(), languages.clone())` (`:562-579`).
16. `debugger_ui::init(cx); debugger_tools::init(cx);` (`:587-588`).
17. `let app_session = cx.new(|cx| AppSession::new(session, cx));` `AppState { languages, client, user_store, fs, build_window_options: window::build_window_options, workspace_store, node_runtime, session: app_session }`; `AppState::set_global` (`:639-651`).
18. `dap_adapters::init(cx)` (`:654`). Skipped: `auto_update::init`, `auto_update_ui::init`, `reliability::init`, `extension_host::init` (`:653-663`).
19. `theme_settings::init(theme::LoadThemes::All(Box::new(assets.clone())), cx)` (`:665`); `theme_extension::init(proxy.clone(), ThemeRegistry::global(cx), cx.background_executor().clone())` (`:667-671`). `eager_load_active_theme_and_icon_theme` skipped (`ExtensionStore` + `block_on`, `zed.rs:2761`).
20. `command_palette::init(cx)` (`:672`).
21. `copilot_chat::init(app_state.client.http_client(), zed_credentials_provider::global(cx), CopilotChatConfiguration { enterprise_uri: <same as :675-680> }, cx)` (`:673-687`) and `copilot_ui::init(&app_state, cx)` (`:688`) — unconditional: `copilot`, `copilot_chat` and `copilot_ui` are in the browser closure through `language_models`, `settings_ui`, `edit_prediction` and `edit_prediction_ui` regardless (2.1), so a `zed_web` feature would gate nothing.
22. `language_model::init(cx); RefreshLlmTokenListener::register(client, user_store, cx); language_models::init(user_store, client, cx);` (`:689-695`).
23. `acp_tools::init(cx); edit_prediction_ui::init(cx); web_search::init(cx); web_search_providers::init(client, user_store, cx); snippet_provider::init(cx);` (`:696`, `:699-702`). `zed::telemetry_log`, `zed::remote_debug`, `zed::edit_prediction_registry` (`:697-698`, `:703`) are `crates/zed` modules and are not available; edit-prediction provider registration is a follow-up (section 7).
24. `let prompt_builder = PromptBuilder::load(fs.clone(), false, cx); project::AgentRegistryStore::init_global(cx, fs.clone(), client.http_client()); agent_ui::init(fs.clone(), prompt_builder, languages.clone(), false, false, cx);` (`:704-717`). `watch_user_agents_md` (`:718`) ported as `agent_settings::init_user_agents_md(fs.clone(), cx, |_, _| {})` (`agent_settings.rs:27`) with a log-only error callback.
25. `repl::init(fs.clone(), cx); recent_projects::init(cx);` (`:720-721`). `dev_container::init` skipped.
26. `editor::init(cx); image_viewer::init(cx); repl::notebook::init(cx); diagnostics::init(cx);` (`:728-731`). `audio::init` skipped.
27. `workspace::init(app_state.clone(), cx); ui_prompt::init(cx);` (`:734-735`).
28. `go_to_line, file_finder, tab_switcher, outline, call_hierarchy, project_symbols, project_panel, outline_panel, tasks_ui, snippets_ui` (`:737-746`); `channel::init(&client, user_store, cx)` (`:747`); `search::init(cx); lsp_locations::init(cx);` (`:748-749`); `cx.set_global(workspace::PaneSearchBarCallbacks { .. })` exactly as `:750-758`.
29. `vim::init(cx); terminal_view::init(cx);` (`:759-760`); `journal::init` skipped (`:761`); `encoding_selector, language_selector, line_ending_selector, toolchain_selector, theme_selector, settings_profile_selector, language_tools` (`:762-768`).
30. `notifications::init(client, user_store, cx)` (`:770`); `git_ui::init(cx)` (`:772`); `markdown_preview, tabular_data_preview, svg_preview` (`:774-776`); `settings_ui::init(cx); keymap_editor::init(cx);` (`:778-779`); `edit_prediction::init(cx); json_schema_store::init(cx); which_key::init(cx);` (`:781`, `:783`, `:785`). Skipped: `miniprofiler_ui::init` (`:784`; takes `std::time::Instant`, which panics at runtime on wasm — 2.5; port to `web_time` is a follow-up), `call`, `collab_ui`, `feedback`, `onboarding`, `extensions_ui` (needs the b4 `RemoteExtensionStore` gate, b4 section 7 item 14), `inspector_ui`, `etw_tracing`.
31. `title_bar::init(cx)` — on desktop this runs inside `collab_ui::init` (`collab_ui.rs:25`, from `main.rs:771`); `collab_ui` is excluded, so the entry crate calls it directly (`title_bar.rs:104` registers the title bar on every `Workspace`).
32. `SettingsStore` observer for window background appearance and text rendering mode (`:789-804`); server-URL reconnect branch (`:805-815`) dropped.
33. `app_state.languages.set_theme(cx.theme().clone())` + `GlobalTheme` observer (`:822-828`).
34. `workspace_chrome::init(app_state.clone(), cx)` (replaces `initialize_workspace`, `:871`).
35. `cx.activate(true)` (`:873`).

### 3.27 `crates/zed_web/src/boot.rs` (create)

```rust
pub async fn run(config: BootConfig, assets_tar: Vec<u8>, host: JsHost) -> Result<(), BootError>;
pub async fn flush_client_state() -> anyhow::Result<()>;
pub fn set_hidden(hidden: bool);
pub fn has_unsaved_changes() -> bool;
```

`run` (each numbered step emits `BootStage` progress through `bridge::progress`; the whole sequence runs under a 90 s timer that rejects with `BootError { code: "boot_timeout" }`):

1. `Booting`: install the chained panic hook (3.21); `Assets`: `let assets = WebAssets::new(AssetPack::from_tar(&assets_tar)?)` (error code `bad_assets`).
2. Build the app: `gpui_platform::application_with_web_backend(config.backend.into()).with_assets(assets.clone())` (`gpui_platform.rs:31-38`), then `let handle = app.run_embedded(move |cx| { ... })` and `std::mem::forget(handle)` (`app.rs:255-266`; fork evidence `zed-web main.rs:2192-2233`; `Application::run` at `app.rs:234-245` drops the app once the launch callback returns, which on the web is immediate — section 7 item 4). The first statements inside the callback, before any `cx.spawn` or timer: `smol::runtime::install_runtime(Arc::new(GpuiSmolRuntime(cx.background_executor().clone()))).ok();` with the adapter exactly as b5 §4 (`crates/zs_smol_shim/src/runtime.rs`, b5:532-573: `pub struct GpuiSmolRuntime(pub gpui::BackgroundExecutor); impl smol::runtime::Runtime for GpuiSmolRuntime { fn schedule(&self, runnable) { self.0.spawn(async move { runnable.run(); }).detach(); } }`), then assert `smol::runtime::runtime_installed()` (error `runtime_missing`) and `db::registered_migration_count() > 0` (b6 §3.4/§4.7; error `ctors_missing`, section 7 item 3 — the same `inventory` registry the earlier inline `inventory::iter::<db::DomainMigration>()` read, so `zed_web` no longer depends on `inventory` directly). Then `cx.spawn(async move |cx| boot_in_app(...).await).detach()`. The outer `run` future resolves from a `oneshot` completed by `boot_in_app`.
3. Inside `boot_in_app` (an `AsyncApp` task on the main thread):
   a. `Settings`: `let fs = fs::WasmFs::new(cx.background_executor().clone());` (b6 §3.2), `settings::seed_config_files(&fs, &config.settings_json, &config.keymap_json)` (synchronous; `insert_file` + `insert_dir`), keep the `Arc<WasmFs>` for `install_save_back`/`flush_pending_saves`, `let fs_dyn: Arc<dyn Fs> = fs.clone();`.
   b. `cx.update(|cx| init::init_before_connect(fs_dyn.clone(), &assets, host_os, &config.settings_json, &build, cx))?` → `(client, proxy)`.
   c. `Connecting`: `let remote = connect::connect(&config.workspace.id, &config.connect, cx).await?` (3.28; `set_status` messages from b1's `WebSocketClientDelegate` become `Connecting` details; a terminal close during the first dial maps through `last_close()` — 4005 → `BootError { code: "session_busy" }`, 4001 → `taken_over`, 4002/4006 → `incompatible_server`, 1001 → `server_stopping`; a terminal refresh error → `unauthorized` / `workspace_stopped` — per b1 §3.3 step 5 and D2/D3).
   d. `Database`: `let proto = remote.read_with(cx, |r, _| r.proto_client())`; `let (image, version) = workspace::client_state::load_client_state(&proto).await?` (b4 §3.8); `let (app_db, outcome) = cx.background_spawn(db::AppDatabase::open_with_image(image)).await` (b4 §3.6; D7 — the restore runs off the main thread; it returns the `RestoreOutcome`, and an image from a newer build that fails validation yields a fresh database, never a boot failure); `cx.update(|cx| { cx.set_global(app_db.clone()); db::kvp::GlobalKeyValueStore::init(&app_db); })` (b4 §3.6a — the global key-value rows travel in the same image, D7; `init` must precede anything that calls `GlobalKeyValueStore::global()`, e.g. `prompt_store`'s rules→skills migration); `let session = Session::new(uuid, KeyValueStore::from_app_db(&app_db)).await` (`session.rs:15-38`); `let store = cx.new(|cx| ClientStateStore::new(&app_db, RemoteClientStateSink::new(proto.clone(), build_id()), version, outcome, cx))` (b4 §3.7) kept in a global for `flush_client_state`/`set_hidden`; `cx.subscribe(&store, ..)` on `ClientStateEvent`: `ReadOnly(reason)` (a `RestoreOutcome::Skipped`, i.e. an image the running build cannot use) → a workspace notification "Saved layout from a newer build could not be loaded; layout changes are not being saved" with a "Discard saved layout" button that calls `store.allow_overwrite()` (the entry crate owns that decision, b4 §3.7; nothing calls it automatically), `SaveFailed`/`Stale` → `log::warn`, `Saved` → `log::debug`; `connect::observe(remote, store, cx)` (3.28) installs the reconnect/disconnect observers.
   e. `Languages`: `cx.update(|cx| init::init_after_db(client, fs_dyn.clone(), assets, proxy, session, cx))` → `app_state`; `settings::install_save_back(fs.clone(), cx)`; subscribe to `project::Event::LifecycleNotice` once the project exists (step f) and forward every notice with `bridge::lifecycle`; on `LifecycleKind::Stopping` run, in order, `settings::flush_pending_saves(cx).await` (3.24), `workspace::client_state::snapshot_unsaved_buffers(&workspace, cx).await` (D6, b4 §3.8 — every dirty path-backed buffer's path, text and saved mtime go into the `unsaved_buffers` table of the image), then `store.flush_now(cx).await` (the `STOPPING` flush of D7, inside b4's 5 s stopping window). **Never `Workspace::save_all`**: the client does not write to the workspace filesystem unless the user saves (D6).
   f. `Window`: `let opened = connect::open_remote_workspace(remote, &config, app_state, cx).await?` → `OpenedRemoteProject { window, workspace, items }` (D16). Then `opened.window.update(cx, |_, window, cx| workspace::client_state::restore_unsaved_buffers(&opened.workspace, window, cx))?.await` (D6): it runs after b1's `finish_opening_remote_workspace` has restored the editor items, the order b4 §7 item 22 makes normative, and reopens each snapshot row dirty with the stored text (a `warn` per row whose path no longer resolves). Terminal restore (D4) needs nothing here: b3 reattaches persisted terminals during terminal-panel deserialization inside the same open task, and PTYs survived the fresh session in the server-level `PtyManager` (D3).
   g. `Ready`: emitted when the b1 open task returns (it awaits worktree creation and item restoration, b1 §3.12) — not on `project::Event::WorktreeAdded`, which fires when the worktree entity is created (`project.rs:3937-3939`) and never fires for an empty `paths` list. With `config.workspace.paths` empty the window opens on an empty remote project and `Ready` follows immediately. The `run` future resolves then (or on error).

`flush_client_state`: `settings::flush_pending_saves(cx).await` then `store.flush_now(cx).await`, unless the store is stopped (`flush_now` returns `Err` after any `Disconnected`, b4 §3.7 — nothing to flush against a session that is no longer ours; the error is swallowed, not surfaced). `set_hidden(true)` calls `store.set_interval(5 s)` and the same two flushes; `set_hidden(false)` restores `SAVE_INTERVAL`. These, the 15 s dirty ticker and the `Stopping` flush of step 3e are the only flush triggers the design relies on (D7); the loader's `pagehide` call (3.30) is best-effort on top. `has_unsaved_changes`: any `Workspace` in the window has a dirty item (`workspace.items(cx).any(|i| i.is_dirty(cx))`).

### 3.28 `crates/zed_web/src/connect.rs` (create)

Consumes b1 §3.3/§3.12 (as amended by D1, D2, D3, D16); the only local code is the status/progress plumbing and the state observers.

```rust
/// Dial (refresh/backoff happen inside the pool, b1 §3.3) and create the one RemoteClient of the session.
pub async fn connect(workspace_id: &str, info: &ConnectInfo, cx: &mut AsyncApp) -> Result<Entity<RemoteClient>, BootError> {
    // D1: identity (Hash/Eq, workspace persistence row `name = workspace_id`, pool key) is `workspace_id` =
    // BootConfig.workspace.id; `session_id` is the per-connect id from /connect and is informational.
    let options = remote::WebSocketConnectionOptions::new(info.ws_url.clone(), workspace_id.to_string(),
            info.session_id.clone(), info.token.clone())                                            // b1:350 `new(url, workspace_id, session_id, token)`
        .with_takeover(info.takeover)
        .with_refresh(Arc::new(bridge::JsSessionRefresh));                                          // b1 §3.3/§4.1
    let delegate: Arc<dyn remote::RemoteClientDelegate> = Arc::new(remote::WebSocketClientDelegate::new(
        |status, cx| cx.update(|_| bridge::progress(BootStage::Connecting, status.unwrap_or("")))));   // b1:232-236
    let connection = remote::connect(options.clone().into(), delegate.clone(), cx).await.map_err(..)?;  // b1 §3.5 pool arm
    let (_cancel_tx, cancel_rx) = futures::channel::oneshot::channel();                                 // held for the app lifetime
    cx.update(|cx| RemoteClient::new(ConnectionIdentifier::setup(), connection, cancel_rx, delegate, cx))   // remote_client.rs:410-416
        .await.map_err(..)?.ok_or(BootError::cancelled())
    // a terminal close before HelloAck: map options.last_close() / bridge::LAST_REFRESH_ERROR with close_code_detail
}

/// Reconnect/disconnect → BootStage, the host's onClosed, and ClientStateStore (b4 §3.7 stop/resync).
pub fn observe(remote: Entity<RemoteClient>, store: Entity<ClientStateStore>, cx: &mut App) {
    cx.observe(&remote, |remote, cx| match remote.read(cx).connection_state() {       // remote_client.rs:1020
        ConnectionState::HeartbeatMissed | ConnectionState::Reconnecting => bridge::progress(BootStage::Reconnecting, ""),
        _ => {} }).detach();
    cx.subscribe(&remote, move |remote, event, cx| match event {
        RemoteClientEvent::Reconnected => { bridge::ready_once(); store.update(cx, |s, cx| s.resync(cx)).detach(); }
        RemoteClientEvent::Disconnected { .. } => {                                   // both terminal states (D2): ServerNotRunning and ReconnectExhausted
            let close = remote.read(cx).connection_options().and_then(|o| match o { RemoteConnectionOptions::WebSocket(o) => o.last_close(), _ => None });
            if let Some(c) = &close { bridge::on_closed(c.code, &c.reason); }        // optional host callback (b9 §4.6)
            bridge::progress(BootStage::Stopped, close_code_detail(close.as_ref(), bridge::last_refresh_error()));
            store.update(cx, |s, _| s.stop());                                        // every Disconnected (b4 §3.7)
        } }).detach();
}

/// Stopped-detail vocabulary (also the BootError codes of 4.1); D3's close codes as b1 §3.3 step 5 / b2 §4 emit them.
fn close_code_detail(close: Option<&CloseInfo>, refresh: Option<RefreshErrorKind>) -> &'static str {
    match (refresh, close.map(|c| c.code)) {
        (Some(RefreshErrorKind::Stopped), _)      => "workspace_stopped",   // D2: RefreshError::Stopped short-circuited the budget
        (Some(RefreshErrorKind::Unauthorized), _) => "unauthorized",        // D2: terminal; b1 synthesizes CloseInfo{4003}
        (_, Some(4001))                           => "taken_over",          // D3: superseded by a takeover (or a stale epoch)
        (_, Some(4005))                           => "session_busy",        // D3: session active, no takeover
        (_, Some(4002)) | (_, Some(4006))         => "incompatible_server", // build/protocol mismatch, bad Hello
        (_, Some(1001))                           => "server_stopping",     // D3: server going away (SIGTERM / STOPPING); 4004 is retired
        _                                         => "reconnect_exhausted", // D2: 20 attempts / 8 s cap spent; the last close, if any, is in the message
    }
}

/// D16: one window, one Workspace with the persisted id, no placeholder.
pub async fn open_remote_workspace(remote: Entity<RemoteClient>, config: &BootConfig, app_state: Arc<AppState>, cx: &mut AsyncApp)
    -> Result<workspace::OpenedRemoteProject, BootError> {
    let paths: Vec<PathBuf> = config.workspace.paths.iter().map(PathBuf::from).collect();
    let options = cx.update(|cx| (app_state.build_window_options)(None, cx));
    cx.update(|cx| workspace::open_remote_project_in_new_window_with_client(remote, app_state, paths, options, cx)).await
        .map_err(BootError::window)                                              // b1 §3.12 lines 367-408: Task<Result<OpenedRemoteProject { window, workspace, items }>>
}
```

Ordering (decided, D16): the database image is fetched over the session (`load_client_state` takes an `AnyProtoClient`, b4 §3.8), and `WorkspaceDb` must exist before `deserialize_remote_project` runs, so the `RemoteClient` is created **before** the workspace is opened. b1 §3.12 (lines 367-408) provides exactly that split: `open_remote_project_in_new_window_with_client(remote, app_state, paths, window_options, cx) -> Task<Result<OpenedRemoteProject>>` runs `deserialize_remote_project(remote.read(cx).connection_options(), paths)` → `Project::remote(remote, …, true, cx)` → `resolve_remote_project_paths` → `cx.open_window` with a single `Workspace::new(Some(workspace_id), …)` → `finish_opening_remote_workspace`, and b1's connection-taking `open_remote_project_in_new_window` delegates to the same inner function after `RemoteClient::new`. The placeholder-window path (`Workspace::new(None, project)` then `open_remote_project_with_existing_connection(..)`) is not used: it attaches two `Workspace`s to one `Project` (`workspace.rs:1610` subscribes twice) and `MultiWorkspace::activate` (`:1310-1328`) keeps the empty placeholder in the sidebar. `ConnectionIdentifier::setup()` is the right identifier for the `_with_client` form (b1:408): for the WebSocket transport it only feeds `Hello.identifier` (logs-only, b2:392), never a socket path, and the workspace-persistence identity is the options' `workspace_id` (D1) — the DB row does not exist yet when the client is created, so `ConnectionIdentifier::Workspace(row)` is impossible here and unnecessary.

`takeover` at boot: the shell passes `connect.takeover` (4.1); `start()` is single-shot, so on `session_busy` the shell reloads the page with `takeover: true` (BUILD-SPEC 3.6 "Tabs", 7.6 takeover dialog). **D2's host `reconnect()` is the shell reloading the page** (a fresh `start`, i.e. "a new connection from scratch"): after a post-boot terminal close (`Stopped`), the shell's Reconnect/Resume affordance calls `/connect` again and reloads. This brief chooses the reload form (b4 §9 leaves the choice to b7) because `gpui_web` cannot reopen its window (`platform.rs:381` `ReopeningUnsupported`) and a new `RemoteClient` implies a new `Project` and `Workspace`; consequently `ClientStateStore::rebind` (b4 §3.7) is never called from `zed_web`. A reload is a *fresh* session under D3 (`Hello.reconnect = false`): the server resets the `HeadlessProject`, the client re-opens worktrees and buffers by path, dirty text comes back through D6's `unsaved_buffers` rows (after a `STOPPING`) and the throttled `editors.contents`, and PTYs survive in the server-level `PtyManager` (D3/D4). There is no warm attach on reload any more; only b1's in-transport reconnect (same `RemoteClient`, `Hello.reconnect = true`, matching epoch) is warm.

### 3.29 `crates/zed_web/src/workspace_chrome.rs` (create)

Port of `zed.rs:428-665`, `:777-818`, `:1474-1541` and the verified part of `:914-923`:

```rust
pub fn init(app_state: Arc<AppState>, cx: &mut App);
fn initialize_pane(workspace: &Workspace, pane: &Entity<Pane>, window: &mut Window, cx: &mut Context<Workspace>);
fn initialize_panels(window: &mut Window, cx: &mut Context<Workspace>) -> Task<Result<()>>;
fn register_actions(app_state: Arc<AppState>, workspace: &mut Workspace, cx: &mut Context<Workspace>);
```

- `MultiWorkspace` observer: sidebar registration (`zed.rs:535-546`), `ActiveWorkspaceChanged` → agent panel (`:502-528`); window-close hook (`:492-500`) becomes a best-effort `flush_client_state` call (not one of D7's three triggers, which are the ticker, `visibilitychange` → hidden and `STOPPING`; a window close never happens in the browser anyway); `track-project-leak` and telemetry loop dropped.
- `Workspace` observer: `initialize_pane` on the center pane and `PaneAdded`; status bar items and order exactly `zed.rs:585-652` including `vim::ModeIndicator` and `ImageInfo`; `initialize_panels` (project, outline, terminal, git, debug; no `CollabPanel`) followed by `initialize_agent_panel` semantics (`:880-912`: `setup_or_teardown_ai_panel` on `DisableAiSettings`, and `register_action(AgentPanel::toggle_focus / focus / toggle)` + `InlineAssistant::inline_assist`), then `finish_dock_restoration`; `initialize_file_watcher` and GPU warnings dropped.
- `initialize_pane`: the `zed.rs:1484-1540` list minus items owned by `crates/zed` or excluded crates: drop `MultibufferHint` (onboarding), `QuickActionBar` (`zed::quick_action_bar` is private; a web copy is deferred), `TelemetryLogToolbarItemView`, `MigrationBanner`; keep the rest in the same order (`BasedPyrightBanner` needs `language_onboarding`, section 5).
- `register_actions`: `OpenDocs`, `OpenStatusPage`, `GetMerch` (`:921-923`); `zed_actions::Quit` → `settings::flush_pending_saves`, `workspace::client_state::snapshot_unsaved_buffers(&workspace, cx)` (D6 — dirty buffers go into the image, never to the workspace filesystem; the desktop's save prompt is not replayed), `flush_client_state`, then `BootStage::Stopped` with detail `"quit"` instead of quitting; `OpenSettings`/`OpenSettingsAt`/`OpenSettingsPage` wasm handlers hosting the settings window in a modal (3.7); `OpenSettingsFile`/`OpenKeymapFile`/`OpenDefaultSettings`/`OpenDefaultKeymap` are left to `settings_ui`/`keymap_editor` in v0 (section 7). The remaining `:924-1472` handlers are reviewed one by one at implementation time; anything touching `paths::*` local files, CLI install or the about window is skipped.

### 3.30 `crates/zed_web/web/index.html` and `crates/zed_web/web/loader.js` (create) — dev harness and loader contract

These are the reference loader for `cargo xtask web-bundle --serve`; `apps/web` (out of this repo) implements the same contract in the editor route (BUILD-SPEC 7.6). Requirements:

- Headers on the document and every subresource (`.js`, `.wasm`, `.tar`): `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`; `Cross-Origin-Resource-Policy: same-origin` on the bundle files. Verify `crossOriginIsolated === true` before loading; otherwise show the "browser not supported" message (the shared-memory build cannot fall back to single-threaded, section 7 item 15).
- `<script type="module" src="/editor/<build>/loader.js">`. `loader.js` does `import init, { start, flush_client_state, set_hidden, has_unsaved_changes, build_id } from "./zed_web.js";` — the glue must be a real same-origin URL with `Content-Type: text/javascript` because `wasm_thread` derives the worker's import URL from a stack trace (`wasm_thread utils.rs:33-39`) and workers `import` it (`web_worker_module.js`).
- CSP for the route (decision, owned here): `script-src 'self' 'wasm-unsafe-eval'` as BUILD-SPEC 7.6 plus `worker-src 'self' blob:` (workers are `blob:` module workers, `utils.rs:60-70`, `mod.rs:301`). This requires the vendored `wasm_thread` patch of 3.33 (D10; no `js_sys::eval`; shim URL from `globalThis.__zsBindgenShimUrl` that the loader sets before `start`). Until that patch lands, the editor route carries `'unsafe-eval'` as a recorded deviation — never on any other route; b9 §4.9 gates it behind `ZS_CSP_UNSAFE_EVAL=1` and flips the flag to `0` when 3.33 ships.
- Boot: `const wasm = await init({ module_or_path: "./zed_web_bg.wasm" });` then `globalThis.__zsCallCtors?.()` (added to the glue by the memory patch, 3.31 step 4b) or `wasm.__wasm_call_ctors?.()` (exported by 3.16), then `await start(JSON.stringify(config), assets, host)`; `start` rejects with `{ code, message }` (4.1) and the shell branches on `code` (`session_busy` → takeover dialog → reload with `takeover: true`; `unauthorized` → sign-in; `incompatible_server` → reload; `workspace_stopped`/`server_stopping` → "stopped" state with a Resume button; `ctors_missing` → call the ctor export and reload once).
- Terminal outcomes after boot: `bootProgress("stopped", detail)` (detail vocabulary in 3.28) and, when supplied, `onClosed({ code, reason })`. The shell's **Reconnect/Resume affordance is D2's host `reconnect()`**: it re-POSTs `/connect` (with `reason: "resume"` for a stopped workspace, b9 §3.26) and reloads the page — a new connection from scratch. There is no in-page re-dial export (3.28 explains why).
- Memory: created by the wasm-bindgen glue from the module's import limits (initial 128 MiB, max 4 GiB from b5's block); no explicit `WebAssembly.Memory` in the loader; `thread_stack_size` left at the glue default.
- `host` callbacks (section 4.2); `visibilitychange` → `set_hidden(document.hidden)` and, when hidden, `flush_client_state()` (a D7 trigger); `pagehide` → `flush_client_state()` (best-effort only and not part of the D7 contract: the executor may not tick again, b4 §3.8 — the 15 s ticker, the hidden flush and the `Stopping` flush are authoritative); `beforeunload` → `if (has_unsaved_changes()) event.preventDefault()`; `fullscreenchange` → `navigator.keyboard?.lock(["KeyW","KeyT","KeyN","KeyQ","Tab"])` / `unlock()` (BUILD-SPEC 3.6; keyboard lock is a JS-side API not present in `gpui_web`'s `web-sys` feature list). `gpui_web` never invokes its `on_quit` callback (`platform.rs:488-490`), so `cx.on_app_quit` hooks (e.g. `workspace::init`'s serialization flush) do not run in the browser; wiring `pagehide` to them in `gpui_web` is an upstream-friendly follow-up (section 7).
- Page styles as `hello_web/index.html` (`html, body { height: 100% }`, `canvas { display: block; touch-action: none; }`); `gpui_web` creates the canvas itself (`platform.rs:307-322`).
- Assets: `fetch("./zed-assets.tar")` as `Uint8Array` in parallel with `init()`; the dev harness reads `settings.json`/`keymap.json` from `localStorage` and `connect` from `?ws=…&token=…&session=…&workspace=…&takeover=…` (`workspace` fills `BootConfig.workspace.id`, the D1 identity; `session` is the per-connect id).

### 3.31 `tooling/xtask/src/tasks/web_bundle.rs` (create), `tooling/xtask/src/tasks.rs`, `tooling/xtask/src/main.rs`, `tooling/xtask/src/tasks/web_examples.rs` (modify), `script/patch-wasm-bindgen-memory.sh` + `script/test-patch-wasm-bindgen-memory.sh` (create)

`tasks.rs`: add `pub mod web_bundle;` (after line 8). `main.rs`: add `WebBundle(tasks::web_bundle::WebBundleArgs)` to `CliCommand` (`:15-34`) with doc `/// Builds the zed_web browser bundle (wasm + glue + asset pack).` and the dispatch arm in `:38-52`. `web_examples.rs:20`: `fn check_program` → `pub(crate) fn check_program` so `web_bundle` can reuse it.

```rust
#[derive(clap::Parser)]
pub struct WebBundleArgs {
    /// Cargo profile (default web-release; use `dev` for a debug build with util/debug-embed)
    #[arg(long, default_value = "web-release")] pub profile: String,
    /// Output directory; the bundle lands in <out_dir>/<build_id>/
    #[arg(long, default_value = "target/web-bundle")] pub out_dir: PathBuf,
    /// Build id baked into the binary and used as the immutable path segment (default: git short sha + "-0")
    #[arg(long)] pub build_id: Option<String>,
    #[arg(long)] pub skip_wasm_opt: bool,
    #[arg(long)] pub serve: bool,
    #[arg(long, default_value = "8080")] pub port: u16,
    /// Fail if the brotli-compressed wasm exceeds this many bytes (BUILD-SPEC 3.4 budget)
    #[arg(long)] pub max_brotli_bytes: Option<u64>,
    /// Stop after the toolchain and forbidden-crate checks (steps 1-2); used by the `check_wasm` CI job (3.32)
    #[arg(long)] pub check_only: bool,
}
pub fn run_web_bundle(args: WebBundleArgs) -> anyhow::Result<()>;
pub fn check_forbidden_crates(cargo: &str) -> anyhow::Result<()>;   // section 6; also called by the CI step
```

Steps (all commands run from the repo root, env vars set on the child only):

1. Toolchain: `check_program("wasm-bindgen", "cargo install wasm-bindgen-cli --version 0.2.120")` and assert `wasm-bindgen --version` equals the workspace pin (`Cargo.toml:898`; the fork's pin check is `zed-web/web/build.sh:60-66`); `check_program("wasm-opt", "install binaryen >= 116")` unless `--skip-wasm-opt`.
2. `check_forbidden_crates` (section 6).
3. `ZS_WASM_MODE=build ZS_BUILD_ID=<build_id> script/check-wasm -p zed_web --profile <profile>` (b5 §3 item 3: it runs `script/download-wasi-sdk`, refuses rustflags env vars, and passes `-Zbuild-std=std,panic_abort` with `RUSTC_BOOTSTRAP=1`; rustflags and the C toolchain come from `.cargo/config.toml`, b5 item 2 + 3.16); for `--profile dev` add `--features util/debug-embed`.
4. `wasm-bindgen --target web --no-typescript --out-dir <out>/<build_id> --out-name zed_web target/wasm32-unknown-unknown/<profile>/zed_web.wasm` (mirrors `web_examples.rs:98-118`).
   4b. `script/patch-wasm-bindgen-memory.sh <out>/<build_id>/zed_web.js` — the fork's glue patch carried verbatim except that it names the ctor helper `globalThis.__zsCallCtors` (shared-memory accessor fallback, one-shot `__wasm_call_ctors` helper, `DataView` retry after `memory.grow`; 2.6). The fork needed it on wasm-bindgen 0.2.127 and this workspace pins 0.2.120, so the patch's own `test-patch-wasm-bindgen-memory.sh` runs here against the freshly generated glue and fails the build if a rewrite no longer matches; if 0.2.120's glue already handles growth (the patch's `grep -Fq` guards make it a no-op), the step logs that and the decision is recorded in section 7 item 3.
5. `wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue -o zed_web_bg.wasm zed_web_bg.wasm`.
6. Asset pack: `tar -C assets -cf <out>/<build_id>/zed-assets.tar --exclude='._*' --exclude='.DS_Store' --exclude='themes/src' fonts icons images themes sounds` (fork `build.sh:76-80`; `prompts` and `*.md` stay embedded, 3.14).
7. Write `build.json` `{ "build_id", "commit", "wasm_bytes", "wasm_brotli_bytes" }` (brotli measured with the `brotli` CLI when present; never emit `.br` files — Vercel recompresses precompressed files, BUILD-SPEC 3.5). Enforce `--max-brotli-bytes`.
8. Copy `crates/zed_web/web/{index.html,loader.js}` into the bundle dir; `--serve` runs the python COOP/COEP server from `web_examples.rs:150-175` rooted at `<out_dir>`.

### 3.32 `tooling/xtask/src/tasks/workflows/run_tests.rs` (modify) and regenerate `.github/workflows/run_tests.yml`

On top of b5 item 16 (`cargo_check_wasm` runs `./script/check-wasm` with **no arguments** and no rustflags env var; the crate list is the script's `default_packages`, b5 §3 item 3 line ~210, whose day-one value is `gpui_platform cloud_api_client smol`): the per-layer list is extended in `script/check-wasm`'s `default_packages`, not in the xtask, in dependency order as each layer compiles so the job is never red on day one — `util paths settings ui` (after 3.1/3.2/3.2a and b5's util gates), then each gated leaf crate of this brief as it goes green (`activity_indicator remote_connection title_bar language_models agent_ui settings_ui recent_projects sidebar`), after b6's leaves (`sqlez db prompt_store clock fs terminal acp_thread client`, b6 §6), then `zed_web` last (it also needs b1, b3's `terminal` remote surface per D17, b4 and the `project`/`workspace` gates). In `run_tests.rs` add a step `check_forbidden_crates` to the same job that runs `cargo xtask web-bundle --check-only` (stops after 3.31 step 2) once `zed_web` is in the list. Native jobs that must stay green after every gate: `cargo check --workspace`, `script/clippy`, `cargo shear`, and `cargo test -p title_bar -p language_models -p agent_ui -p settings_ui -p recent_projects -p remote_connection -p activity_indicator -p sidebar -p settings -p ui -p zed_web_core`. Regenerate with `cargo xtask workflows` (the YAML at `.github/workflows/run_tests.yml:637-680` is generated output).

### 3.33 `vendor/wasm_thread` (create — the `js_sys::eval`-free `wasm_thread`, vendored per D10), workspace `Cargo.toml` (modify), `vendor/README.md` (extend)

`wasm_thread` is a git dependency of `gpui_web` and `scheduler` (`crates/gpui_web/Cargo.toml:36-38`, `crates/scheduler/Cargo.toml:38-43`: `git = "https://github.com/zed-industries/wasm_thread", rev = "0cf96c7708dfb97ccf3da50347e25edcf75d6937"`, features `es_modules`, optional under `multithreaded`/`wasm-threads`). The CSP decision of 3.30 needs its five `js_sys::eval` sites gone (`src/wasm32/utils.rs:15, 26, 34`, `src/wasm32/mod.rs:60, 300`; section 7 item 2). Per D10 the change ships as a vendored copy under a path `[patch]`, in the layout b5 §3 items 4 and 19 fix for `lsp-types`/`agent-client-protocol` (and b1's `vendor/yawc`, b6's `vendor/alacritty_terminal`):

- Copy `~/.cargo/git/checkouts/wasm_thread-586cb4b723c583fe/0cf96c7/` verbatim to `vendor/wasm_thread/` (keep `Cargo.toml`, `src/`, `LICENSE*`, `README.md`; drop any `.git`/`target`). It has no `[lints]` table to strip; being path-sourced it compiles uncapped, so it must be warning-free under `-D warnings` on wasm (b5 risk 14) — fix in the copy and record in the README.
- Root `Cargo.toml`: add `"vendor/wasm_thread"` to `[workspace] exclude` (the list b5 item 4 creates) and a new table `[patch."https://github.com/zed-industries/wasm_thread"] wasm_thread = { path = "vendor/wasm_thread" }` next to the `[patch.crates-io]` table at `:976` (a `[patch."<git url>"]` table overrides every dependency declared from that source, including the two per-crate target-table declarations, so `gpui_web`/`scheduler` need no manifest change).
- The diff (intended upstream form: one commit on top of `0cf96c7`, recorded in `vendor/README.md` as `- Upstream: https://github.com/zed-industries/wasm_thread @ 0cf96c7708dfb97ccf3da50347e25edcf75d6937` with the file list and the git-patch form `wasm_thread = { git = "<fork carrying this commit>", rev = "<commit>" }`): `utils.rs:33-39` `get_wasm_bindgen_shim_script_path` first reads `js_sys::Reflect::get(&js_sys::global(), "__zsBindgenShimUrl")` and only falls back to the stack-trace trick when it is unset; the `js_sys::eval` calls at `utils.rs:15, 26, 34` and `mod.rs:60, 300` become `js_sys::global()`/`web_sys` lookups (`Worker`, `Blob`, `URL.createObjectURL`, `WorkerType::Module` are all reachable without `eval`); `Builder::wasm_bindgen_shim_url` (`mod.rs:144-146`) keeps working and takes precedence over the global. Loader side: `loader.js` sets `globalThis.__zsBindgenShimUrl = new URL("./zed_web.js", import.meta.url).href` before `start` (3.30). The two spawn sites (`gpui_web/src/dispatcher.rs:188`, `scheduler/src/scheduler.rs:215`) need no change because the vendored copy reads the global itself; passing the URL explicitly there remains the upstream-friendly follow-up once the fork exists.
- Verification: `script/check-wasm -p gpui_web` (the vendored copy is reached through the patch; `-p wasm_thread` is not a member, b5 risk 16) and the `memory_grow_after_boot`/boot smoke tests, which exercise worker spawn; `grep -rn 'js_sys::eval' vendor/wasm_thread/src` must be empty (`web_bundle::tests::vendored_wasm_thread_has_no_eval`, section 6).

## 4. New types and messages

### 4.1 `crates/zed_web_core/src/boot_config.rs` — boot configuration, progress, errors

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootConfig {
    pub build_id: String,
    pub connect: ConnectInfo,
    pub workspace: WorkspaceTarget,
    /// User settings.json document; "" when the user has none.
    #[serde(default)] pub settings_json: String,
    /// User keymap.json document; "" when the user has none.
    #[serde(default)] pub keymap_json: String,
    #[serde(default)] pub backend: Backend,
    /// "mac" | "windows" | "linux"; None = detect from navigator.
    #[serde(default)] pub host_os: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub ws_url: String,            // wss://<sandbox-host>.vercel.run/rpc; may differ on every /connect
    pub token: String,             // ES256 JWT; offered as the second Sec-WebSocket-Protocol entry on both targets (b1 §4.3; never a query parameter)
    /// Minted per /connect by the control plane (D1). Informational only — telemetry, logs, `Hello.session_id`,
    /// the server's session bookkeeping; never an identity or a persistence key (that is `WorkspaceTarget.id`).
    pub session_id: String,
    /// Close any other attached client with 4001 and attach us (D3; BUILD-SPEC 3.6 "Tabs").
    #[serde(default)] pub takeover: bool,
    #[serde(default)] pub server_build: Option<String>,
    #[serde(default)] pub session_expires_at: Option<String>,   // RFC 3339; drives bridge::ensure_fresh_token
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTarget {
    /// Control-plane workspace id: the stable identity of D1 — `WebSocketConnectionOptions.workspace_id`
    /// (Hash/Eq, pool key), the workspace-persistence row (`name = workspace_id`, `host = None`, `user = None`),
    /// the sandbox name — and the save-back key. Stable across stop/resume, takeover and rebuild.
    pub id: String,
    pub paths: Vec<String>,        // absolute sandbox paths, e.g. ["/workspaces/repo"]; may be empty
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend { #[default] Auto, WebGpu, WebGl }
// zed_web: impl From<Backend> for gpui_platform::WebBackendPreference

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootStage { Booting, Assets, Settings, Connecting, Database, Languages, Window, Ready, Reconnecting, Stopped, Failed }
impl BootStage { pub fn as_str(self) -> &'static str /* "booting", "assets", ... snake_case */ }

/// `start()` rejection payload; `Stopped` details use the same code vocabulary (3.28 `close_code_detail`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BootError { pub code: &'static str, pub message: String }
// codes: bad_config, bad_host, bad_assets, runtime_missing, ctors_missing, settings, connect_failed,
//        session_busy (close 4005), taken_over (4001), incompatible_server (4002 / 4006),
//        server_stopping (1001 — D3; 4004 is retired), unauthorized (RefreshError::Unauthorized, D2;
//        b1 synthesizes CloseInfo{4003}), workspace_stopped (RefreshError::Stopped, D2),
//        reconnect_exhausted (D2: 20 attempts / 8 s cap; the last CloseInfo, if any, is in `message`),
//        database, window, boot_timeout, cancelled, quit (Stopped detail only)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentKind { Settings, Keymap }
impl DocumentKind { pub fn as_str(self) -> &'static str /* "settings" | "keymap" */ }

pub struct BuildInfo { pub id: &'static str, pub commit_sha: Option<release_channel::AppCommitSha> }   // zed_web side
```

### 4.2 JS host contract (TypeScript, implemented by `loader.js` and `apps/web`)

```ts
export interface ZsBootConfig {
  buildId: string;
  // sessionId is minted per /connect and informational (D1); the identity is workspace.id
  connect: { wsUrl: string; token: string; sessionId: string; takeover?: boolean; serverBuild?: string; sessionExpiresAt?: string };
  workspace: { id: string; paths: string[] };                          // id = the stable workspace identity (D1)
  settingsJson?: string;
  keymapJson?: string;
  backend?: "auto" | "webgpu" | "webgl";
  hostOs?: "mac" | "windows" | "linux";
}

export type ZsBootStage = "booting"|"assets"|"settings"|"connecting"|"database"|"languages"|"window"|"ready"|"reconnecting"|"stopped"|"failed";
export type ZsLifecycleKind = "idle_stop_in" | "session_cap_in" | "stopping" | "resumed";   // b4 §3.16 LifecycleKind::as_str() — snake_case; b9's SCREAMING_SNAKE copy (b9:1211) must adopt this spelling (b4 §7 item 21)
export type ZsStoppedDetail = "taken_over" | "session_busy" | "incompatible_server" | "server_stopping" | "unauthorized" | "workspace_stopped" | "reconnect_exhausted" | "quit";   // 3.28 close_code_detail

export interface ZsHost {
  bootProgress(stage: ZsBootStage, detail: string): void;              // "stopped" carries a ZsStoppedDetail
  refreshConnectInfo(): Promise<ZsBootConfig["connect"]>;             // POST /api/workspaces/{id}/connect (BUILD-SPEC 3.4 step 1, 4.1 reconnect); reject with { code: "unauthorized" } when the control-plane session is gone (terminal, D2) and { code: "stopped" } when the workspace is stopped (b9 409 workspace_stopped; terminal at once, D2); any other rejection is retried within the 20-attempt budget
  saveDocument(kind: "settings" | "keymap", json: string): Promise<void>;  // PUT /me/settings | /me/keymap; reject on a stale-version 409
  reportError(kind: "panic" | "boot", message: string, stack: string): void; // client-errors route (BUILD-SPEC 12)
  onLifecycle(kind: ZsLifecycleKind, seconds: number): void;          // shell renders the toast and posts keep-alive (BUILD-SPEC 7.3/7.5, b9)
  onClosed?(info: { code: number; reason: string }): void;            // optional (b9 §4.6): the server's last close frame on every terminal disconnect — 4001, 4005, 4002, 4006, 1001 (D3), or the synthesized 4003 — emitted right before bootProgress("stopped", …)
}
// Not part of the contract (declined in 3.21 with reasons): keepAlive, stop, setDirty, onExtensionsChanged, openExternal.
// D2's host `reconnect()` is a shell-side action (re-POST /connect, then reload the page), not a wasm export or host callback (3.28, 3.30).

export interface ZsBootError { code: string; message: string }        // rejection value of start(); code ∈ the 4.1 list

// exported by zed_web.js
export function start(configJson: string, assets: Uint8Array, host: ZsHost): Promise<void>;   // single-shot
export function flush_client_state(): Promise<void>;
export function set_hidden(hidden: boolean): void;
export function has_unsaved_changes(): boolean;
export function build_id(): string;
```

### 4.3 Session refresh hook

`bridge::JsSessionRefresh` implements b1's `remote::WebSocketSessionRefresh` (3.21): `refresh(&self, workspace_id: &str, reason: RefreshReason, cx: &mut AsyncApp) -> Task<Result<WebSocketSession { url, token, session_id }, RefreshError>>` (D1: the first argument is the stable identity; the result carries the new per-connect `session_id`). There is no channel pump: the trait method receives `&mut AsyncApp`, so the implementation spawns a foreground task that reads the main-thread `JsHost` directly. The refreshed `{url, token, session_id}` is written to b1's `WebSocketSessionState.current` and to the options snapshot by the transport (b1 §3.3 step 2) and mirrored in `bridge::SESSION` for HTTP use. `RefreshError::Stopped` and `RefreshError::Unauthorized` are terminal and end the retry budget immediately (D2); `Other` is retried by b1 with backoff up to 20 attempts / 8 s cap.

### 4.4 Remote client delegate

b1's `remote::WebSocketClientDelegate::new(on_status: impl Fn(Option<&str>, &mut AsyncApp) + Send + Sync + 'static)` (b1:232-236) — no local delegate type; `on_status` forwards to `bridge::progress(BootStage::Connecting, ..)`. Its `download_server_binary_locally`/`get_download_url` return ready errors (the sandbox provisions the server; b1:237), which is also what 3.9's wasm arms do for the desktop delegates.

### 4.5 Web default settings overrides (`zed_web_core::WEB_SETTINGS_OVERRIDES`, merged over `settings/default.json`)

```jsonc
{
  "telemetry": { "diagnostics": false, "metrics": false },
  "use_system_path_prompts": false,   // open_path_prompt against the sandbox (BUILD-SPEC 3.6 "Dialogs")
  "use_system_prompts": false,        // ui_prompt in-canvas prompts
  "auto_update": false,
  "restore_on_startup": "none",
  "window_decorations": "server"
}
```

(`base_keymap` is not overridden; the user's own value applies, resolved per host OS by 3.23.)

### 4.6 `assets/keymaps/web.json` (one file for every host OS, D12)

```jsonc
// web.json — loaded only in the browser build, last (after vim and specific-overrides; D12).
// Browsers own Cmd/Ctrl+W, T, N, Q, Shift+T and Ctrl+Tab (D12). This layer adds reachable
// alternatives and unbinds actions that have no meaning in a tab. Originals stay bound for
// keyboard-lock fullscreen. Both chord families live here: on a Windows/Linux host the browser
// produces `ctrl-` chords and `cmd-` (platform/Super) chords are unreachable; on a macOS host it
// is the reverse (`cmd-` = platform, gpui_web/src/events.rs:1247-1255). The `null` entries of the
// other family are no-ops on that host because the same chords are not bound in these contexts
// there (default-macos.json binds no ctrl-q/ctrl-shift-n in Workspace; default-linux.json binds
// no cmd-/super- chords at all, script/check-keymaps). A KeyContext `os ==` predicate cannot do
// this selection because the key is "unknown" on wasm (2.4).
[
  { "context": "Workspace", "bindings": {
      // Q — quit has no meaning in a tab
      "ctrl-q": null,                 // zed::Quit (default-linux.json:35)
      "cmd-q": null,                  // zed::Quit (default-macos.json:37)
      "cmd-h": null,                  // zed::Hide (default-macos.json:38)
      "cmd-m": null,                  // zed::Minimize (default-macos.json:40)
      // Shift+N — one window per tab
      "ctrl-shift-n": null,           // workspace::NewWindow (default-linux.json:665)
      "cmd-shift-n": null,            // workspace::NewWindow (default-macos.json:719)
      // W, Shift+T, T, N — alternatives reachable on every host
      "alt-w": ["pane::CloseActiveItem", { "close_pinned": false }],
      "alt-shift-t": "pane::ReopenClosedItem",
      "alt-t": "project_symbols::Toggle",
      "alt-n": "workspace::NewFile",
      // Ctrl+Tab — tab switcher and pane item navigation
      "ctrl-alt-tab": "tab_switcher::Toggle",
      "ctrl-alt-shift-tab": ["tab_switcher::Toggle", { "select_last": true }],
      "ctrl-pagedown": "pane::ActivateNextItem",
      "ctrl-pageup": "pane::ActivatePreviousItem",
      "cmd-shift-]": "pane::ActivateNextItem",
      "cmd-shift-[": "pane::ActivatePreviousItem"
  } },
  { "context": "Terminal", "bindings": { "alt-w": "pane::CloseActiveItem" } }
]
```

The exact alternative chords are a product decision (section 7 item 13; the known collisions are listed in 2.4: `alt-t`/`alt-shift-t` override `task::Rerun`/`task::Spawn` on Linux/Windows hosts because this layer loads last and both are `Workspace`-scoped; `alt-w` yields to `search::ToggleWholeWord` while a search bar is focused; `alt-n` yields to vim's `editor::SelectNextSyntaxNode` inside editors; `ctrl-pagedown`/`pageup` already mean pane navigation in `default-linux.json:497-498` and `vim.json`, but `default-macos.json:87, 93` bind them to `editor::LineUp/LineDown` in editors, which wins there; on macOS `alt-` chords compose characters because `WebKeyboardLayout` maps no key equivalents). The mechanism — one layer file, loaded last, both chord families, `null` unbinding — is fixed by D12. Actions named here all exist in the browser set (`pane`, `workspace`, `project_symbols`, `tab_switcher`).

### 4.7 Settings and `ui` crate additions — section 3.2 (`KeymapOs`, `default_keymap_path_for`, `specific_overrides_keymap_path_for`, `WEB_KEYMAP_PATH`, `BaseKeymap::asset_path_for`) and 3.2a (`PlatformStyle::set_platform_style`, wasm-only; `PlatformStyle::platform()` non-`const` on wasm).

## 5. Cargo/package changes

Workspace `Cargo.toml`:

```toml
# [workspace] members — insert alphabetically
    "crates/zed_web",
    "crates/zed_web_core",

# [workspace.dependencies] — new
tar = { version = "0.4", default-features = false }
zed_web_core = { path = "crates/zed_web_core" }

# after [profile.release.package] (line 1088-1089)
[profile.web-release]
inherits = "release"
debug = false
strip = "symbols"
opt-level = "z"
lto = "thin"
codegen-units = 1

# [workspace] exclude — the list b5 §3 item 4 creates for vendored path patches (D10); append
exclude = [ ..., "vendor/wasm_thread" ]

# next to [patch.crates-io] (line 976) — 3.33
[patch."https://github.com/zed-industries/wasm_thread"]
wasm_thread = { path = "vendor/wasm_thread" }
```

Existing workspace deps reused as-is: `wasm-bindgen = "0.2.120"` (`:898`), `wasm-bindgen-futures = "0.4"` (`:899`), `js-sys = "0.3"` (`:667`), `web-time = "1.1.0"` (`:902`), `console_error_panic_hook` (`:583`), `time` (`:831`, gets the `wasm-bindgen` feature from `zed_web` below as b5 §3 item 15 asks; feature unification applies it to the whole wasm build), `serde_json_lenient`, `git` (`:354`), `language_onboarding` (`:393`).

`crates/client/Cargo.toml`: no change here — b6 §5 (b6:915-925) owns the move of lines 21, 34, 36, 41, 57, 58, the added `web-time`, and the `not(target_family = "wasm")` re-gate of lines 81-86.

`crates/language_models/Cargo.toml`: delete lines 19-22, 24, 36, 41, 64 and add

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
aws-config = { workspace = true, features = ["behavior-version-latest"] }
aws-credential-types = { workspace = true, features = ["hardcoded-credentials"] }
aws-sigv4.workspace = true
aws_http_client.workspace = true
bedrock = { workspace = true, features = ["schemars"] }
extension_host.workspace = true
gpui_tokio.workspace = true
tokio = { workspace = true, features = ["rt", "rt-multi-thread"] }
```

`crates/agent_ui/Cargo.toml`: delete 54, 62; add `[target.'cfg(not(target_family = "wasm"))'.dependencies] extension_host.workspace = true` and `gpui_tokio.workspace = true`. Lines 25/40 (`audio` feature) unchanged.

`crates/settings_ui/Cargo.toml`: delete 23 (`audio`), 32 (`cpal`), 37 (`extension_host`), 57 (`rodio`); add the NATIVE block with `audio.workspace = true`, `cpal.workspace = true`, `extension_host.workspace = true`, `rodio.workspace = true`.

`crates/recent_projects/Cargo.toml`: delete 24, 26; add the NATIVE block with `dev_container.workspace = true` and `extension_host.workspace = true`.

`crates/remote_connection/Cargo.toml`: delete 21; add the NATIVE block with `auto_update.workspace = true`.

`crates/activity_indicator/Cargo.toml`: delete 20, 22; add `web-time.workspace = true` to `[dependencies]` (3.10; `web-time` is at workspace `Cargo.toml:902`); add the NATIVE block with `auto_update.workspace = true` and `extension_host.workspace = true`.

`crates/ui/Cargo.toml`: no change (3.2a uses `std::sync::OnceLock`).

`crates/sidebar/Cargo.toml`: line 24 becomes `agent_ui.workspace = true`; add `[target.'cfg(not(target_family = "wasm"))'.dependencies] agent_ui = { workspace = true, features = ["audio"] }`.

`crates/title_bar/Cargo.toml`: delete 34, 37, 38, 48; line 46 becomes `gpui.workspace = true`; line 19 (`"call/test-support"`) unchanged; add

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
auto_update.workspace = true
call.workspace = true
channel.workspace = true
gpui = { workspace = true, features = ["screen-capture"] }
livekit_client.workspace = true
```

`crates/zed_web_core/Cargo.toml` (new):

```toml
[package]
name = "zed_web_core"
version = "0.1.0"
edition.workspace = true
publish.workspace = true
license = "GPL-3.0-or-later"

[lints]
workspace = true

[lib]
path = "src/zed_web_core.rs"

[dependencies]
anyhow.workspace = true
collections.workspace = true
serde.workspace = true
serde_json.workspace = true
serde_json_lenient.workspace = true
tar.workspace = true

[dev-dependencies]
settings.workspace = true   # default_settings() for the merge test
```

`crates/zed_web/Cargo.toml` (new; `gpui_web` pattern — every Zed and wasm dependency in the wasm table, crate root `#![cfg(target_family = "wasm")]`, so native workspace commands see an empty crate):

```toml
[package]
name = "zed_web"
version = "0.1.0"
edition.workspace = true
publish.workspace = true
license = "GPL-3.0-or-later"

[lints]
workspace = true

[lib]
path = "src/zed_web.rs"
crate-type = ["cdylib", "rlib"]

[features]
default = ["multithreaded"]
multithreaded = ["gpui_web/multithreaded"]

[dependencies]
zed_web_core.workspace = true

[build-dependencies]
cargo_toml.workspace = true
toml.workspace = true

[target.'cfg(target_family = "wasm")'.dependencies]
# platform
anyhow.workspace = true
futures.workspace = true
log.workspace = true
serde.workspace = true
serde_json.workspace = true
gpui.workspace = true
gpui_platform.workspace = true
gpui_web.workspace = true
smol.workspace = true                      # the b5 shim: smol::runtime::install_runtime
wasm-bindgen.workspace = true
wasm-bindgen-futures.workspace = true
js-sys.workspace = true
web-sys = { version = "0.3", features = ["Window", "Navigator", "Location", "Document", "console"] }
web-time.workspace = true
time = { workspace = true, features = ["wasm-bindgen"] }
getrandom = { version = "0.3", features = ["wasm_js"] }   # b6 §7 item 9 / b5 §2: the feature is what selects the backend (gpui already enables it; repeated so the guarantee is local)
util = { workspace = true, features = ["debug-embed"] }
uuid.workspace = true
# (no `inventory`: the ctor assertion of 3.27 step 2 goes through db::registered_migration_count(), b6 §3.4)
# foundation
assets.workspace = true
client.workspace = true
clock.workspace = true
collections.workspace = true
db.workspace = true
extension.workspace = true
feature_flags.workspace = true
fs.workspace = true
git.workspace = true
http_client.workspace = true
language.workspace = true
languages = { workspace = true, features = ["load-grammars"] }
menu.workspace = true
node_runtime.workspace = true
paths.workspace = true
project.workspace = true
release_channel.workspace = true
remote.workspace = true
session.workspace = true
settings.workspace = true
theme.workspace = true
theme_settings.workspace = true
theme_extension.workspace = true
language_extension.workspace = true
debug_adapter_extension.workspace = true
ui.workspace = true
ui_prompt.workspace = true
workspace.workspace = true
zed_actions.workspace = true
zed_credentials_provider.workspace = true
# editor and panels
agent_settings.workspace = true
agent_ui.workspace = true
acp_tools.workspace = true
activity_indicator.workspace = true
breadcrumbs.workspace = true
call_hierarchy.workspace = true
channel.workspace = true
command_palette.workspace = true
copilot_chat.workspace = true
copilot_ui.workspace = true
dap_adapters.workspace = true
debugger_tools.workspace = true
debugger_ui.workspace = true
diagnostics.workspace = true
edit_prediction.workspace = true
edit_prediction_ui.workspace = true
editor.workspace = true
encoding_selector.workspace = true
file_finder.workspace = true
git_hosting_providers.workspace = true
git_ui.workspace = true
go_to_line.workspace = true
image_viewer.workspace = true
json_schema_store.workspace = true
keymap_editor.workspace = true
language_model.workspace = true
language_models.workspace = true
language_onboarding.workspace = true
language_selector.workspace = true
language_tools.workspace = true
line_ending_selector.workspace = true
lsp_locations.workspace = true
markdown_preview.workspace = true
migrator.workspace = true
notifications.workspace = true
outline.workspace = true
outline_panel.workspace = true
platform_title_bar.workspace = true
project_panel.workspace = true
project_symbols.workspace = true
prompt_store.workspace = true
recent_projects.workspace = true
repl.workspace = true
search.workspace = true
settings_profile_selector.workspace = true
settings_ui.workspace = true
sidebar.workspace = true
snippet_provider.workspace = true
snippets_ui.workspace = true
svg_preview.workspace = true
tab_switcher.workspace = true
tabular_data_preview.workspace = true
tasks_ui.workspace = true
terminal_view.workspace = true
theme_selector.workspace = true
title_bar.workspace = true
toolchain_selector.workspace = true
vim.workspace = true
vim_mode_setting.workspace = true
web_search.workspace = true
web_search_providers.workspace = true
which_key.workspace = true

[target.'cfg(target_family = "wasm")'.dev-dependencies]
wasm-bindgen-test = "0.3"

[package.metadata.cargo-shear]
ignored = ["web-time", "time", "util", "getrandom", "smol"]
```

Feature-set invariant (b5 item 12, §9): no dependency of `zed_web` enables a `test-support` feature that reaches `grammars` (`crates/grammars/Cargo.toml:60` re-enables tree-sitter's `wasm` feature and therefore wasmtime); `languages = { workspace = true, features = ["load-grammars"] }` is the only feature enabled here, and `check_forbidden_crates` (section 6) catches a regression through `wasmtime`.

Not depended on, by design (BUILD-SPEC 3.1 "Excluded"): `zed`, `auto_update`, `auto_update_ui`, `install_cli`, `crashes`, `call`, `collab_ui`, `livekit_client`, `feedback`, `onboarding`, `dev_container`, `extension_host`, `extensions_ui` (deferred to the b4 follow-up), `remote_server`, `cli`, `gpui_tokio`, `reqwest_client`, `audio`, `journal`, `inspector_ui`, `component_preview`, `miniprofiler_ui` (std `Instant`, 2.5). `askpass` is not depended on directly but stays in the closure through `remote`, `recent_projects` and `remote_connection`.

`crates/util/Cargo.toml`: no change (`debug-embed` exists at line 20).

## 6. Tests

Unit, native (`cargo test -p zed_web_core`; the crate has only pure dependencies):

- `asset_pack::tests::tar_roundtrip`: build a tar in memory with `tar::Builder` containing `fonts/lilex/Lilex-Regular.ttf` (16 bytes), `themes/one.json`, `./icons/a.svg`; assert `from_tar` yields 3 files, `get("icons/a.svg")` returns the bytes (leading `./` stripped), `list("fonts")` returns exactly the font path, and `list("themes")` includes the theme.
- `asset_pack::tests::tar_rejects_garbage`: `from_tar(b"not a tar")` is `Err`.
- `asset_pack::tests::tar_rejects_traversal`: entries `../x`, `/etc/passwd` and `a/../../b` each make `from_tar` return `Err` naming the entry; a directory entry is skipped, not rejected.
- `asset_pack::tests::tar_rejects_oversize`: 8193 zero-length entries → `Err`; one 65 MiB entry → `Err`.
- `boot_config::tests::parses_minimal`: JSON with only `buildId`, `connect`, `workspace` parses; `settings_json == ""`, `backend == Auto`, `host_os == None`, `connect.takeover == false`, `workspace.paths` may be empty.
- `boot_config::tests::rejects_missing_connect`: error mentions `connect`.
- `boot_config::tests::boot_stage_names_are_snake_case`: every `BootStage::as_str()` matches `^[a-z_]+$` and is unique; `BootError` serializes as `{"code":..,"message":..}` (both are part of the JS contract).
- `host_os::tests::from_platform_strings`: `"MacIntel"`→Mac, `"Win32"`→Windows, `"Linux x86_64"`→Linux, `"iPhone"`→Mac (Safari on iPad reports `MacIntel`); `from_override("windows")` wins over detection; `from_override("amiga")` is `None`.
- `web_settings::tests::merge_keeps_default_keys`: `merge_web_defaults(settings::default_settings())` parses, `telemetry.metrics == false`, `use_system_path_prompts == false`, and every top-level key of `settings::default_settings()` is still present.

Settings crate (`cargo test -p settings`):

- `settings::tests::keymap_paths_by_os`: `default_keymap_path_for(Mac) == "keymaps/default-macos.json"`, `Windows` → `default-windows`, `Linux` → `default-linux`; `specific_overrides_keymap_path_for(Mac)` ends with `-macos.json`; `WEB_KEYMAP_PATH == "keymaps/web.json"` and `SettingsAssets::get(WEB_KEYMAP_PATH).is_some()` (the file is embedded).
- `settings::tests::base_keymap_asset_path_matches_host`: for every `BaseKeymap` variant, `asset_path() == asset_path_for(KeymapOs::current())` (guards the refactor of `base_keymap_setting.rs:98-125`); `TextMate.asset_path_for(Linux).is_none()`.
- `settings::tests::watch_settings_files_applies_initial_contents` (`#[gpui::test]`, `FakeFs`): after 3.17, native still applies both files synchronously (the callback has fired before `watch_settings_files` returns).

`keymap_editor` crate (`cargo test -p keymap_editor`; it already depends on `workspace`, `pane`, `project_symbols`, `tab_switcher` through its dev-deps — `settings` cannot host this test because those crates depend on `settings`):

- `keymap_editor::tests::web_keymap_parses` (`#[gpui::test]`): `KeymapFile::load_asset(settings::WEB_KEYMAP_PATH, Some(KeybindSource::Default), cx)` succeeds with the actions registered (same setup as `collect_contexts_from_assets`, `keymap_editor.rs:3739-3749`), and the loaded bindings contain both `ctrl-q` → unbound and `cmd-q` → unbound (both chord families parse on every host: `Keystroke::parse` maps `cmd` to `platform` everywhere, `keystroke.rs:152-157`).
- `keymap_editor::tests::web_keymap_nulls_are_noops_on_the_other_host` (`#[test]`, pure JSON): every `null` entry of `web.json` whose chord starts with `ctrl-` is absent from `default-macos.json`'s `Workspace`-context sections, and every `cmd-` entry is absent from `default-linux.json` (which `script/check-keymaps` already guarantees) — the property 2.4/4.6 rely on.
- `script/check-keymaps` passes with `web.json` in its `cmd-` exclusion list (3.3).

`ui` crate (`cargo test -p ui`): `platform_style_native_unchanged` — on the host, `PlatformStyle::platform()` still equals the `cfg!(target_os)` table (guards 3.2a's `cfg` split; the wasm arm is covered by the browser test below).

`project` crate: `project_settings::tests::global_tasks_applied_after_first_tick` (`#[gpui::test]`): with 3.17, `SettingsObserver::new_remote` still sees the global `tasks.json` after `cx.run_until_parked()` on native (the synchronous path) — the test guards that the cfg split did not change native ordering.

Gated crates (native tests must stay green; wasm compile is the test):

- `language_models`: existing tests unchanged; `check_wasm -p language_models` is the assertion that `AllLanguageModelSettings` builds without the `bedrock` field.
- `title_bar`: native tests unchanged (`update_version.rs:140-177` still run natively). The wasm stubs in `collab_web.rs`/`update_version_web.rs` are verified by `check_wasm -p title_bar`.
- `recent_projects`: `cargo test -p recent_projects` covers the native path; the wasm variant-gated `Mode` enum and the gated `render_config_selection` are verified by `check_wasm`.
- `settings_ui`, `sidebar`, `agent_ui`, `activity_indicator`, `remote_connection`: `cargo test -p <crate>` unchanged; `check_wasm -p <crate>` as each lands (3.32).

Browser unit tests (`wasm-bindgen-test` in `crates/zed_web/tests/`, headless Chrome via `wasm-pack test --headless --chrome`; BUILD-SPEC 13):

- `keymap_dropped_bindings_are_allowlisted`: `load_default_keymap(Linux, cx)` and `(Mac, cx)` return a dropped-binding set equal to the allow-list (`collab_panel::*`, `onboarding::*`, `welcome::*`, `zed::*`, ...); any new name fails the test. Both runs load `web.json` last with the strict loader (a typo there fails the test, not boot).
- `web_layer_wins_last`: after `load_default_keymap(Linux, cx)`, `alt-t` in a `Workspace` context resolves to `project_symbols::Toggle` (not `task::Rerun`, `default-linux.json:731`) and `ctrl-q` resolves to nothing; after `(Mac, cx)`, `cmd-q`/`cmd-h`/`cmd-m` resolve to nothing and `cmd-shift-]` to `pane::ActivateNextItem` (D12's "loaded last").
- `platform_style_follows_host_os`: `PlatformStyle::set_platform_style(Windows)` then `PlatformStyle::platform() == Windows`; a second `set_platform_style(Mac)` does not change it (3.2a; D12).
- `settings_init_is_synchronous`: after `settings::init(fs, "{\"ui_font_size\": 20}", cx)`, `ThemeSettings` reads 20 before any executor tick.
- `web_default_settings_parse_in_store`: `SettingsStore::new(cx, web_default_settings())` succeeds.
- `alt_w_does_not_insert_text` (product decision for 4.6): synthesize an `alt-w` keydown into an editor and assert the buffer is unchanged.
- `flush_pending_saves_drains_dirty_files`: write `settings.json` through `WasmFs`, call `flush_pending_saves` within the 750 ms debounce, assert `saveDocument("settings", …)` was called exactly once and the debounce timer no longer fires (3.24; b6 §7 item 8).
- `memory_grow_after_boot`: after `start`-equivalent setup, `WebAssembly.Memory.grow(16)` followed by a glue call does not throw `RangeError` (the 3.31 step 4b patch decision).
- `sqlite_image_round_trip_across_workers`: written by b6 (b6 §6) into this suite — `AppDatabase::open_with_image(None)` on the main thread, `GlobalKeyValueStore::init(&db)`, a KVP written from a `spawn_dedicated` worker and a global KVP from the main thread, `serialize()`, reopen with the image, read both back (the D7 fold and the cross-thread use b4's `ClientStateStore` depends on). Listed here so the suite's inventory is complete; b6 owns the test body.

xtask / CI:

- `check_forbidden_crates` (in `web_bundle.rs`, also run by the `check_wasm` step): for each forbidden crate run `cargo tree -i <crate> -p zed_web --target wasm32-unknown-unknown -e normal` (per-crate inverse queries; a full `--no-dedupe` closure of the browser set takes more than six minutes on this checkout) with `RUSTC_BOOTSTRAP=1` and assert "nothing to print"/no path. Forbidden: `wasmtime`, `cranelift-codegen`, `livekit`, `webrtc-sys`, `aws-config`, `aws-sdk-bedrockruntime`, `aws-lc-sys`, `rustls-platform-verifier`, `tiny_http`, `tokio`, `tokio-rustls`, `tokio-native-tls`, `gpui_tokio`, `extension_host`, `call`, `dev_container`, `auto_update`, `http_client_tls`, `bedrock`, `reqwest`, `audio`, `cpal`, `rodio`, `miniprofiler_ui`. Whether `rustls`/`ring` join the list is decided by the first `cargo tree -i rustls` run after b6's TLS gate (they should be absent; if another closure crate pulls them, that is not this brief's edge). Unit-test the parser with a canned `cargo tree -i` output containing `wasmtime v48.0.0` and assert the error names it.
- `web_bundle::tests::build_id_default_shape`: default build id matches `^[0-9a-f]{7,12}-\d+$`.
- `web_bundle::tests::vendored_wasm_thread_has_no_eval`: `grep -rn 'js_sys::eval' vendor/wasm_thread/src` is empty and `vendor/README.md` names `0cf96c7708dfb97ccf3da50347e25edcf75d6937` as the upstream rev (3.33; D10); `cargo xtask web-bundle --check-only` runs it too.
- `check_wasm` CI job (3.32): `script/check-wasm` with no arguments and the staged `default_packages` list; native `cargo check --workspace`, `script/clippy`, `cargo shear` and the crate tests listed in 3.32 stay green.
- Nightly `web_bundle` CI job (added to `run_bundling.rs` or a new workflow, out of this brief's diff): `cargo xtask web-bundle --max-brotli-bytes 20000000`, upload `build.json` as an artifact, and publish the bundle for b9 §3.30 — pack `<out_dir>/<build_id>/` as `editor/<build_id>.tar` and prepend the id to `editor/manifest.json` (`{ "builds": ["<build_id>", …] }`, newest first) at `ZS_EDITOR_BUNDLE_SOURCE` (b9 §3.2); this job is the only producer of both files, and `index.html`/`loader.js` inside the tar are the dev harness (b9 drops them); BUILD-SPEC 3.4 plans 15-18 MB brotli with grammars; `script/test-patch-wasm-bindgen-memory.sh` runs inside step 4b.

Browser integration (Playwright in `apps/web`, described here for the contract):

- Boot smoke: serve the dev harness with COOP/COEP against a `zed-remote-server serve` (b1/b2) in a container; assert `bootProgress` is called with `booting, assets, settings, connecting, database, languages, window, ready` in that order within 10 s and that the canvas paints (non-transparent pixel sample).
- Boot with `paths: []`: `ready` follows `window` with an empty project panel.
- Boot with a client-state image whose migration list is newer than the build: boot still reaches `ready` (b4's `RestoreOutcome::Skipped` → empty DB, read-only saver) and `bootProgress` never reports `failed`.
- Busy session: a second tab's `start` rejects with `{ code: "session_busy" }` (close 4005, D3); reloading it with `takeover: true` reaches `ready` and the first tab receives `onClosed({ code: 4001 })` then `stopped` with detail `taken_over` and does not call `refreshConnectInfo`.
- Reconnect: kill the server's socket; assert `refreshConnectInfo` is called (with a different `wsUrl` and a new `sessionId` on the second server, D1) and `reconnecting` then `ready` follow (BUILD-SPEC Appendix B "Reconnect"); after `ready`, an HTTP call through `bridge::current_session()` uses the rotated token, and the workspace persistence row is the same (`workspace_id` identity, D1: the restored layout is intact after the reconnect and after a full reload).
- Reconnect exhausted: make `refreshConnectInfo` reject with a transient error forever; within the D2 budget (20 attempts, backoff capped at 8 s — under three minutes) the tab receives `stopped` with detail `reconnect_exhausted`, then a Reconnect click (the shell's `reconnect()`, D2) reloads and reaches `ready` on a fresh session.
- Stopped workspace: make `refreshConnectInfo` reject with `{ code: "stopped" }` on the first reconnect attempt; `stopped` with detail `workspace_stopped` arrives after that single attempt, not after the budget (D2 `RefreshError::Stopped`); the same with `{ code: "unauthorized" }` → `unauthorized`.
- Server stop: SIGTERM the server; the tab receives `onClosed({ code: 1001 })` and `stopped` with detail `server_stopping` (D3; never 4004) and does not call `refreshConnectInfo`.
- Hidden tab: hide the tab for 10 minutes, return, assert no `reconnecting` was emitted and that `flush_client_state` ran within 5 s of hiding. Rationale after D3: the client sends the `Heartbeat` text frame every 5 s (b1 §3.3 step 4) from a gpui timer that the browser throttles in hidden tabs (to once per minute after ~5 min); b1 §3.3 asks the server to tolerate gaps of at least a minute, b2 §7 item 18 keeps a server → client frame beside it, and the proto `Ping`/`Ack` exchange still feeds `connection_activity_tx`. This case is the measurement of that tolerance (section 7 item 25).
- Keymap layer: with `hostOs: "linux"`, typing `alt-w` closes the active tab; with `hostOs: "mac"`, `cmd-shift-]` moves to the next tab; `ctrl-q` does nothing; with vim mode on, `alt-w` in normal mode still closes the tab (precedence decision, section 7 item 13).
- Settings save-back: change `ui_font_size` through the settings UI (opened in the modal, 3.7); assert `saveDocument("settings", …)` fires once within 1 s and its JSON contains the new value; three rapid changes within 750 ms produce one call.
- Settings UI: `OpenSettings` from the command palette shows the settings modal; no console error mentions `AlreadyOpen`.
- Unsaved buffer: dirty a buffer, trigger `beforeunload`; the dialog appears; after save it does not.
- Lifecycle: post `Stopping` to the server (`POST /control/lifecycle`, D5/b4 §3.10); `onLifecycle("stopping", 0)` fires and the server records a client-state save before it exits.
- Stop with unsaved buffers (BUILD-SPEC 13 chaos case; D6): dirty two buffers (one path-backed, one untitled), post `Stopping`; assert the file on the sandbox filesystem is **unchanged** (no autosave), the saved image contains one `unsaved_buffers` row for the path-backed buffer, and after the shell's reload (`reconnect()`, D2) both buffers reopen dirty with the edited text (the untitled one through `editors.contents`), and the row is cleared after the restore. Then change the file on disk between stop and reload: the reopened buffer shows a conflict rather than silently overwriting (b4 §3.8 `did_reload` with the stored mtime).
- Settings edit in the debounce window: change `ui_font_size` and hide the tab within 500 ms; assert `saveDocument("settings", …)` fires before `flush_client_state` returns (3.24 `flush_pending_saves`).
- Host OS: with `hostOs: "windows"`, the command palette renders `Ctrl`-style key glyphs and the title bar the Windows layout; with `"mac"`, ⌘ glyphs (3.2a; D12).
- Fonts: `document.fonts` is irrelevant (canvas); assert no console error from `add_fonts` and that `zed-assets.tar` is fetched exactly once.

## 7. Risks and open questions

1. **`open_remote_project_in_new_window_with_client` — decided (D16), delta closed.** 3.28 needs the workspace opened around an existing `Entity<RemoteClient>` because the client-state image (and therefore `WorkspaceDb`) comes over the session before `deserialize_remote_project` can run. b1 §3.12 (lines 367-408) now provides the `_with_client` form returning `OpenedRemoteProject { window, workspace, items }`, with the connection-taking form delegating to the same inner function. The placeholder-window path (two `Workspace`s on one `Project`, `workspace.rs:1610`; a held workspace in the sidebar, `multi_workspace.rs:1310-1328`) is not used anywhere. Residual: the exact `OpenedRemoteProject` field names are b1's (b1:369-372); 3.27/3.28 use `window`, `workspace`, `items`.
2. **CSP versus `wasm_thread` (decision recorded in 3.30; delivered per D10 in 3.33).** The pinned fork calls `js_sys::eval` at `utils.rs:15, 26, 34` and `mod.rs:60, 300`; BUILD-SPEC 7.6's `script-src 'self' 'wasm-unsafe-eval'` blocks JS `eval`. Owned here: the vendored copy `vendor/wasm_thread` (path `[patch]` over `https://github.com/zed-industries/wasm_thread`, README with the upstream rev and the intended git-patch form) replaces the `eval` sites with `js_sys::global()` lookups and reads the shim URL from `Builder::wasm_bindgen_shim_url` (`mod.rs:144-146`) or `globalThis.__zsBindgenShimUrl`; passing the URL explicitly at the two spawn sites (`gpui_web/src/dispatcher.rs:188`, `scheduler/src/scheduler.rs:215`) is the upstream-friendly follow-up once a fork repo exists. Fallback until 3.33 lands: `'unsafe-eval'` on the editor route only, behind b9's `ZS_CSP_UNSAFE_EVAL=1`.
3. **Static constructors and the wasm-bindgen memory patch.** `db` (`db.rs:37`), `settings` and `gpui` actions rely on `inventory`; the fork found the threads transform does not run `__wasm_call_ctors` and exported it (`zed-web main.rs:2107-2113`, `build.sh:45`) — also on wasm-bindgen 0.2.127 (`zed-web/web/build.sh:14`), which is newer than the 0.2.120 pinned here, so 0.2.120 is not proven to behave differently. 3.27 step 2 asserts `db::registered_migration_count() > 0` (b6 §3.4; error `ctors_missing`) and the loader calls the ctor helper once before `start`; calling ctors twice is idempotent for `inventory` (b6 §7 item 13) but the loader still never retries `start` in the same page without reloading. The fork's `DataView` growth retry is carried as 3.31 step 4b with its self-test; the `memory_grow_after_boot` test (section 6) decides whether it stays.
4. `Application::run` versus `run_embedded` on the web. `app.rs:234-245` drops `Application` after `platform.run` returns (immediately on the web, `platform.rs:307-330`); `hello_web` uses `run` (`main.rs:433`) and works, so the App must be kept alive elsewhere; the fork chose `run_embedded` + `mem::forget` (`zed-web main.rs:2192-2233`). The brief follows the fork; confirm with `hello_web` behaviour before relying on `run`.
5. **`PlatformStyle::platform()` is `Mac` on wasm — in scope now (D12, 3.2a).** `ui/src/styles/platform.rs:16-24` is a `const fn` on `cfg!(target_os)`; this is not only title-bar spacing — `ui::KeyBinding` renders ⌘/⌥ glyphs for Windows/Linux users everywhere key bindings are shown, including the command palette that 4.6's discoverability relies on. No call site uses it in a `const` position (2.1 lists all of them), so the wasm-only runtime override (`PlatformStyle::set_platform_style` into a `OnceLock`, read by a non-`const` `platform()` under `cfg(target_family = "wasm")`, set once from `HostOs` in 3.26 step 2) is the small `ui` change D12 permits. Residual: anything that caches `PlatformStyle::platform()` in a `static`/`LazyLock` upstream later would read `Mac` if it ran before `set_platform_style`; the boot order (3.26 step 2 precedes every `init`) keeps that from happening today.
6. **Single window.** `gpui_web` refuses a second `open_window` (`platform.rs:379`). 3.7 handles the settings window; `workspace::NewWindow`/`open_new` (`workspace.rs:10964`), `OpenRecent { create_new_window }` and the two `agent_ui` pop-outs (`agent_panel.rs:2726`, `conversation_view.rs:3007`) stay reachable from the command palette and log `AlreadyOpen`; hiding them (a `CommandPaletteFilter` entry from `workspace_chrome`) is a follow-up.
7. **`watch_settings_files` async split (3.17).** On wasm the loop's first iteration applies the initial documents; if the loop body diverges from the synchronous first-load code (e.g. notification wording), native and web differ subtly. The `settings_init_is_synchronous` test pins the boot-visible behaviour; a diff review of the loop body against `:370-380` is part of implementation.
8. **`WasmFs` (b6 §3.2/4.1)**: `new(BackgroundExecutor) -> Arc<WasmFs>`, `insert_file`, per-file watch events with 100 ms/500 ms latency, `canonicalize` erroring for missing files (`watch_config_file` falls back to the raw path, `settings_file.rs:178`). The save-back hook (3.24) and the keymap watcher depend on those semantics; b6's `test_wasm_fs_watch_config_file_end_to_end` is the guard.
9. **Reconnect budget and resume (decided, D2/D3).** `max_reconnect_attempts()` = 20 with an 8 s backoff cap (D2; b1:224) and `refreshConnectInfo()` may block while `/connect` waits for the sandbox (b9 polls `202`/`423` for up to 5 min inside one attempt); a resume that still exceeds the budget ends in `ReconnectExhausted` → `Stopped` with detail `reconnect_exhausted` and the last `CloseInfo` in the message. A stopped workspace is `RefreshError::Stopped` and ends the budget at once (D2). D2's host `reconnect()` is implemented as the shell's re-`/connect` + page reload (3.28, 3.30): a fresh session under D3 (the `HeadlessProject` is reset; PTYs survive; dirty text returns via D6), not a warm attach. An in-page re-dial (a new `RemoteClient` under the same App, `ClientStateStore::rebind`) is not planned because `gpui_web` cannot reopen its window (`platform.rs:381`). A `reason` on `RemoteClientEvent::Disconnected` (b1 §7 item 6) remains the upstream-friendly follow-up; until then `last_close()` plus `bridge::last_refresh_error()` carry the reason.
10. Crates kept in the closure but not compile-verified on wasm in this brief: `channel`, `notifications`, `git_hosting_providers`, `web_search_providers`, `repl`, `acp_tools`, `copilot`, `copilot_chat`, `copilot_ui`, `zed_credentials_provider` (keyring), `askpass` (transitively via `remote`, `recent_projects`, `remote_connection`), `recent_projects`/`remote_connection` themselves (kept by `title_bar`, 3.11), `sysinfo` in `git_ui` (`git_runtime_diagnostics.rs`). Each is either a leaf brief or a follow-up gate; the staged `check_wasm` list (3.32) surfaces them in dependency order.
11. **Token expiry.** `bridge::ensure_fresh_token` (3.21) refreshes 60 s before `sessionExpiresAt`; the socket itself survives expiry (b1), so only HTTP calls made by later briefs need it, and they must call it before each request. `session_id` stability (b1 §7 item 3, b9 §7 item 3) is closed by D1: the workspace DB row and the pool key are `workspace_id` (= `BootConfig.workspace.id`), which survives stop/resume, takeover and rebuild (the image itself lives in `$HOME/.local/share/zed`, which D9's rebuild tarball carries); `session_id` rotates per `/connect` and nothing here keys on it.
12. BUILD-SPEC 3.7 promises JSON editing of settings and keymap "unchanged"; opening `paths::settings_file()` as an editor buffer needs a buffer backed by the client-side `WasmFs`, and `Project::remote` only opens sandbox files. v0 offers the settings UI (in the modal of 3.7) and the keymap editor (a pane item, `keymap_editor.rs:1949`), both writing through `update_settings_file`/`WasmFs`; an editor-buffer path over `WasmFs` is a follow-up.
13. **Keymap alternatives.** `alt-` chords on macOS produce composed characters in text inputs unless the keyboard mapper's key equivalents are honoured; `WebKeyboardLayout` implements only `id()`/`name()` (`keyboard.rs:1-12`), so on a Mac host `alt-w` types `∑` in an editor today. The layer loads last (D12), so an `alt-` alternative beats a vim or default binding whenever the contexts are equal, and loses only to deeper contexts (2.4 lists the collisions: `task::Rerun`/`task::Spawn` are overridden on Linux/Windows hosts, `search::ToggleWholeWord` and vim's `alt-n` win while their deeper contexts are focused). The chords in 4.6 are placeholders for a product decision made with those constraints; the file, its position and the remapped set are D12's; the `alt_w_does_not_insert_text`/`web_layer_wins_last` tests and the vim Playwright case pin whatever is chosen.
14. `__wasm_call_ctors`, `--initial-memory`, `--max-memory` and `--shared-memory` in `.cargo/config.toml` (b5 + 3.16) apply to every wasm32 build in the workspace, including the `check_wasm` job and `cargo xtask web-examples` (`web_examples.rs:50-58`); the examples currently rely on the `hello_web/.cargo/config.toml` (1 GiB max). Harmless for `check`, but the examples pipeline should be re-run once.
15. Safari and non-isolated contexts. The shared-memory build requires `crossOriginIsolated`; `gpui_web`'s single-thread fallback (`dispatcher.rs:164-175`) cannot rescue an instantiation that fails on a missing `SharedArrayBuffer`. A separate single-threaded bundle (`--no-default-features`) is possible but not planned; BUILD-SPEC 15 item 4 already flags Safari verification for month one.
16. wasm-opt feature flags. Rust ≥ 1.82 enables reference types and multivalue by default on `wasm32-unknown-unknown`; the flag set in 3.31 step 5 is the minimum that keeps `wasm-opt` from rejecting the module, but binaryen's version matters (≥ 116). Verify in CI and pin the version in the toolchain image.
17. Size and `assets` split. 3.14 halves the embedded assets; `editor`, `markdown` and `prompt_store` depend on `assets` but none calls `Assets::get`/`asset_str::<Assets>` directly (2.4), so they read through `cx.asset_source()` and see the tarball. Any future direct read of `images/**`/`icons/**` would miss on wasm; `check_wasm` cannot catch that, only the boot smoke test can.
18. Edit-prediction provider registration (`crates/zed/src/zed/edit_prediction_registry.rs`, `main.rs:703`) and `extensions_ui` are not wired in v0; the former needs a web copy limited to providers that work without Zed sign-in (BUILD-SPEC 8), the latter the b4 follow-up.
19. The two `inline_assistant.rs`/`agent` evals reference `gpui_tokio` only under `feature = "unit-eval"` + `test`; `cargo test --all-features` on native is unaffected by the target block in `agent_ui/Cargo.toml` because the dev/test path is native-only. If `unit-eval` ever runs on wasm, the dev-dependency must move too.
20. **Flush ordering and unsaved buffers (D6/D7).** `flush_client_state` sends `SaveClientState` over the socket; b1's io-task guard closes the socket when the transport is killed, and a 4001 arrives before any flush. The D7 triggers are the 15 s dirty ticker, `visibilitychange` → hidden (with the 5 s interval while hidden) and the `Stopping` flush; `pagehide` is best-effort on top; after any `Disconnected` the store is stopped and a flush returns `Err`, which 3.27 swallows rather than surfaces. Unsaved buffers: on `Stopping` the snapshot of D6 (`snapshot_unsaved_buffers`, then `flush_now`) puts every dirty path-backed buffer's text into the image and the next open restores it dirty (`restore_unsaved_buffers` after the workspace opens) — the client never autosaves to the workspace filesystem, so b1 §7 item 9's "server keeps its copy" no longer applies (a reload is a fresh session, D3). Not covered by D6: a tab killed without a `Stopping` notice (takeover, crash, reconnect exhausted) still relies on the throttled `editors.contents` and on `has_unsaved_changes` + `beforeunload` for navigation (b4 §7 item 22); a copy/export of dirty buffers after a terminal close remains a follow-up.
21. **`on_app_quit` hooks never run in the browser** (`gpui_web/src/platform.rs:488-490` only stores the callback). `workspace::init`'s serialization flush and any other `cx.on_app_quit` user are therefore skipped; the loader's `pagehide` export covers the client-state image only. Wiring `pagehide` to the quit callbacks inside `gpui_web` is the upstream-friendly fix (follow-up).
22. **Panic reporting off the main thread.** The chained hook (3.21) can only `console.error` on `wasm_thread` workers; the main thread reports the flag on its next tick, so a panic that hangs the main thread is reported by nobody but the shell's own `error`/`unhandledrejection` listeners (BUILD-SPEC 12).
23. `title_bar`'s dependence on `recent_projects` and `remote_connection` (`Cargo.toml:50`, `:52`) keeps those crates and `askpass` in the closure regardless of the collab gate; if they fail to compile on wasm after their own briefs, the fallback is gating the three popover call sites (`title_bar.rs:664`, `:848`, `:900`).
24. **`KeyContext` `os` key is `"unknown"` on wasm** (`gpui/src/keymap/context.rs:30-46`). Consequences: the two `os == windows` sections of `vim.json:442, 448` never match for a Windows-host browser user, and no keymap can branch on the host OS. A wasm-only runtime override in gpui (same shape as 3.2a's `OnceLock`, set from `HostOs`) would fix both and would let `web.json` use `os ==` predicates instead of carrying both chord families; it is a second upstream-crate change not covered by D12 and is a follow-up. Until then 4.6's single file relies on the no-op property verified by `web_keymap_nulls_are_noops_on_the_other_host`.
25. **Heartbeat direction (D3 versus b1 §7 item 8 / b2 §7 item 18).** D3 fixes the client → server `Heartbeat` every 5 s and b1 §3.3 step 4 implements it from a gpui timer; b1's §7 item 8 and b2 still describe a server → client frame, which b2 keeps beside the client's and flags for confirmation. For this brief the only consequence is the hidden-tab behaviour: browsers throttle the client's timer in hidden tabs, so the server's tolerance for heartbeat gaps (b1 asks for at least a minute) decides whether a hidden tab comes back `ready` or `reconnecting`; the Playwright hidden-tab case measures it. No `zed_web` code sends or reads heartbeats.
26. **b1's tail is mid-amendment.** b1 §3 carries the decided shapes this brief consumes (D1 `new(url, workspace_id, session_id, token)`, `WebSocketSession { url, token, session_id }`, D2 `RefreshError::Stopped`, D3 `CLOSE_GOING_AWAY 1001`, D16 `_with_client`), while b1 §4.1 (`refresh(&self, session_id, ..)`, `RefreshError { Unauthorized, Other }`), §4.6 (`open_remote_project_in_new_window(connection, ..)`, 4004) and §7 items 3/8/9 still show the earlier text. This brief follows §3 and the decisions; if b1's §4.1 lands with a different first argument name for `refresh` nothing here changes (3.21 ignores it).
27. **`onLifecycle` spelling.** This brief and b4 §3.16 use snake_case (`"stopping"`); b9:787/1211 type the callback as SCREAMING_SNAKE (`"STOPPING"`). b4 §7 item 21 records that b9 should adopt the snake_case tags; until b9 is amended the shell's toast switch would not match.
28. **`ClientStateEvent::ReadOnly` policy.** 3.27 step 3d surfaces a `RestoreOutcome::Skipped` as a notification with an explicit "Discard saved layout" action (`allow_overwrite()`); nothing overwrites the server copy automatically. Whether an older tab should be allowed to overwrite a newer build's image at all is a product question; the conservative default is chosen here.
29. **Messages replayed right after `HelloAck` (round 3).** b2's `replay_after_attach` sends the last `PortsChanged` and a pending `LifecycleNotice { Resumed }` as soon as the session attaches, but on the web the `Project` (whose `Project::remote` registers the handlers for them) is only created in 3.27 step 3f, after the client-state round trip and `init_after_db`; creating it earlier is not possible because `LspStore::new_remote`/`track_worktree_trust` need `trusted_worktrees::init`, which reads the restored `WorkspaceDb`. As landed, `ChannelClient` (`crates/remote/src/remote_client.rs`) holds messages that arrive without a registered handler in a wasm-only buffer (`hold_until_handlers_exist`, at most 64) and `RemoteClient::replay_unhandled_messages` — called by 3.27 right after the `LifecycleNotice` subscription of step 3f — dispatches them and switches the buffer off; natively nothing changes (the branch is `cfg(target_family = "wasm")`). The upstream-friendly form is b2 re-running `replay_after_attach` on request.
30. **`repl` is not in the browser closure (deviation from 3.26 steps 25-26 and §5).** `repl` depends on `jupyter-websocket-client` (tokio) and `runtimelib` (aws-lc-rs), both forbidden crates of §6, and its kernel code uses their types throughout, so a gate is a leaf brief of its own (`crates/repl`), not an edge gate here. Until it lands `.ipynb` files have no notebook item in the browser and `repl::init`/`repl::notebook::init` are not called; `crates/zed_web/Cargo.toml` carries the `ZS-TODO(b7)` marker for the manifest line.
31. **Boot ordering fixes (round 3).** The boot timer now drops the `boot_in_app` task when it fires, so a first dial that completes after `boot_timeout` cannot open the window and emit `ready` behind the shell's back; `connect::observe` reports only state transitions and re-emits `ready` when a `HeartbeatMissed`/`Reconnecting` episode returns to `Connected` (a recovered heartbeat emits no `RemoteClientEvent`); the transport's `set_status` after the first `ready` is reported as `reconnecting` (3.28's `Connecting` mapping was for the boot dial only); `seed_config_files` drains `WasmFs::take_dirty()` after seeding so the first `flush_pending_saves` never PUTs the control plane's own copy back; a document the debounced save cannot read is skipped rather than saved empty; an empty `workspace.paths` opens the window on the bare remote project (b1's `open_remote_project_in_new_window_inner` only errors when a requested path failed to resolve), as step 3g always said.
32. **3.7 as landed.** The modal host lives in `settings_ui` (`SettingsModal`, `open_settings_editor_in_modal`, behind `cfg(target_family = "wasm")`) rather than in `zed_web::workspace_chrome`, and the `OpenSettings`/`OpenSettingsAt`/`OpenSettingsPage` handlers stay registered on both targets; `open_settings_editor_with` branches on the target. Equivalent to the contract (the settings UI works without a second `open_window`). The settings window's close paths (`open_current_settings_file`, the "Manage Trust" banner) go through `SettingsWindow::close_settings_editor`/`with_hosting_workspace`, which dismiss the modal in the browser instead of `window.remove_window()` (that would remove the only window and `gpui_web` cannot reopen one); "Edit in settings.json" shows a notification in the browser (item 12).
33. **3.20/3.23/3.24 naming as landed.** The settings module is `crates/zed_web/src/web_settings.rs` (`mod settings` would shadow the `settings` crate inside the entry crate); the lenient loader is `KeymapFile::load` + `set_meta` (the same result as `load_asset_allow_partial_failure`); a strict layer (`web.json`, the specific overrides) that fails to load makes `keymap::install` return an error and boot rejects with code `settings`, matching "fails loudly" (the desktop panics there). `script/build-web` defaults `--out-dir` to `target/web-bundle` and never writes the dev harness under a `public/` directory (`--out-dir ../apps/web/public/editor` stages a bundle for the app without it); `--serve` sends the editor CSP and refuses a harness-less out-dir; the harness moves `token=` from the URL into `sessionStorage` and carries `no-referrer`.
34. **3.33 as landed.** `vendor/wasm_thread` (rev 0cf96c7) with the five `js_sys::eval` sites replaced and the module-worker polyfill dropped; `script/build-web` fails closed when the vendored source calls `eval`, when the `[patch]` table is missing, or when the built `zed_web_bg.wasm`/`zed_web.js` still carries the removed scripts. b9 can flip `ZS_CSP_UNSAFE_EVAL` to `0`.
35. **Tests not yet landed (round 3).** The `wasm-bindgen-test` suite of §6 needs `zed_web` to compile on wasm and a headless-Chrome runner; neither exists yet (`script/check-wasm -p zed_web` still fails in `askpass`, `async-tar` via `dap`, `fuzzy_nucleo`, `pet-fs`/tree-sitter build scripts via `languages` and `keymap_editor` — sibling leaf gates). Landed natively instead: `settings::tests::watch_settings_files_applies_initial_contents`, `project_settings::tests::global_tasks_applied_after_first_tick`, `keymap_editor::tests::{web_keymap_parses, web_keymap_nulls_are_noops_on_the_other_host}`, `zed_web_core::web_settings::tests::web_defaults_parse_in_store`, `boot_config::tests::debug_redacts_the_token`, `asset_pack::tests::{tar_pax_long_names, pax_records_parse}`.

## 8. Review log

Each finding was checked against `/Users/ray/Projects/play/wed/zed` (and the sibling briefs) before acting on it. "R1" is the first reviewer, "R2" the second; line references are to this checkout unless noted.

### R1 — wrong claims

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | `client/Cargo.toml:84-86` TLS block is active on wasm | Accepted (`cfg(not(any(windows, macos)))`; `target_os = "unknown"` on wasm) | 3.4 now cites b6 §3.8, which re-gates both blocks; `tokio`, `tokio-rustls`, `tokio-native-tls` added to the forbidden list (§6). |
| 2 | `From<WebsocketError>` (`:260-271`) and `authenticate_as_admin` (`:1561-1607`, `Request::post` `:1581`) also break | Accepted | 3.4 rebased on b6 §3.8 (keeps the `From` impl ungated with a feature-less `async-tungstenite`; gates `authenticate_as_admin`). |
| 3 | `Unsupported` variant rationale ("enum non-empty") wrong | Accepted (`:244-258` has six variants) | Variant dropped; b6's `EstablishConnectionError::other(anyhow!(..))` stubs used. |
| 4 | `call/test-support` removal unnecessary | Accepted (scratch workspace at `scratchpad/featexp` checks on both targets) | `title_bar/Cargo.toml:19` left unchanged (3.11, §5). |
| 5 | `title_bar::init` attribution | Accepted (`collab_ui.rs:25`, `main.rs:771`; `crates/zed` never calls it) | 2.1 and 3.26 step 31 corrected; conclusion unchanged. |
| 6 | `Assets::load_fonts` is `:48-62` and enumerates the embedded set | Accepted (`self.list("fonts")` → `Self::iter()`, `:33-43`) | 2.4 and 3.14 rewritten: `Assets::load_fonts` is not used on wasm; `WebAssets::load_fonts` is. |
| 7 | `load_settings` returns `initial_user_settings_content()` on NotFound | Accepted (`settings_store.rs:545-556`) | 2.4 corrected. |
| 8 | `toggle_update_simulation` is `:548-552` | Accepted | 2.1 corrected. |
| 9 | `load_default_keymap(cx)` is `zed.rs:2205` | Accepted (`:2213` is `migrating_in_memory`) | 2.2 corrected. |
| 10 | `update_version.rs` tests start at `:140` (177 lines) | Accepted | 2.1 and §6 corrected. |
| 11 | `gpui_tokio/Cargo.toml:19` | Accepted | 2.1 corrected. |
| 12 | `reqwest_client/Cargo.toml:29-30` | Accepted | 2.1 corrected. |
| 13 | `gpui_platform:37-39`, `gpui_web` features `:12-14` / web-sys `:40-90` (92 lines), `scheduler:38-43` | Accepted | 2.3 corrected. |
| 14 | `hello_web/main.rs:410` / `:431` | Accepted | 2.3 corrected. |
| 15 | `build.sh` anchors off by one; RUSTFLAGS also exports `__heap_base`, `__stack_pointer` | Accepted (`build.sh:44-80`; exports verified) | 2.6 corrected; 3.16 notes the two extra exports are not carried unless step 4b needs them. |
| 16 | `main.rs:718`, `:871`, `:873`, `:875-878` | Accepted | 2.2 corrected. |
| 17 | `zed.rs:437-440`, `:921-923` | Accepted | 2.2 corrected. |
| 18 | `paths.rs:163-165`, `db.rs:37`, `settings.rs:121-127`, `assets.rs:10-24`/`:26-44` | Accepted | 2.4/2.5/3.1 corrected. |
| 19 | `remote_servers.rs:187`/`:201`, `client.rs:1430`, `proxy.rs:82-92`, `remote_connection.rs:488-518` | Accepted | 2.1/3.8 corrected. |
| 20 | "72 references" not reproducible (89 matching lines) | Accepted | 2.1 states the grep and its count. |
| 21 | `render_config_selection` (`:2456-2470`) reads the gated field | Accepted (`:2461`; called from `:2416`) | Added to the 3.8 gate list. |
| 22 | `manifest` still used at `:637` in `uninstall_server` | Accepted | 3.7 only silences `ext_id`. |
| 23 | `web_keymaps_parse` cannot live in `settings`; `check-keymaps` needs the `web-macos.json` exclusion | Accepted (`workspace` depends on `settings`; `check-keymaps:5-10`) | Test moved to `keymap_editor`; 3.3 adds the exclusion. *After D12 there is one file, `web.json`, and it is the one excluded from the `cmd-` grep (3.3); the test is `web_keymap_parses` (§6).* |
| 24 | `zed_web` does not compile natively as specified; native unit tests impossible | Accepted | `gpui_web` pattern adopted (`#![cfg(target_family = "wasm")]`, all deps in the wasm table); pure logic moved to `zed_web_core` (3.18) with native tests; `refresher_round_trip` deleted with the pump design. |
| 25 | `miniprofiler_ui::init` takes `std::time::Instant`; `now()` panics at runtime, "compiles" is the wrong test | Accepted (`miniprofiler_ui.rs:1-6`, `:83`; no `web-time` dep) | Skipped in v0 and removed from the manifest. |
| 26 | `copilot` feature gate is moot | Accepted (`language_models:31-32`, `settings_ui:30-31`, `copilot_ui:24`, `edit_prediction:28-29`, `edit_prediction_ui:22-24`) | Feature dropped; `copilot_chat::init`/`copilot_ui::init` unconditional; `copilot` listed in 2.1 and item 10. |
| 27 | Missing `git` and `language_onboarding` deps | Accepted (`main.rs:30`, `zed.rs:50`) | Added to §5; 3.26 step 7 uses `git::GitHostingProviderRegistry`. |
| 28 | Target rustflags table replaces `[build]` rustflags; CI env var drops `-D warnings` | Accepted in part: precedence confirmed (b5:15 documents it and repeats the flags); the `-D warnings` sub-claim is doubtful (`target.'cfg(all())'` entries concatenate with `target.<triple>` entries, `ci-config.toml:10`) but moot — 3.16/3.32 adopt b5's block and `script/check-wasm`, so the env var is never set. |
| 29 | `open_remote_workspace` uses an unbound `connection_options`; `init_before_connect` returns a non-`Result` yet uses `?` | Accepted (`workspace.rs:11099-11126`, `:11243-11262`) | 3.28 rewritten on b1's API; 3.26 returns `anyhow::Result<(Arc<Client>, Arc<ExtensionHostProxy>)>`. |
| 30 | `observe_active_settings_profile_name` is `pub` | Accepted (`settings_store.rs:338`) | Old item 7 removed. |
| 31 | `title_bar.rs:385`; `language_models.rs:50-103` | Accepted | 2.1/3.5 corrected. |

### R1 — missing items

| # | Item | Verdict | Action |
|---|---|---|---|
| 1 | TLS block re-gate | Accepted | b6 §3.8 owns it; cited in 3.4; forbidden list extended. |
| 2 | `From<WebsocketError>` / `authenticate_as_admin` gates | Accepted | b6 §3.8 owns them; cited. |
| 3 | `render_config_selection` gate | Accepted | 3.8. |
| 4 | `git` / `language_onboarding` deps | Accepted | §5. |
| 5 | Native compile of the crate root | Accepted | 3.19/3.20, `zed_web_core`. |
| 6 | `miniprofiler_ui` runtime panic | Accepted | Skipped. |
| 7 | `activity_indicator` needs a local `DismissMessage` action; nine use lines | Accepted (`:1, :3, :328, :561, :586, :678, :683, :687, :691`) | 3.10 enumerates them and defines `gpui::actions!(auto_update, [DismissMessage])` under wasm (same action name, no keymap binds it). |
| 8 | `WasmFs::canonicalize` used by `watch_config_file` | Accepted (`settings_file.rs:178`; b6 §4.1 line 543 implements it, `Err` when missing) | 2.4 and item 8 note the fallback. |
| 9 | `check_program` is private | Accepted (`web_examples.rs:20`) | Made `pub(crate)` in 3.31. |
| 10 | `title_bar` keeps `remote_connection`/`recent_projects` (and `askpass`) in the closure | Accepted (`Cargo.toml:50`, `:52`; `title_bar.rs:40`, `:614-660`, `:664`, `:848`, `:900`) | 2.1, 3.11 and item 23. |
| 11 | Placeholder workspace shares one `Project` with the real workspace | Accepted (`workspace.rs:1610`, `:11162-11190`; `remote_connections.rs:222-236` uses a separate local project) | 3.28 uses b1's no-placeholder entry point; the ordering problem it exposed is closed by D16 (`open_remote_project_in_new_window_with_client`, b1 §3.12). |
| 12 | `dirs`/`tar` wasm checks, `init_user_agents_md` signature, `RegisterSetting`, `RemoteConnection: Send + Sync`, `AsyncApp::open_window`, wasm_thread citations | Accepted as confirmations | Recorded in 2.3/2.5; old item 11 removed; `agent_settings.rs:27` cited in 3.26 step 24. |
| 13 | `settings.rs:102` `bedrock::RESERVED_HEADER_NAMES` inside the gated literal | Accepted | 3.5 says so explicitly. |

### R2 — wrong claims

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | b1/b5/b6 exist; b7 must rebase on them | Accepted (`docs/briefs/` has b1-b9) | Header rewritten with the exact items consumed; 3.4, 3.16, 3.21, 3.24, 3.28, 3.31, 3.32, 4.3, 4.4 rebased. |
| 2 | b1's `WebSocketConnectionOptions::new().with_takeover().with_refresh()`, `WebSocketSessionRefresh` trait with `&mut AsyncApp`; pump unnecessary | Accepted (b1:449-451, :492-495) | 4.3 replaced by `JsSessionRefresh`; `ConnectInfoRefresher`, `into_callback`, `spawn_refresh_pump` and `refresher_round_trip` deleted. (b1's trait returns `Task<Result<WebSocketSession, RefreshError>>`, not `Result<WebSocketSession>` as the finding wrote.) |
| 3 | 3.26 placeholder is worse than desktop's; use b1 §4.6 | Accepted (`workspace.rs:1610`; `multi_workspace.rs:1310-1328`) | 3.28 rewritten; the DB-before-workspace ordering required a b1 sibling entry point, since decided as D16 (b1 §3.12 `_with_client`). |
| 4 | b6 §3.8 owns the client edges; consume `sign_in_supported()` | Accepted (b6:402-427 at the time; b6:521-559 in b6's current revision) | 3.4 replaced with a citation; 3.11 hides the sign-in button (`title_bar.rs:389-390`, `:1198`) and empties the `UpgradeRequired` arm. |
| 5 | b5 owns config/toolchain/CI; b7's block drops `symbol-mangling`/`tokio_unstable`; env var must never be set | Accepted (b5:15-19, :118-148, :151-180, :411) | 3.16 reduced to one added flag; 3.31 step 2 deleted, step 3 uses `ZS_WASM_MODE=build script/check-wasm`; 3.32 extends b5 item 16. |
| 6 | Native tests in §6 cannot compile; `gpui_web`/`hello_web` precedent | Accepted (`gpui_web.rs:1`, `gpui_web/Cargo.toml:18`, `hello_web/Cargo.toml:1`) | `zed_web_core` + `#![cfg]` root; `wasm-bindgen-test` suite added. |
| 7 | `watch_settings_files` and `subscribe_to_global_task_file_changes` use `block_on` (wasm compile break, nobody owns it) | Accepted (`settings_store.rs:370-377`, `executor.rs:444-445`, `project_settings.rs:1013`, `:1482` in `new_remote`, called from `project.rs:1569`/`:1845`) | New 3.17; 3.24 applies the shell-provided document synchronously. |
| 8 | Settings UI is a second window; `gpui_web` allows one | Accepted (`settings_ui.rs:889`; `platform.rs:379`; fork `settings_ui.rs:440-460`) | 3.7 gates the four handlers and hosts the settings window in a modal; other `open_window` sites listed in 3.6 and item 6. |
| 9 | Strict `load_asset` fails at runtime on default keymaps that bind excluded-crate actions | Accepted (`default-linux.json:917`, `:1173-1189`, `:1432-1434`, `:1446`; `keymap_file.rs:194-196`, `:556-560`) | 3.23: lenient for default/base/vim with a logged dropped set, strict for the web layers; allow-list test in §6. |
| 10 | Hard-coded `"1.19.0"` | Accepted (`remote_server/build.rs`, `server.rs:648-652`) | `build.rs` + `env!("ZED_PKG_VERSION")` (3.20, 3.26 step 3). |
| 11 | `copilot` feature is a no-op | Accepted (duplicate of R1 #26) | Feature dropped. |
| 12 | `BootConfig::from_js` contradiction and `JSON.stringify` of a 6.5 MB array | Accepted | `start(config_json: String, assets: Uint8Array, host: JsValue)` (3.20, 4.2). |
| 13 | `WorktreeAdded` is emitted before the snapshot and never for empty `paths` | Accepted (`project.rs:3937-3939`) | 3.27 step 3g: `Ready` when the open task returns; empty paths ready immediately; 90 s `boot_timeout`. |
| 14 | wasm-bindgen memory patch dropped without evidence; fork pinned 0.2.127 | Accepted (`zed-web/web/build.sh:14`, fork lock `:21133-21134`; ours `Cargo.lock:20054-20055`) | Carried as 3.31 step 4b with its self-test; `memory_grow_after_boot` test; item 3. |
| 15 | `load_fonts` sentence misleading | Accepted (duplicate of R1 #6) | 3.14 rewritten. |
| 16 | b1 puts the browser JWT in a `?zs_token=` query parameter | **Rejected**: the current b1 keeps the token in `Sec-WebSocket-Protocol` on both targets through the patched `yawc::connect_with_protocols` (b1:149 "There is **no query-string token placement**", §3.18 lines 399-412, §4.3 lines 576-584, §7 item 1); the cited b1 lines (200-201, 461-466, 595) do not say what the finding says. 4.1's comment now cites b1 §4.3. |
| 17 | `call/test-support` strip unnecessary | Accepted (duplicate of R1 #4) | Line kept. |
| 18 | `dirs` 6 compiles on wasm; `/home/web` vs b6's `/home/zed` | Accepted (`dirs-6.0.0/src/lib.rs:28-30`) | Old item 11 removed; 3.1 keeps `/home/web` — since fixed by D11 (b6:30 now says the same); the test-fixture collision is only cosmetic (the wasm `home_dir` is a separate cfg arm) but a distinct root is still preferable. |
| 19 | `activity_indicator` has nine use sites and needs a local action | Accepted (duplicate of R1 missing #7) | 3.10. |

### R2 — missing items

| # | Item | Verdict | Action |
|---|---|---|---|
| 1 | b5's smol runtime adapter never installed | Accepted (b5 §4 `crates/zs_smol_shim/src/runtime.rs`, b5:532-573, §7 item 6 — b5 reinstated the `runtime` module for this delta; the earlier "b5:435-456" citation is stale) | 3.27 step 2 installs it first thing inside `run_embedded` and asserts `runtime_installed()`; `smol` added to §5. |
| 2 | b4's `LifecycleHooks` global never set; `keepAlive` callback; `save_all` before `Stopping` | Accepted in substance, API corrected: b4 deleted `LifecycleHooks` (b4:592, :663, :913); the current contract is `project::Event::LifecycleNotice` forwarded to JS plus `flush_now` on `Stopping`, with keep-alive posted by the shell from the toast (b4 §3.16, b9). 3.27 step 3e forwards via `onLifecycle`; 4.2 adds `onLifecycle`. *Superseded in part by D6: `save_all` on `Stopping` is replaced by `snapshot_unsaved_buffers` + `flush_now` (3.27 step 3e, 3.29).* |
| 3 | Takeover, typed `BootError`, 4001 handling, `DisconnectedOverlay` | Accepted (`disconnected_overlay.rs:43-47`, `recent_projects.rs:504`; b1 §4.6 step 4 at the time, now b1 §3.3 step 5; §7 item 6) | `connect.takeover`, `BootError { code, message }` (4.1), `connect::observe` maps `last_close()` codes to `Stopped` details (3.28; code table per D3: 4001/4005/4002/4006/1001, 4004 retired), overlay registration gated NATIVE (3.8). |
| 4 | `Reconnecting`/post-reconnect `Ready` never emitted | Accepted (`remote_client.rs:1020`, `:340-342`, `:761`) | `connect::observe` (3.28). |
| 5 | Reconnect budget vs sandbox resume | Accepted in part: b1 §7 item 5 already raises the WebSocket budget to 20 attempts / 8 s cap and blocks `refresh` on `/connect`, so the "3 attempts / 15 s" premise is superseded; the resume-after-`Disconnected` contract was missing. *Fixed by D2: the budget is 20 / 8 s → `ReconnectExhausted`, `RefreshError::Stopped` short-circuits, and the host `reconnect()` is the shell's re-`/connect` + reload (3.28, 3.30, item 9); no in-page re-dial export.* |
| 6 | Token expiry mid-session | Accepted | `bridge::current_session` / `ensure_fresh_token` (3.21, item 11); token never exported. |
| 7 | Unsaved buffers, `beforeunload`, `on_app_quit` never fired | Accepted (`platform.rs:488-490`) | `has_unsaved_changes` export, `beforeunload` guard, `save_all` on `Quit`/`Stopping` (3.20, 3.29, 3.30), item 21. *D6 replaced the `save_all` half with `snapshot_unsaved_buffers` + `flush_now` on both `Quit` and `Stopping`; the export and the guard stand.* |
| 8 | Panic hook on workers | Accepted | 3.21 chains hooks, checks `is_main_thread`, uses an atomic flag; item 22. |
| 9 | Tar path traversal / caps | Accepted | `AssetPack::from_tar` rejects traversal and caps size; `tar_rejects_traversal`/`tar_rejects_oversize` tests. |
| 10 | `audio` edge via `agent_ui` and `settings_ui` | Accepted with a correction: `agent_ui`'s `audio` is an optional feature (`agent_ui/Cargo.toml:25`, `:40`) enabled by `sidebar/Cargo.toml:24` (in zed_web's closure) and `zed/Cargo.toml:80`; `settings_ui/Cargo.toml:23` is a normal dep. 3.13 gates the `sidebar` feature per target; 3.7 gates `audio`/`cpal`/`rodio` and the two audio pages in `settings_ui`; `audio`/`cpal`/`rodio` added to the forbidden list. |
| 11 | `title_bar`'s `gpui` `screen-capture` feature | Accepted (`Cargo.toml:46`) | Moved to the NATIVE table (3.11, §5). |
| 12 | Keymap semantics for vim and mac `alt-` chords | Accepted (`keyboard.rs:1-12`) | 4.6 note, item 13, `alt_w_does_not_insert_text` test and vim Playwright case. *D12 since fixed the layer as one `web.json` loaded last; the `web-macos.json` variant and the vim-then-web-then-overrides order of this revision are gone (3.2, 3.3, 3.23, 4.6).* |
| 13 | `PlatformStyle` affects key-binding glyphs everywhere | Accepted (no `const` call sites, so a runtime override is feasible) | Item 5 rewritten and scheduled before v0. *D12 permits the `ui` change; it is now 3.2a in this brief's change list.* |
| 14 | Native-build hygiene / which pattern | Accepted | `gpui_web` pattern (3.19); native jobs listed in 3.32. |
| 15 | CI sequencing; per-crate `cargo tree -i` | Accepted | 3.32 staged list; §6 forbidden-crate check uses inverse queries. |
| 16 | Settings save-back scope (b6 §7 item 9 at the time; item 8 in b6's current numbering) and stale-save handling | Accepted | 3.24: settings.json + keymap.json only in v0; rejection → notification, last-writer-wins. *b6 §7 item 8 now records the decision and offers `take_dirty()`, which 3.24's `flush_pending_saves` wires.* |
| 17 | Flush ordering on `pagehide`/takeover | Accepted | 3.27 (`flush_client_state` skips after 4001/4005), 3.30, item 20. |
| 18 | Hidden-tab heartbeat throttling | Accepted in part: b1 §7 item 8 makes the server's `Heartbeat` text frames feed `connection_activity_tx` without client timers, so spurious `HeartbeatMissed` is already mitigated by design; the Playwright case is added and `set_hidden` shortens the client-state interval (b4). |
| 19 | Missing tests | Accepted | §6 adds empty-paths boot, newer-image boot, busy/takeover, rotated token, coalesced save-back, `beforeunload`, vim precedence. |
| 20 | Nobody owns the CSP decision | Accepted | 3.30 records the decision (patched `wasm_thread` route; `'unsafe-eval'` on the editor route only until then); item 2 names the code sites. *The patch is delivered as `vendor/wasm_thread` per D10 (3.33); b9 gates the fallback behind `ZS_CSP_UNSAFE_EVAL`.* |

## 9. Reconciliation log

Amended 2026-09-02 against `docs/briefs/DECISIONS.md` (D1-D20) and the sibling briefs' sections 7 and 8. Every b1..b9 brief was grepped for `b7`, `zed_web`, `entry crate`, `ZsHost`, `bootProgress` and `open_remote_project_in_new_window`; b2, b3 and b8 contain no item addressed to this brief (b2/b8's only `zed_web*` hits are fork-evidence citations), so their impact comes from the decisions and from cross-references in b1, b4, b5, b6 and b9. Every fact added was re-checked against `/Users/ray/Projects/play/wed/zed` (HEAD `c3cf80c`, clean tree — the same commit the previous revision was verified against, so no `crates/**` line anchor moved): `remote_client.rs:160-240, 340-375`, `ui/src/styles/platform.rs:1-25` and the 24 `PlatformStyle::platform()` call sites, `gpui/src/keymap/context.rs:30-46`, `assets/keymaps/default-macos.json` (`ctrl-*` chords, lines 16-1449) and `default-linux.json:291-1492`, `vim.json:348-511`, `script/check-keymaps:1-26`, `gpui_web/Cargo.toml:36-38`, `scheduler/Cargo.toml:38-43`, `gpui_web/src/platform.rs:440-444`, `db/src/db.rs:30-70`, `db/src/kvp.rs:1-60`, `activity_indicator.rs:20-25, 474-492`, `workspace.rs:4863-4875`, root `Cargo.toml:1-12, 976` (no `vendor/` directory exists yet). No cargo command was run; no file outside this brief was modified. Nothing was shortened; superseded review-log entries carry an italic note instead of being deleted.

Decisions:

- **D1** (identity is `workspace_id`; `session_id` per-connect and informational). Applied: header (b1 bullet); 2.5 (`ConnectionIdentifier` only feeds `Hello.identifier` for WebSocket); 3.21 (`refresh(&self, workspace_id, ..)` returning `WebSocketSession { url, token, session_id }`); 3.27 step 3c and 3.28 (`WebSocketConnectionOptions::new(ws_url, workspace_id = BootConfig.workspace.id, session_id, token)`; the DB row identity is the options' `workspace_id`; `ConnectionIdentifier::setup()` justified); 3.30 dev harness `?workspace=`; 4.1 (`ConnectInfo.session_id` and `WorkspaceTarget.id` comments); 4.2; 4.3; §6 reconnect case asserts the persistence row survives a rotated `session_id`; item 11 closed.
- **D2** (20 attempts / 8 s cap → `ReconnectExhausted` with `last_close()`; host `reconnect()` from scratch; `RefreshError::Stopped` short-circuits; `Unauthorized` terminal). Applied: header; 3.21 (`code === "stopped"` → `RefreshError::Stopped`, `LAST_REFRESH_ERROR`); 3.28 (`close_code_detail` with `workspace_stopped`/`unauthorized`/`reconnect_exhausted`; `reconnect()` = the shell's re-`/connect` + reload, chosen over an in-page re-dial because `gpui_web` cannot reopen a window — b4 §9 left this to b7; `ClientStateStore::rebind` unused); 3.30 (Reconnect/Resume affordance); 4.1 codes; 4.2 (`refreshConnectInfo` rejection vocabulary; `reconnect()` is not a wasm export); §6 (reconnect-exhausted and stopped-workspace cases); items 9 and 20; R2 missing 5 annotated.
- **D3** (fresh session resets `HeadlessProject`; PTYs survive in `PtyManager`; close codes 4001/4005/1001; client `Heartbeat` every 5 s; 16 MiB). Applied: header (b1/b2 bullets); 3.27 step 3c/3f; 3.28 (`close_code_detail`: 1001 `server_stopping`, 4004 retired; "a reload is a fresh session, no warm attach"); 4.1 codes; 4.2 `onClosed` codes; §6 (busy session 4005, server stop 1001, hidden-tab rationale rewritten around the client heartbeat); items 9, 20, 25.
- **D4** (terminal restore in b3 through workspace persistence). Applied: header (b3 bullet) and 3.27 step 3f note that b3's reattach runs inside the open task after the image is restored; no API here.
- **D5** (loopback control listener; `--allowed-origin`). Applied: 3.21 (`/files`, `/extensions/{id}/assets` are cross-origin fetches relying on b2's CORS from `manifest.allowedOrigins`); §6 lifecycle case names `POST /control/lifecycle`. Nothing else here talks to the control listener.
- **D6** (unsaved buffers into the image on `STOPPING`; reopened dirty; no filesystem writes without the user saving). Applied: section 1; header (b4 bullet: `snapshot_unsaved_buffers`, `restore_unsaved_buffers`); 3.13; 3.27 step 3e (`flush_pending_saves` → `snapshot_unsaved_buffers` → `flush_now`, **never `save_all`**) and 3f (`restore_unsaved_buffers` after `open_remote_project_in_new_window_with_client`, order normative per b4 §7 item 22); 3.29 (`Quit` no longer calls `save_all`); §6 "Stop with unsaved buffers" case; item 20 rewritten; R2 missing 2 annotated.
- **D7** (one whole-database image with `GlobalKeyValueStore` folded in; `serialize()`/`restore_from()` on `background_spawn`; triggers = 15 s ticker, `visibilitychange` hidden, `STOPPING`). Applied: header (b4 bullet); 2.5 (`scoped_kv_store` reuse); 3.27 step 3d (`cx.background_spawn(open_with_image(..))`, `GlobalKeyValueStore::init(&app_db)` after `set_global`, `ClientStateEvent` handling incl. `ReadOnly` → `allow_overwrite()` action) and the flush paragraph (three triggers; `pagehide` best-effort); 3.29 (window-close hook best-effort); 3.30; 3.24 `flush_pending_saves` wires b6's `take_dirty` into the hidden/`STOPPING` flushes; item 20, item 28; §6 lists b6's `sqlite_image_round_trip_across_workers`.
- **D8** (private ports, `/open` link). Applied: 3.21 no longer lists `/ports` as a client HTTP call (ports are proto + a top-level navigation).
- **D9** (rebuild tarball carries `$HOME/.local/share/zed`). Applied: item 11 (the client-state image survives rebuild; acknowledges b9 §7 item 3).
- **D10** (vendored dependencies, no `<org>` placeholder). Applied: the `wasm_thread` patch of item 2 becomes `vendor/wasm_thread` with a `[patch."https://github.com/zed-industries/wasm_thread"]` path entry, `[workspace] exclude`, README entry and `-D warnings` obligation (new 3.33; §5; test `vendored_wasm_thread_has_no_eval`; 3.30). No `<org>` placeholder exists in this brief (grep verified).
- **D11** (`/home/web`; settings and keymap at Zed's usual relative paths). Already the case; 3.1 and 3.24 now cite D11 and spell out `/home/web/.config/zed/{settings,keymap}.json`; R2 wrong-claim 18 annotated.
- **D12** (`assets/keymaps/web.json`, loaded last on wasm only, remaps Cmd/Ctrl+W, T, N, Q, Shift+T, Ctrl+Tab; `PlatformStyle` override permitted). Applied: section 1; 2.1 (all `PlatformStyle::platform()` call sites); 2.4 (`KeyContext` `os` key evidence and the chord collisions); 3.2 (`WEB_KEYMAP_PATH` replaces `web_keymap_path_for`); new 3.2a (`PlatformStyle::set_platform_style`, non-`const` `platform()` on wasm); 3.3 (one file; `web.json` in the `cmd-` exclusion list); 3.23 (load order default → base → vim → specific-overrides → web); 3.26 step 2; 4.6 (one file with both chord families and the no-op argument); 4.7; §5 (`ui` unchanged in Cargo); §6 (`web_keymap_parses`, `web_keymap_nulls_are_noops_on_the_other_host`, `platform_style_native_unchanged`, `web_layer_wins_last`, `platform_style_follows_host_os`, host-OS Playwright case); items 5, 13, 24; R2 missing 12/13 annotated.
- **D13** (activity ping fields). Not applicable here beyond the b2 bullet's note that client heartbeats are never input.
- **D14**, **D15** (b8 prebuild; b10/b11 new briefs). Not applicable; 3.26 step 21 still initializes `language_models` (its providers are gated by settings/sign-in; the `/api/ai/*` proxy is b11).
- **D16** (`open_remote_project_in_new_window_with_client`). Applied: header; 3.13; 3.27 step 3f (`OpenedRemoteProject { window, workspace, items }`); 3.28 (the "until it lands" fallback paragraph replaced by the decided ordering); item 1 closed; R1 missing 11 and R2 wrong-claim 3 annotated.
- **D17** (terminal ownership b3/b6). Applied: 3.32 cites b3's `terminal` remote surface as a prerequisite of `-p zed_web`; nothing else here touches `terminal`.
- **D18**, **D19** (supervisor/control-plane contracts). Not applicable, except that 3.21 declines b9's `onExtensionsChanged` because installed-extension reporting is supervisor → control plane.
- **D20** (serve contract). Not applicable.

Sibling deltas addressed to this brief:

- **b1** (§3.3 lines 164-176, 232-283; §3.12 lines 367-408; §2 line 107): consumed as amended — constructor, session, refresh error, delegate line numbers (`:232-236`, was `:222-227`), `_with_client` return type, `Hello.identifier` note (b1:408 cites b7:776's `setup()`), close-code table with 1001. b1's §4.1/§4.6/§7 are still pre-decision (item 26); nothing here depends on them.
- **b4** (header line 11; §3.6a; §3.7; §3.8 lines 351-418; §3.16 line 684; §7 items 5, 21, 22; §9 "b7" row): `save_all` → `snapshot_unsaved_buffers` + `flush_now`; `restore_unsaved_buffers` after the open; `GlobalKeyValueStore::init(&db)`; `open_with_image` under `background_spawn` and the tuple destructured (b4 §7 item 5, b7:676); `stop` on every `Disconnected`; `rebind` not used (b4 §9 item 3: b7 chooses reload); `LifecycleKind::as_str()` snake_case adopted (b4 §7 item 21 → item 27 here); `pagehide` not a trigger. All applied (3.24, 3.27, 3.28, 3.29, 3.30, 4.2).
- **b5** (§2 lines 21, 29; §3 items 2, 3, 16; §4 lines 505-573; §7 items 6, 13, 19; §9 "b7" rows): stale citations replaced (`b5:435-456` → `crates/zs_smol_shim/src/runtime.rs`, b5:532-573, risk 6) in the header, 3.27 and R2 missing 1; `GpuiSmolRuntime` shape quoted; `default_packages` in `script/check-wasm` is the CI layer list (3.32 rewritten; the xtask job stays argument-free; `check_forbidden_crates` step kept); `--export=__wasm_call_ctors` line acknowledged as recorded b7-owned (3.16); `getrandom` feature note corrected to "the feature selects the backend" (§5); `time` feature line unchanged; the `grammars`/`test-support` invariant added (§5); the `vendor/` layout adopted for `wasm_thread` (3.33).
- **b6** (header line 5; §2 lines 30, 98; §3.2 lines 156, 171-200; §3.4 lines 281-282, 332; §3.8 line 547; §6 line 970; §7 items 5, 8, 10, 12, 13; §9 "b7" rows): `insert_dir` used by `seed_config_files`; `take_dirty` wired through `flush_pending_saves` (b6 §7 item 8 left it open); `db::registered_migration_count()` replaces the inline `inventory` read and `inventory` leaves `zed_web`'s manifest; the `activity_indicator.rs:23,477,489` `web_time::Instant` swap added to 3.10/§5 (b6 §7 item 5); `sign_in_supported()` citation updated to b6:547/§4.6; "b6 §7 item 9/10/7" citations renumbered to items 8/9/5 as b6 now numbers them; `client::Status::ReconnectionError` note corrected (no consumer reads the field, 3.11); telemetry-off policy recorded (3.24, b6 §7 item 10); `sqlite_image_round_trip_across_workers` listed in §6 as b6-owned in this suite.
- **b9** (§2 lines 58-59, 84-85; §3.26 lines 784-789; §4.6 lines 1196-1220; §4.9; §7 items 3, 6; §8 R2 wrong-claim 3): `onClosed` accepted (3.21, 3.28, 4.2); `onLifecycle` already present (snake_case, item 27); `keepAlive`, `stop`, `setDirty`, `onExtensionsChanged`, `openExternal` declined with reasons (3.21, 4.2); `refreshConnectInfo` rejecting `{ code: "stopped" }` → `RefreshError::Stopped` (D2; 3.21, 4.2); `ZS_CSP_UNSAFE_EVAL` recorded as the gate for the `'unsafe-eval'` fallback (3.30, item 2); b9's stale contract copies (two-argument `start`, `assets` inside the config, `sessionId === workspaceId`) noted in the header — 4.2 is authoritative; b9 §7 item 3's acknowledgement given in item 11 (`workspace_id` identity survives rebuild).
- **b3**, **b2**, **b8**: no items addressed to this brief. b2's close-code table and heartbeat note are consumed (header, 3.28, item 25); b3's D4 obligations need only the boot order already in 3.27.

Shared contract items this brief defines or consumes (`NAME: value/shape — defined by / consumed by`):

- `start(config_json: String, assets: Uint8Array, host: ZsHost) -> Promise<void>` (single-shot; rejects with `ZsBootError { code, message }`), `flush_client_state() -> Promise<void>`, `set_hidden(bool)`, `has_unsaved_changes() -> bool`, `build_id() -> string` — wasm exports, defined by b7 §3.20/§4.2 / consumed by b9 §3.26.
- `ZsBootConfig { buildId, connect: { wsUrl, token, sessionId, takeover?, serverBuild?, sessionExpiresAt? }, workspace: { id, paths }, settingsJson?, keymapJson?, backend?, hostOs? }` — defined by b7 §4.1/§4.2 / consumed by b9 §3.26; `workspace.id` is D1's identity, `connect.sessionId` per-connect.
- `ZsHost { bootProgress(stage, detail), refreshConnectInfo(), saveDocument(kind, json), reportError(kind, message, stack), onLifecycle(kind, seconds), onClosed?({ code, reason }) }` with stage vocabulary `booting|assets|settings|connecting|database|languages|window|ready|reconnecting|stopped|failed`, stopped/boot-error codes `bad_config, bad_host, bad_assets, runtime_missing, ctors_missing, settings, connect_failed, session_busy, taken_over, incompatible_server, server_stopping, unauthorized, workspace_stopped, reconnect_exhausted, database, window, boot_timeout, cancelled, quit`, lifecycle kinds `idle_stop_in|session_cap_in|stopping|resumed`, and `refreshConnectInfo` rejections `{ code: "unauthorized" | "stopped" }` — defined by b7 §4.2 / consumed by b9 §4.6 (b9 must adopt the snake_case lifecycle kinds and `onClosed` as optional).
- Host `reconnect()` (D2) = shell-side re-`POST /connect` + page reload; no wasm export, no in-page re-dial — decided by b7 §3.28 / consumed by b9 §3.26, b4 §3.7 (`rebind` unused).
- `remote::WebSocketConnectionOptions::new(url, workspace_id, session_id, token).with_takeover(bool).with_refresh(Arc<dyn WebSocketSessionRefresh>)`; identity = `workspace_id` — defined by b1 §3.3/§4.1 (D1) / consumed by b7 §3.28.
- `remote::WebSocketSessionRefresh::refresh(&self, workspace_id: &str, reason: RefreshReason, cx: &mut AsyncApp) -> Task<Result<WebSocketSession { url, token, session_id }, RefreshError::{Unauthorized, Stopped, Other}>>` — defined by b1 §3.3 (D1, D2) / consumed by b7 §3.21 (`JsSessionRefresh`).
- `remote::WebSocketClientDelegate::new(on_status: impl Fn(Option<&str>, &mut AsyncApp))`, `remote::connect(options.into(), delegate, cx)`, `WebSocketConnectionOptions::last_close() -> Option<CloseInfo { code, reason }>`, close codes 4001/4005/4002/4006/1001 (+ synthesized 4003), `max_reconnect_attempts()` = 20 / 8 s cap → `ReconnectExhausted` — defined by b1 §3.3/§3.5 (D2, D3) / consumed by b7 §3.28.
- `workspace::open_remote_project_in_new_window_with_client(remote: Entity<RemoteClient>, app_state, paths, window_options, cx) -> Task<Result<OpenedRemoteProject { window, workspace, items }>>` — defined by b1 §3.12 (D16) / consumed by b7 §3.28.
- `ConnectionIdentifier::setup()` for the WebSocket `RemoteClient` (feeds `Hello.identifier` only; logs-only on the server) — used by b7 §3.28 / accepted by b1 §3.12 (b1:408) and b2 (b2:392).
- `db::AppDatabase::open_with_image(Option<Vec<u8>>) -> (Self, RestoreOutcome)` (awaited under `cx.background_spawn`), `db::kvp::GlobalKeyValueStore::init(&AppDatabase)`, `db::registered_migration_count() -> usize` — defined by b4 §3.6/§3.6a and b6 §3.4 (D7) / consumed by b7 §3.27.
- `db::client_state::ClientStateStore::{new(&db, sink, loaded_version, outcome, cx), flush_now, set_interval, stop, resync, allow_overwrite, is_read_only}`, `ClientStateEvent::{Saved, SaveFailed, Stale, ReadOnly}`, `SAVE_INTERVAL`; flush triggers = 15 s dirty ticker, `visibilitychange` → hidden, `STOPPING` (D7) — defined by b4 §3.7 / consumed by b7 §3.27/§3.28.
- `workspace::client_state::{RemoteClientStateSink::new(client, client_build) -> Arc<Self>, load_client_state(&AnyProtoClient) -> Result<(Option<Vec<u8>>, u64)>, snapshot_unsaved_buffers(&Entity<Workspace>, &mut App) -> Task<Result<usize>>, restore_unsaved_buffers(&Entity<Workspace>, &mut Window, &mut App) -> Task<Result<usize>>}` — defined by b4 §3.8 (D6) / consumed by b7 §3.27, §3.29.
- `project::Event::LifecycleNotice { kind: LifecycleKind, seconds: u32 }`, `LifecycleKind::as_str()` snake_case — defined by b4 §3.16 / consumed by b7 §3.21/§3.27 (forwarded verbatim to `onLifecycle`).
- `fs::WasmFs::{new(BackgroundExecutor) -> Arc<Self>, insert_file(&Path, Vec<u8>), insert_dir(&Path), take_dirty() -> Vec<DirtyFile { path, contents: Option<Vec<u8>> }>}`, per-file watch events at the caller's latency, `canonicalize` erroring for a missing file — defined by b6 §3.2/§4.1 / consumed by b7 §3.24, §3.27.
- `client::Client::sign_in_supported() -> bool` — defined by b6 §3.8/§4.6 / consumed by b7 §3.11.
- `fs::JobInfo.start: web_time::Instant` on wasm — defined by b6 §3.2 / consumed by b7 §3.10 (`activity_indicator` swap).
- `util::paths::home_dir()` = `/home/web` on wasm; `settings_file()`/`keymap_file()` = `/home/web/.config/zed/{settings,keymap}.json` (D11) — defined by b7 §3.1 / consumed by b6 (`WasmFs` seeding, `db`, `prompt_store`, `telemetry::log_file_path`), b7 §3.24.
- `settings::{KeymapOs, default_keymap_path_for, specific_overrides_keymap_path_for, WEB_KEYMAP_PATH = "keymaps/web.json", BaseKeymap::asset_path_for}` and `assets/keymaps/web.json` loaded last on wasm only (D12) — defined by b7 §3.2/§3.3/§4.6 / consumed by b7 §3.23 (no sibling consumer).
- `ui::PlatformStyle::set_platform_style(PlatformStyle)` (wasm-only) and a non-`const` `PlatformStyle::platform()` on wasm (D12) — defined by b7 §3.2a / consumed by b7 §3.26 step 2.
- `.cargo/config.toml` wasm rustflags: `"-C", "link-arg=--export=__wasm_call_ctors"` appended to b5's block — defined by b7 §3.16 / recorded by b5 item 2 as b7-owned.
- `script/check-wasm` (`ZS_WASM_MODE=build ZS_BUILD_ID=<id> script/check-wasm -p zed_web --profile <profile>`; `default_packages` as the CI layer list) — defined by b5 item 3/16 / consumed by b7 §3.31 step 3 and §3.32 (appends `util paths settings ui`, its leaf crates, `zed_web` last).
- `smol::runtime::{Runtime, Runnable, install_runtime, runtime_installed}` on wasm and the `GpuiSmolRuntime(pub gpui::BackgroundExecutor)` adapter living in `zed_web` — defined by b5 §4 / consumed by b7 §3.27 step 2.
- `vendor/<name>` layout (`[workspace] exclude`, `[patch."<git url>"] <name> = { path = "vendor/<name>" }`, `vendor/README.md` `- Upstream:` line) — defined by b5 items 4/19 (D10) / consumed by b7 §3.33 (`vendor/wasm_thread`, upstream `zed-industries/wasm_thread@0cf96c7708dfb97ccf3da50347e25edcf75d6937`).
- `globalThis.__zsBindgenShimUrl` (set by the loader before `start`; read by the vendored `wasm_thread`) and `globalThis.__zsCallCtors` (added to the glue by 3.31 step 4b) — defined by b7 §3.30/§3.33 / consumed by b9 §3.26's loader.
- Editor-route CSP: `script-src 'self' 'wasm-unsafe-eval'` + `worker-src 'self' blob:`, with `'unsafe-eval'` only while `ZS_CSP_UNSAFE_EVAL=1` (until 3.33 lands) — decided by b7 §3.30 / implemented by b9 §4.9.
- COOP `same-origin` / COEP `require-corp` on the document and every bundle subresource, CORP `same-origin` on bundle files, `crossOriginIsolated` checked before `init()` — defined by b7 §3.30 / consumed by b9 §3.26.
- `cargo xtask web-bundle [--profile] [--out-dir] [--build-id] [--skip-wasm-opt] [--serve] [--port] [--max-brotli-bytes] [--check-only]`, bundle layout `<out_dir>/<build_id>/{zed_web.js, zed_web_bg.wasm, zed-assets.tar, build.json, index.html, loader.js}` — defined by b7 §3.31 / consumed by b9 §3.30 (`scripts/fetch-editor-bundle.ts`) and CI.
- Save-back scope in v0: `settings.json` and `keymap.json` only, via `saveDocument("settings" | "keymap", json)` after a 750 ms per-document debounce, drained early by `flush_pending_saves` — decided by b7 §3.24 (b6 §7 item 8) / consumed by b9 (`PUT /api/me/settings|keymap`), b6.
- Forbidden crates in the wasm closure (`wasmtime`, `cranelift-codegen`, `livekit`, `webrtc-sys`, `aws-config`, `aws-sdk-bedrockruntime`, `aws-lc-sys`, `rustls-platform-verifier`, `tiny_http`, `tokio`, `tokio-rustls`, `tokio-native-tls`, `gpui_tokio`, `extension_host`, `call`, `dev_container`, `auto_update`, `http_client_tls`, `bedrock`, `reqwest`, `audio`, `cpal`, `rodio`, `miniprofiler_ui`) — defined by b7 §6 `check_forbidden_crates` / consumed by CI (3.32) and every crate brief that gates an edge.

Unresolved after this pass (also listed in the return to the orchestrator):

1. Heartbeat direction (item 25): D3 says client → server; b1 §3.3 implements that and b2 §7 item 18 additionally keeps a server → client frame pending confirmation. No `zed_web` code depends on it, but the hidden-tab behaviour does (server tolerance for throttled client timers).
2. b1's §4.1/§4.6/§7 still show the pre-decision shapes (item 26); this brief cites b1 §3. If b1's final `refresh` keeps `session_id: &str` as the first argument name, nothing here changes.
3. `onLifecycle` spelling with b9 (item 27): snake_case here and in b4; b9's TypeScript type must be amended.
4. `KeyContext` `os == unknown` on wasm (item 24): a gpui runtime override is not covered by D12; left as a follow-up, with the single-file no-op property tested instead.
5. Whether D2's "host `reconnect()`" was meant as a wasm export rather than a shell action: this brief implements it as the shell's re-`/connect` + reload (b4 §9 item 3 left the choice to b7); if an in-page re-dial is required, `ClientStateStore::rebind` exists on b4's side but `gpui_web`'s single-window constraint (`platform.rs:381`) makes it a larger change.

### Contract pass (2026-09-02)

Cross-brief mismatch found by the CONTRACTS.md audit and fixed here:

- §6: the nightly `web_bundle` CI job is named as the producer of `editor/<build_id>.tar` (the packed 3.31 bundle directory) and `editor/manifest.json` (build-id list) that b9 §3.30 fetches; b9 now reads 3.31's `build.json` (`build_id`) instead of a `BUILD_ID` file and treats `index.html`/`loader.js` as this brief's dev harness (not served). 3.31's layout is unchanged.
