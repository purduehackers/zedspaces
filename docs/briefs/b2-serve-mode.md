# b2-serve-mode: `zed-remote-server serve` subcommand

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` §4.2 (server; amended by D3), §4.3 (tokens), §4.4 (wire), §3.6 (`/files`), §6.2 (supervisor), §10 (security), §12 (logs), §13 (tests), and the binding cross-brief decisions in `docs/briefs/DECISIONS.md` (D1-D20; the ones this brief implements are D1, D3, D4, D5, D6, D9, D10, D13, D14, D18, D19, D20 – see §9). Fork: `/Users/ray/Projects/play/wed/zed` (branch `zs`, upstream `c3cf80c`). All paths below are relative to that fork unless absolute. Sibling briefs this one is the server half of: `docs/briefs/b1-ws-transport.md` (client transport: framing helpers, `ControlFrame`, `Hello.epoch`/`HelloAck.epoch`, close codes, token placement, the §4.4 arbitration this brief implements), `b3-terminals.md` (`PtyManager`, whose `detach_all`/`kill_all` this brief calls; D3/D17), `b4-proto-additions.md` (`ControlChannel` mounted on this brief's loopback control listener, `enable_sandbox`, `on_session_attached`, `notify_files_uploaded`, `HeadlessExtensionStore::asset_path`), `b8-supervisor-image.md` (spawns this binary, polls `/health`, calls `/control/*`), `b9-control-plane.md` (mints the JWTs, delivers `manifest.allowedOrigins`, sets the shell-page CSP).

## 1. Goal

Add a `serve` subcommand to the `remote_server` binary that binds a public TCP port, serves `GET /health`, `GET /rpc` (WebSocket), `GET|POST|OPTIONS /files` and `GET /extensions/{id}/assets/{rel}` over plain HTTP/1.1, binds a second, loopback-only control listener (`127.0.0.1:8446`, D5) that routes `POST /control/{lifecycle,ports,extensions}` to b4's `ControlChannel` behind a secret read from `--control-secret-file`, and feeds the one authenticated WebSocket session at a time into the *same* `(incoming_tx, outgoing_rx)` envelope channels that `run` feeds from Unix sockets today, so `HeadlessProject`, `ChannelClient` ack/replay and the `RemoteStarted` handshake are reused unchanged. Each binary frame carries exactly what `write_message` writes (`u32` LE length prefix + prost `Envelope`, b1 §3.1 helpers). Sessions are gated by ES256 JWTs verified before the upgrade; the first frame in each direction is b1's `ControlFrame::Hello` / `ControlFrame::HelloAck`; arbitration follows b1 §4.4 as decided in D3: a *reconnect* (`Hello.reconnect`, `Hello.epoch` equal to the epoch of the last attach in this process) attaches warm, supersedes a still-attached half-open socket of the same epoch with 1001 and replays through Zed's ack/replay protocol; a *fresh* session (`reconnect:false`) resets the `HeadlessProject` (worktrees, language servers, git, local and user settings) and gets a new epoch; a takeover closes the previous client with 4001; a stale epoch is refused with 4001; a second client without `takeover` is refused with 4005. The process, its `ChannelClient`, its `HeadlessProject` entity and b3's server-level `PtyManager` (D3: PTYs survive fresh sessions; `detach_all` on detach, never `kill_all`) stay alive across sessions. The server sends a `ControlFrame::Heartbeat` text frame every 5 s; the 10-minute idle exit does not apply; SIGTERM flushes, closes the session with 4004 (`CLOSE_SERVER_STOPPING`, b1's terminal code) and quits the gpui app. Logs are JSON lines on stderr; once bound the process prints `ZS_LISTENING=<addr>` (and `ZS_CONTROL_LISTENING=<addr>`) on stdout and writes `--port-file`.

## 2. Existing code that matters

| Anchor | Note |
|---|---|
| `crates/remote_server/src/main.rs:6-22` | `Cli` (clap): `command: Option<Commands>` plus hidden `--askpass/--crash-handler/--printenv`. `serve` is a new `Commands` variant, no change to `Cli`. |
| `crates/remote_server/src/main.rs:42-56` | Dispatch `remote_server::run(command)`; `ExecuteProxyError` exit-code mapping. `serve` errors take the generic path. |
| `crates/remote_server/src/main.rs:57-62` | Usage string `usage: remote <run\|proxy\|version>` must gain `serve`. |
| `crates/remote_server/Cargo.toml:12-14` | `[lib] path = "src/server.rs"` – the crate root is `server.rs`; `serve` and `headless_project` are sibling modules. `:24-76` `[dependencies]` has **no** `prost`, `tokio`, `hyper`, `serde`, `bytes`; `:78-80` `[target.'cfg(windows)'.dependencies]` – the crate is built and clippy'd on Windows; `:111-112` `[package.metadata.cargo-shear] ignored`. |
| `crates/remote_server/build.rs:31-33` | Only `GITHUB_RUN_NUMBER → ZED_BUILD_ID` is exported; no `ZS_BUILD_ID`, no `cargo:rerun-if-env-changed`. |
| `crates/remote_server/src/server.rs:1-9` | `mod headless_project;` (private), `pub mod windows` (cfg), re-exports. `pub mod serve;` goes here, next to b3's `pub mod pty;` and b4's `pub mod client_state; pub mod control; pub mod ports;` (each brief adds its own line). |
| `crates/remote_server/src/server.rs:62-83` | `pub enum Commands { Run{..}, Proxy{..}, Version }` – add `Serve(ServeArgs)`. |
| `crates/remote_server/src/server.rs:85-127` | `pub fn run(command)` match – add the `Serve` arm. |
| `crates/remote_server/src/server.rs:129-140` | `pub static VERSION: LazyLock<String>` – reported in `/health.version` and as `HelloAck.build` when `ZS_BUILD_ID` is unset (there is no `HelloAck.version` field; b1 §4.2, §3.7 step 4). |
| `crates/remote_server/src/server.rs:142-153` | `init_logging_proxy()` – env_logger with `LogRecord` JSON formatter (template for stderr JSON in serve). |
| `crates/remote_server/src/server.rs:239-304` | `init_logging_server(log_file)` – rotating file + channel; panic hook at 273-288; env_logger builder at 289-301. Serve reuses the panic hook and formatter shape but targets stderr. |
| `crates/remote_server/src/server.rs:314-332` | `init_telemetry_forwarding(session, cx)` – reused as-is. |
| `crates/remote_server/src/server.rs:334-385` | `handle_crash_files_requests(project, client)` – reused as-is. |
| `crates/remote_server/src/server.rs:403-540` | `start_server(listeners, log_rx, cx, is_wsl_interop) -> AnyProtoClient`. **The shape to copy**: channels at 412-414, `on_app_quit` at 416-423, `IDLE_TIMEOUT` 10 min at 410 and its exit at 443-452 (`cx.shutdown(); cx.quit();` hack, comment 446-447), per-connection reader task 466-482 (`read_message` → `stdin_msg_tx`; reader and writer are separate tasks), inner `select_biased!` pump 484-533, and `RemoteClient::proto_client_from_channels(incoming_rx, outgoing_tx, cx, "server", is_wsl_interop)` at 539. The `ChannelClient` is built **once** and survives every accept iteration; only the streams are replaced. That is the invariant serve keeps for reconnects. |
| `crates/remote_server/src/server.rs:542-558` | `init_paths()` – call from serve too. |
| `crates/remote_server/src/server.rs:560-744` | `execute_run`: `gpui_platform::headless()` at 570; crash handler 573-599 (spawns `crashes::init(..)` → `Task<Arc<crashes::Client>>`, awaited at 641); rayon pool 616-621; login-shell env 623-635; the `run` closure 638-732 with `settings::init` 646, `release_channel::init` 653, `gpui_tokio::init(cx)` 654, `HeadlessProject::init` 656, WSL probe 658-663, `start_server` 666, telemetry 667, `trusted_worktrees::init` 668, git/dap/extension/json-schema init 670-677, **`let extension_host_proxy = ExtensionHostProxy::global(cx)` at 675 (captured by the `cx.new` closure, used at 715)**, project construction 679-721, `handle_crash_files_requests` 723, `mem::forget(project)` 731, `catch_unwind` 734-743. Serve factors 679-721 and 616-621 into helpers and calls them. |
| `crates/remote_server/src/server.rs:881-890` | `execute_proxy --reconnect` with no running server → `ProxyLaunchError::ServerNotRunning` (exit 90) → client `State::ServerNotRunning` (`remote_client.rs:888-895`) → `disconnected_overlay.rs:153-162` reopens the project. This is the `run`-mode analogue of "reconnect asked, nothing to resume" that serve reports as `HelloAck{resumed:false}`. |
| `crates/remote_server/src/server.rs:1203-1270` | `initialize_settings(session, fs, cx)` – reused. |
| `crates/crashes/src/crashes.rs:25,48-53` | `pub use minidumper::Client;` and `pub fn init<..>(..) -> impl Future<Output = Arc<Client>>` – the extracted crash-handler helper returns `Option<Task<Arc<crashes::Client>>>`. |
| `crates/remote_server/src/headless_project.rs:52-74` | `pub struct HeadlessProject` – `pub worktree_store` (55), `pub buffer_store` (56), `pub lsp_store` (57), `pub kernels` (73). |
| `crates/remote_server/src/headless_project.rs:76-84` | `HeadlessAppState { session, fs, http_client, node_runtime, languages, extension_host_proxy, startup_time }` – **not changed**: `grep 'HeadlessAppState {'` finds 25 construction sites across 8 files (`sidebar_tests.rs`, `zed.rs`, `remote_connections.rs`, `headless_project.rs`, `server.rs`, `remote_editing_tests.rs`, collab's `remote_editing_collaboration_tests.rs`, `remote/src/transport/mock.rs`), the same finding b4 §8 R1-1 made. Serve installs its shutdown callback through a post-construction setter (§3.10), following `handle_crash_files_requests` (`server.rs:334-385`) and b4's `enable_sandbox`. |
| `crates/remote_server/src/headless_project.rs:52-74,342-362` | `HeadlessProject` fields (`pub extensions: Entity<HeadlessExtensionStore>` at 66 – the entity `HeadlessExtensionStore::asset_path` lives on, §3.6) and the struct literal returned by `new` – gains `shutdown_request_handler: None` (§3.10). |
| `crates/rpc/src/proto_client.rs:626-635` | `subscribe_to_entity` keys on `(TypeId, remote_id)` and **panics** on a second registration – the reset in §3.10 must reuse every store entity (`worktree_store`, `buffer_store`, `settings_observer`, …) and never recreate one. |
| `crates/settings/src/settings_store.rs:959-983` | `SettingsStore::set_user_settings(&str, cx) -> SettingsParseResult` (`#[must_use]`; early-returns `Unchanged` when the content equals `last_user_settings_content`). `"{}"` parses as an empty `UserSettingsContent` and recomputes values from defaults – the mechanism behind D3's "settings observer restart" (§3.10). |
| `crates/remote_server/src/headless_project.rs:92-104` | `HeadlessProject::new(state, init_worktree_trust: bool, cx)`. |
| `crates/remote_server/src/headless_project.rs:201-210,287` | `SettingsObserver::new_local(..)` + `observer.shared(..)`, subscribed at 287 – user settings pushed by a client (`UpdateUserSettings`, sent by the client observer at `project_settings.rs:991` and applied at `:1123-1136` via `SettingsStore::set_user_settings`) live in the global `SettingsStore` and would survive a fresh session on their own; local settings of removed worktrees are cleared by the observer's `WorktreeRemoved` arm (`:1152`). D3 requires the fresh-session reset to restart the settings layer: §3.10 resets user settings to `{}` (the entity stays – re-subscribing panics, see the `proto_client.rs` row) and the new client's own `UpdateUserSettings` repopulates them. |
| `crates/remote_server/src/headless_project.rs:411-420` | `LspStoreEvent::LanguageServerRemoved` handler forwards a message to `self.session` – so a worktree reset emits envelopes beyond `UpdateProject`. |
| `crates/remote_server/src/headless_project.rs:480-566` | `handle_add_worktree`: always allocates a new worktree id (512-517) and a new `Worktree::local` (518-530); no dedupe by path. A fresh client re-adding an existing root would create a duplicate scanner – hence the fresh-session reset below. |
| `crates/remote_server/src/headless_project.rs:568-580` | `handle_remove_worktree` – `reset_for_new_client` goes after it. |
| `crates/remote_server/src/headless_project.rs:1205-1221` | `handle_shutdown_remote_server`: `cx.shutdown(); cx.quit();` in a spawned task, then `Ok(Ack)`. In serve mode this must close the session, not the process, and the Ack must reach the client before the close. |
| `crates/remote_server/src/headless_project.rs:1223-1230` | `handle_ping` → `Ack`; used by the integration test. |
| `crates/remote_server/src/remote_editing_tests.rs` | Builds `HeadlessProject` directly; never calls `execute_run`/`start_server` – the §3.11 extraction has no existing regression test (§3.14 adds one). |
| `crates/remote/src/protocol.rs:9-10,26-36,38-52` | `MessageLen = u32` little-endian prefix; `read_message`/`write_message`. **Kept inside WebSocket frames**: one binary frame = `u32 LE len || prost(Envelope)` via b1's `encode_envelope_frame`/`decode_envelope_frame` (b1 §3.1, appended after `:52`). BUILD-SPEC §4.1 (line 203) and §4.4 (line 231) require this. |
| b1 §3.2 `crates/remote/src/transport/websocket/wire.rs` (new in b1), re-exported as **`remote::websocket_wire`** (b1 §3.8 line 321; b1 §8 R-12 – `remote.rs:6` keeps `mod transport` private, so the nested path does not exist) | `PROTOCOL_VERSION=1`, `SUBPROTOCOL="zs.v1"`, `MAX_FRAME_BYTES=16 MiB`, `CLOSE_TAKEN_OVER=4001`, `CLOSE_BUILD_MISMATCH=4002`, `CLOSE_UNAUTHORIZED=4003`, `CLOSE_SERVER_STOPPING=4004`, `CLOSE_SESSION_BUSY=4005`, `ZS_BUILD_ID: Option<&str> = option_env!("ZS_BUILD_ID")`, `split_subprotocol_header(value) -> Option<(&str, &str)>`, `builds_compatible(client, server)` (exact match unless either side is a dev build), `ControlFrame::{Hello, HelloAck, Log(LogFrame), Heartbeat}` (`#[serde(tag = "type", rename_all = "snake_case")]`), `Hello { protocol, build, session_id, identifier, reconnect, takeover, client, epoch: Option<u64> }`, `HelloAck { protocol, build, os, arch, os_version, shell, resumed, session_id, epoch: u64 }`, `LogFrame { level, module_path, file, line, message }`, `ClientKind { Desktop, Web }`. **b1 defines no query-string token placement** (b1 §4.3, b9 §7.5): `TOKEN_QUERY_PARAM="zs_token"` and `PROTOCOL_QUERY_PARAM="zs_proto"` are therefore serve-side constants in `serve/auth.rs` (§3.5), used only by `/files` downloads (`<a download>` cannot set headers); `/rpc` also honours them as a documented, unused server-side superset — both client targets (native and wasm) send the subprotocol list only. Serve imports everything else (§3.3). b1 §3.3 step 5 close-code mapping: 4001 and 4005 → exit 91 terminal, 4002 → 92 terminal, 4004 and `reconnect && !HelloAck.resumed` → 90 terminal, 4003 and 1000-1013 → reconnect (refresh + redial). b1 §4.4 is the arbitration this brief implements (D20). |
| `crates/remote/src/remote_client.rs:160-162` | `MAX_MISSED_HEARTBEATS=5`, `HEARTBEAT_INTERVAL=5s`, `HEARTBEAT_TIMEOUT=5s` – client pings every 5 s; serve must not count those as input. |
| `crates/remote/src/remote_client.rs:410-536` | `RemoteClient::new`: a **fresh** client waits for `RemoteStarted` (`wait_for_remote_started().with_timeout(..)` 459-462) before pinging. |
| `crates/remote/src/remote_client.rs:538-546` | `proto_client_from_channels(...) -> AnyProtoClient` = `ChannelClient::new(..).into()`. Serve needs the concrete `Arc<ChannelClient>` too (new `server_channel_from_channels`). |
| `crates/remote/src/remote_client.rs:587-760` | Client reconnect: kills the connection (670-676), calls `start_proxy(.., reconnect = true, ..)` (692-700), `client.reconnect(incoming_rx, outgoing_tx, cx)` (712), then `resync` (714). Serve learns "reconnect" from `Hello.reconnect`. |
| `crates/remote/src/remote_client.rs:1647-1649` | `ResponseChannels`, `StreamResponseChannels` types – cleared by `begin_fresh_session`. |
| `crates/remote/src/remote_client.rs:1682-1723` | `ChannelClient { next_message_id, outgoing_tx: Mutex<UnboundedSender>, buffer: Mutex<VecDeque<Envelope>>, response_channels, stream_response_channels, message_handlers, max_received, task: Mutex<Task<..>> (1691), executor (1694) }` and `new`. |
| `crates/remote/src/remote_client.rs:1729-1782` | `start_handling_messages`: sends `RemoteStarted` (id 0, no ack) at 1735-1738; trims `buffer` on `ack_id` 1745-1750; on `FlushBufferedMessages` replays `buffer` then Acks 1751-1770; on `RemoteStarted` sets the signal and Acks 1772-1778; `max_received.store(incoming.id)` 1780. |
| `crates/remote/src/remote_client.rs:1782-1818` | Response routing: an incoming envelope with `responding_to` is delivered to whichever pending request has that id; unknown ids are dropped. A stale server response can therefore be delivered to the wrong request of a fresh client whose ids restarted at 0 (§3.7 stale-response rule). |
| `crates/remote/src/remote_client.rs:1824-1858` | Message handlers run as **detached foreground tasks**; dropping the `start_handling_messages` task does not cancel a handler in flight. |
| `crates/remote/src/remote_client.rs:1878-1886` | `ChannelClient::reconnect(incoming_rx, outgoing_tx, cx: &AsyncApp)` (`pub(crate)`): swaps `outgoing_tx` and restarts `start_handling_messages` (which re-sends `RemoteStarted`). Does **not** clear `buffer`, `max_received` or the response channels. Serve's fresh-session reset reuses it (§3.2). |
| `crates/remote/src/remote_client.rs:1910-1930` | `resync`: unbuffered `FlushBufferedMessages` request then replay of the client's `buffer`. |
| `crates/remote/src/remote_client.rs:2036-2049` | `send_buffered`/`send_unbuffered` stamp `ack_id = max_received` and `send_buffered` pushes to `buffer` **and** `outgoing_tx`. This is why `max_received` must be reset to 0 for a fresh client, and why anything a store emits during the worktree reset lands in the old channel (§3.7). |
| `crates/remote/src/remote.rs:10-14` | Public re-exports from `remote_client` – add `ServerChannel`, `ChannelEnds`. b1 adds `pub use transport::websocket::wire as websocket_wire;` next to them (b1 §3.8). |
| `crates/remote/src/transport.rs:5,41-52`; `crates/util/src/util.rs:76` | `parse_os_version` is `pub(crate)` and `parse_shell` private (so serve cannot reuse them), but `util::parse_os_release(content: &str) -> Option<String>` is public – `HelloAck.os_version` uses it on `/etc/os-release` (§3.9). |
| `crates/remote/src/json_log.rs:6-24,42-50` | `LogRecord<'a> { level: usize, module_path, file, line, message }` – flattened into `ServeLogRecord`; `Level::Info => 3`. |
| `crates/proto/proto/zed.proto:21-25` | `Envelope { id, responding_to, original_sender_id, ack_id = 266, oneof payload }`. |
| `crates/proto/proto/zed.proto:554-596`; `crates/proto/src/proto.rs:8,386,492,570,629` | `Ping`, `Ack`, `FlushBufferedMessages`, `RemoteStarted`; **`pub use prost::{DecodeError, Message}`** (the trait serve uses – no direct `prost` dependency needed); `RemoteStarted` is `Background`; `(Ping, Ack)`, `(FlushBufferedMessages, Ack)`, `(RemoteStarted, Ack)` request/response pairs. |
| `crates/project/src/worktree_store.rs:222-229,425,1020-1038,1171-1187` | `WorktreeStoreEvent::{WorktreeAdded, WorktreeRemoved, WorktreeReleased, ..}`, `worktrees()`, `remove_worktree(id, cx)` (emits `WorktreeRemoved`, then `send_project_updates` at 1037 → `downstream_client.send(UpdateProject)` at 1184 → `send_buffered`). |
| `crates/project/src/lsp_store.rs:4871,3835-3878` | `WorktreeRemoved(_, id) => self.remove_worktree(id, cx)`: removes every language server seeded by the worktree (`language_servers.remove`, `LanguageServerRemoved`), prettier state. `git_store.rs:2487`, `project_settings.rs:1152` (`clear_local_settings`), `manifest_tree.rs:199`, `context_server_store.rs:499` react too. **A fresh session is cold worktrees + cold LSP/prettier/git**. |
| `crates/project/src/buffer_store.rs:59,84-85,843,1067,1666` | `SharedBuffer { buffer: Entity<Buffer>, .. }` (strong), `OpenBuffer::Complete { buffer: WeakEntity<Buffer> }`; the only `WorktreeStoreEvent` arm is `WorktreeAdded` (843) – buffers are **not** dropped on `WorktreeRemoved`; `buffers()` iterator; `forget_shared_buffers()` clears the strong refs. `crates/language/src/buffer.rs:2494` `is_dirty`. `crates/worktree/src/worktree.rs:3796` `File.worktree: Entity<Worktree>` and `:140,1433` `_background_scanner_tasks` – a live buffer keeps its removed worktree and scanner alive. |
| `crates/worktree/src/worktree.rs:864-869` | `Worktree::abs_path(&self) -> Arc<Path>` (inherent, owned; shadows `Snapshot::abs_path(&self) -> &Arc<Path>` at 2562 through deref) – root path for `/health`. |
| `crates/gpui_tokio/src/gpui_tokio.rs:12-25,55-73,97-99` | `gpui_tokio::init` builds a 2-worker multi-thread runtime with `enable_all()`; `Tokio::spawn(cx, fut)` (aborts when the returned gpui `Task` drops – always `.detach()`); `Tokio::handle(cx)`. The HTTP listener, broker and session tasks run on this runtime. |
| `crates/gpui/src/app.rs:78,978-1003,1032,2032,2062,2352`; `crates/gpui/src/global.rs:22` | `SHUTDOWN_TIMEOUT = 200 ms`; `App::shutdown` runs `on_app_quit` observers with `block_with_timeout(SHUTDOWN_TIMEOUT)` and only logs on timeout; `App::quit`, `try_global`, `set_global`, `on_app_quit`; `trait Global`. |
| `crates/gpui_linux/src/linux/platform.rs:280-282` | Linux (incl. headless) `Platform::quit` = `common.signal.stop()` – the calloop stops and `Application::run` returns. Same path `run` relies on. |
| `crates/util/src/paths.rs:425-470` | `normalize_lexically(&Path)`: rejects a leading `..` and `..` climbing above the root; **accepts absolute paths** (pushes `RootDir`/`Prefix`, 434-448) and **returns `Ok(PathBuf::new())` for an empty path** (450). Empty/absolute/NUL need explicit checks (§3.6). |
| `crates/paths/src/paths.rs:240-243` | `remote_server_state_dir() = data_dir()/server_state` – not used by serve (no pid/socket files). |
| `Cargo.toml:367,546,549,564,570,637-638,670,802,795,840,910,976-988` | Workspace deps: `gpui_tokio`, `async-tar` (zed fork), `async-tungstenite = "0.33"`, `base64`, `bytes = "1.0"`, `http`/`http-body`, `jsonwebtoken = "10.0"` (no backend feature at workspace level), `serde`, `rustls = "0.23.26"`, `tokio = { version = "1" }`, `yawc` (zed fork rev `71a452f`, line 910). `[patch.crates-io]` at 976-988 holds git patches only; **per D10 `yawc` is vendored under `vendor/yawc` as a path `[patch]` entry** (a `[patch."https://github.com/zed-industries/yawc"]` table, since the dependency is a git source) with `vendor/README.md` recording rev `71a452f` – b1 owns that change (its §3.18 fork patches live there); serve consumes the crate as `yawc` either way. `vendor/` does not exist in the checkout yet. **No** workspace lines exist for `hyper`, `hyper-util`, `http-body-util`, `multer`, `subtle`. No crate in the workspace enables jsonwebtoken's `rust_crypto`. Workspace `edition = "2024"` (line 271): `std::env::remove_var` is `unsafe` (precedent `crates/zed/src/main.rs:1678`), relevant to §3.9 step 1. |
| `Cargo.lock` | Present: `hyper 1.7.0`, `hyper-util 0.1.17`, `http-body-util 0.1.3`, `jsonwebtoken 10.3.0`, `aws-lc-rs 1.17.1`/`aws-lc-sys 0.42.0`, `ring 0.17.14`, `subtle 2.6.1`, `async-tar 0.6.1`, `encoding_rs 0.8.35`, `spin 0.9.8`+`0.10.0`, `signal-hook-registry 1.4.6`, `p256 0.11.1`, `tokio-tungstenite 0.20.1/0.21.0/0.28.0` (the last two are in the lockfile but **not in remote_server's tree**). Absent from the lockfile and from the local registry: `multer` (first build needs network for it), `tar`. |
| `cargo tree -p remote_server -i aws-lc-sys` (read-only) | `aws-lc-sys ← aws-lc-rs ← rustls 0.23.40 ← http_client_tls ← client ← dap ← dap_adapters ← remote_server`. **aws-lc-sys is already in the remote_server musl build**; `jsonwebtoken` with `aws_lc_rs` adds no new native code. `-i hyper`: `hyper 1.7.0 ← hyper-rustls ← zed-reqwest ← reqwest_client ← remote_server` and `← hyper-util ← yawc ← cloud_api_client ← client`; enabled features today are `client,http1,http2` (hyper) and `client,client-legacy,client-proxy,http1,http2,tokio` (hyper-util) – no `server`. `-i yawc`, `-i http-body-util`, `-i async-tar`, `-i subtle`, `-i ring`: present. `-i tokio-tungstenite`, `-i tar`, `-i p256`, `-i jsonwebtoken`: not in this crate's tree. |
| `script/bundle-linux:87-94,131-136` | remote_server is built in its own `cargo build --package remote_server --target *-musl` with `CC_*=musl-gcc` and `+crt-static`; the script fails if the binary links libssl/libcrypto. Nothing below adds OpenSSL. |
| `.github/workflows/run_tests.yml:708`; `script/clippy:6,10`; `script/clippy.ps1:28` | `cargo shear --locked --deny-warnings` in CI; clippy runs `--workspace --all-targets --all-features -- --deny warnings` on Linux, macOS **and Windows** (`clippy_windows`, `run_tests_windows` in `run_tests.yml:189` and `release.yml:121,228`). |
| `crates/livekit_api/Cargo.toml:22` | `jsonwebtoken = { workspace = true, features = ["aws_lc_rs"] }` – precedent for the feature flag. |
| `~/.cargo/registry/src/*/jsonwebtoken-10.3.0/` | `Cargo.toml:50-65` features `aws_lc_rs` / `rust_crypto`, `use_pem` default. `src/decoding.rs:139` `DecodingKey::from_ec_pem`, `:273-283` `decode` (rejects `header.alg ∉ validation.algorithms` with `InvalidAlgorithm` at 281-283 – this, not a key-family check, is what stops HS256). `src/validation.rs:31-50` `Validation` fields (`required_spec_claims`, `leeway`, `validate_exp`, `validate_nbf`, `validate_aud`, `iss`, `aud`); `:113-133` `Validation::new` (leeway 60, exp on, nbf off); `:274-298` only `exp`/`nbf` are compared – **`iat` is never validated**. `src/crypto/mod.rs:104-125`: provider is chosen by `cfg(all(feature = "aws_lc_rs", not(feature = "rust_crypto")))`; if both features are enabled in a unified build the verifier **panics at first decode**. `src/errors.rs:40-87` `ErrorKind` variants used by the §3.5 mapping table. |
| `vendor/yawc/src/native/mod.rs:181,187,386-396,733-738,1048,1189,1230-1249,1265-1285` (D10; line numbers verified on the upstream checkout `~/.cargo/git/checkouts/yawc-*/71a452f/`, which the vendored tree copies) | `MAX_PAYLOAD_READ = 1 MiB`, `MAX_READ_BUFFER = 2 MiB`; `HttpStream::Hyper(TokioIo<Upgraded>)`; `pub struct WebSocket<S> { streaming: Streaming<S>, check_utf8, fragment_layer: FragmentLayer }` (no `Rc`/`RefCell`; expected `Send`, asserted at compile time in §3.7); `upgrade_with_options(&mut Request<B>, Options) -> Result<(Response<Empty<Bytes>>, UpgradeFut)>` (does **not** set `Sec-WebSocket-Protocol` – we add it); `next_frame() -> Result<Frame>`; `impl Stream for WebSocket<S> { type Item = Frame }` (errors end the stream) and `impl Sink<Frame>` whose `poll_flush` writes through to the socket – a stalled peer parks whoever awaits `send()`. There is **no owned split** (`split.rs` halves take `&mut S`), so one task owns each socket (§3.7). `upgrade.rs:322-350`: `UpgradeFut: Future<Output = hyper::Result<WebSocket<HttpStream>>>`. `native/options.rs:61-120` `Options { max_payload_read, max_read_buffer, compression, max_backpressure_write_boundary (119), .. }`; `:317` `without_compression`, `:335` `with_max_payload_read`, `:354` `with_max_read_buffer`, `:369` `with_utf8`, `:466` `with_backpressure_boundary`. `close.rs:27-84,91-114`: `CloseCode::{Normal=1000, Away=1001, Size=1009, Policy=1008, .., Library(u16)}` with `4000..=4999 → Library`. `frame.rs:271,289,390,498,512,713`: `Frame::text/binary/close(code, reason)`, `opcode()`, `payload()`, `close_code()`. `native/builder.rs:189` `WebSocketBuilder::with_request(HttpRequestBuilder)` (test client). |
| `~/.cargo/registry/src/*/hyper-1.7.0/Cargo.toml:69-106`; `src/server/conn/http1.rs:191,265,342,371,401,442` | hyper features `http1` (87-94), `server` (101-105); `Builder::{with_upgrades, keep_alive, header_read_timeout (panics if configured without a `Timer`; default 30 s only applies with a timer), max_buf_size, timer, serve_connection}`. `hyper-util-0.1.17/Cargo.toml:48-108`: features `http1`, `server`, `tokio` (102-106); `service` (101) is **not** needed (`service_fn` lives in `hyper::service`). `hyper-util/src/rt/tokio.rs:91` `TokioTimer`. |
| `~/.cargo/git/checkouts/async-tar-*/bd3ad6f/src/builder.rs:40-47,69,398,423` | `Builder<W: Write + Unpin + Send + Sync>` (so `ChannelWriter` must be `Sync` too), `follow: true` by default, `follow_symlinks(&mut self, bool)`, `append_dir_all(name, src).await`, `finish().await`. |
| `/Users/ray/Projects/play/wed/BUILD-SPEC.md:203,215,219,227,231,178-182,296-305,373-375` | §4.1 client uses `read_message`/`write_message` framing; §4.2 command line `serve --listen 0.0.0.0:8443 --jwt-public-key <path> --workspace <id> [--allow-build <id>]`; §4.2 "the `HeadlessProject` and its stores survive"; §4.3 public key "baked into the sandbox … as an environment variable"; §4.4 "Unchanged from Zed: `u32` little-endian length prefix"; §3.6 drag-drop upload / download hit `https://<session>.vercel.run/files` from the shell page (cross-origin → CORS); §6.2 supervisor stop = "ask the server to flush client state and buffers, then exit" (b4 `POST /control/lifecycle`, then SIGTERM); §7.6 CSP `connect-src 'self' wss://*.vercel.run` (b9 §4.9 line 1157 already adds `https://*.vercel.run`). |
| `docs/briefs/b4-proto-additions.md` §3.10 (`control.rs`), §3.11 (`ports.rs`: `DEFAULT_SUPERVISOR_URL = "http://127.0.0.1:8445"`), §3.13 (`HeadlessExtensionStore::asset_path(&self, id, rel) -> Option<PathBuf>`), §3.14 (`SandboxConfig { control_secret, supervisor_url, supervisor_http, registry, client_state_dir }`, `HeadlessProject::{enable_sandbox, on_session_attached, notify_files_uploaded}`), §3.15 items 1-6, §7.2, §7.8, §7.12 | `crates/remote_server/src/control.rs`: `LIFECYCLE_PATH = "/control/lifecycle"`, `PORTS_PATH = "/control/ports"`, `EXTENSIONS_PATH = "/control/extensions"`, `STOPPING_FLUSH_TIMEOUT = 5 s`, `ControlChannel::handle(&self, ControlRequest { method, path, bearer, peer_is_loopback, session_attached, body }) -> ControlResponse { NoContent, BadRequest(String), Unauthorized, NotFound }` (HTTP-framework-agnostic; `subtle::ConstantTimeEq` on the bearer; the secret arrives from serve, never from the environment). b4's six obligations addressed to serve (D20): `--control-secret-file`/`--supervisor-url`/`--control-listen` flags; the secret read before any spawn; the loopback-only control listener with `/control/{lifecycle,ports,extensions}`; `GET /extensions/{id}/assets/*` on the public listener; `GpuiCommand::{SessionAttached, FilesUploaded}`; `is_input_envelope` excluding `SaveClientState`, `LoadClientState`, `ListExtensions`. All six are in §3.6-§3.9. The earlier `current_ports_message()` hook is gone: b4's `on_session_attached` replays ports/`Resumed`/`ExtensionsChanged` itself. |
| `docs/briefs/b3-terminals.md` §3.8 (`crates/remote_server/src/pty.rs`), §3.9, §7.1, §7.4, §7.8 | `PtyManager::new(project_id, sink: Arc<dyn TerminalOutputSink>, cx: &mut App)` (registers `on_app_quit`, which SIGTERMs then SIGKILLs every process group), `detach_all(&self)` (stream `attached = false`, readers stop blocking on the ack window and fill the 2 MiB ring), `kill_all(&self)`, `list()`, `impl Drop` (SIGKILL). b3 §3.9 currently stores it in `HeadlessProject.pty_manager`; **D3 moves it to server level** (outside `HeadlessProject`, survives fresh sessions) and D20 fixes serve's calls: `detach_all` on session detach, never `kill_all` on a fresh session (`kill_all` only from `on_app_quit`/`Quit` or b3's `CloseTerminal`). b3 §7.1(a) and D20: `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` are not input (§3.7). b3 §7.1(c): `MAX_FRAME_BYTES ≥ 64 KiB + envelope overhead` holds at 16 MiB. |
| `docs/briefs/b8-supervisor-image.md:32-33,497-531,553-555,663,794-800,829,1207` | The supervisor builds the spawn line from **this brief's** flag names (`--listen`, `--jwt-public-key`…, `--workspace-id`, `--audience`, `--issuer`, `--workspace-root`, `--client-build`, `--port-file`; per D5/D18 it gains `--control-secret-file <path>`, `--control-listen 127.0.0.1:8446`, `--allowed-origin <origin>`… from `manifest.allowedOrigins`, and stops exporting `ZS_CONTROL_SECRET`), polls `http://127.0.0.1:8443/health` (loopback → full body; `ServerHealth { build, version, uptime_secs, session_active, last_input_at?, session? }`, `worktrees` deliberately not modelled), derives D13's `busy`/`phase` itself and reports `last_input_at = now` while busy, and stops with `POST /control/lifecycle {"kind":"stopping"}` (budget to exceed the 5 s flush, D18) → SIGTERM → `TERM_GRACE` 3 s → SIGKILL of the process group. b8's *own* loopback API (`/ports`, `/git-token`, `ZS_SUPERVISOR_URL`) is on `127.0.0.1:8446` today (b8:146,663), the same port D5 assigns to serve's control listener – §7.16. |
| `docs/briefs/b9-control-plane.md` §3.18, §4.2 (`SessionClaims { iss, sub, ws, sid, aud, iat, exp, jti }`, ES256 with `kid`), §4.7 (`manifest.allowedOrigins: [controlPlaneUrl()]`), §7.3, §7.5, §8 items 10/M1/16/22, `:1408` | b9 mints `ws = workspaceId`; `sid` was `=== workspaceId` in b9's revision, but **D1 makes `session_id` a per-connect id minted by the control plane and informational** – serve carries `sid` into `SessionMeta`, `HelloAck.session_id`, logs and `/health`, validates nothing else about it, and keys resume on the epoch (§3.7). `aud` is the workspace audience (may differ from the sandbox name); rotation ships two public-key PEMs as files; `?zs_token=` survives only for the `/files` download form (b9 §7.5); editor CSP `connect-src` includes `https://*.vercel.run`; b9 polls the supervisor's `:8445/health`, not this listener (b9 §8 item 10). |
| `docs/briefs/DECISIONS.md` D1-D20 | Binding. This brief's reconciliation is §9. |
| zed-web fork `crates/zed_web_server/src/auth.rs:26-76`, `main.rs:131-157` | Evidence only: a per-IP failure limiter and an axum 0.6 server. We take neither axum (hyper 0.14 beside 1.7) nor the pre-verification limiter (§3.8 explains why). |

