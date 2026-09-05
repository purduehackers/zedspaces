# Round 2 integration status (2026-09-03)

Lanes b4 and b5 on top of round 1 (`docs/status/round1.md`). Precedence: DECISIONS.md (D1-D40) > CONTRACTS.md > briefs. All commands run in `zed/` on macOS (Darwin 27.0.0), Rust 1.97.1.

## 1. Deliverables

- **b4** — `crates/proto/proto/remote_session.proto` (tags 500-514) + `proto.rs` registrations and a round-trip test; `sqlez` image API (`Connection::{serialize_main, open_scratch_from_image, restore_main_from}`, `ThreadSafeConnection::{write_generation, serialize}`, `ThreadSafeConnectionBuilder::{with_restore_image, build_with_outcome}`, `RestoreOutcome`); `db::{AppDatabase::{new_with_image, open_with_image}, open_db_with_image, client_state::ClientStateStore, kvp::{GLOBAL_KVP_NAMESPACE, GlobalKeyValueStore::from_app_db}}` (D7, D34); `workspace::client_state` (`RemoteClientStateSink`, `load_client_state`, gzip, `UnsavedBuffersDb`, `snapshot_unsaved_buffers`/`restore_unsaved_buffers`, D6); `project::{lifecycle::LifecycleKind, port_store::PortStore, remote_extension_store::RemoteExtensionStore}` + `Project` handlers; server `remote_server::{client_state, control::ControlChannel (impl ControlRoutes), extensions::HeadlessExtensionStore, ports::{PortForwarder, DEFAULT_SUPERVISOR_URL = http://127.0.0.1:8450}}`, `HeadlessProject::{enable_sandbox(SandboxConfig) -> Arc<dyn ControlRoutes>, SandboxRuntime, on_session_attached, notify_files_uploaded}`; serve mounts them (`SandboxProjectHooks`; `PendingControlRoutes`/`DefaultProjectHooks` are test-only now), `is_input_envelope` excludes `SaveClientState`/`LoadClientState`/`ListExtensions`; `ReqwestClient::user_agent_without_proxy`. Every round-1 `ZS-TODO(b2->b4)` marker is gone (G1 closed); no `ZS-TODO` remains in `zed/`.
- **b5** — `.cargo/config.toml` wasm rustflags + `CC_/AR_wasm32_unknown_unknown`; `script/{check-wasm, ensure-wasi-sdk, wasi-sdk-env, wasi-sdk.sha256, wasm-cc, wasm-ar, check-vendor-pins}`; CI `check_wasm` job runs `./script/check-wasm` with a wasi-sdk cache (xtask + `run_tests.yml`, D33), `web_examples` passes `-Zbuild-std`; `crates/zs_smol_shim` (package `smol`, `[patch.crates-io]`, wasm `runtime` module); `vendor/{lsp-types, agent-client-protocol}` (README sections, `[workspace] exclude`, `[patch]`, D31); workspace deps `async-executor`, `async-net`, `blocking`; wasm gates in `util::paths` (`UrlExt::{from_file_path_ext, to_file_path_ext}`, wasm `home_dir`), `fuzzy` (no `scoped`), `lsp` (no process transport), `task`, `language_registry`, `languages/python.rs`, `editor/hover_popover.rs`; tree-sitter `wasm` feature moved to `not(wasm)` tables in `language`, `languages`, `multi_buffer`, `migrator`, `edit_prediction_context`, `language_tools`, `settings_json`; `time_format` `wasm-bindgen`.
- **integrator** — `crates/rpc/Cargo.toml`: wasm target table with `getrandom 0.3.4 (wasm_js)` and `getrandom 0.2 (js)` so `script/check-wasm -p rpc` resolves without gpui in the graph (feature unification; `Cargo.lock` gains the two edges); removed the stray two-line PR banner from `zed/README.md` (round-1 G6). No cross-lane compile errors were found.

## 2. Verification

