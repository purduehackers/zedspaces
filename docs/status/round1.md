# Round 1 integration status (2026-09-03)

Integrator pass over the round-1 lanes: b1 (WebSocket transport, workspace persistence), b2 (`zed-remote-server serve`), b3 (terminal proto, server PTYs, client terminals) inside `zed/`; b8 (`sandbox/supervisor`, `sandbox/image`) and b9 (`apps/web`) outside it. Plan of record: `docs/briefs/DECISIONS.md` (D1-D34) over `docs/briefs/CONTRACTS.md` over the briefs.

Bottom line: every lane compiles together with zero rustc warnings, every new test passes, and the only cross-lane fix needed was one constant (§3). The gaps are the not-yet-landed lanes (b4, b5-b7) and the seams that wait for them (§5).

## 1. What each lane delivered

### b1 — WebSocket transport, identity, persistence, entry point (`zed/`)

Files (new): `crates/remote/src/transport/websocket.rs` (1336 lines: `WebSocketConnectionOptions`, `WebSocketRemoteConnection`, `WebSocketSession`, `WebSocketSessionRefresh`/`RefreshError`/`RefreshReason`, `CloseInfo`, `client_build_id`, `set_session_refresh_provider`, `WS_MAX_RECONNECT_ATTEMPTS = 20`, `exit_code_for_close`, `exit_code_for_hello_ack`), `transport/websocket/{wire.rs, dial_native.rs, dial_web.rs, tests.rs}`, `crates/remote/build.rs` (`rerun-if-env-changed=ZS_BUILD_ID`), `vendor/yawc` + `vendor/README.md` (D31 shape), `tools/ws-transport-wasm-check/` (throwaway wasm compile check, its own workspace).

Files (changed): `crates/remote/src/{remote.rs, remote_client.rs, remote_identity.rs, protocol.rs, proxy.rs, transport.rs, transport/mock.rs, Cargo.toml}`; `crates/workspace/src/{workspace.rs, persistence.rs, persistence/model.rs, Cargo.toml}`; `crates/remote_connection`, `crates/recent_projects` (3 files), `crates/title_bar`, `crates/zed/src/{main.rs, zed/open_listener.rs}`, `crates/project/src/trusted_worktrees.rs`, `crates/extension_host` (D27 `supports_extension_upload` gate), `crates/gpui_tokio` (`Tokio::try_handle`), root `Cargo.toml` (`exclude = ["vendor/yawc"]`, `[patch]` for yawc, workspace deps `http-body-util`, `hyper`, `hyper-util`, `multer`, `subtle`), `Cargo.lock`.

Contract items verified in code: `wire.rs` constants (`SUBPROTOCOL`, `PROTOCOL_VERSION`, `MAX_FRAME_BYTES`, `HEARTBEAT_INTERVAL_SECS`, `ZS_BUILD_ID`, `builds_compatible`); close codes per D23 (`CLOSE_GOING_AWAY` 1001, 1008, 1009, `CLOSE_TAKEN_OVER` 4001, `CLOSE_BUILD_MISMATCH` 4002, `CLOSE_UNAUTHORIZED` 4003, `CLOSE_SESSION_ACTIVE` 4005, `CLOSE_BAD_HELLO` 4006; no 4004); `Hello.instance` per-boot nonce (D25); `RemoteConnection::{max_reconnect_attempts, supports_remote_pty, supports_extension_upload}` (D27; WebSocket returns 20/`true`/`false`); `RemoteConnectionIdentity::WebSocket { workspace_id }` and `RemoteConnectionKind::WebSocket` persistence keyed on `workspace_id` only (D1/D26); `workspace::open_remote_project_in_new_window_with_client` + `OpenedRemoteProject` (D16); `ProxyLaunchError::{SessionTakenOver = 91, IncompatibleServer = 92}`; `encode_envelope_frame`/`decode_envelope_frame`; `ServerChannel`/`ChannelEnds`/`RemoteClient::server_channel_from_channels` with a session generation so late handler responses of a replaced session are dropped.

Tests: `transport/websocket/tests.rs` 32, `wire.rs` 4, `remote_client.rs` 2 new (server channel), `remote_identity.rs` 1 new, `protocol.rs` 2, `proxy.rs` 1, `gpui_tokio` 1, workspace persistence (`remote`/`websocket` filters) 13.

### b2 — `zed-remote-server serve` (`zed/crates/remote_server`)