## 3. Change list (dependency order)

### 3.1 `Cargo.toml` (workspace root)

Add to `[workspace.dependencies]` (alphabetical positions):

```toml
http-body-util = "0.1.3"
hyper = { version = "1.7", default-features = false }
hyper-util = { version = "0.1.17", default-features = false }
multer = "3.1"
subtle = "2.6"
```

Lines touched: insert near `Cargo.toml:637-638` (`http`, `http-body`), `:670` (`jsonwebtoken`), `:684` (`mime`), `:812` (`sha2`). `hyper`, `hyper-util`, `http-body-util`, `subtle` are already locked. `multer` is the only new package in `Cargo.lock` (its transitive deps `encoding_rs`, `spin`, `httparse`, `mime`, `memchr` are all locked already); it is absent from the local registry, so the first build needs network access for `cargo update -p multer`.

### 3.2 `crates/remote/src/remote_client.rs`

Add a server-side handle exposing the concrete `ChannelClient` so serve can reset it for a fresh client. Touches: after `proto_client_from_channels` (538-546); new method next to `reconnect` (1878-1886).

```rust
/// The broker's ends of a channel pair.
pub struct ChannelEnds {
    pub incoming_tx: mpsc::UnboundedSender<Envelope>,
    pub outgoing_rx: mpsc::UnboundedReceiver<Envelope>,
}

/// Server-side handle on the channel client, for transports that keep the server
/// process alive across client sessions (`zed-remote-server serve`).
pub struct ServerChannel {
    client: Arc<ChannelClient>,
}

impl ServerChannel {
    pub fn proto_client(&self) -> AnyProtoClient { self.client.clone().into() }

    /// Forget everything that belonged to the previous client and re-run the
    /// initial handshake on a NEW channel pair: clears the unacked replay buffer,
    /// resets the received-id watermark, drops pending response channels (their
    /// futures fail with "connection lost"), then calls `reconnect` (1878-1886),
    /// which restarts `start_handling_messages` and therefore sends `RemoteStarted`
    /// (1735-1738) into the new `outgoing_tx`. Everything queued on the old
    /// `outgoing_rx` dies with it when the caller drops it.
    pub fn begin_fresh_session(&self, cx: &AsyncApp) -> ChannelEnds {
        let (incoming_tx, incoming_rx) = mpsc::unbounded();
        let (outgoing_tx, outgoing_rx) = mpsc::unbounded();
        let c = &self.client;
        c.buffer.lock().clear();
        c.max_received.store(0, SeqCst);
        c.response_channels.lock().clear();
        c.stream_response_channels.lock().clear();
        c.reconnect(incoming_rx, outgoing_tx, cx);
        ChannelEnds { incoming_tx, outgoing_rx }
    }
}

impl RemoteClient {
    pub fn server_channel_from_channels(
        incoming_rx: mpsc::UnboundedReceiver<Envelope>,
        outgoing_tx: mpsc::UnboundedSender<Envelope>,
        cx: &App,
        name: &'static str,
        has_wsl_interop: bool,
    ) -> ServerChannel {
        ServerChannel { client: ChannelClient::new(incoming_rx, outgoing_tx, cx, name, has_wsl_interop) }
    }
}
```

`next_message_id` is deliberately **not** reset: the client only uses server ids as an ack watermark, and monotonic ids keep `buffer` trimming (1745-1750) correct. `reconnect` is `pub(crate)` and `ServerChannel` lives in the same crate. Handlers already in flight (detached at 1830-1858) keep running and will answer into the new `outgoing_tx`; §3.7's stale-response rule handles that. `proto_client_from_channels` (538-546) is unchanged so `server.rs:539` keeps compiling.

### 3.3 `crates/remote/src/remote.rs` and shared wire definitions

Line 10-14: add `ServerChannel`, `ChannelEnds` to the `pub use remote_client::{...}` list.

Serve imports from `remote` everything b1 defines for the wire: `remote::protocol::{encode_envelope_frame, decode_envelope_frame}` (b1 §3.1) and `remote::websocket_wire::*` (b1 §3.2 via the `pub use transport::websocket::wire as websocket_wire;` re-export in `remote.rs`, b1 §3.8: constants incl. `CLOSE_SESSION_BUSY` and `ZS_BUILD_ID`, `ControlFrame::{Hello, HelloAck, Log, Heartbeat}`, `Hello` (with `epoch`), `HelloAck` (with `epoch`), `LogFrame`, `ClientKind`, `split_subprotocol_header`, `builds_compatible`). **Landing order**: if b2 merges before b1, b2 adds `protocol.rs`'s two helpers, `transport/websocket/wire.rs` and the `websocket_wire` re-export with exactly b1's signatures (they are `serde` + `serde_json` + `prost` only and have no transport dependency) and b1 rebases onto them. Serve adds nothing else to `remote`.

### 3.4 `crates/remote_server/Cargo.toml`

Add a cargo feature `serve` (default-on in the fork) that owns the module and every new dependency, so the upstream PR can carry `serve` as an opt-in and `cargo shear`/musl surface stay small. See §5 for exact lines. `[dev-dependencies]` gain `async-tungstenite`, `prost` (tests build envelopes directly) and `tokio` with `macros`/`rt-multi-thread`. Non-test code never names `prost`: the `Message` trait comes from `proto::Message` (`crates/proto/src/proto.rs:8`).

### 3.5 `crates/remote_server/src/serve/auth.rs` (new)

Pure functions, no gpui, unit-testable.

```rust
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, errors::ErrorKind};
use subtle::ConstantTimeEq;
pub use remote::websocket_wire::{SUBPROTOCOL, split_subprotocol_header};

/// Query-string placements. b1 defines none (the subprotocol list is the only client-side
/// placement, b1 §4.3, for native and wasm alike); these exist for `/files` downloads (`<a download>`
/// cannot set headers), so they live here rather than in `wire.rs`. `/rpc` still honours them as a
/// documented, unused server-side superset (`extract_token`, §3.8 (a)/(b)); no client sends them there.
pub const TOKEN_QUERY_PARAM: &str = "zs_token";
pub const PROTOCOL_QUERY_PARAM: &str = "zs_proto";

pub const EXPECTED_ALG: Algorithm = Algorithm::ES256;
pub const LEEWAY_SECS: u64 = 30;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub ws: String,      // workspace id; compared with `--workspace-id` (constant time)
    pub sid: String,     // per-connect session id minted by the control plane (D1): informational –
                         // carried into SessionMeta / HelloAck.session_id / logs, never a resume key
    pub aud: String,
    pub iat: u64,
    pub exp: u64,
    pub jti: String,
}

pub struct AuthConfig {
    keys: Vec<DecodingKey>,          // one per PEM block; two during rotation
    validation: Validation,          // alg=[ES256], aud, iss, required = ["exp","aud","iss","sub"], leeway, nbf off
    workspace_id: String,
}

impl AuthConfig {
    /// `pem_files`: each may hold several `-----BEGIN PUBLIC KEY-----` blocks.
    pub fn load(pem_files: &[std::path::PathBuf], issuer: &str, audience: &str, workspace_id: &str) -> anyhow::Result<Self>;
    pub fn from_pems(pems: &[&str], issuer: &str, audience: &str, workspace_id: &str) -> anyhow::Result<Self>;
    /// For every loaded key: `decode::<Claims>(token, key, &self.validation)`. The first `Ok`
    /// wins; if every key fails, the error reported is the first one that is not
    /// `BadSignature` (a key-2-signed but expired token is `Expired`, not `BadSignature`).
    /// jsonwebtoken checks alg ∈ [ES256], signature, required claims, `exp` (with `leeway`),
    /// `aud`, `iss`. It never looks at `iat`, so after `decode`: `iat > now + LEEWAY_SECS` →
    /// `Malformed` (a token from the future). Then `ws == workspace_id` with `ConstantTimeEq`
    /// (length mismatch counts as unequal) → `WrongWorkspace`.
    pub fn verify(&self, token: &str) -> Result<Claims, AuthError>;
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("missing token")]            Missing,                 // 401
    #[error("malformed token")]          Malformed,               // 401
    #[error("bad signature")]            BadSignature,            // 401
    #[error("token expired")]            Expired,                 // 401
    #[error("wrong audience")]           WrongAudience,           // 403
    #[error("wrong issuer")]             WrongIssuer,             // 403
    #[error("wrong workspace")]          WrongWorkspace,          // 403
    #[error("unsupported algorithm")]    WrongAlgorithm,          // 401
    #[error("subprotocol not offered")]  MissingSubprotocol,      // 426
}

impl AuthError { pub fn status(&self) -> hyper::StatusCode; }

/// `jsonwebtoken::errors::ErrorKind` → `AuthError`:
///   ExpiredSignature → Expired · InvalidSignature → BadSignature ·
///   InvalidAudience | MissingRequiredClaim("aud") → WrongAudience · InvalidIssuer → WrongIssuer ·
///   InvalidAlgorithm | InvalidAlgorithmName | MissingAlgorithm → WrongAlgorithm ·
///   everything else (InvalidToken, Base64, Json, Utf8, InvalidClaimFormat, other MissingRequiredClaim,
///   ImmatureSignature, InvalidEcdsaKey, Provider) → Malformed.
fn map_error(kind: &ErrorKind) -> AuthError;

/// Parses `Sec-WebSocket-Protocol: zs.v1, <jwt>` (any order, any whitespace) via b1's
/// `split_subprotocol_header`. `Err(MissingSubprotocol)` if `zs.v1` is absent,
/// `Err(Missing)` if no second item. Never logs the token.
pub fn token_from_subprotocol(header: &str) -> Result<String, AuthError>;

/// Where a request may carry the token, in order of precedence:
/// 1. `Sec-WebSocket-Protocol` item (native clients, b1 §4.3),
/// 2. `Authorization: Bearer` (`/files`, `/health`),
/// 3. `?zs_token=` (wasm clients cannot set headers; `<a download>` cannot either).
/// Returns the token and whether `zs.v1` was offered (header item or `?zs_proto=zs.v1`).
pub fn extract_token(req: &hyper::Request<hyper::body::Incoming>) -> Result<(String, bool), AuthError>;

/// Rewrites `zs_token=<..>` to `zs_token=***` for logging.
pub fn redact_query(path_and_query: &str) -> String;
```

