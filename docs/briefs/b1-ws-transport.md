# b1-ws-transport: WebSocket RemoteConnection (client)

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` §4.1 (lines 199-208), §4.2 (218-219, as amended by D3), §4.3-4.4 (225-233), §3.4 (155-164), §3.6 "Connectivity"/"Tabs"/"Visibility" (181-184), §11.2 "Version coupling" (459), §13 chaos/wasm tests (480-483), Appendix B "Reconnect" (~584). Binding cross-brief decisions: `/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md` (D1-D20; the ones touching this brief are D1, D2, D3, D5, D6, D7, D9, D10, D16, D17, D20 — see §9). Fork under modification: `/Users/ray/Projects/play/wed/zed` (branch `zs`, upstream `c3cf80c`). All paths below are relative to that checkout unless absolute.

## 1. Goal

Add a fourth transport to `crates/remote` — `RemoteConnectionOptions::WebSocket(WebSocketConnectionOptions)` and `WebSocketRemoteConnection` — that carries Zed's existing length-prefixed `Envelope` protocol over one `yawc` WebSocket, compiles for both native and `wasm32`, and plugs into the `RemoteClient` state machine (heartbeat, `HeartbeatMissed`, `ChannelClient::reconnect`/`resync`) with small defaulted trait additions. It skips server-binary provisioning, refreshes `{url, token, session_id}` through a caller-supplied callback before every reconnect dial (D1: `workspace_id` is the stable identity, `session_id` is minted per connect and informational), does all slow I/O (refresh, backoff, TCP/TLS dial, HTTP upgrade) in the pool's `connect` path so that the 5 s `resync` window of `RemoteClient::reconnect` only has to cover the in-band `Hello`/`HelloAck` exchange, bounds reconnection at 20 attempts with backoff capped at 8 s (D2), and exposes two public functions that open a workspace in a new window — one from a raw connection (desktop convenience) and `open_remote_project_in_new_window_with_client` from an already-created `Entity<RemoteClient>` (D16), which `crates/zed_web` (b7) uses so the client-state image can be loaded over the session before `deserialize_remote_project` runs.

## 2. Existing code that matters

Every anchor below was read in this session.

### `crates/remote`

| Anchor | Note |
|---|---|
| `crates/remote/src/remote_client.rs:48` | `use std::time::{Duration, Instant}`; `Instant::now()` at `:1820` panics on wasm — the fork replaced it with `web_time::Instant` (see fork evidence). |
| `remote_client.rs:113-117` | `#[derive(Copy, Clone, Debug)] pub struct RemotePlatform` — **no `PartialEq`/`Eq`**; any struct that embeds it cannot derive those. |
| `remote_client.rs:135-158` | `trait RemoteClientDelegate` (ask_password / get_download_url / download_server_binary_locally / `set_status(&self, Option<&str>, &mut AsyncApp)`). WS never calls the first three. |
| `remote_client.rs:160-166` | `MAX_MISSED_HEARTBEATS=5`, `HEARTBEAT_INTERVAL=5s`, `HEARTBEAT_TIMEOUT=5s`, `INITIAL_CONNECTION_TIMEOUT=5s debug/60s release` — all **private** `const`s (so `wire.rs` carries its own `HEARTBEAT_INTERVAL_SECS = 5` for the client→server `Heartbeat` frame, D3); `pub const MAX_RECONNECT_ATTEMPTS=3` (also read by `crates/zed/src/zed/remote_debug.rs:48`). |
| `remote_client.rs:168-196` | `enum State` (Connecting, Connected, HeartbeatMissed, Reconnecting, ReconnectFailed, ReconnectExhausted, ServerNotRunning). `State::remote_connection()` `:213-225` returns `None` for `Connecting/Reconnecting/ReconnectExhausted/ServerNotRunning` — after a terminal close the `Arc<dyn RemoteConnection>` is unreachable from `RemoteClient`. `can_reconnect()` `:227-237` is false for `Reconnecting`. |
| `remote_client.rs:339-343` | `RemoteClientEvent { Disconnected { server_not_running: bool }, Reconnected }` (emitted at `:761`). |
| `remote_client.rs:349-379` | `ConnectionIdentifier::to_string(cx)` → `[<channel>-]setup-N` / `[<channel>-]workspace-N` (prefix omitted on Stable). It calls `ReleaseChannel::global(cx)` (`crates/release_channel/src/lib.rs:190-192` → `App::global`, which **panics** if `release_channel::init` was not called, `crates/gpui/src/app.rs:2024-2028`). `RemoteClient::new` calls it unconditionally at `:417`. |
| `remote_client.rs:381-393` | `pub async fn connect(options, delegate, cx: &mut AsyncApp) -> Result<Arc<dyn RemoteConnection>>` via the global `ConnectionPool`. |
| `remote_client.rs:410-536` | `RemoteClient::new`: reads `path_style/remote_platform/remote_os_version/connection_options` at `:434-437` **before** `start_proxy(…, reconnect=false, …)` at `:449-457` and caches them on the entity (`:1030-1040` return the cached copies; the telemetry event at `:512-519` uses them). Waits for the server's `RemoteStarted` with `INITIAL_CONNECTION_TIMEOUT` at `:459-462`; first `ping` at `:498`. |
| `remote_client.rs:538-546` | `proto_client_from_channels` — what the server (`serve`) feeds. |
| `remote_client.rs:548-586` | `shutdown_processes`: drops `multiplex_task`, then `heartbeat_task`, then the connection (no `kill()` call). |
| `remote_client.rs:587-777` | `reconnect`: drops multiplex/heartbeat tasks `:622-623` (cancelling the transport's io task **before** `kill()`), `attempts > MAX_RECONNECT_ATTEMPTS` check `:639`, `remote_connection.kill()` `:670-676`, re-reads `connection_options()` `:678`, `ConnectionPool::connect` `:684-690` (returns a **new** connection because the old one `has_been_killed()`; this `await` is under the `failed!` path with **no timeout**), `start_proxy(…, true, …)` `:692-700` (**not awaited** — handed to `monitor`), `client.reconnect` `:712`, `client.resync(HEARTBEAT_TIMEOUT)` `:714` — **5 s hard budget** for everything that happens after `start_proxy` returns, including the `FlushBufferedMessages`/`Ack` round trip. An io-task `Err` while the state is `Reconnecting` is swallowed (`monitor` → `reconnect()` → `can_reconnect()` false); the attempt then fails through the resync timeout. |
| `remote_client.rs:779-847` | heartbeat: every `()` on `connection_activity_rx` resets missed count; otherwise a proto `Ping` with 5 s timeout. |
| `remote_client.rs:878-917` | `monitor`: `Ok(exit_code)` with `ProxyLaunchError::from_exit_code` → `ServerNotRunning` (no reconnect); any other `Ok` (including `Ok(0)`, logged as "proxy process terminated unexpectedly") or `Err` → `reconnect()`. This is the only hook for "do not reconnect". |
| `remote_client.rs:946-952, 1056-1067` | `shell()` / `default_system_shell()` read lazily from the connection; `force_disconnect` calls `kill()` on the live connection and documents that reconnection follows. |
| `remote_client.rs:1001-1018` | `proto_client()` (`AnyProtoClient`, what b4/b7 use to load the client-state image before the workspace exists, D16), `connection_options()` `:1005` returns a **clone of the cached snapshot** (not an `Option` — b7 §3.28's `.and_then` must be a `match`), `connection()` `:1009-1018` returns the `Arc<dyn RemoteConnection>` only in `State::Connected`. `unique_identifier` is a `String` built by `ConnectionIdentifier::to_string` (`:349-379`: `setup()` is a process-local counter `NEXT_ID` starting at 1 — identical in every browser tab, which is why `Hello.identifier` gets a per-instance nonce, §3.3 step 2). |
| `remote_client.rs:1218-1327` | `ConnectionPool` keyed by `HashMap<RemoteConnectionOptions, _>`; `connect` runs the constructor inside `cx.spawn(async move |cx| …)` (foreground, `&mut AsyncApp`, no timeout) — the `match opts` at `:1271-1297` is where the new variant is constructed, `.await`-ing like `SshRemoteConnection::new` (`ssh.rs:634`). Entries are `Connecting(WeakShared<Task>)` / `Connected(Weak<dyn RemoteConnection>)` (`:1218-1221`): an entry is reused only if the `Weak` upgrades **and** `!has_been_killed()` (`:1252-1258`); a failed constructor removes the entry (`:1312-1315`). `State::ServerNotRunning` / `State::ReconnectExhausted` carry no connection (`:168-196`), so a terminal outcome drops the last `Arc` and a from-scratch `remote::connect` with the same options key (D2 host `reconnect()`) builds a fresh connection; §3.3 additionally marks the connection killed when its pump ends so this does not depend on `Arc` lifetimes. |
| `remote_client.rs:1329-1336` | `enum RemoteConnectionOptions { Ssh, Wsl, Docker, Mock }` derives `Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize` — every field type of a new variant must satisfy these. `display_name` `:1339-1356`, `connection_type` `:1360-1374`, `From` impls `:1568-1585`. |
| `remote_client.rs:1596-1645` | `trait RemoteConnection` (`#[async_trait(?Send)]`, `Send + Sync`): `start_proxy`, `upload_directory`, `kill`, `has_been_killed`, `shares_network_interface` (default false), `build_command`, `build_forward_ports_command`, `connection_options`, `path_style`, `remote_platform`, `remote_os_version`, `shell`, `default_system_shell`, `has_wsl_interop`, `simulate_disconnect` (test only). b3 §3.4 adds the defaulted `fn supports_remote_pty(&self) -> bool { false }` to this trait and `RemoteClient::supports_remote_pty()` next to `shell()` (D17: b3 owns terminals); this brief only implements it as `true` on the WebSocket connection. This brief adds `max_reconnect_attempts()` (§3.5) and `supports_extension_upload()` (§3.20). |
| `remote_client.rs:1651-1680` | `Signal<T>`: `set()` takes the oneshot sender once — a second `RemoteStarted` is harmless. |
| `remote_client.rs:1729-1876` | `ChannelClient::start_handling_messages`: **each side sends `RemoteStarted` when its `ChannelClient` is created** (`:1736-1738`), answers `FlushBufferedMessages` with a buffer replay **and an `Ack`** (`:1751-1771`; registered as `(FlushBufferedMessages, Ack)` in `crates/proto/src/proto.rs:570`), acks `RemoteStarted` and sets the ready signal (`:1772-1778`). `Payload::Error` responses resolve the pending request with `Err` (`:1975`). `reconnect` `:1878-1886` swaps channels; `resync` `:1910-1930`; `ping` `:1932-1944` (`smol::future::or` at `:1911`, `:1933`). |
| `crates/remote/src/remote.rs:1-20` | `mod transport;` is **private** (`:6`); public re-exports (`DockerConnectionOptions`, `SshConnectionOptions`, `WslConnectionOptions`). Anything a consumer imports must be re-exported from `remote.rs`. |
| `crates/remote/src/transport.rs:17-21` | transport modules; `:128-239` `handle_rpc_messages_over_child_process_stdio` — reference for how a transport feeds `incoming_tx` (`:171`), `connection_activity_tx.try_send(())` on every inbound frame (`:170`, `:210`) and drains `outgoing_rx` with `write_message` (`:144-149`). |
| `crates/remote/src/transport/ssh.rs:42-56, 301-555, 634-720` | `SshRemoteConnection`: `kill` `:303-312` (sets an `AtomicBool` and kills the master), `has_been_killed` `:314-316`, `start_proxy` `:465-538` (only spawns `proxy --identifier … [--reconnect]`; **all slow work — master dial, askpass, platform probing — is in the async `new` at `:634`**), `path_style/remote_platform/remote_os_version` `:540-550` return values captured in `new`. `SshConnectionOptions` at `:137`. |
| `crates/remote/src/transport/mock.rs:186-317` | Smallest complete `RemoteConnection` impl; `start_proxy` `:251-289` is the pump shape to copy (select over server→client and client→server, `try_send(())` on activity). |
| `crates/remote/src/protocol.rs:9-14, 26-36, 38-52` | `MessageLen=u32`, `MESSAGE_LEN_SIZE`, `message_len_from_buffer`; `read_message` (u32 LE len + prost `Envelope`); `write_message`. |
| `crates/remote/src/proxy.rs:1-24` | `#[derive(Copy, Clone, thiserror::Error, Debug)] #[repr(i32)] enum ProxyLaunchError { #[error("…")] ServerNotRunning = 90 }` — every variant needs an `#[error]` attribute; `to_exit_code`/`from_exit_code` `:13-23`. |
| `crates/remote/src/remote_identity.rs:10-27, 32-57, 60-81` | `RemoteConnectionIdentity` (persistence identity), `persistence_key`, `From<&RemoteConnectionOptions>` — exhaustive matches. |
| `crates/remote/src/json_log.rs:6-13, 26-39` | `LogRecord` JSON shape and `log()`; reused for server log frames. |
| `crates/remote/Cargo.toml:21-52` | deps: no `yawc`, `url`, `web-time`, `gpui_tokio` yet; `urlencoding`, `serde_json`, `futures`, `smol` present; no `rand`/`uuid` (the per-instance nonce in §4.1 uses `web_time::SystemTime` + a counter). **`[dev-dependencies]` already exists at `:49-52`** (gpui/fs/util test-support). The crate has **no `build.rs`** (`crates/remote/` holds `Cargo.toml`, `LICENSE-GPL`, `src`), so `option_env!("ZS_BUILD_ID")` would go stale without the `rerun-if-env-changed` script b2 §7.4(c) asks for (§3.19). |

### Existing yawc usage (both targets)

| Anchor | Note |
|---|---|
| `crates/cloud_api_client/src/websocket.rs:7-12, 16-24` | `use yawc::frame::{Frame, OpCode};` (the portable import path), `#[cfg(not(target_family = "wasm"))] mod native; #[cfg(target_family = "wasm")] mod web;` and `forward_frame` demuxing on `Frame::opcode()` (Binary/Close/Ping/Pong/Text). |
| `crates/cloud_api_client/src/websocket/native.rs:19-27, 30-62, 82-92` | `SplitSink<TcpWebSocket, Frame>` / `SplitStream` from `websocket.split()` (no `map(Ok)` — native consumes bare `Frame`s); read loop in `cx.background_spawn` (TcpWebSocket is `Send`); **dial inside `gpui_tokio::Tokio::spawn_result(cx, …)`** with `WebSocket::connect(url).with_request(request::Builder::new().header(…))`. |
| `crates/cloud_api_client/src/websocket/web.rs:26-48, 68-74` | wasm: read loop in foreground `cx.spawn` (socket is `!Send`); every yawc error is converted by formatting (`anyhow!("Cloud WebSocket error: {error}")` `:34`, `:72`) because **`yawc::WebSocketError` is `!Send` on wasm** (`Js(wasm_bindgen::JsValue)`, yawc `src/lib.rs:166-168`) and therefore has no `From` into `anyhow::Error` there; `WebSocket::connect(url)` raced against `executor.timer(CONNECT_TIMEOUT)`. |
| `crates/cloud_api_client/Cargo.toml:26-29` | `yawc.workspace = true` unconditionally, `gpui_tokio` only for non-wasm. |
| `crates/gpui_tokio/src/gpui_tokio.rs:12-25, 77-95, 97-99` | `init(cx)` builds a 2-thread runtime and sets a private `GlobalTokio`; `Tokio::spawn_result<C: AppContext>(cx, fut) -> Task<Result<R>>` and `Tokio::handle(cx)` go through `read_global`/`global`, which **panic if `init` was never called**; there is no `try_handle`. Callers of `init`: `crates/zed/src/main.rs:489`, `remote_server/src/server.rs:654`, and test `init_test`s (`agent_servers/src/e2e_tests.rs:412`, `extension_host/src/wasm_host.rs:1016`). `AppContext::read_global` returns `R` directly (`crates/gpui/src/gpui.rs:242`), so `&AsyncApp` works as `cx`. |
| `crates/gpui/src/executor.rs:117-119` | `BackgroundExecutor::spawn` requires `Send + 'static`; `:197` `timer()` exists on wasm; `:236-246` `allow_parking()` (tests with real sockets; precedent: `agent_servers/src/e2e_tests.rs` runs `#[gpui::test]` with `gpui_tokio::init` and real network/processes behind the `e2e` feature). |
| `Cargo.toml:910, 976` | `yawc = { git = "https://github.com/zed-industries/yawc", rev = "71a452f551cac178367eaac5d7418a09afa1f3a2", version = "0.3.3" }`; checkout at `~/.cargo/git/checkouts/yawc-4536022b4863f78e/71a452f`. A `[patch.crates-io]` section exists at `:976` and is the only `[patch` table; a `[patch."https://github.com/zed-industries/yawc"]` table with a `path` entry is the supported way to substitute a git dependency. `zed/vendor/` **does not exist yet** — D10 creates it (`zed/vendor/<name>` per vendored crate plus `zed/vendor/README.md`); §3.18 adds `vendor/yawc`. |

yawc facts verified in that checkout:
- `src/lib.rs:77-101`: `mod wasm` on `target_arch = "wasm32"` (`pub use wasm::*`), `mod native` otherwise (`pub use native::*`); `pub mod close;` and `pub mod frame;` are unconditional. **Only the native module re-exports `Frame`/`OpCode` at the crate root** (`src/native/mod.rs:157`); `src/wasm.rs` has no `pub use` at all (`:1-17`). Portable code imports `yawc::frame::{Frame, OpCode}`, `yawc::close::CloseCode`, `yawc::{WebSocket, WebSocketError, Result}`.
- `WebSocketError` (`src/lib.rs:103-230`): native variants wrap `std::io::Error`, `hyper::Error`, `url::ParseError` (all `Send + Sync`); the wasm-only `Js(wasm_bindgen::JsValue)` (`:166-168`) makes the enum `!Send` on wasm, so `?` from a `yawc::Result` into `anyhow::Result` does not compile there. All yawc errors in shared code go through `fn ws_err(e: WebSocketError) -> anyhow::Error { anyhow!("{e}") }`.
- **Native**: `src/native/mod.rs:761` `WebSocket::connect(url: Url) -> WebSocketBuilder`; `src/native/builder.rs:154-160` `with_options(Options)`, `:189-195` `with_request(HttpRequestBuilder)` (re-exported at `src/native/mod.rs:156`). `handshake_with_request` (`src/native/mod.rs:908-979`) keeps every user header, only adds `Host` if absent (`:914-930`) and `Upgrade/Connection/Sec-WebSocket-Key/Version` (`:934-942`) — so a user-supplied **`Sec-WebSocket-Protocol` header is sent verbatim**. It `tokio::spawn`s the connection driver (`:951-958`) → must run inside a tokio context. Its `verify()` does not check the echoed subprotocol. `Options` (`src/native/options.rs:61-120`): `max_payload_read` (default 1 MiB, `MAX_PAYLOAD_READ` at `mod.rs:181`; read side only), `max_read_buffer` (2 MiB), `compression: None` by default, `max_backpressure_write_boundary: Option<usize>` (`:119`); builders `with_max_payload_read` `:335`, `with_max_read_buffer` `:354`, `with_no_delay` `:384`, `with_backpressure_boundary` `:466`, `without_compression` `:317`. `TcpWebSocket` (`mod.rs:166`) implements `Stream<Item = Frame>` (`:1230-1243` — **native yields bare `Frame` and turns any read error, including `FrameTooLarge`, into end-of-stream**; the peer gets `CloseCode::Size`, `streaming.rs:258`) and `Sink<Frame, Error = WebSocketError>` (`:1245-1249`).
- **wasm**: `src/wasm.rs:45-71` `WebSocket::connect(url: Url)` calls `web_sys::WebSocket::new(url.as_str())` — **no subprotocol or header support**; the `stream: web_sys::WebSocket` field is private (`:22-27`), the event closures are `forget()`-ed (`:99, 109, 124, 155`) and there is **no `Drop` impl** — dropping the value leaves the browser socket open. `Sink<Frame, Error = WebSocketError>` `:175-217`: `poll_ready` always ready, `start_send` is **synchronous** (`Close` → `close_with_code_and_reason`, `:190-200`), `poll_close` → `stream.close()`. `Stream<Item = Result<Frame>>` `:219-236` yields the `Close` frame from `onclose` (`:93-95`), then ends. Errors: `WebSocketError::Js(JsValue)` / `ConnectionClosed`.
- `src/frame.rs`: `Frame::text` `:271`, `Frame::binary(impl Into<Bytes>)` `:289`, `Frame::close(CloseCode, reason)` `:390`, `opcode()` `:498`, `payload() -> &Bytes` `:512`, `close_code() -> Option<CloseCode>` `:713`, `close_reason()` `:733`. `Frame` is `Send` (opcode + `Bytes`). `src/close.rs:90-113`: `From<u16>` maps 4000-4999 → `CloseCode::Library(u16)`.

### Consumers that must learn the new variant

| Anchor | Note |
|---|---|
| `crates/workspace/src/persistence/model.rs:36-40, 160-177` | `RemoteConnectionKind { Ssh, Wsl, Docker }` and its `"ssh"/"wsl"/"docker"` strings. `:42-46` `SerializedWorkspaceLocation::Remote(RemoteConnectionOptions)` derives `Serialize/Deserialize/PartialEq` and is written to KVP via `SerializedProjectGroup` (`:65-71`) — **the token, the per-connect `session_id` (D1), the takeover flag and the refresh callback must be `#[serde(skip)]`**; only `url` and `workspace_id` are written. |
| `crates/workspace/src/persistence.rs:885-892, 982-983, 1032, 1035` | `remote_connections(id, kind, host, port, user, distro, name, container_id, use_podman, remote_env)`. `get_or_create_remote_connection_internal` `:1697-1766` (exhaustive on `RemoteConnectionIdentity`; `user` is assigned in every arm), the select `:1782-1800` **matches on all of `kind, host, port, user, distro, name, container_id`** (so any column filled from a rotating value creates a new row), insert `:1801-1827`, `remote_connection_from_row` `:1998-2033` (returns `Option`; `restorable_workspaces` `:1952-1968` `filter_map`s a `None` row away, `remote_connection(id)` `:1971-1997` turns it into `Err("invalid remote_connection row")`). |
| `crates/workspace/src/workspace.rs:7513-7519` | `workspace_location` builds `Remote(connection_options)` from the live project. `:10450-10466` `same_host` closure (ends with `_ => false`, so not a compile requirement, but window reuse needs the arm). `:11040-11097` `open_remote_project_with_new_connection(window, Arc<dyn RemoteConnection>, cancel_rx, delegate, app_state, paths, cx)` — needs an existing `WindowHandle<MultiWorkspace>`. `:11128-11241` `open_remote_project_inner` (path resolution `:11142-11160`, `Workspace::new` + `multi_workspace.activate` `:11162-11191`, toolchains `:11193-11214`, `open_items` `:11216-11223`, error toasts `:11225-11235`). `:11243-11266` `deserialize_remote_project` → `WorkspaceDb::get_or_create_remote_connection`. |
| `crates/recent_projects/src/remote_connections.rs:128-134, 204-246, 248-290, 316-326, 350-362, 377-387, 478-497` | `open_remote_project` (desktop path): creates the window with a placeholder `Project::local` (`:221-241`), shows `RemoteConnectionModal`, `remote::connect` (`:290`), two exhaustive `match connection_options` for prompt titles (a failed connect shows a Critical "Retry/Cancel" prompt, `:312-333`), then `open_remote_project_with_new_connection`. `path_exists` (`:478-497`) runs `build_command` locally — returns `false` when it errs, which is acceptable. |
| `crates/zed/src/main.rs:1418-1460`, `crates/zed/src/zed/open_listener.rs:922-937` | Desktop launch restores every persisted `SerializedWorkspaceLocation::Remote(opts)` by calling `open_remote_project` — a restored WebSocket row that cannot dial would prompt on every start. |
| `crates/recent_projects/src/disconnected_overlay.rs:64-79, 153-165, 203` | `DisconnectedOverlay` receives only `remote_connection_options` + `server_not_running: bool`; its text and its "Reconnect" button do not know why the session ended. |
| `crates/recent_projects/src/recent_projects.rs:1991-2002` | `icon_for_remote_connection` exhaustive match. |
| `crates/recent_projects/src/remote_servers.rs:403-421, 1576-1611, 1663-1686, 1775-1800` | `ProjectPickerData` exhaustive match; the SSH/WSL/dev-container pickers create a second `RemoteClient::new(ConnectionIdentifier::setup(), …)` on the pooled connection to browse directories (also `crates/remote_connection/src/remote_connection.rs:581, 622` and `crates/git_ui_core/src/worktree_picker.rs:1585`). |
| `crates/remote_connection/src/remote_connection.rs:246-260` | `RemoteConnectionModal::new` exhaustive match; `:442-486` desktop `RemoteClientDelegate` impl; `:637-653` `BackgroundRemoteClientDelegate` (status no-op) — the shape of our headless delegate. |
| `crates/title_bar/src/title_bar.rs:617-629` | exhaustive match for nickname/tooltip/icon. |
| `crates/project/src/trusted_worktrees.rs:159-184` | `From<RemoteConnectionOptions> for RemoteHostLocation` exhaustive match. |
| `crates/sidebar/src/sidebar.rs:2269-2273` | uses `_ =>` wildcard — no change. |
| `crates/project/src/project.rs:1413-1445` | `Project::remote(remote: Entity<RemoteClient>, client, node, user_store, languages, fs, init_worktree_trust, cx)`; `:2336-2340` `remote_connection_options`; `:3849-3870` `on_remote_client_event` (`Disconnected { server_not_running }`); `:5520-5532` the only non-`remote` consumer of `RemoteClient::remote_platform()` (telemetry). |
| `crates/project/src/buffer_store.rs:1138-1156` | `disconnected_from_host`: buffers become `ReadOnly`; a fresh `Project::remote` re-opens buffers by path. Under D3 a fresh session (`Hello.reconnect = false`, or stale epoch) resets the server's `HeadlessProject`, so dirty server-side text does **not** survive a reload; D6/D7 (b7, b4) persist dirty buffers in the client-state image on `STOPPING`, and b7's `beforeunload` guard covers navigation. |
| `crates/extension_host/src/extension_host.rs:2285-2325` | `ExtensionStore::register_remote_client(&mut self, client: Entity<RemoteClient>, cx)`: returns early if the client is already registered (`:2287-2289`), subscribes to `RemoteClientEvent::Reconnected` (`:2293-2302`), then spawns `reconcile_remote_client` (`:2308-2315`) — the SSH-style extension sync that calls `upload_directory`, which this transport refuses. b4 §7.3 offers the `supports_extension_upload()` gate to b1; §3.20 adds it here (desktop-only crate, excluded from the browser build). |
| `crates/remote_server/src/headless_project.rs:658, 783` | server→client file content is chunked at 1 MiB; client→server envelopes are not chunked anywhere. |
| `crates/path/src/path.rs:29-33` (re-exported at `crates/util/src/paths.rs:20`) | `PathStyle { Unix, Windows }` — the transport returns `PathStyle::Unix`. |
| `crates/release_channel/src/lib.rs:56-88, 99-134, 190-197` | `AppCommitSha`, `AppVersion::load` (build metadata `<channel>.<ZED_BUILD_ID>.<sha>`), `AppVersion::global(cx)`, `ReleaseChannel::global` (panics) / `try_global`. `crates/remote_server/build.rs:29-33` sets `ZED_COMMIT_SHA`/`ZED_BUILD_ID`. |
| `.github/workflows/run_tests.yml:670` | `check_wasm` runs `cargo check --target wasm32-unknown-unknown -p gpui_platform -p cloud_api_client` only. |

### Server side (contract only; implemented in brief b2)

| Anchor | Note |
|---|---|
| `crates/remote_server/src/server.rs:63-83, 85-110` | `Commands { Run, Proxy, Version }` — `Serve(ServeArgs)` is added by b2 behind a `serve` cargo feature (b2 §3.9, R2 M15). `ServeArgs` (b2 §3.9 `:553-578`): `--listen`, `--jwt-public-key` (repeatable), `--workspace-id` (alias `--workspace`), `--audience`, `--issuer` (default `zs`), `--workspace-root`, `--client-build` (alias `--allow-build`), `--allowed-origin`/`ZS_ALLOWED_ORIGINS` (D5), `--port-file`, `--log-file`; b4 §3.15 / D5 / D20 add `--control-secret-file` (**required**), `--supervisor-url`, `--control-listen` (default `127.0.0.1:8446`). There is no `ZS_LISTENING=` stdout line — the bound address is written to `--port-file`. |
| `server.rs:403-540` | `start_server`: one `(incoming_tx, outgoing_rx)` pair for the whole process (`:412-413`); accept loop rebinds new streams to the same channels (`:425-537`) — this is the "reconnect keeps the project" behaviour the WS `Hello{reconnect:true}` must map to. `:539` `proto_client_from_channels`. |
| `server.rs:842-988` | `execute_proxy`: `--reconnect` against a non-running server exits with `ProxyLaunchError::ServerNotRunning` (`:881-890`) — the client must treat "reconnect, but nothing to resume" as terminal, not as a fresh session; a fresh attach **kills and respawns** the server (`:892-899`). |
| `server.rs:560-744` | `execute_run` (headless gpui app `:570`, `AppVersion::load` `:647-653`, `gpui_tokio::init` `:654`, `HeadlessProject::new` `:708-720`). |
| `crates/remote_server/src/remote_editing_tests.rs:4695-4740, 4746-4770` | `init_test` (calls `release_channel::init(semver::Version::new(0,0,0), cx)` on both contexts) / `build_project` — the client-side `Project::remote` scaffolding to reuse in the integration test. |
| `crates/remote_server/Cargo.toml:59, 82-105` | `remote.workspace = true` (so `remote::websocket_wire` is importable by the server), dev-deps incl. `remote` test-support (`:98`), `workspace` (`:104`), `tempfile` (`:100`). |
| `crates/proto/proto/zed.proto:21-25, 550-562` and `crates/proto/src/proto.rs:386, 492, 570` | `Envelope{id, responding_to, original_sender_id, ack_id}`; `Error{message, code, tags}` is the generic error response; `Ping→Ack`, `FlushBufferedMessages→Ack`, `RemoteStarted` (Background). **No proto changes in this brief.** |

### Fork evidence (read-only, `/private/tmp/…/scratchpad/zed-web`, commit `88db2d1`)

- `crates/remote/src/remote_client.rs` and `transport/{ssh,docker,wsl}.rs` differ from this checkout by `use web_time::Instant;` (the wasm-motivated change), by the absence of `RemoteClientEvent::Reconnected` and of `kill_on_drop(true)` calls, and by `transport.rs` test helpers using `CARGO_MANIFEST_DIR` instead of `util::dev_repo_root()`. The latter three look like base-revision drift (the fork is not on `c3cf80c`), so the fork only proves that `Instant` needed a change *at its base*, not that nothing else in `crates/remote` needs a `cfg` gate at `c3cf80c`. It relies on `smol_wasm`/`which_wasm` shims (W3's job). `crates/remote/Cargo.toml` adds `web-time.workspace = true`.
- `crates/cloud_api_client/src/websocket.rs` gating is identical to upstream; `crates/rpc/src/wasm_conn.rs` talks to `web_sys::WebSocket` directly (design not copied).
- `crates/zed_web` does not exist in this checkout (only `crates/gpui_web`); §4.6 is the contract b7 (`b7-edge-gates-entry.md` §3.28 `connect.rs`, §4.1 `ConnectInfo`) builds against, verified against `workspace.rs:11162-11191` and `remote_connections.rs:221-241` shapes. b7 creates the `RemoteClient` itself (`RemoteClient::new(ConnectionIdentifier::setup(), ..)`, b7:776) and calls `open_remote_project_in_new_window_with_client` (b7:800, D16).

## 3. Change list (dependency order)

### 3.1 `crates/remote/src/protocol.rs` — modify

Add byte-compatible one-shot framing helpers next to `write_message` (`:38-52`):

```rust
/// Encodes one envelope exactly as `write_message` would write it to a stream:
/// `u32 LE length || prost bytes`. One WebSocket binary frame == one such buffer.
pub fn encode_envelope_frame(message: &Envelope) -> Vec<u8>;

/// Inverse of `encode_envelope_frame`; rejects a length prefix that does not
/// match `bytes.len() - MESSAGE_LEN_SIZE` and frames larger than `max_len`.
pub fn decode_envelope_frame(bytes: &[u8], max_len: usize) -> Result<Envelope>;
```
Touches: lines 1-4 imports (`prost::Message` already imported), append after `:52`. Uses `message_len_from_buffer` (`:12`) and `MESSAGE_LEN_SIZE` (`:10`).

### 3.2 `crates/remote/src/transport/websocket/wire.rs` — create

Shared, dependency-light wire definitions (**`serde` + `serde_json` only**; no `gpui`, `url`, `anyhow`) so `remote_server` (already depends on `remote`, `crates/remote_server/Cargo.toml:59`) imports the same types as `remote::websocket_wire` (§3.8). Full definitions in §4.2.

```rust
pub const PROTOCOL_VERSION: u32 = 1;
pub const SUBPROTOCOL: &str = "zs.v1";
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;   // inbound ceiling on both sides (D3)
/// Client → server `ControlFrame::Heartbeat` cadence (D3). `remote_client.rs`'s own
/// `HEARTBEAT_INTERVAL` is private, hence the duplicate.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 5;
/// Close codes (D3; b2 imports these instead of defining its own). 4004 "server stopping" is
/// retired: a stopping server closes with the standard 1001 "going away".
pub const CLOSE_GOING_AWAY: u16 = 1001;       // server going away (SIGTERM / lifecycle STOPPING); terminal, never refresh
pub const CLOSE_TAKEN_OVER: u16 = 4001;       // superseded: another client attached with takeover=true, or a same-instance redial replaced this socket
pub const CLOSE_BUILD_MISMATCH: u16 = 4002;
pub const CLOSE_UNAUTHORIZED: u16 = 4003;     // Hello.session_id ≠ token sid (b2); client refreshes and redials
pub const CLOSE_SESSION_ACTIVE: u16 = 4005;   // attach refused: another client instance is attached and takeover=false
pub const CLOSE_BAD_HELLO: u16 = 4006;        // no/invalid Hello within the server's HELLO_TIMEOUT, or protocol != PROTOCOL_VERSION (b2)
pub const ZS_BUILD_ID: Option<&str> = option_env!("ZS_BUILD_ID");   // kept fresh by crates/remote/build.rs (§3.19)

#[derive(Debug, Clone, PartialEq, Eq)] pub struct InvalidToken;   // impl Display + std::error::Error
/// RFC 6455 requires each subprotocol name to be an RFC 2616 token (no `=`, `+`, `/`, spaces).
/// Base64url-without-padding JWTs (`A-Za-z0-9-_.`) satisfy this; anything else is rejected
/// here instead of panicking inside `http::HeaderValue`.
pub fn validate_subprotocol_token(token: &str) -> Result<(), InvalidToken>;
pub fn subprotocol_header_value(token: &str) -> Result<String, InvalidToken>;   // "zs.v1, <token>"
pub fn subprotocols(token: &str) -> Result<[&str; 2], InvalidToken>;           // ["zs.v1", token] for the browser API
pub fn split_subprotocol_header(value: &str) -> Option<(&str, &str)>;          // server side: ("zs.v1", token)
pub fn builds_compatible(client: &str, server: &str) -> bool;                  // exact match unless either side is a dev build ("dev" prefix or no ZS_BUILD_ID)
```
`client_build_id(cx)` lives in `websocket.rs` (§3.3) because it needs `gpui` and `release_channel`. There is **no query-string token placement** (see §3.18 and §4.3).

### 3.3 `crates/remote/src/transport/websocket.rs` — create (+ `websocket/dial_native.rs`, `websocket/dial_web.rs`)

Owns the options, the shared session state, the refresh trait and registry, the connection, the headless delegate, the socket bridge and the pump.

```rust
pub struct WebSocketConnectionOptions { /* §4.1: url, workspace_id, session_id, token, takeover (+ refresh, state) — D1 */ }
pub struct WebSocketSession { pub url: String, pub token: String, pub session_id: String }   // one /connect result (D1)
pub trait WebSocketSessionRefresh: Send + Sync + 'static { /* §4.1 */ }
pub enum RefreshReason { /* §4.1 */ }
pub enum RefreshError { Unauthorized, Stopped, Other(anyhow::Error) }   // Unauthorized and Stopped are terminal (D2)
pub struct CloseInfo { pub code: u16, pub reason: String }
pub struct WebSocketSessionState { /* §4.1, shared Arc across reconnects */ }
pub struct WebSocketServerInfo { /* from HelloAck, §4.1 */ }

/// Process-wide fallback refresh provider (gpui Global), consulted when
/// `options.refresh` is `None` — the desktop path for restored workspaces.
pub fn set_session_refresh_provider(cx: &mut App, provider: Arc<dyn WebSocketSessionRefresh>);
pub fn session_refresh_provider(cx: &App) -> Option<Arc<dyn WebSocketSessionRefresh>>;
pub fn client_build_id(cx: &App) -> String;   // ZS_BUILD_ID or AppVersion::global(cx).to_string()

pub struct WebSocketRemoteConnection {
    options: parking_lot::Mutex<WebSocketConnectionOptions>,
    state: Arc<WebSocketSessionState>,
    killed: AtomicBool,
    /// The dialed socket, owned by a task that lives as long as this field. `start_proxy`
    /// takes the channel ends exactly once; `kill()` (or dropping the connection) drops
    /// the task, which closes the socket. All fields are `Send + Sync`.
    bridge: parking_lot::Mutex<Option<SocketBridge>>,
    server_info: parking_lot::Mutex<Option<WebSocketServerInfo>>,
}

/// Send-safe handle to the socket-owning task (§3.3 "bridge").
struct SocketBridge {
    frames_tx: futures::channel::mpsc::Sender<Frame>,                    // pump → socket (bounded, 64)
    frames_rx: Option<futures::channel::mpsc::Receiver<Result<Frame, String>>>, // socket → pump, taken by start_proxy
    _task: Task<()>,                                                       // owns the yawc socket
}

impl WebSocketRemoteConnection {
    /// Called from `ConnectionPool::connect` (foreground task, no timeout). Does everything
    /// slow: refresh (on redial), backoff, TCP/TLS dial, HTTP upgrade. See algorithm below.
    pub(crate) async fn new(options: WebSocketConnectionOptions,
        delegate: Arc<dyn RemoteClientDelegate>, cx: &mut AsyncApp) -> Result<Self>;
    pub fn server_info(&self) -> Option<WebSocketServerInfo>;
    pub fn last_close(&self) -> Option<CloseInfo>;   // same data as WebSocketConnectionOptions::last_close()
}

#[async_trait(?Send)]
impl RemoteConnection for WebSocketRemoteConnection {
    fn start_proxy(&self, unique_identifier: String, reconnect: bool,
        incoming_tx: UnboundedSender<Envelope>, outgoing_rx: UnboundedReceiver<Envelope>,
        connection_activity_tx: Sender<()>, delegate: Arc<dyn RemoteClientDelegate>,
        cx: &mut AsyncApp) -> Task<Result<i32>>;
    fn upload_directory(&self, _src: PathBuf, _dest: RemotePathBuf, _cx: &App) -> Task<Result<()>>; // Task::ready(Err)
    async fn kill(&self) -> Result<()>;
    fn has_been_killed(&self) -> bool;
    fn build_command(&self, …) -> Result<CommandTemplate>;                 // Err
    fn build_forward_ports_command(&self, …) -> Result<CommandTemplate>;   // Err
    fn connection_options(&self) -> RemoteConnectionOptions;              // WebSocket(current, incl. refreshed url/token, shared state)
    fn path_style(&self) -> PathStyle;                                     // PathStyle::Unix
    fn remote_platform(&self) -> RemotePlatform;                           // server_info or Linux/X86_64 (see note)
    fn remote_os_version(&self) -> Option<String>;                         // server_info.os_version
    fn shell(&self) -> String;                                             // server_info.shell or "/bin/sh"
    fn default_system_shell(&self) -> String;                              // same as shell()
    fn has_wsl_interop(&self) -> bool;                                     // false
    fn max_reconnect_attempts(&self) -> usize;                             // WS_MAX_RECONNECT_ATTEMPTS = 20 (D2), or 0 once `state.terminal` is set (new defaulted trait method, §3.5)
    fn supports_remote_pty(&self) -> bool;                                 // true — b3 §3.4 owns the trait method (defaulted false) and the terminal code (D17)
    fn supports_extension_upload(&self) -> bool;                           // false — §3.20 (defaulted true; b4 §7.3)
}

/// Headless delegate for callers that drive their own UI (zed_web overlay, tests).
/// The callback receives the `AsyncApp` so it can reach a gpui entity through a `WeakEntity`
/// (DOM/`web_sys` handles are `!Send` and cannot be captured on wasm).
pub struct WebSocketClientDelegate { on_status: Arc<dyn Fn(Option<&str>, &mut AsyncApp) + Send + Sync> }
impl WebSocketClientDelegate {
    pub fn new(on_status: impl Fn(Option<&str>, &mut AsyncApp) + Send + Sync + 'static) -> Self;
    pub fn silent() -> Self;
}
impl RemoteClientDelegate for WebSocketClientDelegate { /* ask_password: drop tx + log; download fns: Task::ready(Err(anyhow!("not supported over WebSocket"))); set_status: (on_status)(status, cx) */ }
```

Note on `remote_platform()`/`remote_os_version()`: `RemoteClient::new` snapshots them at `remote_client.rs:434-437` **before** `start_proxy`, and `HelloAck` only arrives inside `start_proxy`. `RemoteClient::remote_platform()` therefore reports `Linux/X86_64` / `None` for WebSocket sessions (its only consumer outside `remote` is telemetry, `project.rs:5527`); the accurate values are on `WebSocketRemoteConnection::server_info()` after the handshake and are what the lazily-read `shell()`/`default_system_shell()` use. Tests assert on the connection, not on `RemoteClient`.

**`WebSocketRemoteConnection::new` algorithm** (runs inside the pool's `cx.spawn` at `remote_client.rs:1266`, under the `failed!` path of `RemoteClient::reconnect` — *not* inside the 5 s `resync` window):

1. Validate: `url` scheme `ws`/`wss`; `workspace_id` non-empty; a refresh source exists (`options.refresh`, else `session_refresh_provider(cx)`) or `token` is non-empty; on native, `gpui_tokio::Tokio::try_handle(cx)` is `Some` (§3.17) — else `Err("gpui_tokio not initialised")`. If `state.terminal` is set (an earlier `RefreshError::Unauthorized` or `RefreshError::Stopped`) → `Err` immediately; together with `max_reconnect_attempts() == 0` in that state (§3.5) the next `RemoteClient::reconnect` iteration goes straight to `ReconnectExhausted` — D2's "short-circuits retries immediately".
2. `let redial = state.dials.fetch_add(1) > 0` (this session state has already been dialed in this process — true for every `RemoteClient::reconnect` redial, false for the first open and for the shell's from-scratch `reconnect()`, which builds new options). If `redial`: `attempt = state.reconnect_attempts.fetch_add(1) + 1`; `delegate.set_status(Some("Refreshing session"), cx)`; `refresh.refresh(&workspace_id, RefreshReason::Reconnect { attempt, last_close: state.last_close() }, cx).await`: `Ok(session)` → store `{url, token, session_id}` in `state.current` **and** `self.options` (so `connection_options()` returns the refreshed url and the new per-connect `session_id`, D1); `Err(Unauthorized)` → `state.last_close = Some(CloseInfo { code: CLOSE_UNAUTHORIZED, reason: "session expired" })`, `state.terminal = true`, return `Err`; `Err(Stopped)` (the control plane answered `409 workspace_stopped`: the workspace is stopped and a reconnect must never resume it, b9 §3.26/§7.6, D2) → `state.last_close = Some(CloseInfo { code: CLOSE_GOING_AWAY, reason: "workspace stopped" })`, `state.terminal = true`, return `Err`; `Err(Other)` → return `Err` (the `ReconnectFailed` path retries). Without any refresh source, reuse `state.current`. Then wait `state.backoff_delay(attempt)` = `min(2^(attempt-1), 8)` s (D2: exponential, capped at 8 s) via `cx.background_executor().timer(..)` (`remote_client.rs:638-646` has no backoff of its own; `Duration::ZERO` under the test override, §4.1). Across the 20 attempts the backoff alone sums to ≈ 2.5 min, plus whatever `/connect` takes.
3. `delegate.set_status(Some("Connecting to workspace"), cx)`; dial (`dial_native.rs` / `dial_web.rs`, selected with `#[cfg(not(target_family = "wasm"))]` / `#[cfg(target_family = "wasm")]`, mirroring `cloud_api_client/src/websocket.rs:9-12`), raced against `cx.background_executor().timer(CONNECT_TIMEOUT = 30 s)`; every yawc error is stringified with `ws_err`:
   - native: `gpui_tokio::Tokio::spawn_result(cx, async move { yawc::WebSocket::connect(url).with_options(Options::default().with_max_payload_read(MAX_FRAME_BYTES).with_max_read_buffer(2 * MAX_FRAME_BYTES).with_backpressure_boundary(1024 * 1024).with_no_delay()).with_request(yawc::HttpRequestBuilder::new().header("Sec-WebSocket-Protocol", subprotocol_header_value(&token)?)).await.map_err(ws_err) })` → `TcpWebSocket`. A 401 before the upgrade surfaces as the builder's status-code error.
   - wasm: `yawc::WebSocket::connect_with_protocols(url, &subprotocols(&token)?)` → `yawc::WebSocket` (the patched yawc, §3.18; browsers report a failed upgrade only as an `error`/`close` event, so 401 vs. transient failure is indistinguishable here — see §7).
4. Spawn the **bridge** task that owns the socket and exposes only `Send` channels: native `cx.background_spawn` (`TcpWebSocket: Send`), wasm `cx.spawn` (foreground; the browser delivers messages on the main thread anyway). Bridge loop: `select_biased!` over `outbound.next()` → `socket.send(frame).await` (error → forward `Err(msg)` and end) and `socket.next()` → forward `Ok(frame)` (native yields bare frames; wasm yields `Result<Frame>` mapped with `ws_err(..).to_string()`); end-of-stream → drop `frames_tx`. On wasm the socket is wrapped in `struct ClosingSocket(yawc::WebSocket)` whose `Drop` calls `Pin::new(&mut self.0).start_send(Frame::close(CloseCode::Normal, "client gone"))` — synchronous (`close_with_code_and_reason`), so dropping the task **always** closes the browser socket; on native dropping `TcpWebSocket` ends its driver. Store the bridge in `self.bridge`.
5. Return `Self` (`server_info` still `None`; `state.dials` incremented).

**`start_proxy` algorithm** (one foreground task returned as `Task<Result<i32>>`, created with `cx.spawn(async move |cx| …)`):

1. `let Some((frames_tx, frames_rx)) = self.bridge.lock().as_mut().and_then(|b| b.frames_rx.take().map(|rx| (b.frames_tx.clone(), rx))) else { return Task::ready(Err(anyhow!("websocket session already attached or killed"))) }`. **Invariant: one pump per pooled connection.** A second `RemoteClient::new` on the same connection (the directory pickers in `remote_servers.rs:1611/1686/1800`, `connect_reusing_pool` in `remote_connection.rs:622`, `worktree_picker.rs:1585`) fails here with a clear error instead of opening a second socket to a single-session server; those flows are not offered for the WebSocket variant (§3.14).
2. `delegate.set_status(Some("Attaching to workspace"), cx)`. Send `Frame::text(serde_json::to_string(&ControlFrame::Hello(Hello { protocol, build: client_build_id, workspace_id, session_id: state.current.session_id, identifier: format!("{unique_identifier}/{}", state.instance), reconnect, takeover: options.takeover, client, epoch: if reconnect { state.epoch() } else { None } }))?)` through `frames_tx`. `session_id` is always the one that came with the current token (D1: minted per connect; b2 closes 4003 when it differs from the JWT `sid`). `identifier` carries a per-`WebSocketSessionState` nonce (§4.1) because `ConnectionIdentifier::setup()` is a process-local counter (`remote_client.rs:353-359`) and every browser tab would otherwise present `setup-1` — b2 treats a same-`identifier` redial as the same instance and replaces the old socket without `takeover`, which must not happen between two tabs. The nonce is stable across the reconnects of one session state, so a genuine same-instance redial still supersedes its own half-open socket.
3. Await the first frame with a 15 s timer (`cx.background_executor().timer`). It must be a `Text` frame decoding to `ControlFrame::HelloAck`: check `protocol == PROTOCOL_VERSION`; `builds_compatible(client_build, ack.build)` (else record `CloseInfo{4002}` and return `Ok(ProxyLaunchError::IncompatibleServer.to_exit_code())`); store `WebSocketServerInfo` in `self.server_info` and `state.server_info`, `state.epoch = Some(ack.epoch)`, `state.reconnect_attempts = 0`. **If `reconnect && !ack.resumed`** (the server restarted, the epoch was stale, or another instance attached in between — the server treated our `reconnect:true` as a *fresh* session per D3, and replaying unacked envelopes against a reset `HeadlessProject` would be wrong, exactly like `execute_proxy --reconnect` at `server.rs:881-890`) → return `Ok(ProxyLaunchError::ServerNotRunning.to_exit_code())`; the shell's host `reconnect()` (D2) then opens a fresh session. A `Close` frame → map per step 5; anything else → `Err("unexpected first frame")`. On reconnect this exchange is the only in-band work inside `RemoteClient::reconnect`'s 5 s `resync` window (plus `FlushBufferedMessages`/`Ack`); the socket is already open and authenticated, so it is one round trip.
4. `delegate.set_status(None, cx)`; run the pump: native `cx.background_spawn(run_pump(..)).await` (everything is `Send` now); wasm `run_pump(..).await` inline on the foreground task, with `decode_envelope_frame` offloaded via `cx.background_spawn` for frames ≥ 64 KiB (the `Bytes` payload is `Send`; BUILD-SPEC line 193 wants marshalling off the main thread).
   ```rust
   async fn run_pump(frames_tx: mpsc::Sender<Frame>, frames_rx: mpsc::Receiver<Result<Frame, String>>,
       incoming_tx: UnboundedSender<Envelope>, outgoing_rx: UnboundedReceiver<Envelope>,
       connection_activity_tx: Sender<()>, state: Arc<WebSocketSessionState>,
       executor: BackgroundExecutor /* for the heartbeat timer; `Send + Clone`, `timer()` exists on wasm (executor.rs:197) */) -> Result<i32>;
   ```
   `select_biased!` over:
   - `heartbeat.next()` where `heartbeat` is a re-armed `executor.timer(Duration::from_secs(HEARTBEAT_INTERVAL_SECS))`: send `Frame::text(r#"{"type":"heartbeat"}"#)` (`ControlFrame::Heartbeat`) through `frames_tx` — **client → server every 5 s (D3)**, the server's liveness signal for this socket and the only client-originated traffic in an idle session besides the proto `Ping`. Not an envelope, so it never touches b2's `is_input_envelope`. In a hidden browser tab the browser throttles this timer (≥ 1 s, and once per minute after ~5 min hidden), so the server must tolerate heartbeat gaps of at least a minute before treating the socket as dead (§7.8, contract item in §7.12).
   - `outgoing_rx.next()`: `None` → `Ok(0)`; `Some(envelope)` → `let bytes = encode_envelope_frame(&envelope)`; **if `bytes.len() > MAX_FRAME_BYTES`** → `log::error!`, and (if the envelope is a request, i.e. it is not itself a response) inject a local `Envelope { responding_to: Some(envelope.id), payload: Error { message: "message too large for the WebSocket transport (…)", code: Internal } }` into `incoming_tx` so the pending request fails (`remote_client.rs:1975`) instead of looping the same poison envelope through every reconnect replay; otherwise `frames_tx.send(Frame::binary(bytes)).await` (`Err` → `Err("socket closed")`).
   - `frames_rx.next()`: `None` (bridge dropped: `kill()`, socket EOF, TLS reset, oversize inbound frame on native) → `Err(anyhow!("websocket closed"))`; `Some(Err(msg))` → `Err(anyhow!(msg))`; `Some(Ok(frame))` by opcode:
     - `OpCode::Binary` → `decode_envelope_frame(payload, MAX_FRAME_BYTES)?` → `incoming_tx.unbounded_send(envelope).ok()`; `connection_activity_tx.try_send(()).ok()` (exactly like `transport.rs:170-171`).
     - `OpCode::Text` → `ControlFrame::Log(record)` → `record.log(log::logger())` (`json_log.rs:26`; reserved — b2 does not emit it in v1, b2 §7.4(d)); an inbound `ControlFrame::Heartbeat` is tolerated (activity only) but not part of the contract — the frame is client → server (D3); other control frames after the handshake are logged and ignored. Counts as activity.
     - `OpCode::Ping | OpCode::Pong` → activity only (yawc answers pings on native; browsers never surface ping/pong to JS, so this arm is dead on wasm — there the activity channel is fed by the `Ack`s to the client's own proto `Ping`s and by ordinary traffic).
     - `OpCode::Close` → `state.last_close = Some(CloseInfo{code, reason})` and return per step 5.
     - `OpCode::Continuation` → ignore (yawc reassembles).
5. Close-code → `monitor` mapping (`remote_client.rs:888-897` decides reconnect vs. terminal):

   | Outcome | Return | Effect |
   |---|---|---|
   | 4001 superseded (another client attached with `takeover:true`; D3) | `Ok(91)` (`ProxyLaunchError::SessionTakenOver`) | terminal, no reconnect, `refresh` never called (would steal the session back) |
   | 4005 session active (attach refused: another instance attached, `takeover=false`; D3) | `Ok(91)` | terminal; `last_close()` distinguishes it from 4001 (b2 §7.4(a): shows the take-over UI instead of retrying) |
   | 4002 build mismatch (Close or `HelloAck.build`) | `Ok(92)` (`ProxyLaunchError::IncompatibleServer`) | terminal; UI reads `last_close()` and asks for a reload |
   | 4006 bad Hello (b2: protocol mismatch / malformed) | `Ok(92)` | terminal; redialing would repeat the same Hello |
   | 1001 server going away (SIGTERM / lifecycle `STOPPING`; D3 — replaces the former 4004) | `Ok(90)` (`ServerNotRunning`) | terminal; `refresh` never called (b9: a reconnect must never resume a stopped workspace); the shell's host `reconnect()` (D2) resumes on the next user action |
   | `reconnect && !HelloAck.resumed` (server restarted, stale epoch, or fresh session per D3) | `Ok(90)` | terminal; UI offers a fresh open (`Hello{reconnect:false}`) via host `reconnect()` |
   | 4003 unauthorized, 1000/1008/1009 and other 1000-1013, unknown 4xxx, abrupt EOF, socket error, oversize inbound frame, `kill()` | `Err(..)` | `reconnect()` → `new()` refreshes `{url, token, session_id}` with backoff → redial (≤ `max_reconnect_attempts()` = 20, D2); `RefreshError::Stopped`/`Unauthorized` end it early |

   Whatever the outcome, the `start_proxy` task sets `self.killed` before returning (the bridge is dropped by `kill()` or by dropping the connection), so `has_been_killed()` is true for every connection whose pump has ended and the pool (`remote_client.rs:1252-1258`) never hands it out again — a from-scratch `remote::connect` after a terminal state (D2's host `reconnect()`, "Take back" after 4001) always dials anew even if something still holds the old `Arc`.

`kill()`: `self.killed.store(true)`; `self.bridge.lock().take()` (drops the socket task → the socket is closed synchronously on wasm by `ClosingSocket::drop`, and on native by dropping `TcpWebSocket`); return `Ok(())` without awaiting (the SSH impl awaits process exit at `ssh.rs:310`, but the pump may already be cancelled — `RemoteClient::reconnect` drops it at `:622` before calling `kill()` at `:670`, which is why the socket must be owned by the bridge and not by the pump). `has_been_killed()` reads the flag, which makes `ConnectionPool::connect` build a fresh connection on reconnect (`remote_client.rs:1252-1258`). A `kill()` while the pump is alive (`RemoteClient::force_disconnect`, `:1056`) makes the pump return `Err("websocket closed")`, which `monitor` turns into a reconnect — the documented `force_disconnect` behaviour. Dropping the connection (`shutdown_processes`, `:580`) closes the socket the same way.

### 3.4 `crates/remote/src/proxy.rs` — modify

```rust
#[derive(Copy, Clone, Error, Debug)]
#[repr(i32)]
pub enum ProxyLaunchError {
    #[error("Attempted reconnect, but server not running.")]
    ServerNotRunning = 90,
    /// Another client holds the WebSocket session (close code 4001 superseded, or 4005 session active).
    #[error("Another client is attached to this workspace session.")]
    SessionTakenOver = 91,
    /// Server build/protocol does not match this client (close code 4002 or 4006, or HelloAck.build).
    #[error("Remote server build is incompatible with this client.")]
    IncompatibleServer = 92,
}
```
Touch `:5-11` (variants; the `thiserror` derive requires the `#[error]` attributes) and `:18-23` (`from_exit_code`: add `91`, `92`). `monitor`'s `match error` (`remote_client.rs:889-897`) is exhaustive and gains the arms in §3.5; `server.rs:886/981` only construct `ServerNotRunning` and need no change. `ServerNotRunning` (90) is reused for 1001 "server going away" and for `reconnect && !resumed` — both mean "nothing to resume here; open a fresh session".

### 3.5 `crates/remote/src/remote_client.rs` — modify

- `:48` → `time::Duration` only; add `use web_time::Instant;` (identical to the fork; `web-time` re-exports `std` on native). Affects `:1820`.
- `:1329-1336` add `WebSocket(crate::transport::websocket::WebSocketConnectionOptions)`; `display_name` `:1339-1356` add `WebSocket(opts) => opts.display_name()` (host of `url`, else `workspace_id`); `connection_type` `:1360-1374` add `WebSocket(_) => "websocket"`; after `:1578` add `impl From<WebSocketConnectionOptions> for RemoteConnectionOptions`. The derived `Hash`/`Eq` of the enum delegate to `WebSocketConnectionOptions`'s manual impls, which use `workspace_id` only (D1) — the pool key and window-reuse identity therefore survive URL/token/`session_id` rotation.
- `:1271-1297` (pool) add `RemoteConnectionOptions::WebSocket(opts) => WebSocketRemoteConnection::new(opts, delegate, cx).await.map(|c| Arc::new(c) as Arc<dyn RemoteConnection>)` — async, like the SSH arm; this is where refresh/backoff/dial run (§3.3).
- `:888-897` (`monitor`) handle the new variants: `SessionTakenOver | IncompatibleServer | ServerNotRunning => set_state(State::ServerNotRunning)` (log each distinctly).
- Trait `:1596-1645`: add a defaulted method `fn max_reconnect_attempts(&self) -> usize { MAX_RECONNECT_ATTEMPTS }` and use it at `:639` (`if attempts > remote_connection.max_reconnect_attempts()`; `remote_connection` is in scope from the `match state` at `:606-632` and, on the retry path, is the connection carried in `State::ReconnectFailed` — which shares the session `state` `Arc` with every connection of that session). The WebSocket impl returns `WS_MAX_RECONNECT_ATTEMPTS = 20` (D2), or **`0` once `state.terminal` is set** (`RefreshError::Unauthorized`/`Stopped`), so the iteration after a terminal refresh answers `attempts > 0` and sets `ReconnectExhausted` without another dial (`:639-646`; verified: `reconnect()` re-enters through `this.reconnect(cx)` at `:762-763` while the state is `ReconnectFailed`). Reason: BUILD-SPEC §3.6 wants retry with backoff across a sandbox resume; SSH keeps 3. `MAX_RECONNECT_ATTEMPTS` stays `pub` for `remote_debug.rs:48`. The reconnect budget is otherwise unchanged upstream code: bounded, then `ReconnectExhausted` (D2), with `last_close()` readable through the options snapshot (§4.1).
- Trait `:1596-1645`: add a defaulted `fn supports_extension_upload(&self) -> bool { true }` (§3.20); b3 adds `supports_remote_pty()` in the same place (b3 §3.4) — coordinate the two one-line insertions, both defaulted, no ordering dependency.
- `:1911`, `:1933`: replace `smol::future::or(a, b)` with `futures::future::select(a, b)` (or `futures::future::Either`). **Required, not optional**: b5's wasm `smol` shim exports only `fs`, `net`, `process` and `spawn` (b5 §8 "missing" 12), so `smol::future` does not exist in the browser build and `crates/remote` would not compile there. These are the only two `smol::` uses in the file (verified by grep).
- Top-of-file imports: `transport::websocket::{WebSocketConnectionOptions, WebSocketRemoteConnection}`.

(An earlier draft also added `initial_connection_timeout()`; it is dropped — with the dial moved into `connect`, `start_proxy` only has to deliver `Hello`/`HelloAck` and the server's `RemoteStarted` inside `INITIAL_CONNECTION_TIMEOUT`, and a reconnect never uses that constant. Revisit if §6.3 test 1 shows the 5 s debug budget is too tight.)

### 3.6 `crates/remote/src/remote_identity.rs` — modify

`:10-27` add `WebSocket { workspace_id: String }` (D1: the stable workspace identity; `session_id` is per-connect and never part of identity or persistence); `:32-57` `persistence_key` → `format!("ws:{workspace_id}")`; `:60-81` `From` arm `RemoteConnectionOptions::WebSocket(o) => Self::WebSocket { workspace_id: o.workspace_id.clone() }`. Add a unit test mirroring `:107-133` (url/session_id/token/takeover/refresh do not affect identity).

### 3.7 `crates/remote/src/transport.rs` — modify

`:17-21` add `pub mod websocket;` (unconditional — it is the only transport that compiles on wasm). Gating `ssh`/`wsl`/`docker` for wasm is W3's, not this brief's.

### 3.8 `crates/remote/src/remote.rs` — modify

`transport` is private (`:6`), so append after `:20`:
```rust
pub use transport::websocket::{
    CloseInfo, RefreshError, RefreshReason, WebSocketClientDelegate, WebSocketConnectionOptions,
    WebSocketRemoteConnection, WebSocketServerInfo, WebSocketSession, WebSocketSessionRefresh,
    client_build_id, session_refresh_provider, set_session_refresh_provider,
};
pub use transport::websocket::wire as websocket_wire;
```
The server imports `remote::websocket_wire::{ControlFrame, Hello, HelloAck, …}`.

### 3.9 `crates/remote/Cargo.toml` — modify (§5)

### 3.10 `crates/workspace/src/persistence/model.rs` — modify

`:36-40` add `WebSocket`; `:160-177` `"websocket"` both ways. Older desktop builds deserialize `"websocket"` as `None` and skip those rows (`restorable_workspaces` `filter_map`s them, `remote_connection(id)` errors with "invalid remote_connection row") — acceptable, and no error path panics.

### 3.11 `crates/workspace/src/persistence.rs` — modify

- `:1712-1747` add arm `RemoteConnectionIdentity::WebSocket { workspace_id } => { kind = RemoteConnectionKind::WebSocket; name = Some(workspace_id); user = None; }` — exactly D1's `name = workspace_id`, `host = None`, `user = None`; **`host` stays `None`** (as do `port`, `distro`, `container_id`): the select at `:1782-1800` matches on every one of those columns, so storing the per-resume `<session>.vercel.run` host would create a new `remote_connections` row (and lose the persisted layout/toolchains) on every resume. `name = workspace_id` is the whole identity; it is stable across stop/resume, takeover and rebuild (D1, D9 — the client-state image that holds this database travels with the workspace, D7), and `session_id` never reaches the database.
- `:2009-2032` add `RemoteConnectionKind::WebSocket => Some(RemoteConnectionOptions::WebSocket(WebSocketConnectionOptions::new(String::new(), name?, String::new(), String::new())))` (`new(url, workspace_id, session_id, token)`) — the struct has a `pub(crate) state` field (§4.1), so a literal does not compile outside `crates/remote`. A restored row carries no URL, no `session_id` and no token; `WebSocketRemoteConnection::new` on it succeeds only if `options.refresh` or the process-wide `session_refresh_provider` supplies a session (§3.16 gates desktop restore on that).
- No schema migration: existing columns suffice.

### 3.12 `crates/workspace/src/workspace.rs` — modify

- `:10450-10466` add `(RemoteConnectionOptions::WebSocket(a), RemoteConnectionOptions::WebSocket(b)) => a.workspace_id == b.workspace_id` before the `_ => false` arm (not a compile requirement, but window reuse needs it).
- Extract from `open_remote_project_inner` (`:11128-11241`):
  ```rust
  async fn resolve_remote_project_paths(project: &Entity<Project>, paths: Vec<PathBuf>, cx: &mut AsyncApp)
      -> (Vec<(PathBuf, Option<ProjectPath>)>, Vec<anyhow::Error>);        // lines 11139-11156
  async fn finish_opening_remote_workspace(project: Entity<Project>, workspace: Entity<Workspace>,
      workspace_id: WorkspaceId, serialized_workspace: Option<SerializedWorkspace>,
      project_paths_to_open: Vec<(PathBuf, Option<ProjectPath>)>, project_path_errors: Vec<anyhow::Error>,
      window: WindowHandle<MultiWorkspace>, cx: &mut AsyncApp)
      -> Result<Vec<Option<Box<dyn ItemHandle>>>>;                          // lines 11193-11240
  ```
  and make `open_remote_project_inner` call both (behaviour unchanged).
- New public entry points (D16; the `_with_client` form is the API `zed_web` calls, b7 §3.28; desktop can use either):
  ```rust
  pub struct OpenedRemoteProject {
      pub window: WindowHandle<MultiWorkspace>,
      pub workspace: Entity<Workspace>,
      pub items: Vec<Option<Box<dyn ItemHandle>>>,
  }

  /// Opens a brand-new window whose only workspace is the remote project served by an
  /// already-created `RemoteClient` (D16). The caller has run `remote::connect` and
  /// `RemoteClient::new` itself — so it can load the client-state image over
  /// `remote.read(cx).proto_client()` (b4 §3.8 `load_client_state`) and initialise
  /// `WorkspaceDb` *before* `deserialize_remote_project` runs here. Unlike
  /// `open_remote_project_with_new_connection` it needs no pre-existing window and no
  /// placeholder local project (which would double every project subscription,
  /// `workspace.rs:1610`, and leave a held placeholder in the sidebar).
  pub fn open_remote_project_in_new_window_with_client(
      remote: Entity<RemoteClient>,
      app_state: Arc<AppState>,
      paths: Vec<PathBuf>,
      window_options: WindowOptions,
      cx: &mut App,
  ) -> Task<Result<OpenedRemoteProject>>;

  /// Desktop convenience: dials nothing, builds the `RemoteClient` from a pooled connection
  /// with `ConnectionIdentifier::Workspace(workspace_id.0)` (as `:11054-11068`), then opens the
  /// window like the `_with_client` form. `None` when `cancel_rx` fires.
  pub fn open_remote_project_in_new_window(
      remote_connection: Arc<dyn RemoteConnection>,
      cancel_rx: oneshot::Receiver<()>,
      delegate: Arc<dyn RemoteClientDelegate>,
      app_state: Arc<AppState>,
      paths: Vec<PathBuf>,
      window_options: WindowOptions,
      cx: &mut App,
  ) -> Task<Result<Option<OpenedRemoteProject>>>;
  ```
  Bodies (both share a private `open_remote_project_in_new_window_inner(project, paths, workspace_id, serialized_workspace, app_state, window_options, cx)` so `deserialize_remote_project` — which calls `db.next_id()` for an unknown workspace — runs exactly once per open):
  - `_with_client`: `let connection_options = remote.read(cx).connection_options();` (`remote_client.rs:1005`, a clone) → `deserialize_remote_project(connection_options, paths.clone(), cx)` (`:11243`) → `Project::remote(remote, app_state.client.clone(), app_state.node_runtime.clone(), app_state.user_store.clone(), app_state.languages.clone(), app_state.fs.clone(), true, cx)` (as `:11070-11081`) → inner.
  - connection-taking form: `deserialize_remote_project(remote_connection.connection_options(), ..)` → `remote::RemoteClient::new(ConnectionIdentifier::Workspace(workspace_id.0), remote_connection, cancel_rx, delegate, cx)` (`None` → `Ok(None)` on cancel) → `Project::remote(..)` → inner.
  - inner: `resolve_remote_project_paths` → `cx.open_window(window_options, |window, cx| { let workspace = cx.new(|cx| { let mut w = Workspace::new(Some(workspace_id), project.clone(), app_state.clone(), window, cx); w.update_history(cx); if let Some(s) = &serialized_workspace { w.centered_layout = s.centered_layout; } w }); cx.new(|cx| MultiWorkspace::new(workspace, window, cx)) })` → `finish_opening_remote_workspace` → `OpenedRemoteProject { window, workspace, items }`.
  For the `_with_client` form the `ConnectionIdentifier` is the caller's (b7 uses `ConnectionIdentifier::setup()`, b7:776); for the WebSocket transport it only feeds `Hello.identifier` (§3.3 step 2), never a socket path.

### 3.13 `crates/recent_projects/src/remote_connections.rs` — modify

`:316-326` and `:377-387`: add `RemoteConnectionOptions::WebSocket(_) => "Failed to connect to workspace"`. Nothing else: `open_remote_project` then works for desktop deep links, using the modal's status line as `set_status` sink.

### 3.14 Remaining exhaustive matches — modify, one arm each

- `crates/recent_projects/src/recent_projects.rs:1997` → `RemoteConnectionOptions::WebSocket(_) => IconName::Server` (`crates/icons/src/icons.rs:235`; there is no `Cloud` variant, only `CloudDownload` at `:75`).
- `crates/recent_projects/src/remote_servers.rs:411` → `WebSocket(opts) => ProjectPickerData::Ssh { connection_string: opts.display_name().into(), nickname: None }` (display-only placeholder, as Docker). The directory-picker flows that create a second `RemoteClient` on the pooled connection (`:1576-1611`, `:1663-1686`, `:1775-1800`) have no WebSocket entry point; if one is added later it must open its own session — `start_proxy` refuses a second attach (§3.3 step 1).
- `crates/remote_connection/src/remote_connection.rs:255` → `WebSocket(opts) => (opts.display_name(), None, false, false)`.
- `crates/title_bar/src/title_bar.rs:624` → `WebSocket(_) => (None, "Cloud Workspace", IconName::Server)`.
- `crates/project/src/trusted_worktrees.rs:170` → `WebSocket(opts) => (None, SharedString::new(opts.workspace_id))`.

### 3.15 `crates/remote_server` — tests only (§6.3); `Cargo.toml` dev-deps (§5)

### 3.16 Desktop restore gating — `crates/zed/src/main.rs:1434`, `crates/zed/src/zed/open_listener.rs:924` — modify

Both restore paths call `open_remote_project` for every persisted `SerializedWorkspaceLocation::Remote(opts)`; a restored WebSocket row has no token and no `refresh`, so every desktop launch would show the Critical "Failed to connect to workspace" prompt (`remote_connections.rs:312-333`). Add, next to the existing `if let RemoteConnectionOptions::Ssh(options) = &mut connection_options { … }`:
```rust
if let RemoteConnectionOptions::WebSocket(options) = &connection_options
    && !cx.update(|cx| options.can_dial(cx))
{
    log::info!("skipping restore of cloud workspace {}: no session provider registered", options.workspace_id);
    continue; // main.rs loop; in open_listener.rs: skip this location and mark nothing as errored
}
```
`can_dial(cx)` = non-empty `token` || `refresh.is_some()` || `session_refresh_provider(cx).is_some()`. Desktop "recent projects"/deep-link support installs a provider via `set_session_refresh_provider` (deferred; §7).

### 3.17 `crates/gpui_tokio/src/gpui_tokio.rs` — modify

After `:99` add `pub fn try_handle(cx: &App) -> Option<tokio::runtime::Handle> { cx.try_global::<GlobalTokio>().map(|t| t.handle.clone()) }` so `WebSocketRemoteConnection::new` can return `Err("gpui_tokio not initialised")` instead of panicking inside `Tokio::spawn_result` (`:83`). `gpui_tokio::init` is called by desktop (`crates/zed/src/main.rs:489`) and `serve`/`run` (`server.rs:654`); other native embedders (e.g. `crates/project_benchmarks/src/main.rs:153`, currently SSH-only) must call it before using the WebSocket transport (§5).

### 3.18 Vendored yawc + workspace `[patch]` — create/modify (D10)

Copy `zed-industries/yawc` at `71a452f551cac178367eaac5d7418a09afa1f3a2` (the checkout at `~/.cargo/git/checkouts/yawc-4536022b4863f78e/71a452f`) to `zed/vendor/yawc` — D10: until a GitHub fork exists, every modified third-party crate is vendored under `zed/vendor/<name>` as a path `[patch]`; no `<org>` placeholder anywhere — with two wasm-only changes in `src/wasm.rs`:
```rust
/// `new WebSocket(url, protocols)` — the only way a browser can offer subprotocols.
pub async fn connect_with_protocols(url: Url, protocols: &[&str]) -> Result<Self> {
    let array = js_sys::Array::new();
    for p in protocols { array.push(&JsValue::from_str(p)); }
    let stream = web_sys::WebSocket::new_with_str_sequence(url.as_str(), &array).map_err(WebSocketError::Js)?;
    Self::from_stream(stream).await   // the body of `connect` from `:48` onwards, factored out
}
impl Drop for WebSocket { fn drop(&mut self) { let _ = self.stream.close(); } }   // `:22-27` `stream` is private, so only the crate can do this
```
Workspace `Cargo.toml`: add `[patch."https://github.com/zed-industries/yawc"] yawc = { path = "vendor/yawc" }` next to `[patch.crates-io]` (`:976`); the dependency line at `:910` is unchanged (the patch must keep `version = "0.3.3"` in `vendor/yawc/Cargo.toml` so it satisfies the `version` on `:910`). `zed/vendor/README.md` (shared with b5/b6, who vendor `alacritty_terminal`, `lsp-types` and `agent-client-protocol` the same way under D10) gets a `yawc` section recording: upstream `https://github.com/zed-industries/yawc`, revision `71a452f551cac178367eaac5d7418a09afa1f3a2`, the two-change diff above, and the intended git-patch form once a fork repository exists (`[patch."https://github.com/zed-industries/yawc"] yawc = { git = "<fork url>", rev = "<sha>" }` — recorded in the README only, never in `Cargo.toml`). `vendor/yawc` is **not** a workspace member: this brief appends `"vendor/yawc"` to the `[workspace] exclude` array that b5 item 4 introduces (`exclude = ["vendor/lsp-types", "vendor/agent-client-protocol", "vendor/yawc", …]`; b6 §3.1 appends `vendor/alacritty_terminal` the same way), so it is a standalone package for `cargo test --manifest-path vendor/yawc/Cargo.toml`, is neither linted by `script/clippy --workspace` nor run by `cargo test --workspace` as ours, and cannot be `cargo -p`-targeted; the wasm check crate in §5 compiles it transitively. Open an upstream PR to `zed-industries/yawc` with the same diff. Reason: BUILD-SPEC line 218 says the subprotocol carries the token; a `?zs_token=` query form would put the JWT in Vercel edge/access logs (BUILD-SPEC line 431, threat 4) and force b2 to accept two placements. `ClosingSocket` (§3.3 step 4) stays even with the `Drop` patch so the transport does not depend on it.

### 3.19 `crates/remote/build.rs` — create (b2 §7.4(c))

`wire.rs` reads `option_env!("ZS_BUILD_ID")` at compile time; without a build script cargo does not know the crate depends on that variable and a cached `remote` rlib keeps a stale id, which then fails `builds_compatible` against a correct server (b2 R2 M12 found the same for `remote_server`, fixed by b2 §3.13). Add a three-line script — `fn main() { println!("cargo:rerun-if-env-changed=ZS_BUILD_ID"); }` — mirroring `crates/remote_server/build.rs:29-33`. It is target-agnostic (no `std::process`, nothing wasm-hostile) and needs no `build = ` key (`build.rs` is auto-detected).

### 3.20 `supports_extension_upload()` gate — `crates/remote/src/remote_client.rs`, `crates/extension_host/src/extension_host.rs:2285` — modify (b4 §7.3)

- Trait `remote_client.rs:1596-1645`: defaulted `fn supports_extension_upload(&self) -> bool { true }`; `impl RemoteClient` next to `shell()` (`:946-948`, the same spot b3 §3.4 uses for `supports_remote_pty()`): `pub fn supports_extension_upload(&self) -> bool { self.remote_connection().is_some_and(|c| c.supports_extension_upload()) }`. `WebSocketRemoteConnection` returns `false` (`upload_directory` is a ready `Err`, §3.3).
- `extension_host.rs:2285` `register_remote_client`: after the already-registered check at `:2287-2289`, add `if !client.read(cx).supports_extension_upload() { log::info!("extension sync skipped: {} does not accept uploads", client.read(cx).connection_options().connection_type()); return; }` so a desktop "open in desktop" connect over this transport (BUILD-SPEC §1) never runs `reconcile_remote_client`'s upload path against the sandbox (b4 §3.13 already makes the server's `sync_extensions` additive, so this only removes the per-extension upload errors b4 §7.3 describes). `extension_host` is excluded from the browser build (BUILD-SPEC §3.1), so the gate is native-only by construction.

## 4. New types and messages

### 4.1 Options, session, refresh callback (`crates/remote/src/transport/websocket.rs`)

```rust
use std::sync::Arc;
use gpui::{App, AsyncApp, Task};

/// Connection options for a `zed-remote-server serve` endpoint (D1 shape:
/// `{ url, workspace_id, session_id, token, takeover }` plus the two runtime-only fields).
///
/// Identity (Hash/Eq, workspace persistence, ConnectionPool key, sandbox name) is `workspace_id`
/// only: `url`, `token` and `session_id` are expected to change across resumes and reconnects.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct WebSocketConnectionOptions {
    /// Full endpoint, e.g. `wss://<session>.vercel.run/rpc`. Refreshed by `refresh`. Empty for a
    /// restored row until the refresh callback fills it.
    pub url: String,
    /// Stable identity of the workspace (control-plane workspace id; D1). Persisted as
    /// `remote_connections.name`; the JWT `ws` claim.
    pub workspace_id: String,
    /// Minted by the control plane on every `/connect`; informational (telemetry, logs, the
    /// server's session bookkeeping — b2 requires `Hello.session_id == JWT sid`). Rotated by
    /// `refresh`; never part of identity or persistence (D1). Not serialized: a restored row
    /// gets a new one from the next refresh.
    #[serde(skip)]
    pub session_id: String,
    /// ES256 session JWT. Never serialized, never printed.
    #[serde(skip)]
    pub token: String,
    /// Ask the server to close any other attached client with 4001 and attach us.
    /// Per-attempt flag, never persisted (a restored workspace must not replay a takeover).
    #[serde(skip)]
    pub takeover: bool,
    /// Supplies a fresh `{url, token}` before each reconnect dial. `None` → the process-wide
    /// `session_refresh_provider`, else reuse `url`/`token`.
    #[serde(skip)]
    pub refresh: Option<Arc<dyn WebSocketSessionRefresh>>,
    /// Shared across the connection objects the pool creates for one session.
    #[serde(skip)]
    pub(crate) state: Option<Arc<WebSocketSessionState>>,
}
impl WebSocketConnectionOptions {
    pub fn new(url: impl Into<String>, workspace_id: impl Into<String>, session_id: impl Into<String>, token: impl Into<String>) -> Self;
    pub fn with_takeover(self, takeover: bool) -> Self;
    pub fn with_refresh(self, refresh: Arc<dyn WebSocketSessionRefresh>) -> Self;
    pub fn display_name(&self) -> String;                 // host of url, else workspace_id
    pub fn can_dial(&self, cx: &App) -> bool;             // token non-empty || refresh || session_refresh_provider(cx)
    /// The server's last close frame (or a synthesized 4003 after `RefreshError::Unauthorized`,
    /// 1001 after `RefreshError::Stopped`).
    /// Readable after `RemoteClient` reached `ServerNotRunning`/`ReconnectExhausted` — states in
    /// which the `Arc<dyn RemoteConnection>` is no longer reachable (`remote_client.rs:213-225`) —
    /// through `project.remote_connection_options(cx)` / `RemoteClient::connection_options()`,
    /// whose snapshot shares this `state`.
    pub fn last_close(&self) -> Option<CloseInfo>;
    pub fn server_info(&self) -> Option<WebSocketServerInfo>;   // same source
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_backoff_for_tests(&self, delay: Duration);
}
impl std::fmt::Debug for WebSocketConnectionOptions { /* token → "<redacted>", refresh → is_some() */ }
impl PartialEq for WebSocketConnectionOptions { fn eq(&self, o: &Self) -> bool { self.workspace_id == o.workspace_id } }
impl Eq for WebSocketConnectionOptions {}
impl std::hash::Hash for WebSocketConnectionOptions { /* workspace_id only */ }

/// One `/connect` result (D1): the endpoint, the JWT and the per-connect session id that the
/// JWT's `sid` claim names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebSocketSession { pub url: String, pub token: String, pub session_id: String }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseInfo { pub code: u16, pub reason: String }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshReason {
    /// `attempt` starts at 1 for the first reconnect after a drop; `last_close` is the
    /// server's close frame if one was received.
    Reconnect { attempt: usize, last_close: Option<CloseInfo> },
}

/// `Unauthorized` (the user's control-plane session is gone) and `Stopped` (the control plane
/// answered `409 workspace_stopped`: the workspace is stopped or stopping and a reconnect must
/// not resume it, b9 §3.26) are terminal (D2): the transport stops redialing at once and records
/// a synthesized `CloseInfo{4003}` / `CloseInfo{1001, "workspace stopped"}` so the shell can
/// prompt for sign-in / show "stopped, click to resume". `Other` is retried with backoff.
#[derive(Debug)]
pub enum RefreshError { Unauthorized, Stopped, Other(anyhow::Error) }

/// Implemented by the embedder (zed_web's `bridge::JsSessionRefresh` over the host's
/// `refreshConnectInfo()` (b7 §3.21), desktop against `POST /api/workspaces/{id}/connect`
/// through `http_client`). Must be cheap to clone via Arc and must not block: return a gpui
/// `Task` (foreground `cx.spawn` is fine on wasm). The control plane's `/connect` waits for the
/// sandbox to be healthy (BUILD-SPEC §3.4; b9 polls `202`/`423` for up to 5 min), so this call
/// may legitimately take a long time — it runs outside `RemoteClient::reconnect`'s 5 s window.
/// The returned `session_id` is the new per-connect id (D1) and must match the new token's `sid`.
pub trait WebSocketSessionRefresh: Send + Sync + 'static {
    fn refresh(&self, workspace_id: &str, reason: RefreshReason, cx: &mut AsyncApp)
        -> Task<Result<WebSocketSession, RefreshError>>;
}

#[derive(Default)]
pub struct WebSocketSessionState {
    pub(crate) current: parking_lot::Mutex<Option<WebSocketSession>>,   // {url, token, session_id}
    /// Per-boot client-instance nonce appended to `Hello.identifier` (§3.3 step 2):
    /// `format!("{:x}-{:x}", web_time::SystemTime::now().duration_since(UNIX_EPOCH).as_millis(), INSTANCE_COUNTER.fetch_add(1))`.
    /// Stable for the life of this state (all reconnects of one session), distinct across tabs.
    /// `web_time::SystemTime` is `std::time::SystemTime` on native and `Date.now()` on wasm
    /// (web-time 1.1.0 `src/lib.rs:5-7`); `std::time::SystemTime::now()` would panic there.
    pub(crate) instance: String,
    pub(crate) dials: std::sync::atomic::AtomicUsize,          // > 0 → the next `new()` is a redial
    pub(crate) reconnect_attempts: std::sync::atomic::AtomicUsize,
    pub(crate) epoch: parking_lot::Mutex<Option<u64>>,          // from the last HelloAck; sent back on reconnect
    pub(crate) last_close: parking_lot::Mutex<Option<CloseInfo>>,
    pub(crate) server_info: parking_lot::Mutex<Option<WebSocketServerInfo>>,
    pub(crate) terminal: std::sync::atomic::AtomicBool,        // set on RefreshError::Unauthorized | Stopped; makes max_reconnect_attempts() == 0
    pub(crate) backoff_override: parking_lot::Mutex<Option<Duration>>, // tests
}

/// No `PartialEq`/`Eq`: `RemotePlatform` (`remote_client.rs:113`) only derives `Copy, Clone, Debug`.
#[derive(Clone, Debug)]
pub struct WebSocketServerInfo {
    pub build: String,
    pub platform: RemotePlatform,    // parsed from HelloAck.os/arch with transport::parse_platform-equivalent rules
    pub os_version: Option<String>,
    pub shell: String,
    pub resumed: bool,
    pub epoch: u64,
}
```

`WebSocketConnectionOptions::new` allocates `state = Some(Arc::new(WebSocketSessionState { instance: <nonce>, ..Default::default() }))` and seeds `state.current` with `{url, token, session_id}`; `Clone` shares the `Arc`, so every connection object the pool builds for this session (`remote_client.rs:1266-1321`) — and the `connection_options` snapshot `RemoteClient` keeps at `:437`, which `DisconnectedOverlay` reconnects with — sees the same `current`, `instance`, `reconnect_attempts`, `epoch`, `last_close` and `server_info`. `WebSocketRemoteConnection::new` **never re-seeds `state.current` from `options.url/token/session_id` when `state` is already `Some`** (they may be stale copies); it reads `state.current` and only writes it after a successful refresh. A brand-new `WebSocketConnectionOptions::new(..)` (the shell's from-scratch host `reconnect()`, D2) gets a fresh state: `dials == 0` (first dial, no refresh), a new `instance` nonce (a new client instance as far as b2's same-instance rule is concerned), no `epoch`.

### 4.2 Wire (`crates/remote/src/transport/websocket/wire.rs`)

Text frames carry JSON control messages; binary frames carry envelopes. The first frame in each direction after the upgrade is a control frame.

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlFrame {
    Hello(Hello),        // client → server, first frame
    HelloAck(HelloAck),  // server → client, first frame
    Log(LogFrame),       // server → client, any time (reserved; b2 does not emit it in v1 — logs go stderr → supervisor → control plane)
    Heartbeat,           // client → server, every HEARTBEAT_INTERVAL_SECS (5 s) while the pump runs (D3); the server's liveness signal for the socket
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Hello {
    pub protocol: u32,          // PROTOCOL_VERSION (1)
    pub build: String,          // client_build_id()
    pub workspace_id: String,   // stable workspace identity (D1); == JWT `ws`
    pub session_id: String,     // per-connect id from the same /connect as the token (D1); == JWT `sid` (b2 closes 4003 otherwise)
    pub identifier: String,     // "<RemoteClient unique_identifier>/<instance nonce>" — unique per client instance; the server's same-instance-redial key
    pub reconnect: bool,        // == start_proxy's `reconnect`
    pub takeover: bool,
    pub client: ClientKind,     // Desktop | Web
    /// On `reconnect`, the `HelloAck.epoch` of the attachment being resumed. D3: the server
    /// attaches warm and replays only when `reconnect` is true **and** this equals its current
    /// epoch **and** it still holds the state; a stale epoch is treated as a fresh session
    /// (`HelloAck.resumed = false`, which the client maps to exit 90). Session arbitration
    /// (4005 / supersede) happens before this check, so a client whose socket died before
    /// another client took over cannot steal the session back.
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind { Desktop, Web }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HelloAck {
    pub protocol: u32,
    pub build: String,          // server's ZS_BUILD_ID / VERSION (server.rs:129)
    pub os: String,             // "linux"
    pub arch: String,           // "x86_64" | "aarch64"
    pub os_version: Option<String>, // util::parse_os_release output, cf. transport.rs:79-96
    pub shell: String,          // $SHELL of the server process, cf. transport.rs:117-126
    pub resumed: bool,          // true iff this is a D3 *reconnect* (warm attach + replay); false for every fresh session
    pub session_id: String,     // echo of Hello.session_id
    pub epoch: u64,             // incremented on every fresh session; unchanged on a resumed reconnect
}

/// Same fields as `json_log::LogRecord` (owned strings so it can be `'static`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LogFrame { pub level: usize, pub module_path: Option<String>, pub file: Option<String>, pub line: Option<u32>, pub message: String }
```

Binary frame payload: `encode_envelope_frame(&Envelope)` = `u32 LE len || prost(Envelope)`, ≤ `MAX_FRAME_BYTES` (16 MiB) **in both directions** (D3: 16 MiB inbound ceiling on both sides — inbound enforced by yawc `max_payload_read` on native and by `decode_envelope_frame` on both targets; outbound measured before send, §3.3 step 4; b2 sets the same `max_payload_read` and refuses to emit a larger frame with 1009); one envelope per frame; no fragmentation or compression requested (native `Options::default()` already has `compression: None`; the browser never negotiates `permessage-deflate` unless the server offers it — b2 must not).

### 4.3 Token placement

| Target | Placement | Why |
|---|---|---|
| native | `Sec-WebSocket-Protocol: zs.v1, <jwt>` via `WebSocketBuilder::with_request` (yawc keeps user headers; `src/native/mod.rs:914-942`) | matches BUILD-SPEC line 218 |
| wasm | `new WebSocket(url, ["zs.v1", "<jwt>"])` via the patched `WebSocket::connect_with_protocols` (§3.18) | browsers cannot set headers but can offer subprotocols; the JWT never appears in a URL or an edge log |

`validate_subprotocol_token` rejects anything outside the RFC 2616 token alphabet (padded/opaque tokens would otherwise make `http::HeaderValue` fail). The server contract (b2): verify the JWT from the subprotocol list before the upgrade (401/403 on failure, 426 when `zs.v1` is not offered — the only pre-upgrade rejections besides a disallowed `Origin`, D5/b2 §3.8); echo exactly `zs.v1` only when it was offered in the header (b2 §3.8 (d)). b2's `extract_token` tries the `Sec-WebSocket-Protocol` item first (b2 §3.8 `/rpc` (a)), so both targets here use it; b2 §4's remark that "wasm uses the query form" is stale — `?zs_token=` exists only for b2's `<a download>` `/files` path and the shell never builds a token URL (b9 §7.5, b7 R2 #16).

### 4.4 Handshake sequence (client view)

```
client                                  server (serve)
  |-- HTTP upgrade (Sec-WebSocket-Protocol: zs.v1, <jwt>) -->|  verify JWT (401/403/426 before upgrade on failure; nothing else is decided pre-upgrade)
  |<-- 101 (Sec-WebSocket-Protocol: zs.v1) --|
  |-- Text ControlFrame::Hello ---------->|  protocol/build check (Close 4002 / 4006); session arbitration (below)
  |<-- Text ControlFrame::HelloAck -------|  or Close 4001 / 4002 / 4005 / 4006
  |   (resumed=false) <- Binary RemoteStarted (fresh ChannelClient channel pair; HeadlessProject reset per D3)
  |-- Binary RemoteStarted -------------->|  (client ChannelClient always sends one, remote_client.rs:1736)
  |<-> Binary envelopes (Ping/Ack, FlushBufferedMessages/Ack on reconnect, …); Text Heartbeat client → server every 5 s (D3)
  |<-- Close 1001 "server going away" ----|  on SIGTERM / lifecycle STOPPING (after the D6 flush window); terminal for the client
```
Session semantics at `Hello` (D3 — this is the contract b2 adopts under D20; BUILD-SPEC §4.2 is amended to say exactly this):
1. **Arbitration first.** If another client is attached: `Hello.takeover:true` → the attached socket is closed with **4001 superseded** and the newcomer proceeds; `Hello.takeover:false` and the attached socket belongs to the **same instance** (same `Hello.identifier`, i.e. the half-open socket `RemoteClient::reconnect` just dropped, or a laptop-sleep/network-change survivor the server has not yet seen the FIN of) → the old socket is closed with 4001 and the newcomer proceeds (a same-instance redial is never refused); `takeover:false` and a **different instance** → the newcomer is closed with **4005 session active** (terminal for the newcomer; the shell shows the take-over UI). The broker is the single decision point; there is no pre-upgrade 409.
2. **Reconnect** (`Hello.reconnect = true`, `Hello.epoch == current epoch`, and the server still holds the state — same process, `ChannelClient` state of this instance intact): attaches **warm** — rebind the existing `(incoming_tx, outgoing_rx)` like `start_server`'s accept loop (`server.rs:425-537`), keep the server `ChannelClient` (replay buffer, `max_received`), do **not** send a new `RemoteStarted` (a duplicate would be harmless: `Signal::set` is idempotent), replay per Zed's ack/replay protocol on the client's `FlushBufferedMessages`; `HelloAck.resumed = true`, `epoch` unchanged.
3. **Fresh session** (`Hello.reconnect = false`, **or** a stale `epoch`, **or** nothing to resume because the server process restarted): the server **resets the `HeadlessProject`** — worktrees, language servers, git, settings observer restart (b2 §3.7: a warm *process*, cold project) — hands the server `ChannelClient` a new channel pair (b2 R1 #6), sends a fresh `RemoteStarted` first, `HelloAck.resumed = false`, `epoch` incremented. This is the accepted cost of a page reload, takeover and "open in desktop" (D3); dirty server-side buffers do **not** survive it — D6/D7 (b7) persist dirty buffers in the client-state image on `STOPPING`, b7's `beforeunload` guard covers navigation. The client needs nothing persisted for the attach itself — `wait_for_remote_started` resolves on the incoming `RemoteStarted` (`remote_client.rs:1772-1778`) and a fresh `Project::remote` re-opens worktrees and buffers by path. A client that sent `reconnect:true` and receives `resumed:false` cannot use the reset project with its old `ChannelClient` state and maps it to `Ok(90)` (§3.3 step 3); the shell's host `reconnect()` (D2) then opens a fresh session with `reconnect:false`.
4. **PTYs survive fresh sessions** (D3, D4): they live in b2/b3's server-level `PtyManager` outside `HeadlessProject`; the server calls `detach_all` when a session detaches and `kill_all` only on process shutdown or an explicit `CloseTerminal`; b3 restores them on a fresh session via `ListTerminals` + `AttachTerminal { from_offset: 0 }`. Nothing in this transport touches them.
5. **Close codes** (D3): 4001 superseded (takeover or same-instance supersede), 4005 session active, 1001 server going away; plus 4002 build mismatch, 4003 unauthorized (`Hello.session_id ≠ JWT sid`), 4006 bad Hello, 1008 slow consumer, 1009 oversize frame (b2). 4004 is retired.

### 4.5 `ProxyLaunchError` additions — see §3.4.

### 4.6 Public API contract for `crates/zed_web` (and desktop)

`crates/zed_web` does not exist in this checkout; this is the contract the shell workstream (b7 §3.28 `connect.rs`, §3.21 `bridge`) builds against. Boot-config field mapping (b7 §4.1 `ConnectInfo` ← b9 §3.18 `/connect`): `url ← wsUrl`, `workspace_id ← workspace.id` (the control-plane workspace id, D1), `session_id ← sessionId` (per-connect, D1), `token ← token`, `takeover ← connect.takeover`.

```rust
// 0. process setup (once): panics otherwise
release_channel::init(app_version, cx);            // ConnectionIdentifier::to_string → ReleaseChannel::global (remote_client.rs:367)
settings::init(cx); /* SettingsStore */            // Project::remote reads settings
#[cfg(not(target_family = "wasm"))] gpui_tokio::init(cx);   // native dial runs on tokio (§3.17)
// 1. options + refresh callback (D1 shape)
let options = remote::WebSocketConnectionOptions::new(ws_url, workspace_id, session_id, token)
    .with_takeover(takeover)
    .with_refresh(Arc::new(JsSessionRefresh));         // impl WebSocketSessionRefresh over host.refreshConnectInfo() (b7 §3.21);
                                                        // 409 workspace_stopped → Err(Stopped), {code:"unauthorized"} → Err(Unauthorized)
// 2. status sink (overlay is a gpui entity; reached through a WeakEntity and the AsyncApp)
let overlay = overlay.downgrade();
let delegate: Arc<dyn remote::RemoteClientDelegate> = Arc::new(remote::WebSocketClientDelegate::new(
    move |status, cx| { let status = status.map(str::to_owned); overlay.update(cx, |o, cx| o.set_status(status, cx)).ok(); }));
// 3. connect (pool: refresh/backoff/dial happen here) and create the one RemoteClient of the session
let connection = remote::connect(options.into(), delegate.clone(), &mut cx).await?;
let (_cancel_tx, cancel_rx) = futures::channel::oneshot::channel();          // held for the app lifetime
let remote = cx.update(|cx| remote::RemoteClient::new(remote::ConnectionIdentifier::setup(), connection, cancel_rx, delegate, cx))?
    .await?.ok_or_else(|| anyhow!("cancelled"))?;
// 3a. (b7/b4) load the client-state image over `remote.read(cx).proto_client()` and initialise WorkspaceDb (D7, D16)
// 3b. open the window around the existing client (D16)
let opened = cx.update(|cx| workspace::open_remote_project_in_new_window_with_client(
    remote.clone(), app_state, vec![PathBuf::from("/workspaces/<repo>")], window_options, cx))?.await?;   // OpenedRemoteProject { window, workspace, items }
// 4. after a terminal disconnect (RemoteClientEvent::Disconnected / project::Event::DisconnectedFromRemote):
let why = match remote.read(cx).connection_options() { remote::RemoteConnectionOptions::WebSocket(o) => o.last_close(), _ => None };
// 4001 → "taken over" (offer Take back = host reconnect() with takeover:true); 4002 → reload; 4003 → sign in; 4005 → busy (take-over UI);
// 1001 → "stopped" (never refresh; resume on user action); None → reconnect exhausted (D2) or `reconnect && !resumed` (open fresh)
// 5. host `reconnect()` (D2): drop the RemoteClient/Project/window, call /connect again, and repeat 1-3b with *new* options
//    (fresh WebSocketSessionState → Hello{reconnect:false}); the pool builds a new connection because the old one is killed (§3.3).
```
Desktop Zed reaches the same transport through `recent_projects::open_remote_project(RemoteConnectionOptions::WebSocket(..), …)` (`remote_connections.rs:128`) once §3.13 lands, and restores persisted rows only after `set_session_refresh_provider` (§3.16); the `zed://` deep-link parser (`crates/zed/src/zed/open_listener.rs`) is out of scope here.

## 5. Cargo/package changes

Workspace `Cargo.toml` already has every crate needed: `yawc` (`:910`), `url = "2.2"` (`:880`), `web-time = "1.1.0"` (`:902`), `gpui_tokio` (`:367`), `async-tungstenite = "0.33"` (`:549`), `jsonwebtoken = "10.0"` (`:670`), `http = "1.1"` (`:637`, not needed: yawc re-exports `HttpRequestBuilder`). Add the `[patch."https://github.com/zed-industries/yawc"] yawc = { path = "vendor/yawc" }` table (§3.18, D10) and the `vendor/yawc` tree; `crates/remote/build.rs` (§3.19).

`crates/remote/Cargo.toml` (append to `[dependencies]` after `:47`; add the target section; **append to the existing `[dev-dependencies]` table at `:49-52`** — a second table is a TOML duplicate-key error):

```toml
[dependencies]
# … existing …
url.workspace = true
web-time.workspace = true
yawc.workspace = true

[target.'cfg(not(target_family = "wasm"))'.dependencies]
gpui_tokio.workspace = true

[dev-dependencies]
gpui = { workspace = true, features = ["test-support"] }
fs = { workspace = true, features = ["test-support"] }
util = { workspace = true, features = ["test-support"] }
async-tungstenite.workspace = true      # loopback fake server in tests (runtime-agnostic, used with smol::net)
```
`web-time` also replaces `std::time::Instant` in `remote_client.rs:48` (fork precedent; b5 §7.10/§7.19 lists this swap and `rpc`'s as the two b1/b2 depends on — `rpc`'s is b5/b6's) and supplies `SystemTime` for the instance nonce (§4.1). `yawc` on wasm pulls `web-sys`, `js-sys`, `wasm-bindgen`, `getrandom 0.2 (js)` (yawc `Cargo.toml` wasm section) — the same closure `cloud_api_client` already brings into the browser build; `js-sys` is also needed directly by the vendored yawc patch (`Array`), in `vendor/yawc/Cargo.toml`, not by `crates/remote`.

Runtime requirement (native): `gpui_tokio::init(cx)` (or `init_from_handle`) must run before the first `remote::connect` on WebSocket options; `WebSocketRemoteConnection::new` returns a clear `Err` otherwise (§3.17).

wasm compile check: CI's `check_wasm` (`run_tests.yml:670`) does not build `crates/remote`, and the rest of the crate needs W3's smol/which shims. Until `-p remote` can be added there, the new modules are compiled for `wasm32-unknown-unknown` through a throwaway crate `tools/ws-transport-wasm-check` that `#[path]`-includes `wire.rs`, `websocket.rs` and `dial_web.rs` behind stub `RemoteConnection`/`RemoteClientDelegate` traits; the `Send`/`!Send` analysis in §3.3 is verified there, not asserted.

`crates/remote_server/Cargo.toml` (`[dev-dependencies]`, after `:105`):

```toml
jsonwebtoken.workspace = true           # mint ES256 test tokens for `serve`
```
(`remote` with `test-support`, `workspace`, `tempfile`, `gpui` test-support, `project` test-support are already dev-deps at `:98`, `:104`, `:100`, `:90`, `:97`.) The integration test in §6.3 needs the `serve` binary, which b2 gates behind the `serve` cargo feature (b2 §3.4/§5), so the test target carries `required-features = ["serve"]` and runs as `cargo test -p remote_server --features serve --test websocket_serve`.

No changes to `crates/proto`.

## 6. Tests

### 6.1 Unit tests (`#[cfg(test)]` in the new/changed files; run natively with `cargo test -p remote`)

`crates/remote/src/protocol.rs`
- `encode_envelope_frame` round-trips through `read_message` over `&bytes[..]` and `decode_envelope_frame` (byte-compatible with the stdio framing).
- `decode_envelope_frame` rejects: buffer < 4 bytes; length prefix ≠ remaining bytes; prefix > `max_len`.

`crates/remote/src/transport/websocket/wire.rs`
- `subprotocol_header_value("t") == Ok("zs.v1, t")`; `subprotocols("t") == Ok(["zs.v1", "t"])`; both reject `"a=b"`, `"a+b"`, `"a b"`, `""` with `InvalidToken`; `split_subprotocol_header` accepts `"zs.v1, t"`, `"zs.v1,t"`, rejects missing token and unknown protocol.
- `ControlFrame` JSON: `{"type":"hello",…}` / `{"type":"hello_ack",…}` / `{"type":"log",…}` / `{"type":"heartbeat"}` serialize and deserialize; unknown `type` is an error; `Hello.epoch: null` round-trips; `Hello` without `workspace_id` fails to deserialize (it is required, D1).
- `builds_compatible`: equal → true; differing release builds → false; either side `dev` → true.
- Constants pinned: `CLOSE_GOING_AWAY == 1001`, `CLOSE_TAKEN_OVER == 4001`, `CLOSE_SESSION_ACTIVE == 4005`, `CLOSE_BAD_HELLO == 4006`, `HEARTBEAT_INTERVAL_SECS == 5`, `MAX_FRAME_BYTES == 16 * 1024 * 1024`; there is no 4004 constant (D3).

`crates/remote/src/transport/websocket.rs`
- `WebSocketConnectionOptions`: `Hash`/`Eq` depend only on `workspace_id` (two options with different `url`/`session_id`/`token` compare equal); `serde_json::to_string` omits `session_id`, `token`, `takeover` and `refresh`; `Debug` output does not contain the token; `clone()` shares `state` (Arc ptr_eq) and therefore the `instance` nonce; two `new()` calls produce different `instance` nonces; `can_dial` false for a restored row, true after `set_session_refresh_provider`.
- `WebSocketRemoteConnection::new` (with `set_backoff_for_tests(ZERO)`, no server) rejects `http://` URLs, an empty `workspace_id`, and an empty token without `refresh` before dialing; with `refresh` returning `Err(Unauthorized)` on a redial it sets `last_close() == Some(CloseInfo{4003,..})`, `max_reconnect_attempts() == 0` and a subsequent `new()` fails fast (`terminal`); the same with `Err(Stopped)` → `last_close() == Some(CloseInfo{1001, "workspace stopped"})` (D2).
- `refresh` is invoked with the `workspace_id`, not the `session_id`; a successful refresh replaces `connection_options().session_id` and `.url` with the returned values.
- `remote_platform()` before any handshake is `Linux/X86_64`, `path_style()` is `Unix`, `shell()` is `/bin/sh`; after injecting a `HelloAck` via a test-only setter they reflect it (compare fields — `RemotePlatform` has no `PartialEq`).
- `build_command`, `build_forward_ports_command` return `Err`; `upload_directory` returns a ready `Err` task; `has_wsl_interop()` is false; `supports_remote_pty()` is true; `supports_extension_upload()` is false; `max_reconnect_attempts() == 20` until `state.terminal` is set, then `0`.
- Close-code mapping table (§3.3 step 5) via a pure `fn exit_code_for_close(&CloseInfo) -> Result<i32>` (1001 → `Ok(90)`, 4001/4005 → `Ok(91)`, 4002/4006 → `Ok(92)`, 4003/1000/1008/1009/unknown 4xxx → `Err`), plus `exit_code_for_hello_ack(reconnect, &HelloAck)` for the `resumed == false` row.
- `Hello` composition: `Hello.identifier == format!("{unique_identifier}/{instance}")`, `Hello.workspace_id == options.workspace_id`, `Hello.session_id == state.current.session_id` (after a refresh, the refreshed one).
- Outbound oversize: a `run_pump` driven with in-memory channels receives a 17 MiB request envelope → nothing reaches `frames_tx`, an `Error` response with `responding_to == id` appears on `incoming_tx`, the pump keeps running.

`crates/remote/src/remote_identity.rs`
- WebSocket identity ignores `url`, `session_id`, `token`, `takeover`, `refresh`; differs by `workspace_id`; `persistence_key() == "ws:<workspace_id>"`.

`crates/remote/build.rs` — a `cargo build -p remote` after changing `ZS_BUILD_ID` in the environment recompiles the crate and `client_build_id()` reflects the new value (manual check; no automated test).

`crates/remote/src/proxy.rs` — `from_exit_code(91)`, `from_exit_code(92)` round-trip; `to_string()` of each variant is non-empty.

`crates/gpui_tokio` — `try_handle` is `None` before `init`, `Some` after.

### 6.2 Loopback tests without `serve` (`crates/remote/src/transport/websocket/tests.rs`, native only, `#[gpui::test]`)

Harness: `cx.executor().allow_parking()` (`gpui/src/executor.rs:236`) so awaiting real sockets works; `cx.update(|cx| { release_channel::init(semver::Version::new(0,0,0), cx); gpui_tokio::init(cx); })`; `options.set_backoff_for_tests(Duration::ZERO)`; a fake server on `smol::net::TcpListener::bind("127.0.0.1:0")` + `async_tungstenite::accept_hdr_async` that records the upgrade request headers/URL, echoes `zs.v1`, and scripts frames. The precedent for real I/O plus tokio under the deterministic dispatcher is `agent_servers/src/e2e_tests.rs` (`#[gpui::test]` + `gpui_tokio::init` + real network behind the `e2e` feature); if tokio `JoinHandle` wakers turn out not to wake the test dispatcher reliably, move these cases to §6.3's headless harness. **Timers are fake-clock in `TestAppContext`**: the 30 s dial timer, the 15 s handshake timer and `RemoteClient`'s 5 s `resync`/heartbeat timers only fire after `cx.executor().advance_clock(..)`; assertions are driven by socket events except where a test says `advance_clock` explicitly.

1. **Handshake + token placement (native)**: fake server sees `Sec-WebSocket-Protocol: zs.v1, <token>` and a bare `/rpc` path (no query string); client sends `Hello{reconnect:false, takeover:false, epoch:None, build, workspace_id:"ws_1", session_id:"sess_1", identifier: "setup-1/<nonce>"}` first; after `HelloAck{epoch:1, resumed:false}` the server sends a `RemoteStarted` envelope and `RemoteClient::new(ConnectionIdentifier::setup(), conn, rx, delegate, cx)` resolves `Some(_)`; `connection_state() == Connected`; delegate saw `Some("Connecting to workspace")`, `Some("Attaching to workspace")`, then `None`; `conn.server_info().unwrap().epoch == 1`.
2. **Envelope pump + heartbeat**: server answers `Ping` with `Ack` (`responding_to` set) — `client.proto_client().request(proto::Ping{})` resolves; server sends an unsolicited `Test` envelope — it reaches a registered handler; every inbound binary frame produced a `()` on `connection_activity_rx` (observe via a `MockDelegate`-style probe or by counting on a test hook); after `advance_clock(15 s)` the fake server has received three `{"type":"heartbeat"}` text frames (D3: client → server every 5 s); an inbound `{"type":"heartbeat"}` text frame is ignored apart from activity.
3. **Reconnect with refresh**: fake server drops the TCP connection; `RemoteClient` enters `Reconnecting`; the `WebSocketSessionRefresh` stub is called with `("ws_1", RefreshReason::Reconnect{attempt:1,last_close:None})` and returns a **different port** and `session_id:"sess_2"` (second fake server); the second server sees `Hello{reconnect:true, epoch:Some(1), session_id:"sess_2", identifier: <same "setup-1/<nonce>" as attempt 1>}`, replies `HelloAck{resumed:true, epoch:1}`, receives `FlushBufferedMessages` and answers **`Ack`** (`proto.rs:570`); state returns to `Connected` without advancing the clock (the whole exchange must fit the 5 s resync window with real time); `connection_options()` now carries the new URL and `session_id == "sess_2"` while `workspace_id` is unchanged; `RemoteClientEvent::Reconnected` was emitted; `conn.has_been_killed()` is true on the first connection and the pool handed out a different `Arc`.
4. **Superseded / session active**: server sends `Close(4001, "taken over")`; io task returns `Ok(91)`; `RemoteClient` ends in `Disconnected` (`ServerNotRunning`) **without** calling `refresh`; `options.last_close() == Some(CloseInfo{4001,..})` readable from the `RemoteClient::connection_options()` snapshot. Same with `Close(4005)`. Afterwards a from-scratch `remote::connect` with **new** options for the same `workspace_id` (D2 host `reconnect()`) dials a third fake server with `Hello{reconnect:false, identifier: <different nonce>}` — the pool did not reuse the dead connection.
5. **Build mismatch**: `HelloAck{build:"other"}` with a release-style client build → `Ok(92)`, no reconnect, `last_close().code == 4002`.
6. **Server restarted / stale epoch (fresh session per D3)**: on reconnect the second server replies `HelloAck{resumed:false, epoch:2}` → io task returns `Ok(90)`; `RemoteClient` ends `Disconnected { server_not_running: true }`, `refresh` was called once, `last_close()` is `None`.
7. **kill()**: `force_disconnect` (`remote_client.rs:1056`) makes the fake server observe a `Close`/EOF; `has_been_killed()` becomes true; because `monitor` treats the pump's `Err` as a drop, the client **reconnects** (the refresh stub is called, a second fake server accepts) and ends `Connected` on a new `WebSocketRemoteConnection` (different `Arc` pointer). Dropping the `RemoteClient` entity (as `shutdown_processes` does) closes the socket without a reconnect attempt.
8. **Oversize inbound frame**: server sends a 17 MiB binary frame → yawc closes the stream (the server receives `Close(1009)`), the io task errors → reconnect path (refresh stub called with `attempt:1`, `last_close: None` — native yawc reports no reason for its own close); with a refresh stub that always errors, after `max_reconnect_attempts()` refusals the state is `ReconnectExhausted` (`advance_clock(5 s)` per attempt is not needed: `new()` fails before `start_proxy`).
9. **Connect timeout / bad Hello**: server accepts the upgrade but never sends `HelloAck` → after `advance_clock(15 s)` the task errors; server sends a binary frame first → `Err("unexpected first frame")`; a TCP listener that never completes the upgrade → after `advance_clock(30 s)` `remote::connect` returns `Err`.
10. **Refresh unauthorized**: refresh stub returns `Err(Unauthorized)` on attempt 1 → `ReconnectExhausted` after one attempt (`terminal`; the second `reconnect()` iteration sees `max_reconnect_attempts() == 0` and never dials), `last_close() == Some(CloseInfo{4003,..})`, the stub was called exactly once.
11. **Refresh stopped (D2)**: refresh stub returns `Err(Stopped)` on attempt 1 → `ReconnectExhausted` immediately, `last_close() == Some(CloseInfo{1001, "workspace stopped"})`, the stub was called exactly once, no second fake server was ever dialed.
12. **Server going away (D3)**: server sends `Close(1001, "server shutting down")` → io task returns `Ok(90)`, `RemoteClient` ends `Disconnected { server_not_running: true }`, `refresh` was **not** called, `last_close().code == 1001`.
13. **Two tabs, one workspace**: two independent `WebSocketConnectionOptions::new(..)` for `workspace_id:"ws_1"` present different `Hello.identifier` suffixes to the fake server (so b2's same-instance rule cannot conflate them), while the reconnect in test 3 presented the same suffix twice.

wasm: the subprotocol list builder is unit-tested natively (6.1); the vendored yawc patch is checked by `cargo check --target wasm32-unknown-unknown` (§5); an end-to-end `wasm-bindgen-test` against a local `serve` is deferred to W8 (BUILD-SPEC line 480).

### 6.3 Native integration test against `zed-remote-server serve` (brief b2) — `crates/remote_server/tests/websocket_serve.rs`

Preconditions supplied by b2 (+ b4 §3.15 / D5 / D20 flags): `zed-remote-server serve --listen 127.0.0.1:0 --port-file <tmp>/port --jwt-public-key <pem> --workspace-id <ws> --audience <aud> --workspace-root <tmp> --control-secret-file <tmp>/secret --control-listen 127.0.0.1:0 [--client-build <id>]` writes `<ip>:<port>\n` to `--port-file` once bound (there is no stdout line; `--control-listen 127.0.0.1:0` so parallel test cases and b2's own `tests/serve.rs` never collide on the default `127.0.0.1:8446`, b2 §3.9/§6.4); exits on SIGTERM after closing the session with 1001 (D3; b2's `Shutdown` path amended from 4004); implements the §4.4 semantics (D3/D20: epoch-keyed reconnect, fresh-session reset, `detach_all` on detach). Test fixtures: `crates/remote_server/tests/fixtures/es256_private.pem`, `es256_public.pem` (checked in, test-only keys; b2 §6 uses the same `tests/fixtures/es256_public.pem`); tokens minted with `jsonwebtoken::EncodingKey::from_ec_pem` and the claim set `{ iss: "zs", sub, ws: <workspace_id>, sid: <session_id>, aud, iat, exp, jti }` (b2 §4; BUILD-SPEC §4.3) — `ws` is the stable workspace id and `sid` the per-connect session id the test also puts in `WebSocketConnectionOptions::new(url, ws, sid, token)` (D1).

Harness: plain `#[test]` running `gpui_platform::headless()` (`crates/gpui_platform/src/gpui_platform.rs:23`, as `server.rs:570` does) so real timers drive the heartbeat; `release_channel::init` + `gpui_tokio::init(cx)`; server spawned from `env!("CARGO_BIN_EXE_remote_server")` with `kill_on_drop`; client built like `remote_editing_tests.rs:4746-4770` (`Client::new` with `FakeHttpClient::with_404_response()`, `NodeRuntime::unavailable()`, `Project::remote`).

1. **Fresh session**: temp dir with `src/lib.rs`; connect (`remote::connect` + `RemoteClient::new` + `Project::remote`); `find_or_create_worktree(tmp)`; `open_buffer("src/lib.rs")` text matches; on the **connection**, `server_info().platform.os == Linux` (or the host OS in CI), `shell()` non-empty, `server_info().os_version` present on Linux, `resumed == false`; `RemoteClient::remote_platform()` is the documented default (Linux/X86_64).
2. **Auth**: expired token → `remote::connect` fails before `Hello` (HTTP 401 before the upgrade), `RemoteClient::new` is never reached. Wrong `aud` → same.
3. **Subprotocol echo**: the 101 response carries `Sec-WebSocket-Protocol: zs.v1` exactly (checked by dialing with `async_tungstenite` directly and inspecting the response headers).
4. **Reconnect keeps the project (D3 reconnect)**: with a buffer open and a pending unacked edit, close the client socket via `force_disconnect`; the client reconnects with `Hello{reconnect:true, epoch:Some(e), identifier: <same>}` (the refresh callback returns the same URL, a new token and a new `sid`), `HelloAck.resumed == true`, `HelloAck.epoch == e`, no new `RemoteStarted`, the buffer remains usable and the edit is replayed (`FlushBufferedMessages`/`Ack`).
5. **Server restart**: SIGTERM the server (the client observes `Close(1001)` → `Ok(90)` → `Disconnected { server_not_running: true }`, `last_close().code == 1001`, `refresh` **not** called); restart it on the **same** port; a from-scratch `remote::connect` + `RemoteClient::new` with new options (`reconnect:false`) opens the buffer again. Variant: kill the server with SIGKILL instead (no Close frame) — the client enters `Reconnecting`, the refresh callback returns the same URL with a new token, reconnect attempt 1 fails in `connect` (connection refused) and attempt 2 dials the restarted server after the backoff; `HelloAck.resumed == false` (nothing to resume) → the io task returns `Ok(90)`; `RemoteClient` ends `Disconnected { server_not_running: true }` and `last_close()` is `None`.
6. **Fresh session on reload (D3)**: dirty an open buffer, drop the `RemoteClient`/`Project` (tab reload), open a new `RemoteClient` (`reconnect:false`, `takeover:false`) on new options with the same `workspace_id` (new `session_id`/token from a new `/connect`, new instance nonce); `HelloAck.resumed == false`, `HelloAck.epoch` is greater than before, `RemoteStarted` arrives first, the worktree is re-added by the client and the reopened buffer holds the **on-disk** text (the server reset its `HeadlessProject`; dirty text is the client-state image's job, D6/D7). b3's terminal-survival assertion (`ListTerminals` after the reload still lists the PTY, D3/D4) lives in b3's suite.
7. **Takeover**: second client (different options → different instance nonce) with `takeover: true`; first client observes `Disconnected` with `last_close().code == 4001` and does **not** call `refresh`; second client gets `resumed == false` and a higher `epoch`, and can open the buffer; a third client with `takeover: false` completes the upgrade and is closed with **4005** at `Hello` (`last_close().code == 4005`, `refresh` not called).
8. **Stale epoch**: after the takeover in 7, while the second client is still attached, the first client's options are reused for a `Hello{reconnect:true, epoch:Some(old), takeover:false}` (drive `start_proxy` directly on a fresh connection) → Close **4005** (arbitration precedes the epoch check); with the second client detached, the same Hello gets `HelloAck{resumed:false}` (stale epoch = fresh session per D3) → `Ok(90)`.
9. **Heartbeat**: the server's `/health` (loopback, full body) or its `session_attached` log shows the client's `Heartbeat` frames arriving every ~5 s; pause the server process with SIGSTOP for 30 s; the client reaches `HeartbeatMissed` then `Reconnecting`; SIGCONT; reconnect succeeds (same instance: the server's dead socket is superseded with 4001, not refused; `resumed == true`).
10. **Version coupling**: run the server with `--client-build other` (b2 §3.7: the check is against `Hello.build`) with a release-style client id → `4002`, client ends `Disconnected`, `last_close().code == 4002`.
11. **Slow reconnect**: refresh callback sleeps 8 s before returning (simulating a sandbox resume); the reconnect still succeeds because the wait happens in `connect`, outside the 5 s `resync` window.

### 6.4 Workspace-level tests (`crates/workspace` or `crates/recent_projects` tests)

- `open_remote_project_in_new_window_with_client` with a `RemoteClient` built on `RemoteClient::fake_server` (mock transport) opens exactly one window whose workspace `project().is_remote()` and whose `Project` is the one wrapping that client (`project.remote_client()` entity id matches), and `find_existing_workspace` (`workspace.rs:10492`) finds it via `SerializedWorkspaceLocation::Remote(opts)` (mirrors `remote_connections.rs:594-718`); `deserialize_remote_project` ran once (one `next_id()`); the connection-taking `open_remote_project_in_new_window` produces the same result and returns `Ok(None)` when `cancel_rx` fires before `RemoteClient::new` resolves.
- `persistence`: `get_or_create_remote_connection(WebSocket{workspace_id:"w1", session_id:"s1", url:"wss://a/rpc", token:"t"})` and then `WebSocket{workspace_id:"w1", session_id:"s2", url:"wss://b/rpc", token:"u"}` return the same id (works only because `host` is `None` and `session_id` is not stored, §3.11, D1); `remote_connection(id)` yields `workspace_id == "w1"`, empty `session_id`, empty `url`, empty token, `refresh: None`, `takeover: false`; `can_dial(cx)` is false until a provider is registered.
- `RemoteConnectionOptions::WebSocket` round-trips through `serde_json` in `SerializedProjectGroup` without `session_id` or the token, and `takeover: true` deserializes as `false`.
- `restorable_workspaces` tolerates a `remote_connections` row with `kind = "websocket"` when `RemoteConnectionKind::deserialize` returns `None` (simulate by inserting `kind = "unknown"`): the row is skipped, no error.

## 7. Risks and open questions

1. **Vendored yawc (D10).** §3.18 makes the browser offer subprotocols and close on drop through `zed/vendor/yawc`, a path `[patch]` over the git dependency, with `zed/vendor/README.md` recording the upstream revision and the intended git-patch form; until the upstream PR lands the workspace carries that copy, listed in `[workspace] exclude` per b5 item 4 (a non-member path patch: no `cargo -p yawc`, not linted as ours). There is deliberately no query-string fallback for the token.
2. **Native read errors are opaque.** yawc's native `Stream` swallows the error and ends the stream (`src/native/mod.rs:1240`), so a TLS reset, a clean EOF and an oversize inbound frame look the same to the pump; all map to `Err` → reconnect, which is the intended behaviour, but diagnostics rely on the server's `Close` frame having arrived first. If richer errors are needed, drive `WebSocket::poll_next_frame` (`:1178`) directly on native instead of the `Stream` impl.
3. **`session_id` stability (resolved by D1).** Identity for the pool and the workspace DB is the explicit `workspace_id` field (the control plane's stable workspace id); `session_id` is minted per `/connect`, rotates on every refresh, and is informational only (`Hello.session_id`, JWT `sid`, telemetry, the server's session bookkeeping). Persisted rows (`name = workspace_id`, `host = None`, `user = None`) are found again after resume, takeover and rebuild (D9 carries `$HOME/.local/share/zed`, where the client-state image lives, in the rebuild tarball) — this is the acknowledgement b9 §7.3 asked of b1. b9's earlier "`sessionId === workspaceId`" (b9 §3.18) is superseded: `/connect` must return both, and b7's `ConnectInfo` must carry `workspaceId` (or b7 takes it from `BootConfig.workspace.id`) — flagged in §9.
4. **Fresh session resets the project (D3).** §4.4 no longer asks b2 for a warm `HeadlessProject` across `reconnect:false` attaches: a fresh session (reload, takeover, "open in desktop", stale epoch, server restart) resets worktrees, language servers, git and the settings observer, and only a true reconnect (same instance, matching epoch, state still held) attaches warm with replay. The client side needs nothing extra for either path. Dirty server-side buffers do not survive a fresh session; D6/D7 (b7 with b4) cover `STOPPING` through the client-state image's `unsaved_buffers` table, and b7's `beforeunload` guard covers navigation. PTYs survive (server-level `PtyManager`, `detach_all` on detach; b3 restores them, D4).
5. **Reconnect budget (decided, D2).** Refresh, backoff and dial run in `connect` (no timeout; `/connect` blocks until the sandbox is healthy — b9's host polls `202`/`423` for up to 5 min), so a reconnect attempt is not bounded by the 5 s `resync` window; only `Hello`/`HelloAck` + `FlushBufferedMessages`/`Ack` are. `max_reconnect_attempts()` = 20 for WebSocket with exponential backoff capped at 8 s, then terminal `ReconnectExhausted` with `last_close()` diagnostics; `RefreshError::Stopped` (control plane: workspace stopped) and `RefreshError::Unauthorized` end the loop at once. Everything beyond that is the shell's host `reconnect()` (b7), which starts a new connection from scratch (new options, `Hello{reconnect:false}`), not a re-dial of the exhausted client. A post-attach failure during a reconnect (e.g. the server closes right after `HelloAck`) is only detected by the 5 s resync timeout because `monitor`'s `reconnect()` is a no-op in `State::Reconnecting`.
6. **Terminal-state diagnostics.** `DisconnectedOverlay` only gets `server_not_running: bool`, so it says "process exiting unexpectedly" for 4001/4002/4003/4005 and its "Reconnect" button would take a session back after 4001. The shell reads `last_close()` through the options snapshot (§4.6 step 4) and branches itself; a more upstream-shaped fix (a `reason` on `RemoteClientEvent::Disconnected`) is a follow-up.
7. **Backpressure.** Native yawc applies real backpressure through its `Sink` (`with_backpressure_boundary(1 MiB)`, so a stalled peer stalls the pump instead of growing memory); the wasm `WebSocket` does not expose `bufferedAmount`, so the "bounded send buffer → reconnecting" behaviour (BUILD-SPEC §4.4) is approximated there: a stalled socket makes the proto `Ping` time out and the heartbeat state machine reconnects. `ChannelClient`'s `outgoing_tx` is unbounded upstream (`remote_client.rs:1684`), so a true client-side bound needs an upstream change.
8. **Hidden tabs (D3: the `Heartbeat` is client → server).** Chrome throttles timers in hidden tabs (≥ 1 s at once, once per minute after ~5 min hidden), so both the client's proto `Ping` cadence and its 5 s `Heartbeat` frame degrade there. On the client this is benign: a missed heartbeat needs the 5 s timeout timer to fire before the `Ack` arrives, and that timer is throttled at least as much as the ping — late, never early — while the `Ack` itself arrives on the socket's message event, which is not throttled; so no spurious `HeartbeatMissed` in a hidden tab. On the server it means client `Heartbeat` gaps of ≥ 60 s are normal for a hidden tab: b2 must not detach or close a session for missing client heartbeats below ~90 s (contract item in 7.12; b7's Playwright "hide the tab for 10 minutes, no `reconnecting`" case — b7 §6 — is the guard and must be re-based on this direction; it currently assumes server-sent heartbeats). Browsers never expose WS ping/pong to JS, so a server WS-level keepalive would not help; a server → client `Heartbeat` is tolerated by the pump but no longer part of the contract.
9. **Unsaved buffers on terminal outcomes (D6/D7).** After 4001/4002/1001/`ReconnectExhausted`, `Project` marks buffers read-only and the shell's host `reconnect()` replaces the workspace, dropping in-memory dirty text — as SSH does today, but far more frequent in a browser, and since D3 the server does not keep a copy across a fresh session either. D6 makes the client write every dirty buffer's path, text and version into the client-state image (`unsaved_buffers`) on `LifecycleNotice STOPPING` and flush `SaveClientState` inside the stopping window, reopening them dirty on the next open; D7's flush triggers (15 s dirty timer, `visibilitychange` to hidden, `STOPPING`) and b7's `beforeunload` guard cover reloads; the client never writes to the workspace filesystem without the user saving. This transport's contribution is only that 1001 arrives *after* the flush window (b8's stopping budget exceeds the 5 s flush, D18) and that a 4001/4005 skips the flush (b7 §7.20). BUILD-SPEC line 483 "stop with unsaved buffers" is the chaos test for this.
10. **wasm compile of the rest of `crates/remote`** (ssh/wsl/docker modules, `util::command::Child = smol::process::Child` at `crates/util/src/command.rs:21`, `tempfile`, `which`, `askpass::EncryptedPassword` in the delegate signature) is W3's responsibility; the fork's evidence is weaker than first read (base-revision drift, §2). This brief's code must not add new wasm blockers (no `std::process`, no `std::time::Instant`, `background_spawn` only for `Send` futures) and is compiled for wasm through the throwaway crate in §5 until `-p remote` can join `check_wasm`.
11. **Native TLS.** `wss://…vercel.run` relies on yawc's `rustls-ring` + `webpki-roots` (default feature). Corporate proxies / custom CAs are not honoured (Zed's `http_client` proxy settings are not consulted). Acceptable for v1; note for W6.
12. **Server `serve` contract items (adopted by b2 under D20, as amended by D3/D5).** (a) bound address in `--port-file` (no `ZS_LISTENING=` line); (b) 401/403/426 (and 403 for a disallowed `Origin`, D5) as the only pre-upgrade rejections — no 409; (c) the §4.4 semantics: arbitration first (supersede with 4001 on `takeover:true` or a same-`identifier` redial, 4005 session active otherwise), then reconnect = `reconnect:true` + matching `epoch` + state held → warm attach with replay (`resumed:true`, epoch unchanged), everything else = fresh session with `HeadlessProject` reset, new channel pair, `RemoteStarted` first, `resumed:false`, epoch incremented (D3); `PtyManager::detach_all` on detach, never `kill_all` on a fresh session (D20); (d) close codes `1001` going away (SIGTERM / `STOPPING`, replacing 4004), `4001`, `4002`, `4003` (`Hello.session_id ≠ sid`), `4005`, `4006`, `1008`, `1009` — all defined in `wire.rs` (§3.2) and imported by b2; (e) `Hello` carries `workspace_id`, `session_id`, `identifier` (unique per client instance), `epoch`; `HelloAck` carries `resumed`, `epoch`, `session_id`, `os`, `arch`, `os_version`, `shell`, `build`; (f) `Heartbeat` is a client → server text frame every 5 s (`HEARTBEAT_INTERVAL_SECS`); the server tolerates gaps of at least 90 s before treating the socket as dead (hidden tabs, §7.8) and never counts it as input; (g) no `permessage-deflate`; (h) `Log` text frames are reserved (not emitted in v1); (i) 16 MiB inbound ceiling on the server too (`max_payload_read`), writer refuses larger frames with 1009; (j) echoing `zs.v1` only when offered in the header; (k) `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` (and b4's `SaveClientState`, `LoadClientState`, `ListExtensions`) excluded from `is_input_envelope` (D20) — no client-side effect, listed for completeness.
16. **`Hello.identifier` must be unique per client instance.** `ConnectionIdentifier::setup()` is a process-local counter (`remote_client.rs:353-359`), so every fresh browser tab would present `setup-1`; b2's same-instance rule (same `identifier` → replace the old socket without `takeover`) would then let a second tab silently supersede the first. The transport appends a per-`WebSocketSessionState` nonce (§4.1) — same across the reconnects of one session, different across tabs and across the shell's from-scratch `reconnect()`. If b2 would rather key on a dedicated field, `Hello.instance` is the one-line alternative; the composed string was chosen so b2's rule and `SessionMeta.identifier` need no change.
17. **4004 is retired; 1001 is the server's stopping close (D3).** b2 §4 (`CLOSE_SERVER_STOPPING` in its `Shutdown` path), b7 §3.28 (`close_code_detail` "server_stopping" 4004) and b9 §4.6 (`onClosed` mapping `4004/1001 → stopped`) still name 4004; they must switch to `CLOSE_GOING_AWAY = 1001` from `wire.rs`. The client maps 1001 to `Ok(90)` and never refreshes on it (b9 §3.26: a reconnect must not resume a stopped workspace), so a server that still sent 4004 during the transition would merely take the `Err` → refresh → `RefreshError::Stopped` path to the same terminal state one round trip later.
13. **Frame size vs. Vercel edge.** The 16 MiB frame ceiling is enforced on both ends; whether the `vercel.run` edge imposes a smaller WebSocket message limit is unmeasured (BUILD-SPEC §15 risk 3 asks for a month-one measurement).
14. **wasm auth errors are indistinguishable from network errors.** Browsers hide the HTTP status of a failed upgrade, so 401 and a transient failure both surface as a failed `connect`; the transport therefore always refreshes before a redial on wasm, and `RefreshError::Unauthorized` from the control plane is the signal the shell uses to prompt for sign-in.
15. **Desktop restore of WebSocket rows** is skipped until a refresh provider is registered (§3.16); "recent projects" support for cloud workspaces is a later brief.

## 8. Review log

Each finding was checked against the checkout before acting on it. Line references are to this checkout unless noted.

### Reviewer 1 — wrong claims

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | `yawc::Frame`/`OpCode` not exported on wasm | Accepted (`src/wasm.rs` has no `pub use`; `native/mod.rs:157` does) | §2 yawc facts rewritten; portable imports are `yawc::frame::{Frame, OpCode}` / `yawc::close::CloseCode`. |
| 2 | `WebSocketError: !Send` on wasm, `?` into anyhow fails | Accepted (`lib.rs:166-168` `Js(JsValue)`) | §2 + §3.3: all yawc errors go through `ws_err` (`anyhow!("{e}")`); the pump no longer touches yawc types at all (bridge design). |
| 3 | `WebSocketServerInfo` cannot derive `PartialEq, Eq` | Accepted (`remote_client.rs:113` derives `Copy, Clone, Debug` only) | §4.1 derives `Clone, Debug` only; §6.1 compares fields. |
| 4 | `host` is part of the persistence SELECT | Accepted (`persistence.rs:1782-1800`) | §3.11 stores `host = None`; restored URL is empty; §6.4 test explains why it passes. |
| 5 | `FlushBufferedMessages` is answered with `Ack` | Accepted (`proto.rs:570`, `remote_client.rs:1766-1768`) | §6.2 test 3 and §6.3 test 4 fixed. |
| 6 | Reconnect attempt must fit the 5 s `resync` window; `initial_connection_timeout()` does not help | Accepted (`remote_client.rs:692-714`, `:161`, `:228-238`) | Redesign: refresh/backoff/dial moved into the pool's async `new` (§3.3), only `Hello`/`HelloAck` stays in `start_proxy`; `initial_connection_timeout()` dropped; `max_reconnect_attempts()` added; §7.5 rewritten; §6.3 test 11 added. |
| 7 | `same_host` is not exhaustive (`_ => false`) | Accepted | §2 and §3.12 wording fixed (still add the arm). |
| 8 | `connect` returns `Result<Arc<..>>` | Accepted (`:381-393`) | §2 fixed. |
| 9 | `ConnectionIdentifier::to_string` prefixes channels and panics without `release_channel::init` | Accepted (`:367-378`, `release_channel/src/lib.rs:190`) | §2 fixed; `release_channel::init` added to §4.6, §6.2 and §6.3 harnesses. |
| 10 | `ProxyLaunchError` variants need `#[error]` | Accepted (`proxy.rs:3`) | §3.4 rewritten with attributes. |
| 11 | `util::defer` cannot `.await` a `Sink::send`; wasm socket is not closed on drop | Accepted (`gpui_util/src/lib.rs:528`; `wasm.rs` no `Drop`, private `stream`) | Replaced by the socket-owning bridge task plus `ClosingSocket::drop` calling the synchronous `start_send(Frame::close)` (§3.3 step 4), and the yawc `Drop` patch (§3.18). |
| 12 | `wire.rs` is not serde-only; `remote::websocket::wire` path does not exist | Accepted (`remote.rs:6` private `mod transport`) | `client_build_id` moved to `websocket.rs`; `url_with_token_query` removed; server imports `remote::websocket_wire` (§3.2, §3.8, §2 remote_server row). |
| 13 | Duplicate `[dev-dependencies]` table | Accepted (`remote/Cargo.toml:49-52`) | §5 appends to the existing table. |
| 14 | Fork differs by more than `Instant` (`kill_on_drop`, `dev_repo_root`) | Accepted (diffed `ssh.rs`/`docker.rs`/`wsl.rs`/`transport.rs`; also `RemoteClientEvent::Reconnected` is absent in the fork) | §2 fork evidence softened; §7.10 notes the weaker evidence. |
| 15 | `native.rs:19-27` has no `.map(Ok)` | Accepted | §2 corrected; the `split()`/`map(Ok)` shape is gone from the design anyway. |
| 16 | `smol::future::or` is at 1911/1933 | Accepted | §2 and §3.5 fixed. |

### Reviewer 1 — missing items

| # | Item | Verdict | Action |
|---|---|---|---|
| 1 | Reconnect vs. pre-upgrade 409 race | Accepted (`reconnect` only known post-upgrade; `remote_client.rs:620-676` drops the pump before `kill()`) | §4.4: 401 is the only pre-upgrade rejection; session arbitration happens at `Hello`; a `reconnect:true` supersedes a half-open socket; 4005 for a busy non-takeover attach. |
| 2 | `release_channel::init` / settings init requirements | Accepted | §4.6 step 0, §6.2/§6.3 harness. |
| 3 | Desktop session restore prompts on every launch | Accepted (`main.rs:1434`, `open_listener.rs:924`) | New §3.16 (`can_dial` gate) + `set_session_refresh_provider` registry (§3.3); §7.15. |
| 4 | Fake-clock timers in §6.2; dispatcher wake-up unverified | Accepted | §6.2 harness states which timers need `advance_clock`, adds `set_backoff_for_tests(ZERO)`, cites the `agent_servers` e2e precedent and names the headless fallback. |
| 5 | `crates/zed_web` does not exist | Accepted | Noted in §2 fork evidence and §4.6. |
| 6 | `kill()` → pump exit → `monitor` reconnects | Accepted (`remote_client.rs:888-902`, `:1056-1067`) | §3.3 `kill()` paragraph documents it; §6.2 test 7 expects the reconnect; `shutdown_processes` path noted. |
| 7 | 17 MiB frame leaves no close reason | Accepted (`native/mod.rs:1240`, `streaming.rs:258`) | §6.2 test 8 asserts only the reconnect path and `last_close: None`. |
| 8 | Header value guard for non-token JWTs | Accepted | `validate_subprotocol_token` / `InvalidToken` in §3.2, tested in §6.1. |

### Reviewer 2 — wrong claims

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | Same as R1 #6, with the SSH-shaped fix | Accepted | See R1 #6. Chosen shape: dial in `connect` on both targets, socket owned by a bridge task exposing `Send` channels (works around the `!Send` wasm socket without a `GET /health` probe or a two-phase attach); `Hello` stays in `start_proxy` because `reconnect` is only known there. |
| 2 | Same as R1 #4, plus "do not rebuild `url` from `host`" | Accepted | §3.11 restores an empty `url`. |
| 3 | `defer` cannot close; `kill()` after the pump is dropped finds a dead `close_tx`; wasm reconnect fails deterministically | Accepted (`remote_client.rs:622-623` vs `:670-676`; `wasm.rs` no `Drop`) | Bridge owns the socket independently of the pump; `kill()` drops the bridge; `ClosingSocket::drop`; supersede rule in §4.4. |
| 4 | `last_close()` unreachable after `ServerNotRunning` | Accepted (`remote_client.rs:213-225`, overlay `:64-79`) | `WebSocketConnectionOptions::last_close()`/`server_info()` read the shared state; retrieval path documented in §4.1 and §4.6; §7.6. |
| 5 | Struct literal with `pub(crate) state` does not compile in `crates/workspace`; `new()` must not re-seed a shared state | Accepted | §3.11 uses `WebSocketConnectionOptions::new`; §4.1 states the no-re-seed rule. |
| 6 | Warm attach needs nothing client-side; cold path loses dirty buffers | Accepted (`Signal::set` idempotent at `:1671-1675`; `wait_for_remote_started` resolves on any `RemoteStarted`; `buffer_store.rs:1138-1156`) | §4.4 contract at the time: `reconnect:false` on a live project → warm attach with reset replay state and a fresh `RemoteStarted`, `resumed:true`; §6.3 test 6; §7.4 rewritten. **Superseded by D3** (§9): a fresh session resets the `HeadlessProject` and reports `resumed:false`; dirty buffers are D6/D7's. The client-side conclusion ("needs nothing extra") stands. |
| 7 | `reconnect:true` + `resumed:false` must be terminal (exit 90) | Accepted (`server.rs:881-890`) | §3.3 step 3 and mapping table; §6.2 test 6; §6.3 test 5 rewritten. |
| 8 | `RemoteClient` caches platform before `start_proxy`; §6.3 test 1 would fail on macOS CI | Accepted (`:434-437`, `:1030-1040`) | Documented in §3.3; tests assert on the connection's `server_info()`. Not moving `HelloAck` into `connect` because `reconnect` is only known in `start_proxy` (see R2 #1). |
| 9 | Desktop restore is not only "recent projects" | Accepted | See R1 missing #3. |
| 10 | yawc patch is a one-line `[patch]`; query token leaks into edge logs | Accepted (`Cargo.toml:976` patch table; BUILD-SPEC lines 218, 431) | New §3.18; query placement removed everywhere (§3.2, §4.3, §6.3 test 3 replaced); §7.1 rewritten. The patch source is now the vendored `zed/vendor/yawc` path (D10), not a fork URL. |
| 11 | Outbound frames are unbounded → poison-message reconnect loop | Accepted (`headless_project.rs:658/783` chunk only server→client; `remote_client.rs:1751-1771` replays) | §3.3 step 4 measures before send and injects a local `Error` response; §6.1 test added. |

### Reviewer 2 — missing items

| # | Item | Verdict | Action |
|---|---|---|---|
| 1 | One pump per pooled connection; picker flows create a second `RemoteClient` | Accepted (`remote_servers.rs:1611/1686/1800`, `remote_connection.rs:581/622`, `worktree_picker.rs:1585`) | `start_proxy` takes the bridge's receiver once and errors on a second attach (§3.3 step 1); §3.14 notes the pickers have no WebSocket entry point. |
| 2 | Takeover race → attach epoch | Accepted | `Hello.epoch` / `HelloAck.epoch` in §4.2, stored in `WebSocketSessionState`; §4.4 stale-epoch rule; §6.3 test 8. |
| 3 | Hidden-tab throttling; browsers hide ping/pong | Accepted (BUILD-SPEC line 184) | `ControlFrame::Heartbeat` from the server (§4.2, §3.3 step 4); §7.8. **Direction reversed by D3** (§9): the frame is client → server; §7.8 now explains why a hidden tab still cannot produce a spurious `HeartbeatMissed` on the client and what the server must tolerate. |
| 4 | No wasm compile verification | Accepted (`run_tests.yml:670`) | §5 adds the throwaway `wasm32` check crate; §7.10. |
| 5 | `gpui_tokio` global is a hard requirement | Accepted (`gpui_tokio.rs:83` `read_global`) | §3.17 `Tokio::try_handle`; §5 runtime requirement; `new()` errors instead of panicking. |
| 6 | `takeover` is persisted | Accepted | `#[serde(skip)]` in §4.1; §6.4 asserts it. |
| 7 | Delegate callback cannot capture DOM handles; needs `cx` | Accepted | `Fn(Option<&str>, &mut AsyncApp)` in §3.3 and §4.6. |
| 8 | Decoding large frames on the wasm main thread | Accepted in part | `decode_envelope_frame` offloaded via `background_spawn` for frames ≥ 64 KiB on wasm (§3.3 step 4); the copy into `Bytes` necessarily happens on the main thread because the browser delivers messages there. |
| 9 | Reconnect budget decision | Accepted | Decided in §3.3/§3.5/§7.5: slow work in `connect`, `max_reconnect_attempts()` defaulted trait method (WS = 20). Confirmed by D2 (20 attempts, 8 s cap, `ReconnectExhausted`, `Stopped`/`Unauthorized` terminal, host `reconnect()` from scratch). |
| 10 | wasm auth failures indistinguishable; tests for token expiry | Accepted | `RefreshError::Unauthorized` (terminal, synthesized 4003) in §4.1; §6.2 tests 3 and 10; §7.14. |
| 11 | Backoff and handshake timers are fake-clock | Accepted (duplicate of R1 missing #4) | See R1 missing #4. |
| 12 | Unsaved-buffer behaviour unspecified | Accepted | §7.9; warm attach keeps the server copy; shell export is the zed_web workstream's. **Superseded by D3/D6/D7** (§9): the server copy does not survive a fresh session; b7/b4 persist dirty buffers in the client-state image on `STOPPING`. |
| 13 | Backpressure boundary on native; `outgoing_tx` unbounded | Accepted (`options.rs:119`; the builder is `with_backpressure_boundary` at `:466`, not `with_max_backpressure_write_boundary` as the review named it) | §3.3 step 3 sets 1 MiB; §7.7. |
| 14 | Older builds ignore `websocket` rows | Accepted (`persistence.rs:1952-1968` `filter_map`, `:1997` `.context`) | §3.10 documents the tolerance; §6.4 test added. |

## 9. Reconciliation log

Amended 2026-09-02 against `docs/briefs/DECISIONS.md` and the deltas addressed to b1 in the sibling briefs' sections 7 and 8. Every code anchor added in this pass was read in `/Users/ray/Projects/play/wed/zed` (`c3cf80c`); nothing was compiled.

### Decisions

| Decision | Touches b1? | What changed |
|---|---|---|
| D1 Identity | Yes | `WebSocketConnectionOptions { url, workspace_id, session_id, token, takeover }` (+ runtime-only `refresh`, `state`); `new(url, workspace_id, session_id, token)`; `Hash`/`Eq`, `RemoteConnectionIdentity::WebSocket { workspace_id }`, `persistence_key = "ws:<workspace_id>"`, persistence `name = workspace_id`, `host = None`, `user = None`, `same_host`, `trusted_worktrees`, `display_name`, restore log line, `can_dial` gate all keyed on `workspace_id`. `session_id` is per-connect: `WebSocketSession { url, token, session_id }`, refreshed with the token, `#[serde(skip)]`, sent as `Hello.session_id` (== JWT `sid`), never persisted. `WebSocketSessionRefresh::refresh(&self, workspace_id, ..)`. `Hello` gains `workspace_id`. §1, §2, §3.2, §3.3, §3.5, §3.6, §3.11, §3.12, §3.14, §3.16, §4.1, §4.2, §4.6, §6.1-§6.4, §7.3. "Used for `ConnectionIdentifier`" is read as the persistence/pool identity; the `RemoteClient` `ConnectionIdentifier` stays the caller's (`setup()` for b7) and only feeds `Hello.identifier`. |
| D2 Reconnect budget | Yes | Already 20 attempts / 8 s cap; now stated as decided. Added `RefreshError::Stopped` (synthesizes `CloseInfo{1001, "workspace stopped"}`, sets `terminal`), and `max_reconnect_attempts()` returning `0` once `terminal` is set so the next `RemoteClient::reconnect` iteration goes straight to `ReconnectExhausted` (`remote_client.rs:639-646`, `:762-763` verified). Documented the host `reconnect()` as a from-scratch `remote::connect` with new options, and made the connection single-use (killed when its pump ends) so the pool never reuses a dead one. §3.3, §3.5, §4.1, §4.6, §6.1, §6.2 tests 4/10/11, §7.5. |
| D3 Session semantics | Yes | §4.4 rewritten: arbitration first (4001 supersede on takeover or same-instance redial; 4005 session active), reconnect = `reconnect:true` + matching epoch + state held → warm attach with replay, everything else (incl. stale epoch) = fresh session with `HeadlessProject` reset, `resumed:false`, epoch incremented; PTYs survive in `PtyManager`. Close codes: `CLOSE_GOING_AWAY = 1001` replaces `CLOSE_SERVER_STOPPING = 4004` (removed), `CLOSE_SESSION_BUSY` renamed `CLOSE_SESSION_ACTIVE`, `CLOSE_BAD_HELLO = 4006` added; 1001 → `Ok(90)` terminal without refresh. `Heartbeat` reversed to client → server every 5 s (`HEARTBEAT_INTERVAL_SECS`, a timer arm in `run_pump`, `BackgroundExecutor` parameter); inbound heartbeat tolerated only. 16 MiB both sides restated. `Hello.epoch` doc, `HelloAck.resumed`/`epoch` docs. §2, §3.2, §3.3, §3.4, §4.2, §4.4, §6.1, §6.2 tests 2/6/12, §6.3 tests 4-10, §7.4, §7.8, §7.12, §7.17; §8 rows marked superseded. |
| D4 Terminal restore | Indirect | §4.4 item 4 and §6.3 test 6 point at b3's restore; no transport change. |
| D5 Control listener | Yes (test preconditions) | `serve` spawn line in §6.3 and the `ServeArgs` row in §2 carry `--control-secret-file` (required), `--allowed-origin`, `--port-file`; 403 for disallowed `Origin` listed among pre-upgrade rejections (§4.3, §7.12). |
| D6 Unsaved buffers | Indirect | §2 `buffer_store` row, §4.4 item 3 and §7.9 rewritten: dirty buffers are persisted by b7/b4 in the client-state image on `STOPPING`; the transport guarantees 1001 arrives after the flush window and that 4001/4005 skip it. |
| D7 Client-state store | Indirect | §3.11 notes the workspace DB travels in the image; §4.6 step 3a shows the image being loaded over `proto_client()` before the window opens (why D16 exists). |
| D8 Private ports | No | — |
| D9 Rebuild tarball | Indirect | §3.11/§7.3: persistence key survives rebuild because the image directory is in the tarball (b9 §7.3 acknowledgement). |
| D10 Vendored dependencies | Yes | §3.18 rewritten: `zed/vendor/yawc` path `[patch]`, `zed/vendor/README.md` entry (upstream rev `71a452f551cac178367eaac5d7418a09afa1f3a2`, intended git-patch form), no `<org>` placeholder; §2 `Cargo.toml` row, §5, §7.1, §8 R2 #10 updated. |
| D11 Wasm home | No | — |
| D12 Web keymap | No | — |
| D13 Activity ping | No | — |
| D14 Prebuild / devcontainer | No | — |
| D15 AI proxy | No | — |
| D16 Entry point | Yes | §3.12 adds `open_remote_project_in_new_window_with_client(remote: Entity<RemoteClient>, app_state, paths, window_options, cx) -> Task<Result<OpenedRemoteProject>>` (body: `remote.read(cx).connection_options()` → `deserialize_remote_project` → `Project::remote` → shared inner), keeps the connection-taking form as a wrapper that builds the client with `ConnectionIdentifier::Workspace(id)`; both share one inner so `deserialize_remote_project` runs once. §4.6 and §6.4 rewritten around it; §2 gained the `proto_client()`/`connection_options()` anchors. |
| D17 Terminal ownership | Yes (one method) | `WebSocketRemoteConnection::supports_remote_pty() -> true` on b3's defaulted trait method (§2, §3.3, §6.1). Nothing else. |
| D18 Supervisor contract | Indirect | §7.9 cites the stopping budget exceeding the 5 s flush. |
| D19 Control plane contract | Indirect | §4.6 field mapping from b9's `/connect` (`wsUrl`, `token`, `sessionId`) plus `workspace.id`. |
| D20 serve contract | Yes | §7.12 restated as the adopted contract with D3/D5 amendments (close codes from `wire.rs`, epoch, `detach_all`, heartbeat direction and tolerance, `is_input_envelope` exclusions listed for completeness); §6.3 preconditions match b4's flags. |

### Sibling deltas addressed to b1

| Source | Delta | What changed |
|---|---|---|
| b2 §7.4(a) | map 4005 to a terminal `SessionActive` | Already `Ok(91)`; constant renamed `CLOSE_SESSION_ACTIVE` to match b2/D3 wording (§3.2, §3.3 step 5). |
| b2 §7.4(b) | `HelloAck{resumed:false}` after `reconnect:true` → discard `ChannelClient` state, exit 90 | Already so (§3.3 step 3); now framed as the D3 fresh-session case and paired with the host `reconnect()`. |
| b2 §7.4(c), R2 M12 | `crates/remote` needs `rerun-if-env-changed=ZS_BUILD_ID` | New §3.19 `crates/remote/build.rs`; §2 and §5 updated; §6.1 manual check. |
| b2 §7.4(d) | `ControlFrame::Log` is reserved (serve does not emit it) | Noted in §3.3 step 4 and §4.2. |
| b2 §4 / §3.7 | close codes 4006, 1008, 1009; `Hello.session_id ≠ sid` → 4003; same-`identifier` redial replaces; `--port-file`; `serve` feature; `--client-build` | §3.2 defines 4006 (client maps to `Ok(92)`); §3.3 step 5 rows; §4.4; §6.3 preconditions and test 10; §5 test feature. b2's "wasm uses the query form" noted as stale in §4.3 (b2 accepts the header item first, so no runtime conflict). |
| b3 §7.1 | `WebSocketRemoteConnection::supports_remote_pty()` (b1); `MAX_FRAME_BYTES ≥ 64 KiB + overhead` | Implemented as `true` (§3.3, §6.1); 16 MiB satisfies the bound. |
| b4 §7.3 | `RemoteConnection::supports_extension_upload()` gate belongs to b1 or a desktop follow-up | Taken here: new §3.20 (trait default `true`, WS `false`, gate at `extension_host.rs:2285`); §2 anchor row; §6.1. |
| b4 §7.6 | 16 MiB frame ceiling vs 12 MiB client-state images | No change needed; §4.2 restates the ceiling both ways. |
| b5 §7.10 / §7.19, §8 missing 12 | `std::time::Instant` swap in `remote`; wasm `smol` shim has no `smol::future`; `smol::net`/`process` stubs error immediately | §3.5: `web_time::Instant` swap kept; `smol::future::or` replacement now **required** (only two uses, verified); §5 credits b5. |
| b7 §7.1, §3.28, R2 #3 | `open_remote_project_in_new_window_with_client(remote, app_state, paths, window_options, cx)`; `ConnectionIdentifier::setup()` | D16 — §3.12, §4.6, §6.4. b7's `.and_then` on `connection_options()` must be a `match` (it returns a clone, not an `Option`; §2). |
| b7 §7.9 / R2 missing #5 | 20-attempt budget; host `reconnect()` follow-up | D2 — §7.5 names the host `reconnect()` as the from-scratch path and what the transport guarantees for it. |
| b7 §7.11 | `session_id` stability affects the workspace DB row key | D1 — §7.3; b7's `ConnectInfo` needs `workspaceId` (or `workspace.id`) for `WebSocketConnectionOptions::new` (flagged below). |
| b7 §7.20 | 4001 arrives before any flush; flush skipped after 4001/4005 | Consistent with §3.3 step 5 and §7.9; no change. |
| b7 §6 "Hidden tab", R2 missing #18 | relies on server-sent `Heartbeat` frames | Reversed by D3; §7.8 explains the client-side reasoning and the server tolerance b2 must provide; b7's Playwright case needs re-basing (flagged below). |
| b9 §7.3 | acknowledge that the client persistence key survives rebuild | Acknowledged: `workspace_id` (D1) + D9 tarball — §3.11, §7.3. |
| b9 §7.6, R2 #4 | `RefreshError::Stopped` synthesising a close | Added (D2), synthesising `CloseInfo{1001}` rather than the requested 4004 because D3 retires 4004 — §3.3, §4.1, §6.2 test 11, §7.17. |
| b9 §7.5 | token placement: subprotocol on both targets | Unchanged; restated in §4.3. |
| b9 §3.18 / §4.6 | `sessionId === workspaceId`; `onClosed` mapping includes 4004 | Superseded by D1/D3 — §7.3, §7.17 (flagged below). |
| b6 §7.5 | `web_time::Instant` swaps owed by owning briefs | `remote`'s is §3.5; none of b6's listed files are in this brief. |
| b8 §7.26 | `RESUMED` delivery depends on b2's fresh-vs-reconnect semantics | Resolved by D3's definition; no transport change. |

### Removed as contradicted

`CLOSE_SERVER_STOPPING = 4004` and the "4004 server stopping" mapping row; the server → client `Heartbeat`; the `reconnect:false` warm-attach contract (`resumed:true` on reload) in §4.4 and §6.3 test 6; `session_id` as identity (Hash/Eq, persistence key, `same_host`, `trusted_worktrees`, `display_name` fallback, `refresh(&session_id, ..)`); the fork-URL `[patch]` and "if no fork repo is available" wording; the `ZS_LISTENING=` stdout precondition and `serve --workspace <id>` spelling in §6.3; the `open_remote_project_in_new_window`-builds-the-client shape in §4.6; "optional" on the `smol::future::or` swap.

### Contract pass (2026-09-02)

Cross-brief mismatches found by the CONTRACTS.md audit and fixed here:

- §6.3: the integration-test `serve` spawn line now passes `--control-listen 127.0.0.1:0`; without it every test process and b2's own `tests/serve.rs` (b2 §6.4 step 1) would bind the default `127.0.0.1:8446` (b2 §3.9). b2 §7.21 was updated to match.
- §3.18 / §7.1: `vendor/yawc` is appended to `[workspace] exclude` per b5 item 4/§9 (the vendored-crate convention b6 §3.1 also follows); the earlier "members or unlisted" wording is gone.