Files (new): `src/serve.rs` (CLI `ServeArgs`, `execute_serve`, `PtyHooks`, `ProjectHooks`/`DefaultProjectHooks`, `PendingControlRoutes`, `GpuiHooks`, gpui command loop, signal task, JSON serve logger), `src/serve/{auth.rs (ES256 JWT, aws_lc_rs), files.rs (/files upload/download, tar, traversal rules), http.rs (public + control listeners, CORS, /health), session.rs (SessionBroker: Hello arbitration, epoch, warm/fresh attach, heartbeat, 90 s dead detection, replay watermark, is_input_envelope), test_support.rs}`, `tests/{serve.rs, run.rs, fixtures/*.pem, fixtures/control_secret}`.

Files (changed): `Cargo.toml` (feature `serve`, default-on; `jsonwebtoken` with `aws_lc_rs` only; hyper/tokio/multer/subtle/yawc optional), `build.rs` (`ZS_BUILD_ID`), `src/main.rs` (usage line), `src/server.rs` (`pub mod serve`, `Commands::Serve`, `execute_run` split into `build_headless_project`/`init_crash_handler`/`init_rayon_pool`/`set_user_data_dir`, new `--user-data-dir` on `run`), `src/headless_project.rs` (`reset_for_new_client`, `set_shutdown_request_handler`, serve-aware `handle_shutdown_remote_server`), `crates/remote/src/remote_client.rs` (`ServerChannel::{proto_client, replace_buffered, begin_fresh_session}` per CONTRACTS §5.4), `CONTRIBUTING.md` (jsonwebtoken backend note).

Contract items verified in code: `DEFAULT_SUPERVISOR_URL = http://127.0.0.1:8450`, `DEFAULT_CONTROL_LISTEN = 127.0.0.1:8451` (D21); server→client `Heartbeat` every 5 s plus protocol ping every 5 s, `DEAD_AFTER` 90 s → 1008 (D22); D23 codes imported from `wire.rs` (`CLOSE_SUPERSEDED = CLOSE_TAKEN_OVER`, `CLOSE_STOPPING = CLOSE_GOING_AWAY`); arbitration on `(workspace_id, instance)` (D25); `ServeHooks::{begin_fresh_session, session_attached, session_detached, replace_buffered, request_quit}` (D27); `is_input_envelope` excludes `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` (D20); `detach_all` on `SessionDetached`, `kill_all` only on `Quit` (D24); stale epoch → 4001 "stale epoch"; `--control-listen` must be loopback; `ZS_CONTROL_SECRET` scrubbed, secret from `--control-secret-file` (D18).

Tests: `serve` filter 95 (session 29, auth 18, files 25, http 14, serve.rs 2, plus the lib-level ones), `tests/serve.rs` 5 (`serve_end_to_end`, upload/download round trip, CLI rejections, SIGTERM exit), `tests/run.rs` 1.

### b3 — terminals (`zed/`)

Files (new): `crates/proto/proto/terminal.proto` (tags 488-499: `SpawnTerminal`…`AttachTerminalResponse`), `crates/remote_server/src/pty.rs` (1723 lines: `PtyManager::{new, global, install, spawn, write, resize, ack, attach, detach, detach_all, list, close, kill_all, child_pid}`, `GlobalPtyManager`, `TerminalOutputSink` for `AnyProtoClient`, ring `OutputStream`, constants `SCROLLBACK_CAPACITY` 2 MiB, `OUTPUT_WINDOW` 512 KiB, `OUTPUT_CHUNK` 64 KiB, `EXIT_DRAIN_TIMEOUT`, `KILL_ESCALATION_DELAY`, `MAX_TERMINALS` 64), `crates/terminal/src/remote_pty.rs` (1131 lines: `TerminalType::Remote` side, `RemotePtyHandle`, `ProtoPtyTransport`).