`Validation` setup: `let mut v = Validation::new(Algorithm::ES256); v.set_audience(&[audience]); v.set_issuer(&[issuer]); v.set_required_spec_claims(&["exp", "aud", "iss", "sub"]); v.leeway = LEEWAY_SECS; v.validate_nbf = false;`. HS256-with-public-key confusion is closed by `validation.algorithms` (`decoding.rs:281-283`, `InvalidAlgorithm` before any crypto). The only bearer-string comparison in our code is `ws`, and it uses `subtle`.

**Backend constraint** (`crypto/mod.rs:104-125`): the provider is selected by `aws_lc_rs && !rust_crypto`. No crate in the workspace enables `rust_crypto` today; a future one would make `verify` panic in any unified build (`cargo test --workspace`, clippy `--all-features`). Add to `docs/` and the fork's CONTRIBUTING: *"no workspace crate may enable jsonwebtoken's `rust_crypto`"*, and add `auth.rs` test `provider_is_available` (a plain `decode` of a fixture token) so a unified-build regression fails as a test, not a panic in production.

### 3.6 `crates/remote_server/src/serve/files.rs` (new)

```rust
pub const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_FILES_PER_UPLOAD: usize = 512;
pub const MAX_DOWNLOAD_ENTRIES: usize = 100_000;   // directory tar entry cap
pub const TEMP_SUFFIX: &str = ".zs-upload-";

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error("path is outside the workspace root")] Traversal,          // 400
    #[error("path contains an invalid component")] InvalidPath,        // 400
    #[error("not found")] NotFound,                                     // 404
    #[error("upload too large")] TooLarge,                              // 413
    #[error("too many files")] TooManyFiles,                            // 413
    #[error("unsupported content type")] UnsupportedMedia,              // 415
    #[error(transparent)] Io(#[from] std::io::Error),                   // 500
}

/// Resolve `requested` (the percent-decoded `?path=` value; `/`-separated) under `root`.
/// Steps, in order: percent-decode (invalid UTF-8 → InvalidPath); reject empty, any NUL byte,
/// any absolute path (`Path::is_absolute()` or a leading `/`) and any `Prefix` component →
/// InvalidPath (`normalize_lexically` alone accepts absolute and empty inputs, paths.rs:434-450);
/// `util::paths::normalize_lexically` → Err → Traversal; `root.canonicalize()`; canonicalize the
/// deepest existing ancestor of the joined path and require `starts_with(canonical_root)`
/// (defeats symlink escapes) → else Traversal; return the joined, non-canonical tail so a
/// not-yet-existing file name is preserved.
pub fn resolve_under_root(root: &std::path::Path, requested: &str) -> Result<std::path::PathBuf, FilesError>;

#[derive(serde::Serialize)]
pub struct UploadResponse { pub written: Vec<String> }   // paths relative to root, `/`-separated

/// `POST /files?path=<dir>` with `multipart/form-data` (each part's `filename` is joined under
/// `<dir>`; nested `a/b.txt` filenames are allowed and re-validated with `resolve_under_root`),
/// or `POST /files?path=<file>` with `application/octet-stream` (body is the file).
/// Before reading the body: `Content-Length > MAX_UPLOAD_BYTES` → 413. While reading: a running
/// byte counter across all parts → 413 at the first byte past the limit; part count >
/// MAX_FILES_PER_UPLOAD → 413 TooManyFiles. Streams to `<target><TEMP_SUFFIX><jti>` then renames;
/// creates parent dirs; on any error removes the temp file. Marks activity via `state.touch_input()`.
/// After the last rename: `state.gpui_tx.unbounded_send(GpuiCommand::FilesUploaded(abs_paths))`
/// (b4 §3.15 item 5) so `HeadlessProject::notify_files_uploaded` rescans the worktree entries and
/// sends `proto::FilesUploaded` to the client; the 201 does not wait for that.
pub async fn handle_upload(
    state: &ServeState,
    claims: &crate::serve::auth::Claims,
    req: hyper::Request<hyper::body::Incoming>,
) -> Result<hyper::Response<BoxBody>, FilesError>;

/// `GET /extensions/{id}/assets/{rel}` (b4 §3.15 item 4; BUILD-SPEC §9): `id` and `rel` are the
/// percent-decoded path segments (`rel` may contain `/`). Resolution happens on the gpui side
/// because `HeadlessExtensionStore` is an entity: send `GpuiCommand::ResolveExtensionAsset { id,
/// rel, reply }` and await `reply` (b4's `asset_path` returns `None` for unknown ids, uninstalled
/// extensions and any traversal). `None` → 404; `Some(path)` → the same streamed file response as
/// `handle_download` for a file (`Content-Type` from the extension: `.css/.json/.png/.svg/.ttf/
/// .woff2/.wasm` via a small table, else `application/octet-stream`; no `Content-Disposition`).
/// Directories → 404. Never touches `/files`' root (`asset_path` bounds it to
/// `paths::remote_extensions_dir()`).
pub async fn handle_extension_asset(
    state: &ServeState,
    id: String,
    rel: String,
) -> Result<hyper::Response<BoxBody>, FilesError>;

/// `GET /files?path=<rel>`: file → `application/octet-stream`, `Content-Length`,
/// `Content-Disposition: attachment; filename="<name>"`, body streamed in 64 KiB reads via `tokio::fs`.
/// Directory → `application/x-tar`, `Content-Disposition: attachment; filename="<name>.tar"`,
/// produced by `async_tar::Builder::new(ChannelWriter)` with `follow_symlinks(false)` (async-tar
/// follows symlinks by default, builder.rs:53,69 – `ln -s / x` must not tar the filesystem) +
/// `append_dir_all(name, dir)`, chunked; more than MAX_DOWNLOAD_ENTRIES entries aborts the stream.
pub async fn handle_download(
    state: &ServeState,
    req: hyper::Request<hyper::body::Incoming>,
) -> Result<hyper::Response<BoxBody>, FilesError>;

/// Removes leftover `*<TEMP_SUFFIX>*` files under `root` (bounded walk, best effort). Called once at startup.
pub async fn sweep_temp_files(root: &std::path::Path);

/// `futures::AsyncWrite` adapter that forwards each write as `Bytes` into an mpsc channel;
/// the receiver is wrapped in `http_body_util::StreamBody` for the response.
/// `futures::channel::mpsc::Sender` is `Send + Sync`, which `async_tar::Builder<W>` requires.
struct ChannelWriter { tx: futures::channel::mpsc::Sender<Result<hyper::body::Frame<bytes::Bytes>, std::io::Error>> }
```

`BoxBody = http_body_util::combinators::BoxBody<bytes::Bytes, std::io::Error>` (shared alias in `serve/http.rs`). All three handlers are called only after `AuthConfig::verify` succeeded in the router; `handle_upload` receives the `Claims` for the `jti` temp suffix. CORS headers on every `/files` and `/extensions/*` response are added by the router (§3.8).

### 3.7 `crates/remote_server/src/serve/session.rs` (new)

The session broker: one tokio task that owns the envelope channel ends and at most one session; each attached socket is driven by its own task. **The broker never awaits a socket write** – a stalled peer must not delay takeover or SIGTERM. Arbitration is b1 §4.4 as decided in D3/D20: resume is keyed on the **epoch** (a `u64` the server hands out in every `HelloAck` and the client echoes in `Hello.epoch` on reconnect), not on the JWT `sid` (per-connect and informational, D1) and not on `Hello.identifier` (logging only).

```rust
use std::time::Duration;
use yawc::{WebSocket, HttpStream, frame::{Frame, OpCode}, close::CloseCode};
use remote::protocol::{encode_envelope_frame, decode_envelope_frame};
use remote::websocket_wire::{
    ControlFrame, Hello, HelloAck, LogFrame, ClientKind, MAX_FRAME_BYTES, PROTOCOL_VERSION,
    CLOSE_TAKEN_OVER, CLOSE_BUILD_MISMATCH, CLOSE_UNAUTHORIZED, CLOSE_SERVER_STOPPING, CLOSE_SESSION_BUSY,
    builds_compatible,
};
use remote::ChannelEnds;

/// Close codes this side uses beyond b1's five constants (b1 §3.3 step 5 maps 1000-1013 and unknown 4xxx to "reconnect"; see §4/§7).
pub const CLOSE_SUPERSEDED: u16 = 1001;       // RFC 6455 "going away": a still-attached socket of the SAME epoch is replaced by a reconnect (b1 §4.4, D3)
pub const CLOSE_BAD_HELLO: u16 = 4006;        // no/invalid Hello within HELLO_TIMEOUT, or protocol != 1 (a client bug; b1 treats it as reconnectable)
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
pub const UPGRADE_TIMEOUT: Duration = Duration::from_secs(10);   // 101 sent → upgrade future must resolve
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(30);     // one frame to a peer that is not reading
pub const DETACH_TIMEOUT: Duration = Duration::from_secs(1);     // session task must exit after a Close ctl
pub const SHUTDOWN_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
pub const CLOSE_GRACE: Duration = Duration::from_millis(100);    // wait for stragglers after the queue drained
pub const SESSION_QUEUE_FRAMES: usize = 64;                      // bounded broker → session frame channel
pub const MAX_CLOSE_REASON_BYTES: usize = 123;                   // RFC 6455; browsers reject longer reasons
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5); // server → client `ControlFrame::Heartbeat` (b1 §4.2/§7.8, D3)
pub const LOG_FRAME_MAX_LEVEL: log::Level = log::Level::Warn;    // records at this level or more severe are mirrored as `ControlFrame::Log`
pub const EPOCH_SEQ_BITS: u32 = 16;                              // epoch = (process start unix ms << 16) | attach counter

const _: () = { fn assert_send<T: Send>() {} fn _check() { assert_send::<WebSocket<HttpStream>>(); } };

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind { Fresh, Reconnect }

#[derive(Clone, Debug, serde::Serialize)]
pub struct SessionMeta {
    pub session_id: String,   // JWT `sid` (authoritative; D1: informational, minted per connect). A differing `Hello.session_id` is logged, not fatal.
    pub sub: String,          // JWT `sub`
    pub jti: String,
    pub identifier: String,   // Hello.identifier – the client instance (logs only)
    pub kind: SessionKind,
    pub epoch: u64,           // the epoch this attach runs under (new for Fresh, carried for Reconnect)
    pub client_build: String,
    pub client: ClientKind,
    pub attached_at_ms: u64,
}

pub enum BrokerCommand {
    /// Sent by the per-connection task after the upgrade AND the Hello exchange succeeded.
    Attach { ws: WebSocket<HttpStream>, hello: Hello, claims: crate::serve::auth::Claims },
    /// From `ShutdownRemoteServer` or a supervisor request: flush, close the current session, stay alive.
    CloseSession { code: u16, reason: &'static str },
    /// From SIGTERM/SIGINT: flush, close CLOSE_SERVER_STOPPING, then `hooks.request_quit()`.
    Shutdown { done: tokio::sync::oneshot::Sender<()> },
}

/// Bridge to the gpui side; the production impl talks over channels (§3.9 `GpuiHooks`), tests stub it.
pub trait ServeHooks: Send + Sync + 'static {
    /// Must, on the gpui thread and in this order: `HeadlessProject::reset_for_new_client`
    /// (D3: drops worktrees → language servers, git, local settings; resets user settings;
    /// emits UpdateProject / LanguageServerRemoved / … into the OLD channels), then
    /// `ServerChannel::begin_fresh_session` (new channel pair, `RemoteStarted` queued on the
    /// new `outgoing_rx`). Never touches b3's `PtyManager` (D3/D20). Returns the broker's new
    /// ends; the broker drops the old ones.
    fn begin_fresh_session(&self) -> futures::future::BoxFuture<'static, ChannelEnds>;
    /// After every attach. For `Fresh` the gpui side runs b4's `HeadlessProject::on_session_attached`
    /// (replays the last `PortsChanged`, a pending `Resumed`, the current `ExtensionsChanged`);
    /// for `Reconnect` nothing (the queue and the replay buffer were kept).
    fn session_attached(&self, meta: &SessionMeta);
    /// After every session-task exit. The gpui side calls `PtyManager::detach_all()` (D3/D20, b3 §7.1(b)/§7.4)
    /// so reader threads stop blocking on the ack window and terminals keep running into their rings.
    fn session_detached(&self, meta: &SessionMeta);
    fn request_quit(&self);
}

/// Broker → session task control.
enum SessionCtl { Close { code: u16, reason: String } }

/// Why a session task exited (logged as `session_detached.reason`).
pub enum SessionExit { PeerClosed { code: Option<u16> }, ReadError(String), WriteError(String), SlowConsumer, FrameTooLarge, Closed { code: u16 } }

struct ActiveSession {
    meta: SessionMeta,
    frame_tx: tokio::sync::mpsc::Sender<Frame>,            // SESSION_QUEUE_FRAMES
    ctl_tx: tokio::sync::mpsc::UnboundedSender<SessionCtl>,
    done: tokio::task::JoinHandle<SessionExit>,
    incoming_watermark: Arc<AtomicU32>,                    // highest Envelope.id received under this epoch + 1; 0 = nothing yet
}

pub struct SessionBroker {
    incoming_tx: futures::channel::mpsc::UnboundedSender<rpc::proto::Envelope>,
    outgoing_rx: futures::channel::mpsc::UnboundedReceiver<rpc::proto::Envelope>,
    commands: tokio::sync::mpsc::UnboundedReceiver<BrokerCommand>,
    state: Arc<ServeState>,
    hooks: Arc<dyn ServeHooks>,
    current: Option<ActiveSession>,
    epoch_base: u64,                               // (unix ms at process start) << EPOCH_SEQ_BITS – epochs never collide across restarts
    attach_seq: u64,                               // fresh attaches in this process (1-based)
    current_epoch: Option<u64>,                    // epoch of the most recent Fresh attach in this process; None until the first one
    last_watermark: u32,                           // incoming_watermark of the most recent session (carried over on Reconnect)
    stashed: Option<BrokerCommand>,                // a command that preempted a queue push
}

impl SessionBroker {
    pub fn new(incoming_tx, outgoing_rx, commands, state, hooks) -> Self;
    /// Runs until `Shutdown` is processed. `tokio::select!(biased)` over:
    /// 1) `stashed` / `commands.recv()`; 2) `current.done` (session task exited);
    /// 3) `outgoing_rx.next()` **only when attached** (envelopes queue while detached, exactly like
    ///    `run`'s accept loop never polls `outgoing_rx` between connections).
    pub async fn run(mut self);
}

/// Owns one socket. Loop `select!(biased)`: a) `ctl_rx` → Close: send `Frame::close(code, reason[..123])`,
/// `SinkExt::close`, exit `Closed`; b) `ws.next_frame()` (keeps the error text, unlike the `Stream` impl):
/// Binary → `decode_envelope_frame(payload, MAX_FRAME_BYTES)` → raise `incoming_watermark` → activity rule →
/// `incoming_tx.unbounded_send`; Text after the Hello → `ControlFrame::Heartbeat` is accepted silently (D3
/// wording; liveness only, never `touch_input`; the server never times out a socket on missing client `Heartbeat`
/// frames – b1 §7.12(f): gaps ≥ 90 s are normal for hidden tabs – liveness is the TCP/WebSocket close only), anything else → warn, ignore; Ping is answered by yawc; Close →
/// exit `PeerClosed`; Err → exit `ReadError` (payload > max_payload_read arrives here as an error →
/// `FrameTooLarge`, reply Close 1009); c) `frame_rx.recv()` → `select!(biased){ ctl_rx → handle Close and
/// exit, timeout(WRITE_TIMEOUT, ws.send(frame)) → Err(timeout) → Close 1008 "slow consumer", exit
/// SlowConsumer; Err(io) → exit WriteError }`; d) `heartbeat.tick()` (`tokio::time::interval(HEARTBEAT_INTERVAL)`,
/// `MissedTickBehavior::Delay`) → `ws.send(Frame::text(serde_json::to_string(&ControlFrame::Heartbeat)))` under the
/// same WRITE_TIMEOUT/ctl preemption as c) – this is the frame that keeps a hidden browser tab's activity channel
/// fed (b1 §7.8). Sends `first_frame` (the HelloAck) before anything else. `Log` frames arrive through `frame_tx`
/// like envelopes (§3.9 log sink), so they respect the same ordering and the same bounded queue.
async fn run_session(ws, first_frame: Frame, frame_rx, ctl_rx, incoming_tx, incoming_watermark, watermark_at_attach: u32, state) -> SessionExit;

/// True for envelopes that count as user input for the idle clock.
/// Excludes heartbeat/handshake traffic, responses to server-initiated requests, the client-state
/// autosave (b4 §3.15 item 6: a dirty tab's 15 s `SaveClientState` must not keep the workspace
/// "active" forever), the extensions listing, and terminal flow-control/reattach traffic (b3 §7.1(a),
/// D20: a `tail -f` or a long build would otherwise keep the workspace active through the client's acks).
/// Input-bearing terminal messages (`SpawnTerminal`, `TerminalInput`, `CloseTerminal`) stay input.
/// Landing order: the arms name b3/b4 payload variants; whichever of b2/b3/b4 lands last adds the
/// arms it introduces (each is a one-line change) – the test below names all of them.
pub fn is_input_envelope(envelope: &rpc::proto::Envelope) -> bool {
    use rpc::proto::envelope::Payload;
    envelope.responding_to.is_none()
        && !matches!(
            envelope.payload,
            Some(Payload::Ping(_)) | Some(Payload::Ack(_))
            | Some(Payload::RemoteStarted(_)) | Some(Payload::FlushBufferedMessages(_))
            // b4 (D20)
            | Some(Payload::SaveClientState(_)) | Some(Payload::LoadClientState(_)) | Some(Payload::ListExtensions(_))
            // b3 (D20)
            | Some(Payload::AckTerminalOutput(_)) | Some(Payload::ResizeTerminal(_))
            | Some(Payload::ListTerminals(_)) | Some(Payload::AttachTerminal(_))
        )
}
```

Per-connection task (spawned by the router at (g) in §3.8, before the broker sees anything): `let ws = timeout(UPGRADE_TIMEOUT, upgrade_fut).await??;` → read the first frame with `HELLO_TIMEOUT`; it must be `OpCode::Text` parsing as `ControlFrame::Hello` with `protocol == PROTOCOL_VERSION`, else `Close(CLOSE_BAD_HELLO)` and return. `hello.session_id != claims.sid` → **log at warn and continue** (D1: `session_id` is informational; the JWT `sid` is what `SessionMeta`/`HelloAck` carry – the earlier 4003 close is gone). If `--client-build` is set and `!builds_compatible(&hello.build, expected)` → `Close(CLOSE_BUILD_MISMATCH, "expected build <id>")`. Then `broker_tx.send(Attach{ws, hello, claims})`. All of this is off the broker.

Attach algorithm (in `run`; the arbitration table of b1 §4.4, D3 and D20):

1. **Classify** before touching anything:
   - `hello.reconnect && hello.epoch.is_some() && hello.epoch == current_epoch` → `Reconnect` (the server still holds the `ChannelClient` replay state of this epoch: it is only discarded by a Fresh attach, which bumps `current_epoch`).
   - `hello.reconnect && hello.epoch.is_some() && current_epoch.is_some() && hello.epoch != current_epoch` → **stale epoch**: close the new socket with `CLOSE_TAKEN_OVER` "stale epoch" and return (b1 §4.4 and the `Hello.epoch` doc: a client whose socket died before another client took over must not steal the session back; b1 §6.3 test 8). A stale client re-opens with `reconnect:false`, which is the fresh path – so D3's "or stale epoch → fresh session" holds in effect (§7.19).
   - `hello.reconnect && (hello.epoch.is_none() || current_epoch.is_none())` (server restarted, nothing to resume; or the client sent `epoch: None`) → `Fresh` reported through `HelloAck.resumed == false`, which b1 maps to exit 90 and a fresh re-open (b1 §3.3 step 3).
   - `!hello.reconnect` → `Fresh` (D3: page reload, takeover, "open in desktop").
2. If `current.is_some()`: `Reconnect` → the old socket is half-open or its FIN has not been seen yet (laptop sleep, network change, the socket `RemoteClient::reconnect` just dropped): send `SessionCtl::Close{CLOSE_SUPERSEDED (1001), "superseded by reconnect"}`, await `done` ≤ `DETACH_TIMEOUT` (abort on timeout), run step 7 for it, log `session_superseded` – a reconnect is **never** refused with 4005 (b1 §4.4). `Fresh` with `hello.takeover` → `SessionCtl::Close{CLOSE_TAKEN_OVER, "taken over by another session"}`, same await, log `session_replaced`. `Fresh` without `takeover` → close the **new** socket with `CLOSE_SESSION_BUSY` (b1's 4005) "session active" and return; the attached client is untouched. The broker is the single decision point, so there is no window in which two sockets pass a pre-upgrade check; the same-`identifier` replacement rule of the previous revision is gone (b1 always sets `reconnect:true` on a redial, so the epoch rule covers that case).
3. `Fresh`: `let ends = hooks.begin_fresh_session().await; self.incoming_tx = ends.incoming_tx; self.outgoing_rx = ends.outgoing_rx;` (old ends dropped with everything queued on them – the stale `UpdateProject`/`LanguageServerRemoved` envelopes the reset emitted, and whatever the previous client never read); `attach_seq += 1; epoch = epoch_base | attach_seq; current_epoch = Some(epoch)`; `incoming_watermark = 0`. `Reconnect`: touch nothing – the queued envelopes and the server `buffer` are precisely what `FlushBufferedMessages` replays; `epoch` stays; `incoming_watermark` carries over (`last_watermark`).
4. Build `HelloAck { protocol: 1, build: state.build, os: consts::OS, arch: consts::ARCH, os_version, shell, resumed: kind == Reconnect, session_id: claims.sid, epoch }`, spawn `run_session(ws, Frame::text(json), ..)`, set `current`, `state.set_session(Some(meta))`, `hooks.session_attached(&meta)` (Fresh → b4's `on_session_attached` on the gpui side, after `RemoteStarted` was queued in step 3), log `session_attached` (with `session_id`, `identifier`, `kind`, `epoch`, `sub`; log a `sub` change versus the previous session at warn).
5. Pump (broker, branch 3): `env = outgoing_rx.next()`; **stale-response rule** (always on): drop any envelope whose `responding_to >= incoming_watermark` – a response to a request this epoch has not sent, i.e. a handler that was still running for the previous client (detached at 1824-1858); the client would otherwise route it to a colliding new id (1782-1818). The rule is safe for resumed sessions because the watermark carries over and the server can only answer ids it has received. `let bytes = encode_envelope_frame(&env)`; `bytes.len() > MAX_FRAME_BYTES` → log error, `SessionCtl::Close{1009}`, detach (the server must never emit a frame the browser will reject with 1009); else `select!(biased){ cmd = commands.recv() => { stashed = Some(cmd) /* the preempted envelope is dropped; the ChannelClient replay buffer covers it on reconnect */ }, r = current.frame_tx.send(Frame::binary(bytes)) => { Err → detach } }`.
6. Incoming (session task): after decode, `incoming_watermark.fetch_max(env.id + 1)`; `if is_input_envelope(&env) && env.id >= watermark_at_attach { state.touch_input() }` – on `Reconnect` the replayed envelopes (ids below the watermark at attach, i.e. already received under this epoch) do not reset the idle clock. Then `incoming_tx.unbounded_send(env)`.
7. Session exit (branch 2, or after step 2 replaced a socket): `state.set_session(None)`, `last_watermark = incoming_watermark`, `hooks.session_detached(&meta)` (→ `PtyManager::detach_all()` on the gpui side, D3/D20 – terminals keep running into their rings and are re-attached by the next client's `ListTerminals`/`AttachTerminal`, D4), log `session_detached{reason}`; the gpui side is otherwise unaffected (no channel is closed).
8. `CloseSession{code, reason}` (no session → no-op): `flush_then_close(code, reason)`: forward queued envelopes until `outgoing_rx.try_next()` is empty, sleep `CLOSE_GRACE`, forward again until empty (the `Ack` for the `ShutdownRemoteServer` request that triggered this command is produced in the same gpui tick as the command and must go out **before** the Close – without the grace the broker, which prioritises commands, would close first), all bounded by `SHUTDOWN_FLUSH_TIMEOUT`; then `SessionCtl::Close{code, reason}`, await `done` ≤ `DETACH_TIMEOUT`.
9. `Shutdown{done}`: `flush_then_close(CLOSE_SERVER_STOPPING, "server shutting down")` if attached; `hooks.request_quit()`; `done.send(())`; return. With no session attached this completes immediately (SIGTERM on an idle server exits promptly). `CLOSE_SERVER_STOPPING` (4004) stays the SIGTERM code: b1 maps it to exit 90 ("control plane resumes on next user action"); D3's "1001 server going away" is the RFC name of the supersede code used in step 2 (§7.19).

What persists across sessions (precisely): the process; the `App`; the server `ChannelClient` (its `next_message_id`, `message_handlers`, and – for `Reconnect` only – `buffer`, `max_received`, `response_channels`, `stream_response_channels`); the `HeadlessProject` entity and every store entity (never recreated: `subscribe_to_entity` panics on re-registration, proto_client.rs:626-635); **b3's server-level `PtyManager` and every terminal it holds (D3; `detach_all` on detach, `kill_all` only on quit or `CloseTerminal`)**; the node runtime, extension host and download caches; telemetry forwarding; the crash handler; `ServeState` (`last_input_at`, uptime); REPL `kernels`; b4's `ClientStateStore`, `ControlChannel` (its `last_ports`, `pending_resumed`) and `PortForwarder`. **For `Fresh`** the broker discards the old channel pair and, through the hook, the project drops every worktree – which (via `WorktreeRemoved`) also stops every language server seeded by them, prettier, git repositories, local settings and manifest roots (`lsp_store.rs:4871,3835-3878`; `git_store.rs:2487`; `project_settings.rs:1152`; `manifest_tree.rs:199`) – and resets the user settings the previous client pushed (D3 "settings observer restart", §3.10). A fresh session is therefore a warm *process* with cold worktrees, cold language servers and default settings until the new client pushes its own; only the binary, extension host, node runtime, caches and terminals are warm. This is what D3 decides and what BUILD-SPEC §4.2 is amended to say (§7.1).

### 3.8 `crates/remote_server/src/serve/http.rs` (new)

```rust
pub type BoxBody = http_body_util::combinators::BoxBody<bytes::Bytes, std::io::Error>;

