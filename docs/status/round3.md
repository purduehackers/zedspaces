# Round 3 integration status (2026-09-03)

Lanes b6, b7 and the wasm closure loop on top of rounds 1, 2 and 2b (`docs/status/round{1,2,2b}.md`). Precedence: DECISIONS.md (D1-D40) > CONTRACTS.md > briefs. All commands in `zed/` on macOS (Darwin 27.0.0), Rust 1.97.1, wasm-bindgen-cli 0.2.120.

## 1. Deliverables

- **b6** — `fs::WasmFs` (`wasm_fs.rs`: `new`, `insert_file`, `insert_dir`, `take_dirty`, change events; 15 tests); `sqlez` on wasm (`sqlite-wasm-rs 0.5.5` as `libsqlite3-sys` in the wasm table, `wasm_lock`/`wasm_lock_queue`, `thread_safe_connection.rs` gates, provenance section in `vendor/README.md`); `terminal` (vendored `alacritty_terminal` at 4c129667 + `vendor/alacritty_terminal.patch`, `sync_handler.rs` replacing vte's `Instant`-based timeout, D17 gates); `client::Client::sign_in_supported`, `prompt_store`, `clock`, `acp_thread` wasm tables and `web-time`.
- **b7** — `crates/zed_web` (`start`/`flush_client_state`/`set_hidden`/`has_unsaved_changes`/`build_id` exports per CONTRACTS §8.4; `boot`, `connect` (D16 `open_remote_project_in_new_window_with_client`, D26 `WebSocketConnectionOptions::new`, `set_session_refresh_provider`, `close_code_detail`), `AppDatabase::open_with_image` + `ClientStateStore`, `WasmFs::take_dirty` flushes (D32), `web/{index.html,loader.js}`, `tests/sqlite_image_round_trip.rs`); `crates/zed_web_core` (`BootConfig`/`ConnectInfo`/`BootStage`/`BootError`, asset pack, host OS, web settings; native unit tests); `assets/keymaps/web.json` (D12) with `settings::{KeymapOs, default_keymap_path_for, specific_overrides_keymap_path_for, WEB_KEYMAP_PATH}` and `ui::PlatformStyle::set_platform_style`; browser stand-ins (`title_bar/{collab_web,update_version_web}.rs`, `settings_ui/pages/audio_web.rs`, `context_server/transport/stdio_transport_web.rs`) and edge gates in `askpass`, `net`, `util`, `settings`, `agent_ui`, `keymap_editor`, `language_models`, `activity_indicator`, `sidebar`, `recent_projects`, `workspace`; `script/build-web` (+ `patch-wasm-bindgen-memory.sh`, forbidden-crate and eval gates); vendored `wasm_thread` (eval-free); `web-time` in `rpc`/`proto`/`remote` (R3-4) and both `getrandom` lines in `zed_web` (R3-5); `tools/ws-transport-wasm-check` deleted; `check-wasm` defaults extended (`sqlez db clock proto rpc fs terminal ui assets zed_web_core`).
- **wasm closure loop** — vendored `async-tar`, `pet`, `pet-{fs,conda,hatch,uv,env-var-path,pyenv,virtualenvwrapper,venv}`, `tree-sitter-{python,rust,bash,cpp,yaml}` (build.rs wasm blocks) with `[patch]` entries, `[workspace] exclude` and README sections; wasm gates in `context_server`, `language`, `node_runtime`, `prettier`, `prompt_store`, `worktree`, `dap`, `dap_adapters`.
- **integrator** — `script/check-vendor-pins` accepts the round-3 vendoring shapes (skips `## <crate> (not vendored; …)` provenance sections, finds git pins in `crates/*/Cargo.toml`, checks a plain crates-io requirement against the vendored version); no other code change.

## 2. Verification

| # | Command | Result |
|---|---|---|
| 1 | `cargo check -p remote -p remote_server -p terminal -p project -p workspace -p editor -p fs -p client -p db -p title_bar -p git_ui -p agent_ui -p settings_ui` | PASS: `Finished` 1m 50s, 0 errors, 0 rustc warnings (only the upstream `block v0.1.6` future-incompat note) |
| 2 | `cargo test -p remote websocket` / `cargo test -p remote remote` | PASS: 37 / 14 passed |
| 3 | `cargo test -p remote_server serve` / `pty` / `client_state` / `control` | PASS: 99 (+3 `tests/serve.rs`) / 20 / 12 / 12 (+2) passed |
| 4 | `cargo test -p db client_state` / `cargo test -p fs wasm_fs` | PASS: 8 / 15 passed |
| 5 | `cargo test -p terminal remote` / `cargo test -p workspace remote` / `cargo test -p workspace websocket` | PASS: 20 / 11 / 2 passed |
| 6 | `cargo test -p project remote` | PASS: 17 (lib) + 4 (integration) passed |
| 7 | `cargo check -p zed_web -p zed_web_core -p smol` (native; `zed_web` is empty off-wasm) / `cargo test -p zed_web_core` / `cargo check -p zed` | PASS: 0 warnings / 17 passed / PASS: `Finished` 1m 20s, 0 warnings |
| 8 | `./script/check-vendor-pins` | FAIL before the integrator edit (5: `sqlite-wasm-rs` section, `wasm_thread`, `tree-sitter-{python,rust,bash}`); PASS after: `OK (20 crates)` |
| 9 | `cargo metadata --locked --offline` | PASS (Cargo.lock consistent) |
| 10 | `./script/build-web --skip-wasm-opt --check-only` | PASS: `OK (check-only)` — no forbidden crate (tokio, hyper, aws-lc-sys, reqwest, gpui_tokio, extension_host, …) in the `zed_web` closure; vendored `wasm_thread` eval-free (closes R3-6/G9 at graph level) |
| 11 | `./script/check-wasm` (CI gate, default list) | PASS: `check-wasm: OK` for all 21 crates (`target/wasm-logs/20260903-122353-check.log`) |
| 12 | `./script/check-wasm -p zed_web --keep-going` | FAIL (exit 101): `crates that failed to compile: project` only, 16 errors (`target/wasm-logs/20260903-122355-check.log`); identical to the loop's last run at 12:11 |

## 3. Wasm status

- Loop result at hand-off: `{"clean":false,"failing":["dap_adapters"]}`; since then `dap_adapters` checks clean standalone (log 12:10:21) and inside the closure.
- CI gate (`check-wasm` default list, 21 crates: `gpui_platform cloud_api_client smol paths util task fuzzy http_client language_core lsp lsp-types sqlez db clock proto rpc fs terminal ui assets zed_web_core`): PASS.
- `zed_web` closure = 213 workspace + vendor crates. **Clean (143)**, notably: `remote settings client prompt_store worktree language context_server dap dap_adapters askpass git node_runtime prettier fs terminal sqlez db clock rpc proto ui assets zed_web_core gpui gpui_web scheduler` plus every vendored crate. **FAIL (1)**: `project` — 16 errors: `http_client::{github, github_download}` (`agent_server_store.rs:16,1231,1260,1270`), `util::{get_default_system_shell, get_system_shell}` (`terminals.rs:27`), `util::archive` (`yarn.rs:18`), `util::shell_env` (`environment.rs:343`), `ShellBuilder::build_smol_command` (`debugger/locators/cargo.rs:127`), `BackgroundExecutor::scoped` (`project_search.rs:376`), `lsp::LanguageServer::new` trait bounds (`lsp_store.rs:520`) and 6 mismatched types (`lsp_store.rs:1550,5751,10676,10692,11209,11223`). **Not reached (70, depend on `project`)**: `workspace editor terminal_view languages acp_thread agent agent_ui git_ui settings_ui title_bar keymap_editor language_tools language_models debugger_ui vim recent_projects remote_connection search project_panel outline_panel … zed_web`.
- Bundle: not built (loop not clean) — no sizes; `apps/web/public/editor/` still holds the `dev-0` stub. `wasm-opt` (binaryen) and `brotli` are not installed on this machine; `build-web` needs both (or `--skip-wasm-opt`, and then reports `wasm_brotli_bytes: null`).

## 4. Gaps for round 4

| # | Gap | Owner |
|---|---|---|
| R4-1 | `project` on wasm (the 16 errors above), then the 70 crates above it with `zed_web` last; re-run `./script/check-wasm -p zed_web --keep-going` per layer. | wasm loop / b7 |
| R4-2 | Append the crates now clean in the closure (`remote settings client prompt_store worktree language context_server dap dap_adapters`) to `check-wasm` `default_packages`; `acp_thread` after R4-1. | b7 |
| R4-3 | `./script/build-web` → sizes (raw, gzip, brotli) and `apps/web/public/editor/<build>/` replacing `dev-0` (G2/R3-3 tail); install `wasm-opt` ≥ 116 and `brotli` on the build host. | b7; b9 consumes |
| R4-4 | `repl` is out of `zed_web` (`ZS-TODO(b7)`: `jupyter-websocket-client`/tokio, `runtimelib`/aws-lc-rs). | b7 |
| R4-5 | Nothing wasm has run in a browser yet: the §8.4 loader contract, `tests/sqlite_image_round_trip.rs` and the D32 flushes are untested end to end. | b7, b9 |
| R4-6 | CONTRACTS §13.2 lacks the round-3 vendored crates (`alacritty_terminal`, `wasm_thread`, `async-tar`, `pet*`, `tree-sitter-*`) and the `sqlite-wasm-rs` provenance rule; §5.4 rows for `KeymapOs`, `set_platform_style`, `WasmFs`, `sign_in_supported` are now landed. | tech lead |
| R4-7 | Carried: E1 (re-run `scripts/dev-local.sh e2e` against a freshly built server), G7/E3 (image job on Linux), G8/E5 (Vercel sandbox e2e incl. stop → resume), E4 (b11 real provider + `zed_web` consumer), E2. | local-backend, b8, b9, b11 |