Files (changed): `crates/proto/proto/zed.proto` (import + envelope tags), `crates/proto/src/proto.rs` (`messages!`, `request_messages!`, `entity_messages!`), `crates/remote_server/src/headless_project.rs` (`pty_manager` handle, 7 terminal handlers with input-size limits), `crates/remote_server/src/remote_editing_tests.rs` (+5 end-to-end terminal tests), `crates/terminal/src/{terminal.rs, alacritty.rs (reset_term)}`, `crates/project/src/{terminals.rs (+1404: spawn_remote_terminal, fetch_remote_terminal_inventory, restore_remote_terminal, reattach_remote_terminals, handle_terminal_output/exited, INPUT_CHUNK), project.rs}`, `crates/terminal_view/src/{persistence.rs (terminals.remote_terminal_id, remote_title), terminal_panel.rs, terminal_view.rs (D4 restore, D28 recreate)}`, `crates/task/src/task.rs` (`ExitStatus` alias/wasm struct, `shell_from_proto`), `crates/acp_thread`, `crates/agent_servers`, `crates/workspace/src/tasks.rs` (use `task::ExitStatus`), `crates/remote/src/transport/mock.rs` (`remote_pty` flag, `fake_server_with_remote_pty`), `crates/remote_server/Cargo.toml` (`libc`, `parking_lot`, `portable-pty`; dev `terminal`, `prost`).

Contract items verified in code: D4 restore (`ListTerminals` → `AttachTerminal { from_offset: 0 }` into restored panes, unrestored ones closed, exited ones not restored); D28 (a terminal the server no longer has is recreated as a fresh shell in its persisted cwd, `terminal_view.rs:1983`); D27 (`Project::supports_remote_pty` gate); PTYs survive fresh sessions (`reset_for_new_client` never touches the manager).

Tests: `pty.rs` 17, `terminal` `remote` filter 20, `project` `remote` filter 14 (+4 pre-existing integration tests matched by the filter), `terminal_view` `remote` filter 7, `remote_server` `terminal` filter 5 (`test_remote_terminal_roundtrip`, `test_remote_task_terminal_reports_exit_code`, `test_fresh_client_restores_terminal_with_scrollback`, `test_unrestored_terminals_are_closed`, `test_exited_terminal_is_not_restored`).

### b8 — supervisor and image (`sandbox/`)

`sandbox/supervisor` (standalone workspace, `zs-agent`, Rust 1.97.1, musl): 17 modules (`config`, `manifest`, `control_plane`, `logs`, `ports`, `state`, `server`, `port_auth`, `proxy`, `api`, `credential`, `bootstrap`, `activity`, `start`, `warm`, `proto`, `lib/main`), `proto/zs_warm.proto`, `README.md`. `sandbox/image`: `Dockerfile`, `base.lock`, `build.sh`, `build-server.sh`, `test/{mock-control-plane.mjs, fake-zed-remote-server.py, run-local.sh}`, `README.md`. Shared contract docs: `docs/contracts/{sandbox-api.md, sandbox-manifest.v1.json, fixtures/manifest.example.json, fixtures/port-token.vector.json}`. CI: `.github/workflows/sandbox-image.yml`.

Contract items verified in code: D21 (`RPC_PORT` 8443, `PROXY_SLOTS` 8444-8447, `HEALTH_PORT` 8448, `LOCAL_API_PORT` 8450, `SERVER_CONTROL_PORT` 8451, `INFRA_PORTS` 8443-8451, `DEFAULT_SUPERVISOR_URL`); D22 (warm client expects server→client heartbeats); D28 (child env exports `SHELL`, `HOME`, `USER`, `PATH`, `LANG`, tested in `server.rs`); D29 (`ZS_CONTROL_URL` canonical, `ZS_CONTROL_PLANE_URL` not read but scrubbed); no `ZS-TODO` markers.

Tests: 100 unit tests; integration `api.rs` 5, `log_shipper.rs` 5, `proxy_roundtrip.rs` 6, `proto_tags.rs` 2 (reads `../../zed`), `warm_client.rs` 1, `port_watcher_live.rs` (Linux only, 0 here), `start_against_fake_server.rs` 8 and `warm_against_serve.rs` 1 (env-gated; run explicitly, see §2).

### b9 — control plane (`apps/web`)

Next.js 16 app: `lib/` (env, schema + drizzle migrations, db, auth, editor cookie, tokens, port tokens, crypto, usage/plans, api helpers, types, redis/ratelimit, connect, lifecycle, manifest, shell, zed-web host types), `app/(site)` dashboard, `app/(editor)/w/[id]` shell (`editor-shell.tsx`, `shell-phase.ts`, host `reconnect()` per D30), `app/api/{workspaces, sandboxes, repos, me, secrets, admin, webhooks, cron}`, `workflows/` (8 workflows, 118 steps), `proxy.ts`, `public/editor/dev-0` stub, `scripts/`, `README.md`. CI: `.github/workflows/web.yml`.