pub const VERIFY_CONCURRENCY: usize = 4;
pub const AUTH_FAILURE_DELAY: Duration = Duration::from_millis(250);
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_HEADER_BUF: usize = 64 * 1024;

pub const MAX_CONTROL_BODY_BYTES: usize = 1024 * 1024;   // `/control/*` request bodies (a ports list is a few KiB)

/// The seam between the loopback control listener and b4's `ControlChannel` (`crates/remote_server/src/control.rs`,
/// b4 §3.10). Mirrors `ControlChannel::handle(&self, ControlRequest<'_>) -> ControlResponse` exactly so the
/// production impl is one line (`impl ControlRoutes for control::ControlChannel`) and tests stub it.
/// The public listener never sees `/control/*` (D5, b4 §3.15 item 3).
pub trait ControlRoutes: Send + Sync + 'static {
    fn handle<'a>(&'a self, req: crate::control::ControlRequest<'a>)
        -> futures::future::BoxFuture<'a, crate::control::ControlResponse>;
}

pub struct ServeState {
    pub started_at: std::time::Instant,
    pub build: String,                       // option_env!("ZS_BUILD_ID") else VERSION
    pub version: String,                     // VERSION
    pub workspace_id: String,
    pub workspace_root: std::path::PathBuf,  // canonicalized at startup
    pub auth: crate::serve::auth::AuthConfig,
    pub allowed_origins: Vec<String>,        // exact `Origin` values (D5: `--allowed-origin`, fed from `manifest.allowedOrigins`); empty → no CORS, no Origin check
    pub broker_tx: tokio::sync::mpsc::UnboundedSender<BrokerCommand>,
    pub gpui_tx: futures::channel::mpsc::UnboundedSender<GpuiCommand>,   // `FilesUploaded`, `ResolveExtensionAsset` (§3.6)
    verify_permits: tokio::sync::Semaphore,  // VERIFY_CONCURRENCY
    auth_failures: AtomicU64,
    session: std::sync::Mutex<Option<SessionMeta>>,
    last_input_at_ms: AtomicU64,             // 0 = never
    worktrees: std::sync::Mutex<Vec<String>>, // absolute root paths, kept by the gpui side
    dirty_buffers: AtomicU32,                // kept by the gpui side (§3.10)
}
impl ServeState {
    pub fn new(args: &ServeArgs, auth: AuthConfig, workspace_root: PathBuf, broker_tx: UnboundedSender<BrokerCommand>, gpui_tx: futures::channel::mpsc::UnboundedSender<GpuiCommand>) -> Self;
    pub fn touch_input(&self);
    pub fn set_session(&self, meta: Option<SessionMeta>);
    pub fn session(&self) -> Option<SessionMeta>;
    pub fn set_worktrees(&self, roots: Vec<String>);
    pub fn set_dirty_buffers(&self, n: u32);
    pub fn health(&self, full: bool) -> HealthResponse;
    /// Acquire a verify permit, run `auth.verify`; on failure bump `auth_failures` and sleep
    /// AUTH_FAILURE_DELAY **while holding the permit** (bounds attacker throughput to
    /// VERIFY_CONCURRENCY / AUTH_FAILURE_DELAY ≈ 16 failures/s; a valid token waits at most one delay).
    /// Never rejects a token that verifies.
    pub async fn verify(&self, token: &str) -> Result<Claims, AuthError>;
}

#[derive(serde::Serialize)]
pub struct HealthResponse {
    pub build: String,
    pub version: String,
    pub uptime_secs: u64,
    pub workspace_id: String,
    pub session_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub session: Option<SessionMeta>,
    #[serde(skip_serializing_if = "Option::is_none")] pub last_input_at: Option<u64>,   // unix ms
    #[serde(skip_serializing_if = "Option::is_none")] pub worktrees: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub dirty_buffers: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub auth_failures: Option<u64>,
}

/// Accept loop over an already-bound listener (the caller binds and writes `--port-file`, §3.9):
/// `accept` → `tokio::spawn(hyper::server::conn::http1::Builder::new()
///   .timer(hyper_util::rt::TokioTimer::new())          // required, or header_read_timeout panics (http1.rs:342)
///   .header_read_timeout(HEADER_READ_TIMEOUT).max_buf_size(MAX_HEADER_BUF).keep_alive(true)
///   .serve_connection(TokioIo::new(stream), service_fn(move |req| route(state.clone(), peer, req)))
///   .with_upgrades())`. Logs `listening on <addr>` once before the loop.
pub async fn serve_http(
    listener: tokio::net::TcpListener,
    state: std::sync::Arc<ServeState>,
) -> anyhow::Result<()>;

pub async fn route(
    state: std::sync::Arc<ServeState>,
    peer: std::net::SocketAddr,
    req: hyper::Request<hyper::body::Incoming>,
) -> Result<hyper::Response<BoxBody>, std::convert::Infallible>;

/// Accept loop for the loopback control listener (D5; bound by `start_serve` on `--control-listen`, whose
/// IP must be loopback – checked at startup). Same hyper builder settings as `serve_http` minus
/// `with_upgrades`; no CORS; every connection whose peer is not loopback is answered 401 regardless of
/// the bearer (belt and braces on top of the bind address).
pub async fn serve_control(
    listener: tokio::net::TcpListener,
    state: std::sync::Arc<ServeState>,
    control: std::sync::Arc<dyn ControlRoutes>,
) -> anyhow::Result<()>;