| # | Command | Result |
|---|---|---|
| 1 | `cargo check -p remote -p remote_server -p terminal -p project -p terminal_view -p workspace -p proto -p db -p sqlez -p editor -p languages -p lsp -p util` | PASS: `Finished`, 0 errors, 0 rustc warnings (only the upstream `block v0.1.6` future-incompat note) |
| 2 | `cargo test -p remote websocket` | PASS: 37 passed |
| 3 | `cargo test -p remote_server serve` | PASS: 99 passed (lib) + 3 passed (`tests/serve.rs`) |
| 4 | `cargo test -p remote_server pty` | PASS: 20 passed |
| 5 | `cargo test -p remote_server client_state` | PASS: 12 passed |
| 6 | `cargo test -p remote_server control` | PASS: 12 passed (lib) + 2 passed (`tests/serve.rs`) |
| 7 | `cargo test -p terminal remote` | PASS: 20 passed |
| 8 | `cargo test -p db client_state` | PASS: 8 passed |
| 9 | `./script/check-wasm` (default: `gpui_platform cloud_api_client smol paths util task fuzzy http_client language_core lsp lsp-types`) | PASS: `check-wasm: OK`, `Finished` in 25 s |
| 10 | `./script/check-wasm -p proto -p rpc -p db -p sqlez -p language_core -p zs_smol_shim` | FAIL (exit 101): `libsqlite3-sys v0.30.1` build script — `sqlite3.c` unix VFS (`fcntl` `F_SETLK`/`F_WRLCK`, `struct unix_syscall[]`) does not compile under wasi-sdk; blocks `db` and `sqlez` only |
| 10a | `./script/check-wasm -p proto -p language_core -p zs_smol_shim` | PASS: `check-wasm: OK` |
| 10b | `./script/check-wasm -p rpc` | FAIL before the integrator edit (getrandom 0.2 `js` / 0.3.4 `wasm_js` `compile_error!`); PASS after: `check-wasm: OK` |
| 11 | `cargo check -p rpc` (native, after the edit) | PASS: `Finished`, 0 warnings |
| 12 | `./script/check-vendor-pins` | PASS: `OK (yawc lsp-types agent-client-protocol)` |

## 3. Gaps for round 3

| # | Gap | Owner |
|---|---|---|
| R3-1 | `sqlez`/`db` on wasm: `libsqlite3-sys` → `sqlite-wasm-rs 0.5.5` in a wasm table (+ gpui's `getrandom`/`uuid` lines), `thread_local`/`pollster`/`std::thread` in `thread_safe_connection.rs` behind `not(wasm)`, `wasm_lock`/`wasm_lock_queue` (M17 queue name); confirm `sqlite-wasm-rs` exports `sqlite3_serialize`, `sqlite3_deserialize`, `sqlite3_malloc64`, `sqlite3_backup_*` used by b4's `connection.rs`; then append `sqlez db` to `default_packages`. | b6 |
| R3-2 | Remaining b6 leaves: `fs` (`WasmFs`), `terminal` (vendor `alacritty_terminal`, D10/D31), `acp_thread`, `client` (`sign_in_supported`), `prompt_store`, `clock`; append each to `default_packages` as it goes green. | b6 |
| R3-3 | b7 edge gates and entry: `util paths settings ui …` gates, `web.json` keymap (D12), `zed_web` consuming `open_remote_project_in_new_window_with_client`, `WebSocketConnectionOptions::new(url, workspace_id, session_id, token)`, `set_session_refresh_provider`, `AppDatabase::open_with_image` + `ClientStateStore` flush triggers, `WasmFs::take_dirty` (D32), D23 `close_code_detail` names; `crates/remote` into `check-wasm` and delete `tools/ws-transport-wasm-check`; replace `apps/web/public/editor/dev-0` stub (G2). | b7 (b9 consumes) |
| R3-4 | `rpc` compiles on wasm but `std::time::Instant::now()` in `peer.rs`/`message_stream.rs` panics on wasm32-unknown-unknown at runtime; swap to `web-time` (b5 risk 10, same for `remote`). No brief owns `rpc`. | tech lead to assign (b6 or b7) |
| R3-5 | `getrandom 0.2` `js` is provided only by `fastrand`'s target table in gpui graphs and by `rpc`'s new line otherwise; `zed_web` should declare both getrandom lines itself (b7 §5) so the bundle never depends on that transitive edge. | b7 |
| R3-6 | G9: confirm `remote_server`'s default `serve` feature (tokio/hyper/aws-lc-rs) stays outside the browser closure once `zed_web` exists (`cargo xtask web-bundle --check-only`). | b7 |
| R3-7 | G7/G8 carried: image job (`sandbox/image/build.sh`, `run-local.sh`, `port_watcher_live`) needs Docker/Linux; end-to-end create → connect → `/rpc` → stop/resume against a real sandbox needs R3-3 first. | b8; b9 (driver) |
| R3-8 | G10: b10 decisions D35-D40 are recorded and its code lives outside `zed/`; b11 (AI proxy) not started. | b10, b11 |