Contract items verified in code: D21 (`INFRA_PORT_MIN/MAX` 8443-8451, `ZS_PROXY_SLOTS` default `8444,8445,8446,8447`, `ZS_HEALTH_PORT` 8448); D26 connect response `{ wsUrl, token, sessionId, workspaceId, serverBuild, sessionExpiresAt }` (plus `clientBuild`, `sessionCapAt`, `audience`); D29 (`ZS_CONTROL_URL` = `controlApiBase()`, `LifecycleKind` snake_case, `ActivityDirective { idleStopAt, sessionCapAt, stop, forwards, serverTime }`); D23 close-code vocabulary in `shell-phase.ts`; no `ZS-TODO` markers.

Tests: `pnpm test` 46 files / 362 tests; `pnpm test:integration` 4 files / 6 tests.

## 2. Verification commands and results

All run on 2026-09-03 on macOS (Darwin 27.0.0), Rust from `rust-toolchain.toml`, pnpm 11.

| # | Command (cwd) | Result |
|---|---|---|
| 1 | `cargo check -p remote -p remote_server -p terminal -p project -p terminal_view -p workspace -p proto` (`zed/`) | `Finished` in 39 s; **0 warnings, 0 errors** (only the pre-existing upstream `block v0.1.6` future-incompat note) |
| 2 | `cargo check -p zed` (`zed/`) — covers b1's touches to `recent_projects`, `title_bar`, `extension_host`, `agent_servers`, `acp_thread`, `gpui_tokio`, `remote_connection`, `task`, `zed` | `Finished` in 35 s; 0 warnings |
| 3 | `cargo test -p remote -p remote_server -p terminal -p project --no-run` (`zed/`) | built; only macOS linker `__eh_frame section too large` notes (toolchain, not code) |
| 4 | `cargo test -p remote websocket` | 37 passed |
| 5 | `cargo test -p remote remote` | 14 passed |
| 6 | `cargo test -p remote_server serve` | 95 passed (lib) + 3 passed (`tests/serve.rs`) |
| 7 | `cargo test -p remote_server pty` | 17 passed |
| 8 | `cargo test -p remote_server terminal` | 5 passed (`remote_editing_tests`) |
| 9 | `cargo test -p remote_server --test serve --test run` | 5 + 1 passed (`serve_end_to_end`, `upload_and_download_round_trip_through_the_binary`, `serve_cli_rejects_a_non_loopback_control_listener`, `serve_cli_rejects_a_missing_control_secret`, `sigterm_without_a_session_exits_promptly`, `run_answers_ping_and_shuts_down`) |
| 10 | `cargo test -p terminal remote` | 20 passed |
| 11 | `cargo test -p project remote` | 14 passed (lib) + 4 passed (integration, pre-existing tests matched by the filter) |
| 12 | `cargo test -p terminal_view remote` | 7 passed |
| 13 | `cargo test -p workspace remote` / `cargo test -p workspace websocket` | 11 passed / 2 passed |
| 14 | `cargo test -p proto terminal` | compiled; no tests match (proto has no terminal tests) |
| 15 | after the integrator edit (§3): `rustfmt --edition 2024 --check crates/remote_server/src/serve/session.rs`; `cargo check -p remote_server`; `cargo test -p remote_server stale` | fmt OK; `Finished`, 0 warnings; 3 passed (`takeover_closes_old_with_4001_and_stale_epoch_is_refused`, `stale_response_dropped_after_fresh`, `sweep_removes_stale_temp_files`) |
| 16 | `cargo clippy --all-targets -- -D warnings` (`sandbox/supervisor/`) | `Finished`, exit 0 |
| 17 | `cargo test` (`sandbox/supervisor/`) | 100 unit + 5 + 5 + 2 + 6 + 1 integration passed; `port_watcher_live` 0 (Linux only); `start_against_fake_server` 8 and `warm_against_serve` 1 report ok but skip internally without their env flag |
| 18 | `ZS_RUN_START_INTEGRATION=1 cargo test --test start_against_fake_server` (`sandbox/supervisor/`) | 8 passed in 63 s (drives the real `zs-agent` binary against `fake-zed-remote-server.py` and an in-process control plane) |
| 19 | `ZS_RUN_WARM_INTEGRATION=1 cargo test --test warm_against_serve` (`sandbox/supervisor/`, uses `zed/target/debug/remote_server`) | 1 passed (the warm-up client against the real `remote_server serve`) |
| 20 | `pnpm lint` (`apps/web/`) | exit 0 |
| 21 | `pnpm exec tsc --noEmit` (`apps/web/`) | exit 0 |
| 22 | `pnpm typecheck` (`next typegen && tsc --noEmit`) (`apps/web/`) | exit 0; 8 workflows / 118 steps built |
| 23 | `pnpm test` (`apps/web/`) | 46 files, 362 tests passed (16 s) |
| 24 | `pnpm test:integration` (`apps/web/`) | 4 files, 6 tests passed (17 s) |