/// `POST /control/lifecycle | /control/ports | /control/extensions` (b4 `LIFECYCLE_PATH`, `PORTS_PATH`,
/// `EXTENSIONS_PATH`) → read the body (≤ MAX_CONTROL_BODY_BYTES, else 413) → `control.handle(ControlRequest {
/// method, path, bearer: value after "Bearer ", peer_is_loopback: peer.ip().is_loopback(),
/// session_attached: state.session().is_some(), body })` → `NoContent` → 204, `BadRequest(msg)` → 400
/// `{"error":"bad_request","message":"<msg>"}`, `Unauthorized` → 401, `NotFound` → 404. Any other
/// path → 404, any other method → 405. `Cache-Control: no-store` everywhere. Request logging never
/// prints the bearer.
pub async fn route_control(
    state: std::sync::Arc<ServeState>,
    control: std::sync::Arc<dyn ControlRoutes>,
    peer: std::net::SocketAddr,
    req: hyper::Request<hyper::body::Incoming>,
) -> Result<hyper::Response<BoxBody>, std::convert::Infallible>;
```

Routes on the **public** listener (exact behavior):

- **CORS** (only when `allowed_origins` is non-empty): if the request's `Origin` matches an allowed value, every `/files`, `/extensions/*` and `/health` response carries `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`, `Access-Control-Expose-Headers: content-disposition, content-length`, and – because the shell page runs under COEP (b9 §4.9 line 1408) – `Cross-Origin-Resource-Policy: cross-origin`. `OPTIONS /files|/extensions/*|/health` → 204 with those plus `Access-Control-Allow-Methods: GET, POST`, `Access-Control-Allow-Headers: authorization, content-type`, `Access-Control-Max-Age: 600`; no auth on preflight (it carries none). `OPTIONS` on anything else → 405. An `Origin` that is present and not allowed → 403 `{"error":"origin_not_allowed"}` on `/files`, `/extensions/*` and on `/rpc` upgrades (CSWSH defense in depth; the token is the real gate). Requests without `Origin` (native clients, curl) are unaffected.
- `GET /health` → 200 `application/json`. `full = peer.ip().is_loopback() || bearer token verifies`; when `full` is false, `session`, `last_input_at`, `worktrees`, `dirty_buffers`, `auth_failures` are omitted. Never 401.
- `GET /rpc` → in order: (a) `extract_token` (header item, then `Authorization`, then `?zs_token=`) → `state.verify(token)` else `AuthError::status()` (401/403); (b) `zs.v1` must have been offered (`Sec-WebSocket-Protocol` item or `?zs_proto=zs.v1`) else 426; (c) the request must carry `Upgrade: websocket`; (d) `WebSocket::upgrade_with_options(&mut req, Options::default().with_max_payload_read(MAX_FRAME_BYTES).with_max_read_buffer(2 * MAX_FRAME_BYTES).without_compression().with_utf8().with_backpressure_boundary(256 * 1024))`; on the returned response insert `Sec-WebSocket-Protocol: zs.v1` **only if the client offered it in the header** (a browser aborts when the server names a protocol it did not offer; b1 §4.3); (e) `tokio::spawn` the per-connection task of §3.7 (upgrade with `UPGRADE_TIMEOUT`, Hello, checks, `Attach`); return the 101. There is **no** pre-upgrade "session active" rejection: browsers cannot read the status of a failed upgrade, b1 carries `takeover` inside the Hello, and the broker is the only place that knows the true session state.
- `POST /files` → token (`Authorization: Bearer` or `?zs_token=`) → `state.verify` → `files::handle_upload(state, &claims, req)`. 201 on success with `UploadResponse`.
- `GET /files` → same auth, then `files::handle_download`.
- `GET /extensions/{id}/assets/{rel}` → same auth as `/files`, then `files::handle_extension_asset(state, id, rel)` (b4 §3.15 item 4; `rel` is everything after `/assets/`, percent-decoded; an `id` or `rel` containing `..`, NUL or an absolute component is rejected 400 before the gpui round trip, and b4's `asset_path` re-validates).
- `/control/*` on this listener → **404, always** (D5: the public listener never exposes `/control`; b4 §3.15 item 3). The control routes live on the loopback listener (`serve_control` above).
- Anything else → 404; wrong method → 405. Every error body is `{"error":"<snake_case>"}`. Every response carries `Cache-Control: no-store`. Request logging uses `redact_query` so `zs_token` never reaches a log line.

Why there is no pre-verification rate limiter: a global "20 failures/min → 429 for everyone" would let anyone who can reach the public port lock the legitimate user out indefinitely with garbage tokens, which is worse than the ~100 µs an ES256 verify costs. The semaphore + failure delay in `ServeState::verify` bounds CPU and attacker throughput without ever refusing a valid token (BUILD-SPEC §10 item 2 wants the server protected, not the user gated).

### 3.9 `crates/remote_server/src/serve.rs` (new; `pub mod auth; pub mod files; pub mod http; pub mod session;` – all `pub` so the integration tests and sibling modules (`headless_project`, b3's `pty`, b4's `control`) can name these types; b4's `control.rs` itself stays HTTP-agnostic and imports nothing from `serve`)

```rust
#[derive(clap::Args, Debug, Clone)]
pub struct ServeArgs {
    /// Address to bind, e.g. 0.0.0.0:8443; port 0 picks an ephemeral port (tests).
    #[arg(long)] pub listen: std::net::SocketAddr,
    /// PEM file with one or more ES256 public keys; repeatable (two keys during rotation).
    #[arg(long = "jwt-public-key", required = true)] pub jwt_public_keys: Vec<std::path::PathBuf>,
    /// Expected `ws` claim; also stamped on every log line. (`--workspace` is the BUILD-SPEC §4.2 spelling.)
    #[arg(long, visible_alias = "workspace")] pub workspace_id: String,
    /// Expected `aud` claim (`manifest.jwt.audience`; defaults to the sandbox name, rotatable by the control plane – b8 §3.9, §2 b9 row).
    #[arg(long)] pub audience: String,
    /// Expected `iss` claim.
    #[arg(long, default_value = "zs")] pub issuer: String,
    /// Directory that bounds `/files`; must exist.
    #[arg(long)] pub workspace_root: std::path::PathBuf,
    /// If set, a Hello whose build is not `builds_compatible` with this id is closed with 4002.
    /// (`--allow-build` is the BUILD-SPEC §4.2 spelling.)
    #[arg(long, visible_alias = "allow-build")] pub client_build: Option<String>,
    /// Browser origins allowed to call /files, /extensions/* and /health cross-origin (the shell page
    /// origin; D5 – the supervisor passes `manifest.allowedOrigins`, one flag per origin); repeatable,
    /// or comma-separated in ZS_ALLOWED_ORIGINS. Empty → no CORS headers, no Origin check.
    /// (`env =` needs clap's `env` feature, which the workspace dep does not enable – see §5.)
    #[arg(long = "allowed-origin", env = "ZS_ALLOWED_ORIGINS", value_delimiter = ',')] pub allowed_origins: Vec<String>,
    /// File holding the shared secret the supervisor presents as `Authorization: Bearer` on `/control/*`
    /// (D5/D18, b4 §3.15 item 1). Read once, before anything is spawned; trailing newline stripped;
    /// must be non-empty and ≤ 4 KiB. Required: without it `serve` refuses to start (tests write a temp file).
    #[arg(long)] pub control_secret_file: std::path::PathBuf,
    /// Loopback address of the control listener (D5). Must be a loopback IP (checked); port 0 allowed (tests).
    #[arg(long, default_value = "127.0.0.1:8446")] pub control_listen: std::net::SocketAddr,
    /// Base URL of the supervisor's API for `POST /ports`, `DELETE /ports/{port}`, `POST /extensions`
    /// (b4 §3.11/§3.15 item 1; b8 reads the same value from `ZS_SUPERVISOR_URL`). See §7.16 for the port clash.
    #[arg(long, env = "ZS_SUPERVISOR_URL", default_value = crate::ports::DEFAULT_SUPERVISOR_URL)] pub supervisor_url: String,
    /// After binding, write "<ip>:<port>\n" (public listener) here (supervisor/tests).
    #[arg(long)] pub port_file: Option<std::path::PathBuf>,
    /// Also append JSON logs to this rotating file (same format as `run`).
    #[arg(long)] pub log_file: Option<std::path::PathBuf>,
}

pub fn execute_serve(args: ServeArgs) -> anyhow::Result<()>;

/// Reads `--control-secret-file`: whole file, strip one trailing `\r?\n`, reject empty or > 4096 bytes.
/// Then, if `ZS_CONTROL_SECRET` is set in the environment (an older supervisor build, b8:516), scrub it with
/// `unsafe { std::env::remove_var("ZS_CONTROL_SECRET") }` (edition 2024; precedent `crates/zed/src/main.rs:1678`;
/// safe here because it runs before any other thread exists) and log a warning – the server's environment is
/// inherited by every language server, task and PTY, so a secret left there is readable by any code the user runs
/// (b4 §3.15 item 1). The env value is never used as the secret.
fn read_control_secret(path: &std::path::Path) -> anyhow::Result<Vec<u8>>;
```

`execute_serve` mirrors `execute_run` (server.rs:560-744) step by step:

1. `let control_secret = read_control_secret(&args.control_secret_file)?` **first** (before the crash handler, the rayon pool and the login-shell task spawn anything); `anyhow::ensure!(args.control_listen.ip().is_loopback())`; `init_paths()?` (542-558); `init_logging_serve(&args)`; `AuthConfig::load(..)?`; `workspace_root.canonicalize()?`; `gpui_platform::headless()`; `init_crash_handler(&app, "zed-remote-server-serve")`; `init_rayon_pool()`; login-shell env task (623-635).
2. `app.run(move |cx| { .. })` inside the same `catch_unwind` (734-743): `settings::init`, `release_channel::init`, `gpui_tokio::init(cx)`, `HeadlessProject::init(cx)`, WSL probe (658-663); then **construction order** (each step needs the previous one): `(broker_tx, broker_rx) = tokio::sync::mpsc::unbounded_channel()`; `(gpui_tx, gpui_rx) = futures::channel::mpsc::unbounded()` → `state = Arc::new(ServeState::new(&args, auth, root, broker_tx.clone(), gpui_tx.clone()))` → `(session, server_channel, control_listener) = start_serve(&args, state.clone(), broker_rx, gpui_tx.clone(), cx)` (binds **both** listeners inside `Tokio::handle(cx).enter()`, writes `--port-file`, prints the two stdout lines, spawns `serve_http`, the broker and `signal_task`; the control listener is only bound here and served in a later step because its handler needs the project) → `init_telemetry_forwarding`, `trusted_worktrees::init`, git/dap/extension/json-schema init (668-677) → `project = build_headless_project(session.clone(), shell_env_loaded_rx, startup_time, cx)` → `on_shutdown = Arc::new({ let tx = broker_tx.clone(); move || { tx.send(BrokerCommand::CloseSession{ code: 1000, reason: "client requested shutdown" }).ok(); } })`; `project.update(cx, |p, _| p.set_shutdown_request_handler(on_shutdown))` (§3.10) → **b3's `PtyManager`** (D3: server level): `pty_manager = Arc::new(pty::PtyManager::new(REMOTE_SERVER_PROJECT_ID, Arc::new(session.clone()), cx))` and hand the project its handle through the accessor b3 defines for the moved manager (§7.17; b3 §3.9 currently constructs it inside `HeadlessProject::new`, which D3 changes) → **b4's sandbox switch**: `supervisor_http = Arc::new(ReqwestClient::new())` (proxy-less, b4 §7.9), `registry = RegistryConfig { http: Arc::new(HttpClientWithUrl::new(http_client.clone(), std::env::var("ZED_SERVER_URL").unwrap_or("https://zed.dev".into()), None)), release_channel: *RELEASE_CHANNEL }`, `control = project.update(cx, |p, cx| p.enable_sandbox(SandboxConfig { control_secret, supervisor_url: args.supervisor_url.clone(), supervisor_http, registry, client_state_dir: paths::remote_server_state_dir().join("client_state") }, cx))` → `Tokio::spawn(cx, http::serve_control(control_listener, state.clone(), control as Arc<dyn ControlRoutes>)).detach()` → `handle_crash_files_requests` → subscribe `project.read(cx).worktree_store` for `WorktreeStoreEvent` → `state.set_worktrees(..)`; subscribe `buffer_store` for `BufferStoreEvent::BufferAdded` and observe each buffer → `state.set_dirty_buffers(count of is_dirty())` (`buffer.rs:2494`) → `spawn_gpui_command_loop(project.clone(), server_channel, pty_manager, gpui_rx, cx)` → `files::sweep_temp_files(&root)` on the tokio runtime → `mem::forget(project)` (as 731).

```rust
/// Serve analogue of `start_server` (server.rs:403-540). Creates the two envelope channels and the
/// `ServerChannel`; binds `args.listen` (port 0 allowed) and `args.control_listen` (port 0 allowed),
/// writes `--port-file` (public address), prints `ZS_LISTENING=<public addr>\n` and
/// `ZS_CONTROL_LISTENING=<control addr>\n` on stdout (b1 §6.3 preconditions; flushed), logs
/// `listening on <addr>`; spawns `serve_http`, `SessionBroker::run` (with `broker_rx` and a
/// `GpuiHooks`) and `signal_task` on the gpui_tokio runtime; returns the bound control listener
/// for `serve_control`. No idle timeout.
fn start_serve(
    args: &ServeArgs,
    state: Arc<ServeState>,
    broker_rx: tokio::sync::mpsc::UnboundedReceiver<BrokerCommand>,
    gpui_tx: futures::channel::mpsc::UnboundedSender<GpuiCommand>,
    cx: &mut gpui::App,
) -> (rpc::AnyProtoClient, remote::ServerChannel, tokio::net::TcpListener);

/// Commands the tokio side sends to the gpui foreground task.
pub enum GpuiCommand {
    /// Broker, Fresh attach (§3.7 step 3).
    ResetForFreshSession { done: futures::channel::oneshot::Sender<remote::ChannelEnds> },
    /// Broker, after every attach (§3.7 step 4; b4 §3.15 item 5).
    SessionAttached { kind: SessionKind },
    /// Broker, after every session-task exit (§3.7 step 7; D3/D20).
    SessionDetached,
    /// `files::handle_upload`, after its renames (b4 §3.15 item 5). Absolute paths under the workspace root.
    FilesUploaded(Vec<std::path::PathBuf>),
    /// `files::handle_extension_asset` (b4 §3.15 item 4).
    ResolveExtensionAsset { id: String, rel: String, reply: futures::channel::oneshot::Sender<Option<std::path::PathBuf>> },
    Quit,
}

/// gpui-side loop (a `cx.spawn(async move |cx| ..)` so it holds an `AsyncApp` for `reconnect`):
/// `ResetForFreshSession` → `project.update(cx, |p, cx| p.reset_for_new_client(cx))` then
/// `let ends = server_channel.begin_fresh_session(cx)` then `done.send(ends)` (the PtyManager is not touched);
/// `SessionAttached { kind: Fresh }` → `project.update(cx, |p, cx| p.on_session_attached(cx))` (b4 §3.14);
/// `SessionAttached { kind: Reconnect }` → nothing (queue and replay buffer were kept);
/// `SessionDetached` → `pty_manager.detach_all()` (b3 §3.8; D3/D20);
/// `FilesUploaded(paths)` → `HeadlessProject::notify_files_uploaded(project.downgrade(), paths, cx).detach_and_log_err(cx)` (b4 §3.14);
/// `ResolveExtensionAsset { id, rel, reply }` → `reply.send(project.read_with(cx, |p, cx| p.extensions.read(cx).asset_path(&id, &rel)))`;
/// `Quit` → `pty_manager.kill_all()` (D3: kill only on process shutdown; idempotent with b3's `on_app_quit`,
/// but called here so the SIGTERM→SIGKILL escalation is not squeezed into gpui's 200 ms `SHUTDOWN_TIMEOUT`),
/// then `cx.update(|cx| { cx.shutdown(); cx.quit(); })` (same hack as server.rs:445-450 and
/// headless_project.rs:1215-1218; on Linux `quit` stops the calloop and `Application::run` returns,
/// gpui_linux platform.rs:280-282).
fn spawn_gpui_command_loop(
    project: gpui::Entity<crate::HeadlessProject>,
    server_channel: remote::ServerChannel,
    pty_manager: Arc<crate::pty::PtyManager>,
    rx: futures::channel::mpsc::UnboundedReceiver<GpuiCommand>,
    cx: &mut gpui::App,
);

/// `ServeHooks` impl: `begin_fresh_session` sends `ResetForFreshSession` and awaits `done`;
/// `session_attached` sends `SessionAttached { kind }`; `session_detached` sends `SessionDetached`;
/// `request_quit` sends `Quit`.
struct GpuiHooks { tx: futures::channel::mpsc::UnboundedSender<GpuiCommand> }

/// tokio side. Unix: `tokio::signal::unix::signal(SignalKind::terminate())` and `interrupt()`;
/// Windows (the crate is built and clippy'd there, Cargo.toml:78-80, script/clippy.ps1:28):
/// `tokio::signal::ctrl_c()`. On either, send `BrokerCommand::Shutdown` and await `done`.
#[cfg(unix)] async fn signal_task(broker_tx: UnboundedSender<BrokerCommand>);
#[cfg(windows)] async fn signal_task(broker_tx: UnboundedSender<BrokerCommand>);

#[derive(serde::Serialize)]
pub struct ServeLogRecord<'a> {
    pub ts_ms: u64,
    #[serde(flatten)] pub record: remote::json_log::LogRecord<'a>,
    pub ws: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")] pub session_id: Option<String>,   // JWT `sid` of the attached session (D1: informational)
    #[serde(skip_serializing_if = "Option::is_none")] pub epoch: Option<u64>,
    pub mode: &'static str,          // "serve"
}

/// env_logger → `Target::Stderr` (plus optional `RotatingLogFile` tee when `--log-file`), Info
/// default with `parse_default_env()`, one `ServeLogRecord` per line, and the panic hook from
/// server.rs:273-288. `session_id`/`epoch` are read from `CURRENT_SESSION: RwLock<Option<(String, u64)>>`,
/// which `ServeState::set_session` updates. **`Log` frames** (b1 §4.2/§7.12): the same formatter also
/// mirrors every record with `level <= LOG_FRAME_MAX_LEVEL` (warn, error) as
/// `Frame::text(ControlFrame::Log(LogFrame { level, module_path, file, line, message }))` into
/// `CURRENT_LOG_FRAME_TX: Mutex<Option<tokio::sync::mpsc::Sender<Frame>>>` (the attached session's
/// `frame_tx`, set/cleared by the broker in §3.7 steps 4/7) using `try_send` – a full queue or no
/// session drops the frame, and nothing in this path logs (no recursion). stderr stays the primary sink
/// (BUILD-SPEC §12); the frames are a convenience for the browser console.
fn init_logging_serve(args: &ServeArgs) -> anyhow::Result<()>;
```

Startup log line, emitted by `start_serve` right after the bind: `{"ts_ms":1725000000000,"level":3,"message":"listening on 127.0.0.1:8443","ws":"ws_test","mode":"serve"}` (the address is also in `--port-file` and on stdout as `ZS_LISTENING=127.0.0.1:8443`; the control address as `ZS_CONTROL_LISTENING=127.0.0.1:8446`).

`HelloAck.shell`: `$SHELL` of the server process, else `/bin/sh` (Windows: `%COMSPEC%`); `transport.rs:43` `parse_shell` is private, so this is a one-line reimplementation. `HelloAck.os_version`: `util::parse_os_release(&std::fs::read_to_string("/etc/os-release")?)` (`crates/util/src/util.rs:76`, public; `transport.rs:5` `parse_os_version` is `pub(crate)`), `None` on any error. `HelloAck.epoch`: §3.7 step 3/4. `HelloAck.session_id`: the JWT `sid`.

### 3.10 `crates/remote_server/src/headless_project.rs`

- `HeadlessAppState` (76-84) is **not** changed (25 construction sites, §2). `HeadlessProject` (52-74) gains `shutdown_request_handler: Option<Arc<dyn Fn() + Send + Sync>>`, set to `None` in the struct literal (342-362), plus
  ```rust
  /// Serve mode: called instead of quitting the process when a client sends `ShutdownRemoteServer`.
  pub fn set_shutdown_request_handler(&mut self, handler: Arc<dyn Fn() + Send + Sync>) { self.shutdown_request_handler = Some(handler); }
  ```
  `run` never calls it, so the headless project stays transport-agnostic (no `serve` global, no `crate::serve` import here). This follows `handle_crash_files_requests` (server.rs:334-385) and b4's `enable_sandbox` (b4 §3.14) rather than a constructor change.
- Line 1205-1221 `handle_shutdown_remote_server`: before the `cx.spawn`, add
  ```rust
  if let Some(on_shutdown) = this.read_with(&cx, |p, _| p.shutdown_request_handler.clone())? {
      on_shutdown();           // serve: broker flushes the Ack below, then closes the session
      return Ok(proto::Ack {});
  }
  ```
  (`_this` becomes `this`; `Entity::read_with(&self, &AsyncApp, f)` is the existing accessor used throughout this file.)
- New method after `handle_remove_worktree` (568-580):
  ```rust
  /// Serve mode, fresh session (D3): forget the previous client's buffers, drop every worktree so a
  /// client that has no state re-adds its roots without duplicating scanners (see
  /// handle_add_worktree, which never dedupes), and reset the user settings the previous client
  /// pushed. Never touches b3's PtyManager (D3: terminals survive; the client re-attaches them, D4),
  /// `kernels`, or any store entity's identity (re-subscribing panics, proto_client.rs:626-635).
  /// Returns the number of dirty buffers discarded.
  pub fn reset_for_new_client(&mut self, cx: &mut Context<Self>) -> usize {
      let dirty = self.buffer_store.read(cx).buffers().filter(|b| b.read(cx).is_dirty()).count();
      // BufferStore keeps strong `Entity<Buffer>` refs in `shared_buffers` (buffer_store.rs:59) and
      // never reacts to WorktreeRemoved (only WorktreeAdded, :843); without this the buffers, their
      // `File.worktree` entities and the worktrees' background scanners (worktree.rs:3796,140) leak.
      self.buffer_store.update(cx, |store, _| store.forget_shared_buffers());
      let ids: Vec<WorktreeId> = self.worktree_store.read(cx).worktrees().map(|w| w.read(cx).id()).collect();
      self.worktree_store.update(cx, |store, cx| for id in ids { store.remove_worktree(id, cx) });
      // D3 "settings observer restart": local settings of the removed worktrees were cleared by the
      // observer's WorktreeRemoved arm (project_settings.rs:1152); user settings live in the global
      // store (`handle_update_user_settings`, :1123-1136) and are reset to defaults here so the next
      // client starts clean until its own UpdateUserSettings (sent by its observer, :991) arrives.
      // The observer entity itself is kept (it is subscribed under REMOTE_SERVER_PROJECT_ID, :287).
      cx.update_global(|store: &mut SettingsStore, cx| { let _ = store.set_user_settings("{}", cx); });
      if dirty > 0 { log::warn!("fresh session discarded {dirty} dirty buffer(s) of the previous client"); }
      dirty
  }
  ```
  Unsaved edits of the previous client are unrecoverable at this point by design: the new client opens files from disk. The control plane's take-over dialog can warn using `/health.dirty_buffers` (full body) before the user confirms. D6 covers the *stop* path on the client side (dirty text goes into the client-state image on `STOPPING`), not reloads or takeovers (§7.2).

### 3.11 `crates/remote_server/src/server.rs`

- Line 1-9: add `#[cfg(feature = "serve")] pub mod serve;` and `#[cfg(feature = "serve")] pub use serve::ServeArgs;`.
- Line 62-83: add `#[cfg(feature = "serve")] Serve(serve::ServeArgs),` to `Commands` (a tuple variant holding a `clap::Args` struct is accepted by `Subcommand` derive).
- Line 85-127: add `#[cfg(feature = "serve")] Commands::Serve(args) => serve::execute_serve(args).context("running serve on the remote server"),`.
- Lines 573-599 → extract `fn init_crash_handler(app: &gpui::Application, binary: &'static str) -> Option<gpui::Task<Arc<crashes::Client>>>` (body unchanged except `binary`; `crashes::init` returns `impl Future<Output = Arc<Client>>`, crashes.rs:48-53; `execute_run` passes `"zed-remote-server"` and line 641 `let _crash_handler = crash_handler.await;` is unchanged).
- Lines 616-621 → extract `fn init_rayon_pool()`.
- Lines 679-721 → extract
  ```rust
  fn build_headless_project(
      session: AnyProtoClient,
      shell_env_loaded_rx: Option<oneshot::Receiver<()>>,
      startup_time: Instant,
      cx: &mut App,
  ) -> Entity<HeadlessProject>
  ```
  with the body of the `cx.new(|cx| { .. })` block moved verbatim **plus** `let extension_host_proxy = ExtensionHostProxy::global(cx);` at its top (the original captures that local from line 675); the `HeadlessAppState` literal is unchanged (no new field, §3.10); the `#[cfg(windows)] shell_env_loaded_rx = None` branch stays inside. `execute_run` calls it exactly as before. `init_worktree_trust` stays `true` for both modes. The extraction is move-only; §3.14's `tests/run.rs` guards it. Serve's extra wiring (`set_shutdown_request_handler`, the `PtyManager` handle, `enable_sandbox`) happens after the call in `execute_serve` (§3.9).
- `start_server` (403-540) and `IDLE_TIMEOUT` are untouched; serve does not call them.
- Line 1: b3 adds `pub mod pty;` (b3 §3.9: public so `remote_editing_tests.rs` can name `PtyManager`) and b4 `pub mod client_state; pub mod control; pub mod ports;` (their briefs); serve's `use crate::{control, pty}` paths assume those names.

### 3.12 `crates/remote_server/src/main.rs`

Line 59: `b"usage: remote <run|proxy|serve|version>\n"`.

### 3.13 `crates/remote_server/build.rs`

After line 33: `println!("cargo:rerun-if-env-changed=ZS_BUILD_ID"); if let Ok(id) = std::env::var("ZS_BUILD_ID") { println!("cargo:rustc-env=ZS_BUILD_ID={id}"); }` – without the rerun line a cached build keeps a stale id and `--client-build` rejects a correct client. (b1's `wire.rs` reads `option_env!("ZS_BUILD_ID")` in `crates/remote`, which needs the same treatment there; noted in §7.)

### 3.14 Tests (new files)

- `crates/remote_server/tests/serve.rs` – integration test spawning the binary (`env!("CARGO_BIN_EXE_remote_server")`).
- `crates/remote_server/tests/run.rs` – smoke test for the untouched `run` path after the §3.11 extraction: spawn `remote_server run` with temp `--pid-file/--stdin-socket/--stdout-socket/--stderr-socket`, connect the three Unix sockets, expect `RemoteStarted` via `read_message`, send `Ping`, expect `Ack`, send `ShutdownRemoteServer`, expect exit 0. Same env-var gate as `serve.rs`.
- `crates/remote_server/tests/fixtures/es256_private.pem`, `es256_public.pem`, `es256_other_public.pem` – committed P-256 test keys (generate once with `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt` and `openssl ec -pubout`). b9's tests read the same files when present.
- `crates/remote_server/tests/fixtures/control_secret` – a committed 32-byte test secret (`--control-secret-file` is required, §3.9); b1's and b8's serve-spawning tests can point at the same file.
- Unit tests inline in `serve/auth.rs`, `serve/files.rs`, `serve/session.rs`, `serve/http.rs` (see §6).

## 4. New types and messages (full definitions)

Wire (WebSocket) contract for `GET /rpc` – the server half of b1 §4.2-4.4; the types are b1's:

```
Request:  GET /rpc HTTP/1.1                       (?zs_proto=zs.v1&zs_token=<jwt> is accepted but unused: no client sends it, b1 §4.3)
          Upgrade: websocket
          Sec-WebSocket-Version: 13
          Sec-WebSocket-Key: <key>
          Sec-WebSocket-Protocol: zs.v1, <jwt>      (both targets; the query form is for /files downloads only)
          Origin: <shell page origin>               (browsers; must be in --allowed-origin when that list is set)
Response: 101 Switching Protocols
          Sec-WebSocket-Protocol: zs.v1             (echoed only when offered in the header)
Then:     C→S text  {"type":"hello","protocol":1,"build":"<client build>","session_id":"<sid>","identifier":"<client instance>","reconnect":false,"takeover":false,"client":"web","epoch":null}
          S→C text  {"type":"hello_ack","protocol":1,"build":"..","os":"linux","arch":"x86_64","os_version":"..","shell":"/bin/bash","resumed":false,"session_id":"<sid>","epoch":<u64>}
          S→C binary Envelope{id:0, payload: RemoteStarted}           (resumed == false only; a resumed session gets nothing until FlushBufferedMessages)
          C→S binary Envelope{id:0, payload: RemoteStarted}           (client's own handshake; server answers Ack{responding_to:0})
          ... one Envelope per binary frame, `u32 LE length || prost bytes` (encode_envelope_frame), frame ≤ 16 MiB ...
          S→C text  {"type":"heartbeat"}                              every 5 s while attached (activity only; hidden tabs)
          S→C text  {"type":"log","level":..,"module_path":..,"file":..,"line":..,"message":".."}   warn/error records, best effort
          C→S text  {"type":"heartbeat"}                              accepted, ignored (never input)
Reconnect: C→S text  {"type":"hello",...,"reconnect":true,"epoch":<epoch from the last hello_ack>}
          S→C text  {"type":"hello_ack",...,"resumed":true,"epoch":<same epoch>}  then the client's FlushBufferedMessages / Ack replay
Close codes: 1000 client-requested shutdown (after ShutdownRemoteServer's Ack) · 1001 superseded (a reconnect of the same epoch replaced this half-open socket; reconnectable) ·
             1008 slow consumer (no frame accepted for 30 s) · 1009 frame over 16 MiB (either direction) ·
             4001 taken over (Hello.takeover from another client) or stale epoch (reconnect with an epoch that is not the current one) ·
             4002 build mismatch · 4004 server stopping (SIGTERM) ·
             4005 session busy (CLOSE_SESSION_BUSY: another client attached, Hello.reconnect == false, Hello.takeover == false) · 4006 bad/missing Hello
HTTP rejections before upgrade: 401 (missing/malformed/expired/bad signature/alg) · 403 (aud/iss/ws, disallowed Origin)
             · 426 zs.v1 not offered. No 409 and no 429 (see §3.8). Nothing about the session is decided pre-upgrade.
```

Semantics the client half (b1) and the shell page are built against (D1, D3, D20; b1 §4.4):

- **Epoch.** Every `HelloAck` carries `epoch: u64`, opaque, strictly increasing within a server process and never repeated across restarts (`(start unix ms << 16) | attach counter`). A Fresh attach gets a new epoch; a Reconnect keeps it. The client echoes the last epoch in `Hello.epoch` when `reconnect == true` and sends `null` otherwise.
- `resumed == true` iff `Hello.reconnect` and `Hello.epoch` equals the epoch of the last attach in this process – the server then still holds that epoch's `ChannelClient` replay state and replays through `FlushBufferedMessages`/`Ack`. `resumed == false` after a `reconnect:true` Hello means the server restarted (no epoch was ever issued by this process) and cannot replay: the client must discard its `ChannelClient` state and re-open the project – the `run`-mode equivalent is exit 90 / `State::ServerNotRunning` (server.rs:881-890, remote_client.rs:888-895). A `reconnect:true` with an epoch that is not the current one is closed with 4001 (the session moved on without this client). A client closed with 4001, 4002, 4004 or 4005 must not auto-reconnect (4005: show the take-over UI; the control plane's `/connect` already knows a session is open); 1001 is reconnectable but the client that receives it is, by construction, the dead half of a socket the same client already replaced.
- A reconnect (matching epoch) always supersedes a still-attached socket of that epoch (1001) and is never refused with 4005. A `reconnect:false` Hello while another client is attached needs `takeover: true` (the attached client gets 4001); without it the newcomer gets 4005. `Hello.identifier` is for logs only.
- **Fresh = cold project, warm process** (D3): a `reconnect:false` attach resets the `HeadlessProject` (worktrees, language servers, git, local settings, user settings) before `RemoteStarted`; the client re-adds its roots and re-pushes its settings. Terminals survive (D3): the new client lists and re-attaches them (`ListTerminals`, `AttachTerminal { from_offset: 0 }`, D4); the server called `PtyManager::detach_all` when the previous session left, never `kill_all`.
- `session_id` (JWT `sid` == `HelloAck.session_id`) is minted per connect by the control plane and informational (D1): it appears in `SessionMeta`, logs and `/health`; a `Hello.session_id` that differs from the token's `sid` is logged, not rejected. The stable identity the client persists under is its `workspace_id` (D1), which the server sees as the JWT `ws` claim (`--workspace-id`).
- The JWT is verified at upgrade time only; an attached session outlives `exp` (BUILD-SPEC §4.3: revocation is stopping the sandbox). `/files`, `/extensions/*` and the full `/health` body verify per request, so the client must refresh the token (b1's refresh callback / b9 `/connect`, which is idempotent) before those calls once `exp` is near.
- Browser constraints: close reasons are truncated to 123 bytes; `<a download>` cannot set headers, so `GET /files?path=..&zs_token=<jwt>` is a supported form, not a fallback (b9 §7.5 notes the token then appears in edge access logs); the page reads `Content-Disposition` only because `Access-Control-Expose-Headers` lists it; `permessage-deflate` is never offered; the server `Heartbeat` text frame is what keeps a hidden tab's activity channel fed (b1 §7.8).
- Server-side activity: `is_input_envelope` (excludes Ping/Ack/RemoteStarted/FlushBufferedMessages, SaveClientState/LoadClientState/ListExtensions, AckTerminalOutput/ResizeTerminal/ListTerminals/AttachTerminal, client `Heartbeat` text frames and every response), plus replayed envelopes after a resume, plus `/files` uploads. `/health.last_input_at` is what b8's activity ping reports as `lastInputAt` (D13; `busy`/`phase`/`cpuBusyPct` are the supervisor's own).

Control-listener contract (`127.0.0.1:8446` by default, D5/D18; b4 §3.10/§4.2 own the bodies):

```
POST http://127.0.0.1:8446/control/lifecycle    Authorization: Bearer <secret from --control-secret-file>
     {"kind":"idle_stop_in","seconds":300} | {"kind":"session_cap_in","seconds":1800} | {"kind":"stopping"} | {"kind":"resumed"}   → 204
     (`stopping` returns only after the client's SaveClientState landed or STOPPING_FLUSH_TIMEOUT = 5 s elapsed; 204 at once with no session)
POST http://127.0.0.1:8446/control/ports        {"ports":[{"port":3000,"pid":4242,"process_name":"node"}],"forwards":[{"port":3000,"visibility":"private","label":"web","url":"https://…"}]} → 204
POST http://127.0.0.1:8446/control/extensions   {"install":["toml","html"]} → 204 (async install; results arrive as ExtensionsChanged)
Errors: 401 wrong/missing bearer or non-loopback peer · 400 {"error":"bad_request","message":..} · 404 unknown path · 405 · 413 body > 1 MiB
Never reachable on the public listener (404 there).
Startup: stdout `ZS_LISTENING=<ip>:<port>` and `ZS_CONTROL_LISTENING=127.0.0.1:<port>`; `--port-file` holds the public address.
```

JWT claims (`Claims`, §3.5): `{ iss, sub, ws, sid, aud, iat, exp, jti }`, header `{ alg: "ES256", typ: "JWT", kid?: string }`. `kid` is ignored for selection (all loaded keys are tried); it may be used later for a fast path. `ws` is the workspace id (D1's stable identity; checked against `--workspace-id`); `sid` is the per-connect session id (D1; not a resume key); `aud` is the workspace audience b9 mints; `identifier` (Hello) is logged only.

Rust types introduced (all defined in §3): `ServerChannel`, `ChannelEnds` (remote); `ServeArgs`, `GpuiCommand { ResetForFreshSession, SessionAttached, SessionDetached, FilesUploaded, ResolveExtensionAsset, Quit }`, `GpuiHooks`, `ServeLogRecord`, `read_control_secret` (serve.rs); `Claims`, `AuthConfig`, `AuthError`, `TOKEN_QUERY_PARAM`, `PROTOCOL_QUERY_PARAM` (auth.rs); `FilesError`, `UploadResponse`, `ChannelWriter`, `handle_extension_asset` (files.rs); `SessionKind`, `SessionMeta`, `BrokerCommand`, `ServeHooks`, `SessionBroker`, `SessionExit`, `CLOSE_SUPERSEDED`, `CLOSE_BAD_HELLO`, `HEARTBEAT_INTERVAL`, `LOG_FRAME_MAX_LEVEL`, `is_input_envelope` (session.rs); `ServeState`, `ControlRoutes`, `HealthResponse`, `BoxBody`, `serve_http`, `route`, `serve_control`, `route_control`, `MAX_CONTROL_BODY_BYTES` (http.rs); `HeadlessProject::{set_shutdown_request_handler, reset_for_new_client}` (headless_project.rs). Reused from b1 (`remote::websocket_wire`): `ControlFrame`, `Hello`, `HelloAck`, `LogFrame`, `ClientKind`, `encode_envelope_frame`, `decode_envelope_frame`, `builds_compatible`, `split_subprotocol_header`, `ZS_BUILD_ID`, the five close codes and `SUBPROTOCOL`. Consumed from b3: `pty::PtyManager::{new, detach_all, kill_all}`. Consumed from b4: `control::{ControlChannel, ControlRequest, ControlResponse, LIFECYCLE_PATH, PORTS_PATH, EXTENSIONS_PATH}`, `ports::{DEFAULT_SUPERVISOR_URL}` (b4 §3.11 `crates/remote_server/src/ports.rs`), `HeadlessProject::{enable_sandbox, on_session_attached, notify_files_uploaded}`, `SandboxConfig`, `extension_host::headless_host::{RegistryConfig, HeadlessExtensionStore::asset_path}`. No `.proto` changes in this workstream (`FilesUploaded`, client state, ports, extensions are b4; terminals are b3).

## 5. Cargo/package changes

`Cargo.toml` (workspace) additions – see §3.1.

`crates/remote_server/Cargo.toml`:

```toml
[features]
default = ["serve"]
serve = [
    "dep:async-tar", "dep:bytes", "dep:http-body-util", "dep:hyper", "dep:hyper-util",
    "dep:jsonwebtoken", "dep:multer", "dep:serde", "dep:subtle", "dep:tokio", "dep:yawc",
]

[dependencies]   # alphabetical; new entries optional = true, workspace = true
async-tar = { workspace = true, optional = true }
bytes = { workspace = true, optional = true }
clap = { workspace = true, features = ["env"] }      # replaces `clap.workspace = true` (line 29); workspace clap = ["derive", "wrap_help"] only (Cargo.toml:578)
http-body-util = { workspace = true, optional = true }
hyper = { workspace = true, optional = true, features = ["http1", "server"] }
hyper-util = { workspace = true, optional = true, features = ["http1", "server", "tokio"] }
jsonwebtoken = { workspace = true, optional = true, features = ["aws_lc_rs"] }
multer = { workspace = true, optional = true }
serde = { workspace = true, optional = true }
subtle = { workspace = true, optional = true }
tokio = { workspace = true, optional = true, features = ["fs", "io-util", "macros", "net", "rt", "signal", "sync", "time"] }
yawc = { workspace = true, optional = true }
```

`[dev-dependencies]` additions:

```toml
async-tungstenite.workspace = true          # default features: handshake + futures-03-sink; client_async over smol::net::TcpStream
prost.workspace = true                      # tests build Envelopes directly
tokio = { workspace = true, features = ["macros", "rt-multi-thread"] }
```

Every new dependency is referenced by code under `serve/` or the tests, so `cargo shear --locked --deny-warnings` (run_tests.yml:708) stays green without touching `[package.metadata.cargo-shear]`.

Justification of every non-trivial choice:

- **hyper 1.7 + hyper-util + http-body-util** – already locked and already in remote_server's tree through `reqwest_client` and `yawc` (cargo tree, §2), but with client features only; `hyper/server`, `hyper-util/server` and `hyper-util/tokio` (for `TokioTimer`) are new feature bits, not new crates. axum 0.6 (collab, zed-web fork) would drag hyper 0.14/http 0.2 beside hyper 1.x and is rejected.
- **yawc** for framing – the same crate the browser client and `cloud_api_client` use; its server side is a `hyper` upgrade (`upgrade_with_options`), so it slots in with no adapter. `tokio-tungstenite` is in the lockfile (three versions) but not in this crate's tree; `async-tungstenite` is (via `client`) but is client-configured and would need a second HTTP layer for the non-WS routes. **D10**: the crate resolves through a path `[patch]` to `vendor/yawc` (rev `71a452f` plus b1's §3.18 fork changes; `vendor/README.md` records the upstream revision and the intended git-patch form). b1 owns the vendoring; `remote_server`'s `yawc = { workspace = true, optional = true }` line is unaffected, and every yawc API this brief cites (`upgrade_with_options`, `next_frame`, `Options`, `Frame`, `CloseCode`) is unchanged by b1's patches (they touch the wasm side and close-on-drop only).
- **Control listener, `Log` frames, extension assets** add no dependencies: hyper serves both listeners; `ControlFrame`/`LogFrame` serialise with `serde_json` (already a direct dependency, `Cargo.toml:41`); `log`, `paths`, `util`, `http_client`, `reqwest_client`, `release_channel` and `extension_host` (`Cargo.toml:12-48`) are already there for `enable_sandbox`'s `RegistryConfig`/`ReqwestClient` construction. `subtle` is shared with b4's bearer compare (b4 §3.10: whichever brief lands first adds the two lines).
- **jsonwebtoken 10.3 with `aws_lc_rs`** – `aws-lc-sys` is already compiled into remote_server (rustls 0.23 default features via `http_client_tls`), and `livekit_api` already selects this flag; `rust_crypto` would add p256 0.13/p384/ed25519-dalek as new crates and, enabled anywhere in a unified build, would make the provider selection panic (§3.5). If a future rustls change removes aws-lc from the musl build, swap the backend to a 60-line `ring::signature::ECDSA_P256_SHA256_FIXED` verifier over the SPKI point bytes (ring 0.17 is also in the tree) – `AuthConfig::verify` is the only call site.
- **multer 3** – the one genuinely new crate (pure Rust; deps `bytes`, `encoding_rs`, `futures-util`, `http 1`, `httparse`, `memchr`, `mime`, `spin` – all already locked). Needed because the browser sends `FormData` with several files per drop. `application/octet-stream` single-file uploads work without it, so it can be feature-gated out if the lockfile churn is unwelcome.
- **subtle** – locked already (via `rsa`); used for the `ws` claim compare to satisfy the constant-time requirement literally.
- **tokio features** – `tokio` was not a direct dependency of remote_server; `gpui_tokio` only enables `rt, rt-multi-thread`. `net` (listener), `signal` (SIGTERM; `signal-hook-registry` is already locked), `fs`/`io-util` (file streaming), `sync` (broker mpsc/oneshot/semaphore), `time` (timeouts), `macros` (`select!`).
- **`serve` feature** – keeps the upstream PR reviewable as an opt-in subcommand and keeps `cargo shear`, clippy `--all-features` and the musl link surface identical to today when the feature is off.
- **No new native code, no OpenSSL** – consistent with `script/bundle-linux:131-136`. The musl graph is not re-verified here (§7.10); the fork's CI gets a `cargo zigbuild --target x86_64-unknown-linux-musl -p remote_server` job mirroring `bundle-linux:87-94` so the assumption is checked on every PR.

## 6. Tests

### 6.1 Unit – `serve/auth.rs` (`#[cfg(test)]`, plain `#[test]`; tokens minted with `jsonwebtoken::encode` + `EncodingKey::from_ec_pem` on the fixture private key)

| Test | Asserts |
|---|---|
| `provider_is_available` | `decode` of a valid token does not panic (guards the `aws_lc_rs`/`rust_crypto` selection). |
| `valid_token_verifies` | `verify` → `Ok(Claims)` with `sid`, `sub`, `jti` round-tripped; `exp = now+3600`. |
| `expired_token_rejected` | `exp = now-120` → `Err(AuthError::Expired)`; `exp = now-10` (inside `LEEWAY_SECS`) → `Ok`. |
| `future_iat_rejected` | `iat = now+120` → `Err(Malformed)` (manual check; jsonwebtoken ignores `iat`); `iat = now+10` → `Ok`. |
| `wrong_audience_rejected` | `aud = "sb_other"` → `Err(WrongAudience)`. |
| `wrong_issuer_rejected` | `iss = "evil"` → `Err(WrongIssuer)`. |
| `wrong_workspace_rejected` | `ws = "ws_other"` (valid signature/aud) → `Err(WrongWorkspace)`. |
| `wrong_key_rejected` | Signed with a second keypair not loaded → `Err(BadSignature)`. |
| `rotation_accepts_either_key` | `from_pems([k1, k2])`: token signed by k2 verifies. |
| `rotation_reports_specific_error` | `from_pems([k1, k2])`, token signed by k2 but expired → `Err(Expired)`, not `BadSignature`. |
| `hs256_with_public_key_rejected` | Header `alg=HS256`, HMAC over the public PEM bytes → `Err(WrongAlgorithm)` (never `Ok`). |
| `missing_claim_rejected` | Token without `sid` → `Err(Malformed)`. |
| `subprotocol_parsing` | `"zs.v1, T"`, `"T, zs.v1"`, `" zs.v1 ,T "` → `Ok("T")`; `"zs.v1"` → `Missing`; `"T"` → `MissingSubprotocol`. |
| `extract_token_precedence` | Header beats `Authorization` beats `?zs_token=`; `?zs_proto=zs.v1` counts as offered; none → `Missing`. |
| `redact_query_hides_token` | `"/files?path=a&zs_token=abc"` → `"/files?path=a&zs_token=***"`. |

### 6.2 Unit – `serve/files.rs` (tempdir per test)

| Test | Asserts |
|---|---|
| `resolve_accepts_relative` | `"a/b.txt"`, `"./a"`, `"a/./b"`, `"a%2Fb.txt"` (percent-decoded) resolve under root. |
| `resolve_rejects_traversal` | `"../x"`, `"a/../../x"` → `Traversal`; `"/etc/passwd"`, `"a\0b"`, `""`, `"C:\\x"` → `InvalidPath` (explicit checks, not `normalize_lexically`). |
| `resolve_rejects_symlink_escape` | `root/link → /tmp/outside`; `"link/file"` → `Traversal`. |
| `octet_stream_upload_writes_file` | Body bytes land at `root/dir/f.bin`, parents created, temp file renamed, `201` + `written == ["dir/f.bin"]`. |
| `multipart_upload_writes_all_parts` | Two parts (`a.txt`, `sub/b.txt`) under `?path=up` → both files, response lists both. |
| `upload_too_large_is_413_early` | `Content-Length: MAX_UPLOAD_BYTES + 1` → 413 before the body is read. |
| `upload_too_large_is_413_streaming` | Chunked body of `MAX_UPLOAD_BYTES + 1` (streamed, not allocated) → 413 and no partial or temp file left. |
| `upload_too_many_parts_is_413` | `MAX_FILES_PER_UPLOAD + 1` parts → 413 `too_many_files`. |
| `download_file_streams_bytes` | 200, `Content-Length`, `Content-Disposition`, body equals file. |
| `download_dir_is_tar` | `application/x-tar`; parse with `async_tar::Archive` and assert entry names. |
| `download_dir_does_not_follow_symlinks` | `root/d/link → /` ; `GET /files?path=d` tar contains the link entry only, nothing under it. |
| `download_missing_is_404` | |
| `sweep_removes_stale_temp_files` | `root/x.zs-upload-old` removed; `root/x` kept. |
| `upload_sends_files_uploaded_command` | After a multipart upload of `a.txt` and `sub/b.txt`, the `gpui_tx` receiver holds exactly one `GpuiCommand::FilesUploaded` with both absolute paths, sent after both files exist at their final names (b4 §3.15 item 5). |
| `extension_asset_streams_file` | A stub gpui loop answers `ResolveExtensionAsset { id: "theme-x", rel: "themes/x.json" }` with a temp file → 200, `Content-Type: application/json`, body equal, no `Content-Disposition`. |
| `extension_asset_unknown_is_404` | Stub answers `None` → 404; `rel = "../x"` and `id = "../x"` → 400 without any gpui round trip. |

### 6.3 Unit – `serve/session.rs` + `serve/http.rs` (`#[tokio::test(flavor = "multi_thread")]`, in-process: bind `127.0.0.1:0`, run `serve_http` and `SessionBroker::run` with a recording `ServeHooks` stub whose `begin_fresh_session` returns a fresh channel pair with `RemoteStarted` pre-queued; client = `yawc::WebSocket::connect(url).with_request(hyper::Request::builder().header("sec-websocket-protocol", format!("zs.v1, {jwt}")))` – `WebSocketBuilder::with_request(HttpRequestBuilder)` at yawc `src/native/builder.rs:189` – or `async_tungstenite::client_async` as in §6.4)

| Test | Asserts |
|---|---|
| `is_input_envelope_rules` | `Ping`, `Ack`, `RemoteStarted`, `FlushBufferedMessages`, `SaveClientState`, `LoadClientState`, `ListExtensions` (b4), `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` (b3), any `responding_to: Some` → false; `AddWorktree`, `SpawnTerminal`, `TerminalInput`, `CloseTerminal` → true. |
| `health_minimal_vs_full` | Non-loopback (simulated via `route()` with a fake peer) omits `worktrees`/`last_input_at`/`dirty_buffers`; loopback includes them; `session_active` toggles with attach/detach; `session.epoch` and `session.session_id` present when attached. |
| `rpc_without_token_is_401_before_upgrade` | Response is 401, not 101; `auth_failures` incremented; the response took ≥ `AUTH_FAILURE_DELAY`. |
| `valid_token_not_blocked_after_failures` | 50 garbage-token upgrades in parallel, then a valid one → 101 within 1 s. |
| `rpc_without_subprotocol_is_426` | Neither header item nor `zs_proto` → 426; `?zs_proto=zs.v1&zs_token=` → 101 without an echoed `Sec-WebSocket-Protocol`. |
| `rpc_disallowed_origin_is_403` | `allowed_origins = ["https://app.test"]`, `Origin: https://evil.test` → 403; no `Origin` → 101. |
| `files_preflight_and_cors_headers` | `OPTIONS /files` and `OPTIONS /extensions/x/assets/y` from an allowed origin → 204 with the five `Access-Control-*` headers; `GET /files` and `GET /extensions/*` responses carry ACAO + `Vary: Origin` + `Expose-Headers` + `Cross-Origin-Resource-Policy: cross-origin`. |
| `control_routes_only_on_control_listener` | `POST /control/lifecycle` on the public listener → 404 (even from loopback with the right bearer); on the control listener with the bearer → 204 and the stub `ControlRoutes` saw `ControlRequest { peer_is_loopback: true, session_attached: false, .. }`; wrong bearer → 401; body > 1 MiB → 413; `GET /control/ports` → 405; `POST /control/other` → 404. |
| `control_listen_must_be_loopback` | `--control-listen 0.0.0.0:0` → `execute_serve` returns `Err` before binding anything. |
| `hello_session_id_mismatch_is_logged` | `Hello.session_id = "other"` with a token whose `sid = "sid_1"` → attach succeeds, `HelloAck.session_id == "sid_1"`, `/health.session.session_id == "sid_1"`, one warn log line (D1). |
| `second_client_without_takeover_closes_4005` | `reconnect:false, takeover:false` while attached → the new socket gets `CLOSE_SESSION_BUSY` (4005); the first socket stays attached and keeps working. |
| `reconnect_supersedes_half_open_socket_with_1001` | Attach (epoch e); open a second socket with `reconnect:true, epoch:e` while the first is still attached → first gets Close 1001 "superseded by reconnect", second gets `HelloAck{resumed:true, epoch:e}`; hook `begin_fresh_session` not called; `session_detached` hook called once for the first. |
| `takeover_closes_old_with_4001` | Old socket receives Close 4001 with reason; new socket receives `HelloAck` with a **new** epoch and `resumed:false`. |
| `stale_epoch_closes_4001` | After the takeover above, a third socket with `reconnect:true, epoch:<old e>` → Close 4001 "stale epoch"; the attached client is untouched; no hook called (b1 §6.3 test 8). |
| `epoch_is_unique_and_monotonic` | Three fresh attaches in one process → strictly increasing epochs, all `> (start_ms << 16)`; two brokers constructed 2 ms apart never produce equal epochs. |
| `fresh_session_swaps_channels` | Pre-queue 3 envelopes on the original `outgoing_tx`, and have the stub hook enqueue one `UpdateProject` on the **old** pair before returning the new pair; attach fresh; hook called once; the client's first binary frame is `RemoteStarted` (id 0); none of the 4 stale envelopes ever arrive; `session_attached` hook saw `kind == Fresh` after `RemoteStarted` was queued. |
| `reconnect_session_keeps_queue` | Attach (epoch e), detach, re-attach with `reconnect:true, epoch:e` (any `identifier`, a token with a different `sid`): `resumed == true`, `HelloAck.epoch == e`, the 3 queued envelopes arrive in order, `begin_fresh_session` not called, `session_attached` saw `kind == Reconnect`. |
| `reconnect_to_fresh_process_is_not_resumed` | First attach in the process with `reconnect:true, epoch:Some(123)` → `resumed == false`, a fresh epoch, `RemoteStarted`; same with `epoch:None`. |
| `stale_response_dropped_after_fresh` | After a fresh attach, push `Envelope{responding_to: Some(41)}` into `outgoing_tx` before the client sent anything → never delivered; after the client sent ids 0..=41, a `responding_to: Some(41)` is delivered. After a resumed reconnect, a `responding_to` for an id received before the blip is delivered (watermark carried over). |
| `hello_timeout_closes_4006` | No Hello for `HELLO_TIMEOUT` → Close 4006; `protocol: 2` → 4006. |
| `build_mismatch_closes_4002` | `expected_build = "b1"`, Hello `build = "b2"`; a `dev` build passes (`builds_compatible`). |
| `activity_excludes_pings_and_replay` | `Ping` → `last_input_at` unchanged; `AddWorktree` → updated; after a resumed reconnect, re-sending an id ≤ the previous max does not update it; a client `{"type":"heartbeat"}` text frame does not update it. |
| `server_heartbeat_every_5s` | With `tokio::time::pause`, an attached client receives `{"type":"heartbeat"}` text frames at 5 s intervals; none after detach. |
| `log_frames_mirror_warnings` | `log::warn!("x")` while attached → the client receives `{"type":"log","level":2,...,"message":"x"}`; `log::info!` is not mirrored; with the frame queue full the warn is dropped and stderr still has it. |
| `detach_hook_called_on_every_exit` | Peer close, slow-consumer close, supersede and takeover each call `session_detached` exactly once with the right `epoch`. |
| `close_session_delivers_ack_first` | Queue an `Ack`, then `CloseSession{1000}` in the same tick → client receives the Ack, then Close 1000. |
| `shutdown_flushes_then_4004` | Queue 2 envelopes, send `Shutdown` → client receives both then Close 4004; `request_quit` called once. |
| `shutdown_without_session_is_immediate` | `Shutdown` with nothing attached → `done` within 100 ms, `request_quit` called. |
| `oversize_incoming_frame_detaches_only_session` | Client sends 16 MiB + 1 → that socket closes (1009); `/health` still answers and a new attach works. |
| `oversize_outgoing_frame_is_never_sent` | Push a 16 MiB + 1 envelope into `outgoing_tx` → session closed 1009, client never receives a frame that size. |
| `slow_consumer_does_not_block_broker` | Client stops reading; push 64 MiB of envelopes; `Attach` of a takeover completes and the stalled socket is closed within 1 s. |
| `upgrade_never_completing_is_dropped` | Client sends the upgrade request and stalls → per-connection task ends after `UPGRADE_TIMEOUT`, no session state. |

### 6.4 Integration – `crates/remote_server/tests/serve.rs` (spawns the real binary; skipped unless `ZED_RUN_SERVE_INTEGRATION=1` to keep the default test run fast; CI sets it)

1. Spawn `remote_server serve --listen 127.0.0.1:0 --control-listen 127.0.0.1:0 --control-secret-file tests/fixtures/control_secret --port-file <tmp>/port --jwt-public-key tests/fixtures/es256_public.pem --workspace-id ws_test --audience sb_test --workspace-root <tmpdir>` with `RUST_LOG=info` and `ZS_CONTROL_SECRET=leak` in the environment; wait ≤10 s for the port file; read `ZS_LISTENING=` and `ZS_CONTROL_LISTENING=` from stdout and assert the first equals the port file. Also assert `--workspace ws_test --allow-build x` parses (`--help` output lists the aliases) and that omitting `--control-secret-file` is a clap error.
2. `GET /health` → 200, `session_active == false`, `worktrees == []` (loopback), `build` non-empty. `POST http://127.0.0.1:<public>/control/lifecycle` → 404; `POST http://127.0.0.1:<control>/control/lifecycle {"kind":"idle_stop_in","seconds":300}` with the fixture bearer → 204, with bearer `leak` → 401 (the environment variable was scrubbed, not adopted), without a bearer → 401.
3. Mint a JWT (`jsonwebtoken::encode`, fixture private key, `exp=+1h`, `sid="ses_1"`, `ws="ws_test"`). Open `smol::net::TcpStream`, `async_tungstenite::client_async(request_with_subprotocol, stream)`; assert the response has `Sec-WebSocket-Protocol: zs.v1`.
4. Send text `{"type":"hello",..,"session_id":"ses_1","identifier":"i1","reconnect":false,"takeover":false,"epoch":null}`; receive text `hello_ack` with `resumed == false`, `session_id == "ses_1"` and an `epoch` `e1`.
5. Receive binary → `decode_envelope_frame` → `id == 0`, payload `RemoteStarted`.
6. Send `Envelope{ id: 0, payload: RemoteStarted }` → receive `Ack{ responding_to: Some(0) }`.
7. Send `Envelope{ id: 1, payload: Ping }` → receive `Ack{ responding_to: Some(1) }`; `GET /health` → `session_active == true`, `session.epoch == e1`, `last_input_at` absent (Ping excluded). Within 6 s a text frame `{"type":"heartbeat"}` arrives.
8. Send `Envelope{ id: 2, payload: ListRemoteDirectory{ path: <tmpdir>, .. } }` → a `ListRemoteDirectoryResponse` with `responding_to: Some(2)`; `/health.last_input_at` now present.
9. `POST /files?path=hello.txt` (octet-stream, bearer) → 201; the file exists in `<tmpdir>`. `GET /files?path=hello.txt&zs_token=<jwt>` → same bytes. `POST /files?path=../x` → 400. `GET /extensions/nope/assets/x.json` (bearer) → 404. Expired token on `/files` → 401 while the socket from step 3 keeps answering `Ping`.
10. Second socket, a fresh token with `sid="ses_2"`, `identifier "i2"`, `takeover:true, reconnect:false` → first socket receives Close 4001; second gets `resumed == false`, `epoch e2 > e1` and a new `RemoteStarted`. Third socket, `identifier "i3"`, `takeover:false, reconnect:false` → Close 4005; second socket unaffected. Fourth socket, `reconnect:true, epoch:e1` → Close 4001 (stale epoch); second socket unaffected.
11. Send `ShutdownRemoteServer` on the second socket → `Ack` then Close 1000; process still alive (`/health` 200).
12. Reattach (`i2`, `reconnect:true, epoch:e2`, a **third** token with `sid="ses_3"`) → `resumed == true`, `hello_ack.epoch == e2`, `hello_ack.session_id == "ses_3"`. `kill -TERM <pid>` → socket receives Close 4004 within 3 s; process exits with status 0 within 10 s; stderr lines all parse as JSON with `"mode":"serve"` and `"ws":"ws_test"`, none contains the token or the control secret, and at least one has `"session_id":"ses_3"`.
13. Spawn again, `kill -TERM` with no session attached → exit 0 within 3 s.
14. (Owned by b3, run against this fixture once b3 lands.) Spawn a terminal on socket A, take over with socket B (fresh) → `ListTerminals` on B lists it and `AttachTerminal { from_offset: 0 }` replays its scrollback (D3/D4); `kill -TERM` → the shell is gone within 1 s (`kill_all` on quit).

### 6.5 Existing tests

`crates/remote_server/src/remote_editing_tests.rs` and `crates/remote/src/remote_client.rs:1430-1560` tests are untouched: `proto_client_from_channels` and `ChannelClient::new` keep their signatures. `tests/run.rs` (§3.14) covers the `execute_run` extraction.

## 7. Risks and open questions

1. **Fresh-session semantics vs. BUILD-SPEC §4.2 wording – decided (D3).** The spec said the newcomer "gets replay-on-reconnect semantics rather than a cold project" and that "the `HeadlessProject` and its stores survive"; b1 §4.4/§7.4 asked for a warm attach on `reconnect:false`. D3 decides the opposite and amends BUILD-SPEC §4.2: a *reconnect* (matching epoch) attaches warm and replays; a *fresh* session resets the `HeadlessProject` (worktrees, language servers, git, settings) as the accepted cost of a page reload. Replay only makes sense for the epoch whose `ChannelClient` produced the acks; any other client waits for `RemoteStarted` (`remote_client.rs:459-462`) and re-adds its roots; `handle_add_worktree` never dedupes, so the reset is required – and, because every store reacts to `WorktreeRemoved`, it also stops the language servers, prettier, git repositories and local settings (§3.7). PTYs are the one thing that stays warm across fresh sessions (D3/D4). A true "warm join" (re-broadcasting live worktree/LSP state to a new client) needs store-level re-share support and is out of scope; no sign-off is pending any more.
2. **Buffers of removed worktrees.** Verified: `BufferStore` only handles `WorktreeAdded` (843), and `shared_buffers` holds strong refs (59). `reset_for_new_client` calls `forget_shared_buffers()` so the entities can drop; dirty edits of the previous client are discarded (logged; `/health.dirty_buffers` lets the take-over dialog warn first). Anything else still holding a buffer (an LSP request in flight) delays the drop but does not leak it permanently. If a leak is observed anyway, the fallback is a process restart (exit 75, supervisor restart) for fresh sessions – a one-line policy switch in the broker. D6/D7 mitigate the *stop* path only: on `LifecycleNotice STOPPING` the client writes dirty buffers into the client-state image and reopens them dirty next time; a reload or takeover still relies on the shell's own dirty-buffer handling (b1 §7.9) and on the take-over dialog.
3. **Session identity – decided (D1, D3).** `session_id` (JWT `sid`, `Hello.session_id`, `HelloAck.session_id`) is minted per connect by the control plane and informational; the stable identity is `workspace_id` (JWT `ws`, `--workspace-id`). Resume is therefore keyed on the epoch the server issues, not on `sid` (which changes every connect) nor on `Hello.identifier` (logs only). b9's earlier `sid === workspaceId` and this brief's earlier `(sid, identifier)` rule are both superseded; b9 mints a per-connect `sid` and b1 passes it through. `identifier` and `takeover` are chosen by the client; any holder of a valid token can set them, which is the same trust level as the token itself.
4. **b1 alignment items – status after D20.** (a) 4005 is now b1's own `CLOSE_SESSION_BUSY` (terminal, exit 91) – resolved; 4006 (bad Hello) remains serve-only and maps to "reconnect" in b1, acceptable because only a buggy client triggers it. (b) `HelloAck{resumed:false}` after `Hello{reconnect:true}` → b1 §3.3 step 3 returns exit 90 – resolved. (c) b1's `wire.rs` reads `option_env!("ZS_BUILD_ID")` in `crates/remote`; that crate needs the same `rerun-if-env-changed` as §3.13 – still b1's to add. (d) `ControlFrame::Log` is now emitted for warn/error records (§3.9 log sink); stderr remains the primary sink. (e) b1 §7.12's "401 as the only pre-upgrade rejection" is confirmed with a refinement: 403 (aud/iss/ws/origin) and 426 (no subprotocol) also exist; b1 treats every non-101 as a failed dial and refreshes before redialing (b1 §7.14), so nothing on its side depends on 401 specifically. (f) `ZS_LISTENING=` stdout line – added (§3.9). (g) `Heartbeat` every 5 s, no `permessage-deflate`, echoed `zs.v1`, 16 MiB inbound ceiling – all in §3.7/§3.8.
5. **Broker throughput.** All socket I/O runs on the gpui_tokio runtime (2 workers, `enable_all`); gpui touches only `futures::mpsc` channels. The session task serialises reads and writes on one socket (a stalled write pauses reads of that socket only); the broker is never parked on a write. Not verified under load that two workers are enough for 16 MiB frames plus file streaming – bump `worker_threads` only through `gpui_tokio::init_from_handle` if profiling says so.
6. **yawc `Stream` swallows errors** (`native/mod.rs:1236-1242` maps `Err` to `None`). The session task uses `next_frame()` (returns `Result`) so `session_detached.reason` carries the cause.
7. **Frame ceiling.** yawc's default `MAX_PAYLOAD_READ` is 1 MiB; serve sets 16 MiB per §4.4 and a 32 MiB read buffer (same as b1's client options). The writer refuses to emit a larger frame (1009). Not verified that every server-side message (e.g. `UpdateWorktree` for a huge tree) stays under 16 MiB – `oversize_outgoing_frame_is_never_sent` proves the guard, not the absence of such messages.
8. **`multer` is unverified offline.** Version `3.1` and its API (`Multipart::new(stream, boundary)`, `next_field`, `chunk`, `parse_boundary`) are from memory and the crate is not in the local registry; the first build fetches it. Feature-gate or drop in favour of octet-stream-only if the reviewer objects.
9. **`--client-build` closes after the upgrade** (4002) because the build id travels in the Hello frame per §4.1. If the shell page would rather see an HTTP error, add `?build=` to the query and reject with 426 in `route` – trivial, not done here.
10. **`aws-lc-sys` in the musl build.** Confirmed present in remote_server's dependency graph on the host; not re-verified with `--target x86_64-unknown-linux-musl` here. §5 adds a CI job for it; if the musl graph differs, the ring fallback in §5 applies.
11. **Quit path.** `cx.shutdown(); cx.quit()` from a task is the same hack as `run` (server.rs:445-450). `SHUTDOWN_TIMEOUT` is 200 ms (app.rs:78) and `App::shutdown` only logs when `on_app_quit` work overruns (978-1003), so language-server shutdown is best-effort in every mode; the orderly flush is the supervisor's `POST /control/lifecycle {stopping}` (b4/b8) before SIGTERM. On Linux `quit` stops the calloop and `Application::run` returns (gpui_linux platform.rs:280-282) – the integration test's "exit 0 within 10 s" relies on that; macOS headless (dev runs) may terminate the process from inside `quit` instead of returning, which also exits 0.
12. **Health without auth** exposes build/uptime/`session_active` to anyone who finds the port; worktree paths, `last_input_at`, `dirty_buffers` and `auth_failures` require loopback or a token. The control plane polls the supervisor (`:8445`), not this listener.
13. **CLI spelling vs. BUILD-SPEC §4.2.** The spec writes `--workspace` and `--allow-build`; b8's supervisor was written against this brief's `--workspace-id`/`--client-build`. Both spellings are accepted (clap aliases). The spec's "public key baked in as an environment variable" (§4.3) is realised by b8/b9 materialising PEM files and passing `--jwt-public-key` twice during rotation; no env-var PEM input is added. Per D5/D18/D19 the supervisor's spawn line also carries `--allowed-origin <origin>` (one per `manifest.allowedOrigins` entry – resolved, b9 §4.7 delivers it; `ZS_ALLOWED_ORIGINS` stays as an alternative), `--control-secret-file <path>` (required) and `--control-listen 127.0.0.1:8446`; `--supervisor-url` defaults from `ZS_SUPERVISOR_URL`. b8 must update `ServerSpec::command()` (b8:521-522) and stop exporting `ZS_CONTROL_SECRET` (D18); serve scrubs the variable if it is still there (§3.9).
14. **Multi-user takeover state carry-over.** User settings pushed by the previous `sub` are now reset on every fresh session (D3, §3.10), so this item shrinks to: the telemetry forwarding target and REPL `kernels` survive a fresh session with a different `sub`. The broker logs the change at warn; nothing else is deferred.
15. **Windows.** The crate is clippy'd on Windows; `signal_task` is `cfg`-split and `HelloAck.shell` falls back to `%COMSPEC%`. Serve is not otherwise expected to run there.
16. **Port assignments collide across decisions – unresolved, needs the tech lead.** D5/D18 put serve's control listener on `127.0.0.1:8446`; b8's own loopback API (`/ports`, `/git-token`, `ZS_SUPERVISOR_URL=http://127.0.0.1:8446`, b8:146,516,663) is on the same port, and b4's `DEFAULT_SUPERVISOR_URL` is `http://127.0.0.1:8445` while b8 serves only `/health` on 8445. Separately, D8 declares 8444-8447 as four proxy slots, which overlaps b8's health listener (8445) and both loopback APIs (8446). Two processes cannot bind the same loopback port. This brief follows D5 literally (`--control-listen` default `127.0.0.1:8446`, overridable) and `--supervisor-url` is a flag/env so the supervisor's real port can be injected; the assignment itself (control listener vs. supervisor API vs. proxy slots) must be settled in b8/D8, not here.
17. **`PtyManager` handle plumbing (D3).** b3 §3.9 constructs the manager inside `HeadlessProject::new` and stores it as a field; D3 moves it to server level. Serve constructs `Arc<PtyManager>` after `build_headless_project` (it needs the `AnyProtoClient` sink and `&mut App`) and needs (a) an accessor on `HeadlessProject` to hand the handle to b3's request handlers (a setter in the style of `enable_sandbox`, or a gpui global – b3's choice) and (b) `detach_all`/`kill_all` callable from the gpui command loop. `run` mode gets its own `PtyManager` the same way in `execute_run` (b3's change). Until b3 amends, the calls in §3.9 target the field b3 already declares (`project.read(cx).pty_manager.detach_all()`), which is behaviourally identical because `reset_for_new_client` never touches it.
18. **`Heartbeat` direction.** D3 says "`Heartbeat` control frame every 5 s from the client"; b1 §4.2/§7.8 define it as server → client (hidden tabs throttle client timers; browsers hide WS ping/pong). This brief implements the server → client frame (b1's rationale needs it) **and** accepts a client `Heartbeat` silently (never input). If D3 meant only the client direction, the server-side emitter is one `select!` arm to remove; flagged for confirmation.
19. **Close-code reading of D3.** D3 lists "4001 superseded (takeover), 4005 session active, 1001 server going away" and says a stale epoch is a fresh session; b1 §4.4 (adopted by D20) uses 1001 for a reconnect superseding a half-open socket, 4001 for takeover **and** stale epoch, and 4004 for SIGTERM, and its test 8 asserts 4001 on a stale epoch. This brief follows b1 §4.4: 1001 = superseded by a same-epoch reconnect, 4001 = taken over / stale epoch, 4004 = server stopping; a stale-epoch client re-opens with `reconnect:false`, which is the fresh path D3 describes. If "1001 server going away" was meant for SIGTERM instead of 4004, the change is one constant in §3.7 step 9 and b1's mapping row (4004 → 90 would become 1001 → reconnect → `RefreshError::Stopped` under D2); flagged for confirmation.
20. **Prebuild (D14).** `zs-agent prebuild` connects a headless client to warm language servers. Under D3 the language-server *processes* that client started die with the next fresh session; what the snapshot keeps is what D9 lists – language-server downloads, extension installs and caches under `$HOME/.local/share/zed` – plus whatever the warm-up wrote into the repo. Serve needs nothing special for prebuild; the prebuild client is an ordinary fresh session.
21. **`--control-secret-file` is required.** b1 §6.3's precondition now carries `--control-secret-file`/`--audience`/`--workspace-root` (contract pass 2026-09-02); it must also pass `--control-listen 127.0.0.1:0`, otherwise parallel test cases and this brief's own `tests/serve.rs` (§6.4 step 1) collide on the default `127.0.0.1:8446`. b1's integration harness reuses the fixture file (`tests/fixtures/control_secret`, §3.14). Making the flag optional was rejected: `enable_sandbox` needs the secret, and a serve instance without a control listener would silently lose lifecycle notices.

## 8. Review log

Reviewer 1 (severity: major)

| # | Finding | Decision |
|---|---|---|
| 1 | `init_crash_handler` return type `Option<Task<()>>` wrong. | **Accepted.** Verified crashes.rs:48-53 returns `impl Future<Output = Arc<Client>>`. §3.11 now returns `Option<Task<Arc<crashes::Client>>>`. |
| 2 | Private `mod session` makes `crate::serve::session::BrokerCommand` a privacy error from `headless_project`. | **Accepted, then made moot.** Crate root is `server.rs` (Cargo.toml:12-14), so the modules are siblings. §3.9 declares all four submodules `pub`; §3.10 no longer imports `serve` at all (`on_shutdown_request` callback on `HeadlessAppState`). |
| 3 | `prost::Message` used in non-test code without a `prost` dependency. | **Accepted.** Verified Cargo.toml:24-76 has no `prost`; `proto.rs:8` re-exports `Message`. Non-test code uses `proto::Message`; framing goes through b1's `encode_envelope_frame`/`decode_envelope_frame` anyway. `prost` stays a dev-dependency. |
| 4 | `build_headless_project` "verbatim body" references `extension_host_proxy` from the outer closure. | **Accepted.** Verified server.rs:675/715. The helper calls `ExtensionHostProxy::global(cx)` itself. |
| 5 | jsonwebtoken never validates `iat`. | **Accepted.** Verified validation.rs has no `iat` logic (274-298 compare only `exp`/`nbf`). `verify` now checks `iat > now + LEEWAY_SECS` manually; test `future_iat_rejected` added. |
| 6 | Fresh-session ordering: the reset emits `UpdateProject` (and more) into `outgoing_tx` before `RemoteStarted`. | **Accepted.** Verified worktree_store.rs:1037 → 1184 → `send_buffered` (2036-2043), plus headless_project.rs:411 forwarding `LanguageServerRemoved`. Redesigned §3.2/§3.7: the fresh reset hands the `ChannelClient` a **new channel pair** via `reconnect` (1878-1886), so everything emitted during the reset dies with the old pair and `RemoteStarted` is the first frame. Test `fresh_session_swaps_channels` now makes the stub hook emit stale envelopes. |
| 7 | Fresh reset also tears down language servers, git, settings, manifest roots. | **Accepted.** Verified lsp_store.rs:4871/3835-3878, git_store.rs:2487, project_settings.rs:1152, manifest_tree.rs:199, context_server_store.rs:499. §3.7 "what persists" and §7.1 rewritten: fresh = warm process, cold project. |
| 8 | Dropping the 4-byte prefix contradicts BUILD-SPEC §4.1/§4.4. | **Accepted.** Verified BUILD-SPEC lines 203/231 and b1 §3.1/§4.2 (b1 keeps `u32 LE len || prost` inside each frame). §2/§4 now keep the prefix and use b1's helpers. |
| 9 | CLI flag names differ from BUILD-SPEC §4.2. | **Accepted with a different fix.** Verified BUILD-SPEC:215, but b8 §438-439 already builds its spawn line from this brief's names, so renaming would break the supervisor. Added clap aliases `--workspace`/`--allow-build`; deviation recorded in §7.13. |
| 10 | `Worktree::abs_path` is an inherent method returning `Arc<Path>`. | **Accepted.** Verified worktree.rs:864-869 vs 2562. §2 row corrected. |
| 11 | `normalize_lexically` accepts absolute and empty paths. | **Accepted.** Verified paths.rs:434-450. §3.6 lists explicit empty/NUL/absolute/prefix checks before it; `resolve_rejects_traversal` split into `Traversal` vs `InvalidPath` expectations. |
| 12 | `encoding_rs`/`spin` are already locked. | **Accepted.** Verified Cargo.lock (0.8.35; 0.9.8 and 0.10.0). §3.1 says only `multer` is new. |
| 13 | `BufferStore` never closes buffers on `WorktreeRemoved` – leak is real. | **Accepted.** Verified buffer_store.rs:843 is the only arm; `SharedBuffer` holds `Entity<Buffer>` (59). `reset_for_new_client` calls `forget_shared_buffers()` and counts dirty buffers; §7.2 decided (no deferral). |
| 14 | `serve_http` "binds" yet takes a bound listener; `start_serve` cannot create the broker channel that `ServeState` already holds. | **Accepted.** §3.8/§3.9 restate the construction order: channel → `ServeState` → `start_serve(.., broker_rx, ..)` binds, writes `--port-file`, spawns everything. |
| 15 | `headless_project.rs` line ranges drifted (480-566, 512-517, 518-530, 568-580). | **Accepted.** Verified; §2/§3.10 corrected. |
| 16 | `remote_client.rs` line ranges drifted (459-462, 670-676, 692-700, 1910-1930). | **Accepted.** Verified; §2 corrected. |
| 17 | hyper `[features]` table is 69-106; `server` at 101-105. | **Accepted.** Verified; §2 corrected. |
| 18 | Startup log line self-contradictory and not producible by `ServeLogRecord`. | **Accepted.** §3.9 example is now `"message":"listening on 127.0.0.1:8443"` with only the record's fields. |
| M1-M4 | Missing: `pub mod session`, crash-handler type, `prost` trait, `extension_host_proxy`. | **Accepted** (covered by 1-4). |
| M5 | `WebSocket<HttpStream>: Send` unverified. | **Accepted as a compile-time assertion.** Verified `WebSocket<S>` fields (mod.rs:733-738) contain no `Rc`/`RefCell` and `HttpStream::Hyper(TokioIo<Upgraded>)`; `WakeProxy`'s internals not read. §3.7 adds a `const` `assert_send::<WebSocket<HttpStream>>()`. |
| M6 | `async_tar::Builder<W>` requires `W: Send + Sync`. | **Accepted.** Verified builder.rs:40-47. §3.6 states `ChannelWriter` (a `futures::mpsc::Sender`) satisfies it. |
| M7 | Broker must drain after the reset / honour `RemoteStarted`-first. | **Accepted** via the channel-swap design (finding 6). |
| M8 | `iat` semantics must be implemented or dropped. | **Accepted** (finding 5). |
| M9 | Fresh reset contradicts BUILD-SPEC §4.2 more strongly; needs sign-off. | **Accepted** (finding 7; §7.1). |
| M10 | BufferStore leak needs a decision. | **Accepted** (finding 13). |
| M11 | `ShutdownRemoteServer`: Ack must precede the close. | **Accepted.** §3.7 step 8 `flush_then_close` drains, waits `CLOSE_GRACE`, drains again, then closes; test `close_session_delivers_ack_first`. |
| M12 | Length-prefix deviation must be aligned with W1. | **Accepted** (finding 8). |
| M13 | CLI names vs. supervisor. | **Accepted with aliases** (finding 9). |
| M14 | hyper-util `service` feature listed in §2 but not needed. | **Accepted.** Verified hyper-util Cargo.toml:101 (`service = ["dep:tower-service"]`); `service_fn` is `hyper::service`. Removed from §2; `tokio` feature kept (needed for `TokioTimer`). |
| M15 | Construction order of `ServeState`/broker/listener. | **Accepted** (finding 14). |
| M16 | gpui headless `quit` making `Application::run` return is an unstated assumption. | **Accepted.** Verified for Linux (gpui_linux platform.rs:280-282 → `signal.stop()`); stated in §3.9 and §7.11 with the macOS caveat. |

Reviewer 2 (severity: major)

| # | Finding | Decision |
|---|---|---|
| 1 | `iat` not validated. | **Accepted** (same as R1-5). |
| 2 | `normalize_lexically` accepts absolute/empty; percent-decoding needed. | **Accepted** (same as R1-11; percent-decoding added to §3.6 and tests). |
| 3 | Fresh-session ordering; suggest reusing `ChannelClient::reconnect` with a new channel pair. | **Accepted, suggestion adopted.** Verified `reconnect` restarts `start_handling_messages` (1878-1886 → 1735-1738) but does not clear `buffer`/`max_received`/response channels, so `begin_fresh_session` clears those first, then calls `reconnect`. `reset_for_fresh_client` removed. |
| 4 | Fresh = cold LSP too; warm join is W2. | **Accepted** (same as R1-7). |
| 5 | 409 race: two non-takeover upgrades both pass; second silently replaces the first. | **Accepted with a different fix.** Instead of an `attach_pending` slot, the pre-upgrade 409 is removed (browsers cannot read it; b1 carries `takeover` in the Hello) and the broker is the single decision point: a different client instance without `takeover` is closed with new code 4005; a same-instance redial replaces the old socket (needed because a half-open socket cannot be detected quickly). Tests `second_instance_without_takeover_closes_4005`, `same_instance_redial_replaces`. |
| 6 | Hello exchange and socket writes inside the broker task stall takeover/SIGTERM. | **Accepted.** Verified yawc `poll_flush` writes through (1265-1285) and that `WebSocket<S>` has no owned split (split.rs halves take `&mut S`), so the fix is: Hello in the per-connection task; one session task per socket owning reads and writes with `WRITE_TIMEOUT`; the broker pushes into a bounded frame channel that a command can preempt; `with_backpressure_boundary`; tests `slow_consumer_does_not_block_broker`, `upgrade_never_completing_is_dropped`. |
| 7 | Global pre-verification 429 limiter is a DoS on the legitimate user. | **Accepted.** Replaced by a verification semaphore plus a failure delay held under the permit; no 429; valid tokens are never refused. Test `valid_token_not_blocked_after_failures`. |
| 8 | `p256 0.11.1` and `tokio-tungstenite` are in Cargo.lock (not in this crate's tree); `multer` absent from the registry. | **Accepted.** Verified all three. §2 reworded; §3.1/§7.8 note the first-build fetch. |
| 9 | `SHUTDOWN_TIMEOUT` is 200 ms and only logged; the 10 s bound cannot observe it. | **Accepted.** Verified app.rs:78, 978-1003. §7.11 documents it; the orderly flush is b4/b8's `POST /control/lifecycle {stopping}` before SIGTERM. |
| 10 | Prefix removal contradicts the spec and b1. | **Accepted** (same as R1-8). |
| 11 | CLI names and env-var PEM input. | **Accepted for the names (aliases); rejected for the env-var PEM.** b8 and b9 (rotation, line 133) already materialise PEM files and pass `--jwt-public-key` twice; adding a second input path buys nothing. Recorded in §7.13. |
| 12 | `rust_crypto`/`aws_lc_rs` provider conflict panics in unified builds. | **Accepted.** Verified crypto/mod.rs:104-125 and that no workspace crate enables `rust_crypto` today. §3.5 documents the constraint and adds `provider_is_available`. |
| M1 | CORS absent; browser `/files` cannot work. | **Accepted.** Verified BUILD-SPEC §3.6 (cross-origin fetch with `Authorization`) and b9's CSP already includes `https://*.vercel.run`. Added `--allowed-origin`/`ZS_ALLOWED_ORIGINS`, preflight handling, response headers, `/rpc` Origin check; tests added; b8/b9 hand-off noted in §7.13. |
| M2 | Reconnect trust: server must decide `SessionKind`; `sid`-based rule. | **Accepted, refined.** b9 resolves `sid` as stable per sandbox generation **and shared by every tab**, so `sid` alone cannot identify the resuming instance; the rule is `(sid, identifier)` match plus `Hello.session_id == claims.sid` (else 4003). `resumed:false` after `reconnect:true` is the contract for "cannot replay"; b1 side noted in §7.4. Tests `reconnect_to_fresh_process_is_not_resumed`, `reconnect_from_other_instance_is_not_resumed`. |
| M3 | Unsaved buffers / worktree entity leak; `forget_shared_buffers`; `dirty_buffers` in health; 409 on takeover with dirty buffers. | **Accepted except the 409.** `forget_shared_buffers` and the dirty count are in §3.10 and `/health`; a pre-upgrade 409 is gone (R2-5), and the take-over confirmation belongs to the shell page, which can read `/health.dirty_buffers`. |
| M4 | Stale responses from in-flight handlers after a fresh attach. | **Accepted, strengthened.** Verified handlers are detached (1824-1858) and response routing (1782-1818). Rule: after a fresh attach drop outgoing envelopes whose `responding_to` exceeds the highest id received from this instance. Test `stale_response_dropped_after_fresh`. |
| M5 | Windows build: `tokio::signal::unix` does not compile there. | **Accepted.** Verified `clippy_windows`/`run_tests_windows` and `clippy.ps1:28 --workspace`. `signal_task` is `cfg`-split; `%COMSPEC%` fallback; cfg(windows) branch kept in `build_headless_project`. |
| M6 | Token expiry mid-session unspecified; strip `zs_token` from logs. | **Accepted.** Policy written into §4; `redact_query` added; integration step 9 covers expired-token `/files` while the session lives. |
| M7 | `AuthError` mapping table and multi-key precedence undefined. | **Accepted.** Table in §3.5 (`map_error`), precedence rule, note that HS256 is stopped by the `algorithms` allowlist (decoding.rs:281-283). Test `rotation_reports_specific_error`. |
| M8 | `/files` hardening gaps (early 413, `MAX_FILES_PER_UPLOAD`, `follow_symlinks(false)`, percent-decode, `Claims` into upload, stale temp cleanup). | **Accepted in full.** Verified async-tar follows symlinks by default (builder.rs:53,69). All six are in §3.6 with tests. |
| M9 | Slow-consumer / large-frame tests missing. | **Accepted.** Three tests added in §6.3; the writer refuses frames over 16 MiB. |
| M10 | `is_input_envelope` counts replay as activity. | **Accepted.** Replayed ids (≤ the highest id previously received from this instance) do not touch the idle clock (§3.7 step 6); `activity_excludes_pings_and_replay`. The "first N seconds after attach" variant was not adopted: a deliberate reload is user activity. |
| M11 | No regression coverage for the `execute_run` extraction; `cargo shear`; musl CI. | **Accepted.** Verified `remote_editing_tests.rs` never calls `execute_run`, `run_tests.yml:708` runs shear. Added `tests/run.rs`, kept the extraction move-only, all deps referenced, musl CI job in §5. |
| M12 | `ZS_BUILD_ID` stale without `rerun-if-env-changed`. | **Accepted.** Verified build.rs:31-33. §3.13 added; b1's `crates/remote` needs the same (§7.4). Reusing `ZED_BUILD_ID` was not adopted: it is a GitHub run number, while `ZS_BUILD_ID` is the image/commit id b8 bakes in. |
| M13 | HTTP listener hardening (timer, header timeout, `max_buf_size`, upgrade timeout, SIGTERM with no session). | **Accepted.** Verified `header_read_timeout` panics without a `Timer` (http1.rs:342). §3.8 builder settings, `UPGRADE_TIMEOUT`, `shutdown_without_session_is_immediate` and integration step 13. |
| M14 | Wire constraints for the wasm client half (123-byte reasons, `?zs_token=` for downloads, expose headers, echoed subprotocol). | **Accepted.** Stated in §4. |
| M15 | Upstreamability: feature-gate serve; reuse `reconnect`; replace the `ServeMode` global with a callback. | **Accepted in full.** `serve` cargo feature (§3.4/§5), `reconnect` reuse (R2-3), `HeadlessAppState.on_shutdown_request` (§3.10); a separate `serve-files` feature was not added (multer alone is the cost, §7.8). |
| M16 | Multi-user takeover state carry-over. | **Accepted minimally.** `sub` change logged at warn on attach; user-settings reset deferred to W2 (§7.14). *Superseded by D3 – the reset is now in §3.10; see §9.* |

Post-review amendments (2026-09-02, after `DECISIONS.md`): the entries above record the state the reviewers saw. Three of their outcomes were later changed by the tech lead's decisions and are marked here so the log stays honest: R1-2/M2 (`on_shutdown_request` on `HeadlessAppState`) became a setter on `HeadlessProject` because the struct has 25 construction sites (§2, §3.10); R2-5 (same-`identifier` redial replaces) and R2-M2 (`(sid, identifier)` resume key) were replaced by b1 §4.4's epoch arbitration under D1/D3/D20 (§3.7); R2-M16 is resolved by D3. The full decision-by-decision record is §9.

## 9. Reconciliation log

Applied on 2026-09-02 against `docs/briefs/DECISIONS.md` and the sibling briefs' §7/§8 items addressed to b2. Every row names what changed in this brief; "no change" rows record why a decision does not touch serve. Anything this brief could not settle is in §7.16-§7.21.

### 9.1 Decisions

| Decision | Effect on this brief |
|---|---|
| D1 Identity | `Claims.sid`, `SessionMeta.session_id`, `HelloAck.session_id`, the `ServeLogRecord` field and `/health.session` now carry a **per-connect, informational** session id; the `Hello.session_id != claims.sid` → 4003 close is gone (warn log instead, §3.7); resume no longer keys on `sid` at all (epoch, D3). `ws` (`--workspace-id`) is the stable identity. §1, §2 (b9 row), §3.5, §3.7, §4, §6.3 (`hello_session_id_mismatch_is_logged`), §6.4 steps 3/10/12, §7.3. |
| D2 Reconnect budget | Client-side (b1). No change; §4 keeps 4001/4002/4004/4005 terminal and 1000-1013/4003 reconnectable, which is what D2's budget applies to. |
| D3 Session semantics | Arbitration rewritten to b1 §4.4: reconnect = `Hello.reconnect && epoch == current_epoch` → warm attach, replay, supersede a half-open same-epoch socket with 1001; fresh = `reconnect:false` → `reset_for_new_client` (worktrees → LSP/git/local settings, plus user settings reset to `{}` = "settings observer restart") and a new epoch; stale epoch → 4001; busy → `CLOSE_SESSION_BUSY` 4005; SIGTERM stays 4004 (§7.19). PTYs live in b3's server-level `PtyManager`, untouched by the reset; `detach_all` via the new `ServeHooks::session_detached` → `GpuiCommand::SessionDetached`; `kill_all` only from `Quit`/`on_app_quit`. Server `Heartbeat` every 5 s (and client heartbeats accepted, §7.18); 16 MiB both ways unchanged. §1, §2, §3.7, §3.9, §3.10, §4, §6.3, §6.4, §7.1, §7.3, §7.14. |
| D4 Terminal restore (b3) | Serve keeps terminals alive across fresh sessions and detaches on session exit so `ListTerminals`/`AttachTerminal { from_offset: 0 }` work for the next client; §4 semantics, §6.4 step 14 (b3-owned). |
| D5 Control listener | New `--control-listen` (default `127.0.0.1:8446`, loopback enforced), `--control-secret-file` (required), `serve_control`/`route_control` for `POST /control/{lifecycle,ports,extensions}` → b4's `ControlChannel::handle`; `/control/*` on the public listener is a hard 404; `--allowed-origin` documented as fed from `manifest.allowedOrigins`. §1, §3.8, §3.9, §4 control contract, §6.3 (`control_routes_only_on_control_listener`, `control_listen_must_be_loopback`), §6.4 steps 1-2, §7.13, §7.16 (port clash). |
| D6 Unsaved buffers | Client-side. §3.10 and §7.2 note that D6 covers `STOPPING` only; `/health.dirty_buffers` and the take-over warning stay. |
| D7 Client-state store | b4/b7. Only touchpoint: `SaveClientState`/`LoadClientState` excluded from `is_input_envelope` (already via b4 item 6). |
| D8 Private ports | Supervisor/control plane. No serve change; the proxy-slot range overlaps b8's 8445/8446 – recorded in §7.16. |
| D9 Rebuild tarball | Data dir (`$HOME/.local/share/zed`) carries b4's client state and extensions; serve writes nothing else there. §7.20 notes what survives a prebuild snapshot under D3. |
| D10 Vendored deps | `yawc` evidence rows repointed to `vendor/yawc` (line numbers from rev `71a452f`); §2 `Cargo.toml` row and §5 explain the path `[patch]` (b1 owns it). `async-tar` is not in D10's list and stays a git dep. |
| D11 Wasm home | Not applicable (client). |
| D12 Web keymap | Not applicable (client). |
| D13 Activity ping | `/health.last_input_at` is the source of `lastInputAt`; `busy`/`phase`/`cpuBusyPct` are the supervisor's. §2 b8 row, §4. No shape change. |
| D14 Prebuild | b8 owns `zs-agent prebuild`; serve treats the prebuild client as an ordinary fresh session (§7.20). |
| D15 AI proxy | Not applicable. |
| D16 Shell entry point | Not applicable (b1/b7). |
| D17 Terminal ownership | b3 owns `remote_pty.rs`; serve consumes `PtyManager::{detach_all, kill_all}` only (§2 b3 row, §7.17). |
| D18 Supervisor contract | §2 b8 row and §7.13 updated: no `ZS_CONTROL_SECRET` in the environment (serve scrubs a stray one, §3.9 `read_control_secret`), control calls to `127.0.0.1:8446`, stopping budget > 5 s (b4's `STOPPING_FLUSH_TIMEOUT`), `--allowed-origin` from the manifest. |
| D19 Control-plane contract | `manifest.allowedOrigins` → `--allowed-origin` (§3.9, §7.13); `aud` semantics in §2 b9 row. |
| D20 serve contract | `is_input_envelope` excludes `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` (b3) and `SaveClientState`, `LoadClientState`, `ListExtensions` (b4); `detach_all` on detach, never `kill_all` on fresh; b4's six items (flags, secret handling, control listener, asset route, `GpuiCommand` variants, exclusions) in §3.6-§3.9; b1 §7.12 items (arbitration with supersede, epoch, 4005, warm attach on reconnect with replay-state reset on fresh, `Heartbeat`, 16 MiB, `ZS_LISTENING=`, `Log` frames, echoed `zs.v1`, no `permessage-deflate`) in §3.7-§3.9 and §4; §7.4 records the status of each. |

### 9.2 Sibling deltas addressed to b2

| Source | Item | Change here |
|---|---|---|
| b1 §7.4 | Warm attach on `reconnect:false` must be delivered or flagged. | Overridden by D3 (cold project on fresh, warm on reconnect); flagged as decided in §7.1, not silently chosen. |
| b1 §7.12 / §4.4 / §6.3 preconditions | `ZS_LISTENING=` stdout line; 401-only pre-upgrade; arbitration; codes 4001-4005; `HelloAck.epoch`; `Heartbeat`; no deflate; `Log` frames; 16 MiB; echo `zs.v1`; spawn line. | `ZS_LISTENING=`/`ZS_CONTROL_LISTENING=` added (§3.9); arbitration and epoch implemented (§3.7); `Heartbeat` and `Log` emitted (§3.7, §3.9); 401/403/426 refinement recorded (§7.4e); b1's spawn line needs `--control-secret-file`, `--audience`, `--workspace-root` (§7.21). |
| b1 §8 R-12 | Wire module is `remote::websocket_wire`, not `remote::transport::websocket::wire`. | Every import path updated (§2, §3.3, §3.5, §3.7); query-param constants moved into `serve/auth.rs` because b1 removed them (§3.5). |
| b3 §7.1(a), §3.8 idle accounting | Exclude `AckTerminalOutput`/`ResizeTerminal`/`ListTerminals`/`AttachTerminal` from `is_input_envelope`. | Done (§3.7, §6.3). |
| b3 §7.1(b), §7.4 | `detach_all()` on session detach. | `ServeHooks::session_detached` → `GpuiCommand::SessionDetached` → `PtyManager::detach_all()` (§3.7 step 7, §3.9). |
| b3 §7.1(c) | `MAX_FRAME_BYTES ≥ 64 KiB + overhead`. | Holds at 16 MiB; noted in §2 b3 row. |
| b3 §7.8, §3.10 | `begin_fresh_session` calls `kill_all()` until restore lands. | **Rejected by D3/D4/D20**: never `kill_all` on a fresh session; terminals survive and the client re-attaches them. b3 must drop that call (its follow-up "restore" is now in scope per D4). §3.7, §3.10, §7.17. |
| b3 §2 (`:298-303`, `:116-122`, `:357-362`) | Cites `reset_for_fresh_client`, `ServeHooks { begin_fresh_session, request_quit }`. | Current names are `ServerChannel::begin_fresh_session` + `HeadlessProject::reset_for_new_client`, and `ServeHooks` has four methods (§3.2, §3.7); b3's citations are stale, no b2 change. |
| b4 §3.15 item 1, §7.2, §7.8 | `--control-secret-file` (required), `--supervisor-url`, `--control-listen`; read the secret before any spawn; scrub `ZS_CONTROL_SECRET`. | Done (§3.9 `ServeArgs`, `read_control_secret`, step 1). |
| b4 §3.15 item 2 | `enable_sandbox(SandboxConfig {..})` after `build_headless_project` with a proxy-less `ReqwestClient` and `RegistryConfig`. | Done (§3.9 step 2). |
| b4 §3.15 item 3 | Loopback-only listener for `/control/*`; never on the public listener. | Done (§3.8 `serve_control`/`route_control`; public 404). The earlier `ControlRoutes` trait now mirrors `ControlChannel::handle`'s signature. |
| b4 §3.15 item 4, §7.12 | `GET /extensions/{id}/assets/{rel}` with `/files` auth → `HeadlessExtensionStore::asset_path`. | Done (§3.6 `handle_extension_asset`, §3.8 route + CORS, §3.9 `GpuiCommand::ResolveExtensionAsset`, §6.2 tests). |
| b4 §3.15 item 5 | `GpuiCommand::{SessionAttached, FilesUploaded}` → `on_session_attached` (Fresh) / `notify_files_uploaded`. | Done (§3.6, §3.7 step 4, §3.9); the old `session_attached` no-op and the `current_ports_message()` hook are gone. |
| b4 §3.15 item 6 | Exclude `SaveClientState`, `LoadClientState`, `ListExtensions` from the idle clock; extend the test. | Done (§3.7, §6.3). |
| b4 §3.14 / §8 R1-1 | `HeadlessAppState` has 25 construction sites. | Re-verified; this brief's own `on_shutdown_request` field replaced by `HeadlessProject::set_shutdown_request_handler` (§2, §3.10, §3.11, §4). |
| b5 §7.19 | b1/b2 depend on the `Instant` swaps and `smol` stubs. | Native-only server; no change (serve uses `std::time::Instant` on the server side only). |
| b8 §2 (`:32-33`), §3.7 spawn line | Spawn line built from this brief's flags; `/health` polled on `127.0.0.1:8443`. | Flag set extended (D5/D18) and recorded in §2 b8 row and §7.13; `HealthResponse` shape unchanged (`session` gains `session_id`/`epoch`, which b8 models as opaque JSON). |
| b8 §7.17 | Snapshot dirty buffers server-side on `stopping`. | Superseded by D6 (client-side `unsaved_buffers` table); §3.10/§7.2 say so; no server snapshot. |
| b8 §7.26, §8.12 | `RESUMED` held until `session_active` because b2 drops queued envelopes on Fresh. | Still true and now formalised: b4's `on_session_attached` replays a pending `Resumed` after every Fresh attach (§3.7 step 4), so b8's hold is belt-and-braces. |
| b9 §7.3, §8.6 | `sessionId === sid === workspaceId`; b2 keys resume on `(sid, identifier)`. | Superseded by D1/D3: `sid` per connect, resume by epoch (§3.7, §7.3). b9's claim minting must follow D1 (its change). |
| b9 §7.5, §8.22 | `?zs_token=` survives only for `/files` downloads. | Confirmed; constants moved into `serve/auth.rs` (§3.5); §4 notes the access-log exposure. |
| b9 §4.7, §8 M1/16 | `manifest.allowedOrigins` → `--allowed-origin`; CORS covers `/files` and `/extensions/*`. | `/extensions/*` added to the CORS set and `Cross-Origin-Resource-Policy: cross-origin` added for COEP (§3.8). |
| b9 §8.10 | Control plane polls `:8445` (supervisor), not this listener. | Unchanged (§7.12). |

### 9.3 Contract pass (2026-09-02)

Cross-brief mismatches found by the CONTRACTS.md audit and fixed here (b2 is the consumer or the owner as noted):

- `DEFAULT_SUPERVISOR_URL` is defined in b4 §3.11 `crates/remote_server/src/ports.rs`, not `control.rs`: §3.9 `ServeArgs` now reads `crate::ports::DEFAULT_SUPERVISOR_URL` and §4 lists it under `ports::{…}` (§2 already attributed it to `ports.rs`).
- Query-string token placement: `?zs_proto=`/`?zs_token=` are accepted on `/rpc` only as a documented, unused server-side superset — b1 §4.3 sends the subprotocol list from both native and wasm, and the query form exists for `/files` downloads alone. §2 (b1 row), §3.5 doc comment and the §4 request example no longer describe a "wasm `/rpc` fallback" or "wasm uses the query form"; §6.3 `rpc_without_subprotocol_is_426` still exercises the superset.
- `HelloAck` has no `version` field: §2 `VERSION` row now says `/health.version` and `HelloAck.build` (when `ZS_BUILD_ID` is unset), matching §3.7 step 4 and b1 §4.2.
- b3 §3.9 adds `pub mod pty;` (public), not `pub(crate)`: §2 and §3.11 corrected.
- `--audience` doc comment: the expected `aud` is `manifest.jwt.audience` (control-plane owned, defaults to the sandbox name, rotatable — b8 §3.9), as §2's b9 row already said.
- §3.7 step 1: `Hello { reconnect: true, epoch: None }` is `Fresh`, not "stale epoch" — the second rule now requires `hello.epoch.is_some()` and the third accepts `hello.epoch.is_none()`, so the parenthetical and CONTRACTS §1.5 step 3 hold literally.
- §3.7 `run_session` doc: the server never times out a socket on missing client `Heartbeat` frames (b1 §7.12(f), ≥ 90 s gaps in hidden tabs); liveness is the TCP/WebSocket close only. Previously implied, now stated.
- §7.21: b1 §6.3 already carries `--control-secret-file`/`--audience`/`--workspace-root`; the remaining ask is `--control-listen 127.0.0.1:0` (b1 added it) so parallel tests and `tests/serve.rs` never share 8446.