Not run this round (needs Docker / a musl toolchain / a live sandbox): `sandbox/image/build.sh`, `sandbox/image/test/run-local.sh`, wasm builds (excluded from round 1 by the working agreements).

## 3. Integrator changes

Exactly one edit, in b2's file:

- `zed/crates/remote_server/src/serve/session.rs`: the stale-epoch refusal used the literal `"stale epoch"`; it now uses `remote::websocket_wire::CLOSE_REASON_STALE_EPOCH` (b1's constant). The client's `exit_code_for_close` maps 4001 with exactly that reason to exit 90 (fresh session) instead of 91 (taken over), so the string is part of the wire contract and must not drift. The existing assertions on the literal in `session.rs` tests and `tests/serve.rs` are left as pins.

No signature mismatches between b1 and b2 (`ServerChannel`, `ChannelEnds`, `ServeHooks`), no missing hook wiring between serve and the `PtyManager` (`GpuiCommand::SessionDetached → detach_all`, `Quit → kill_all`), and no proto registration collisions (tags 488-499 only; `entity_messages!` extended once) were found.

## 4. Deviations from briefs and decisions (as landed)

| Lane | Deviation | Assessment |
|---|---|---|
| b2/b3 | D24 says the `PtyManager` is "constructed at server level, outside `HeadlessProject`, exposed through a handle accessor". As landed, `HeadlessProject::new` installs it as an `App` global (`PtyManager::global(cx).unwrap_or_else(install)`) and `execute_serve` takes the handle from the `pub pty_manager` field. It is still process-level (serve never rebuilds the project; fresh sessions go through `reset_for_new_client`), so terminals survive fresh sessions as required. Construction site differs from D24's letter, not its behaviour. | Acceptable; optional cleanup in round 2 (§5). |
| b1/b2 | Stale epoch: D23 folds it into 4001. b2 closes 4001 with reason `"stale epoch"`; b1 maps that reason to exit 90 (`ServerNotRunning` → the shell's `reconnect()` opens a fresh session), and every other 4001/4005 to exit 91. This is a refinement of D23 that keeps M3's two positions both true. | Now pinned by a shared constant (§3). |
| b1/b2 | M4: `HelloAck.session_id` is the JWT `sid` on the server; b1 documents it as an echo of `Hello.session_id`. Equal for honest clients; the server logs a mismatch and does not close (D1 "informational"). | No action; document. |
| b2 | `run` gained `--user-data-dir` and `execute_run` was split into `build_headless_project` / `init_crash_handler` / `init_rayon_pool` shared with `serve`. Not in the brief's change list; needed to share the project construction. | Fine. |
| b2 | Control listener mounts `PendingControlRoutes` (bearer check, body validation, 204) and `DefaultProjectHooks` (no-op `on_session_attached`), because b4's `ControlChannel` / `enable_sandbox` have not landed. `is_input_envelope` lacks the b4 payloads. Both carry `ZS-TODO(b2->b4)` markers (`serve.rs:256`, `serve.rs:946`, `session.rs:1155`). | Expected; b4 gap (§5). |
| b2 | `DEFAULT_SUPERVISOR_URL` is defined in `serve.rs:45` (R1 placed it in b4's `ports.rs`). | b4 to define/re-export in `ports.rs`; b2 to switch the import. |
| b2 | `remote_server` default features now include `serve` (per brief b2 §5), which pulls hyper, tokio, jsonwebtoken/aws-lc-rs into every default build of the crate. | As briefed; note for the wasm/desktop build owners. |
| b1 | `tools/ws-transport-wasm-check` is a throwaway standalone workspace (symlinks into `crates/remote`) for the wasm compile check until `crates/remote` joins `script/check-wasm` (D33). Not listed in D31's vendoring or `[workspace] exclude` (it has its own `[workspace]`, so cargo is fine). | Drop when b5 lands. |
| b1 | `Hello.identifier` is the plain `ConnectionIdentifier` string; the nonce travels only in `Hello.instance` (D25). CONTRACTS §1.4 still describes the composed form. | CONTRACTS row is stale; code follows D25. |
| b8 | `start_against_fake_server` and `warm_against_serve` are env-gated (`ZS_RUN_START_INTEGRATION=1`, `ZS_RUN_WARM_INTEGRATION=1`) and pass vacuously otherwise; `port_watcher_live` is Linux-only. | Run explicitly here (§2 rows 18-19), both pass. |
| b9 | `/connect` returns a superset of D26 (`clientBuild`, `sessionCapAt`, `audience` in addition). | Fine; b7 ignores extras. |
| b9 | `public/editor/dev-0` is a stub bundle so `/w/<id>` renders a "bundle not built" state until b7's `zed_web` bundle exists. | Expected; b7 gap. |
| unknown | `zed/README.md` gained two stray lines at the top (`> [!IMPORTANT] > Remove this line to confirm you've reviewed this PR before submitting.`). No brief asks for it. | Remove in round 2 (§5). |
| b2 | `CONTRIBUTING.md` (upstream doc) gained a paragraph on the `jsonwebtoken` backend rule. | Fine; the `provider_is_available` test enforces the rule. |

## 5. Consolidated gap list for round 2

| # | Gap | Owner |
|---|---|---|
| G1 | Land b4: `remote_session.proto` (tags 500-514), `control::ControlChannel` + `impl ControlRoutes`, `HeadlessProject::{enable_sandbox, on_session_attached, notify_files_uploaded}`, `HeadlessExtensionStore::asset_path`, client-state store, extension store, port forwarder with `ports.rs::DEFAULT_SUPERVISOR_URL = http://127.0.0.1:8450` (reconcile with `serve.rs:45`). Then replace `PendingControlRoutes` and `DefaultProjectHooks` in `serve.rs` (lines 256, 946) and add `SaveClientState`, `LoadClientState`, `ListExtensions` to `is_input_envelope` (`session.rs:1155`). | b4 (proto, control, stores); b2 (mounting) |
| G2 | Land b5/b6/b7: `crates/remote` into `script/check-wasm` (D33) and delete `tools/ws-transport-wasm-check`; `zed_web` bundle consuming `open_remote_project_in_new_window_with_client`, `WebSocketConnectionOptions::new(url, workspace_id, session_id, token)`, `set_session_refresh_provider`, the D23 `close_code_detail` names already used by `apps/web/lib/zed-web.ts` and `shell-phase.ts`; drop the `public/editor/dev-0` stub once a real bundle is fetched by `scripts/fetch-editor-bundle.ts`. | b5, b6, b7 (b9 consumes) |
| G3 | D24 letter: move `PtyManager::install` into `execute_serve` (before `build_headless_project`) and expose a `HeadlessProject::pty_manager()` accessor instead of the public field. Behaviour is already correct; this is alignment only. | b2 + b3 |
| G4 | Document M4 (`HelloAck.session_id` = JWT `sid`) and the stale-epoch reason contract in CONTRACTS §1.4/§1.5, and update §1.4's `Hello.identifier` row to D25 (nonce in `instance` only). | tech lead (CONTRACTS.md) |
| G5 | Server `Log` control frames are emitted for warn/error (M7, b2 position); the client logs and ignores them. Decide whether to keep them in v1 and record it. | tech lead; b2 |
| G6 | Remove the stray two-line banner at the top of `zed/README.md`. | whichever lane added it (not identifiable from the tree); integrator can do it in round 2 if unclaimed |
| G7 | Image job not exercised locally: `sandbox/image/dist` is empty (no musl `zed-remote-server` built here), `build.sh` and `test/run-local.sh` need Docker/VCR. CI `sandbox-image.yml` is the intended path; confirm it runs green once a runner is available. `port_watcher_live` needs Linux. | b8 |
| G8 | End-to-end against a real Vercel sandbox (create → connect → `/rpc` handshake → stop/resume with D28 terminal recreation) has not been run; everything above is unit/integration with fakes. Needs G1 + G2 first. | b9 (driver), b2, b8 |
| G9 | `remote_server` default features include `serve`; when b5-b7 gate the wasm closure, confirm the `serve` feature and its tokio/hyper/aws-lc-rs deps stay out of the browser build (they are cfg'd behind the feature today). | b5/b7 |
| G10 | b10 (devcontainer image builder) and b11 (AI provider proxy) are written but not started; nothing in round 1 references them. | b10, b11 |
