# b6-leaf-gates: Leaf-crate gates: fs, terminal, client, acp_thread, sqlez, prompt_store

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` section 3.2 ("Six leaf crates that need real gates", header line 103, table rows 107-112; per-crate work list lines 116-139), 3.4 (boot, line 155), 3.7 (settings and keymap, line 187), 5.1 (terminals, line 239), 5.4 (client persistence, line 260). Fork under modification: `/Users/ray/Projects/play/wed/zed` (branch `zs`, upstream `c3cf80c`); all paths below are relative to that checkout unless stated. Evidence fork (read-only): `/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad/zed-web` ("the fork"; two minor versions behind, so `diff -ru` output also contains upstream drift such as `TerminalMode`, `PtyResources`, `case_sensitive` in `FakeFs`, `rules_to_skills_migration.rs`, and rustfmt-only churn in its vendored alacritty; only `cfg` deltas were taken as evidence). Binding cross-brief decisions: `/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md` (D7, D10, D11 and D17 change this brief directly; D3, D4, D6 and D9 are cited where they touch it; the rest do not reach these crates); section 9 is the reconciliation log against those decisions and the sibling briefs' sections 7-8.

Related briefs: b4 (`docs/briefs/b4-proto-additions.md`) already specifies `Connection::serialize_main`/`restore_main_from` (its 3.4), `ThreadSafeConnection::{write_generation, serialize, restore_from}` and `ThreadSafeConnectionBuilder::with_restore_image` (3.5), `AppDatabase::{new_with_image, open_with_image}` and `open_db_with_image` (3.6), and `db::client_state::ClientStateStore` (3.7). **b3 (`docs/briefs/b3-terminals.md`) owns the remote terminal surface** — `crates/terminal/src/remote_pty.rs`, `TerminalType::Remote(RemotePtyState)`, `PtyEvent::{Output, RemoteLost}`, `RemotePtyTransport`/`RemotePtyHandle`/`RemoteTerminalOptions`, every `Remote` match arm (including `is_pty`, `pid`, the handshake, the `:5602-5610` test helper), `task::ExitStatus` (b3 §3.5a) and the project-side reattach (b3 §3.6); this brief keeps only the alacritty/libc/pty cfg gates, the wasm `TerminalBuilder::new` twin, the `Instant`/vte-timeout swaps and the wasm-only dead-code allowances, as recorded in b3 §7.12. b5 (`docs/briefs/b5-wasm-build-env.md`) owns the wasm toolchain, `.cargo/config.toml` (the `getrandom_backend="wasm_js"` cfg, `CC`/`script/wasm-cc`), the `zs_smol_shim` crate, the `check_wasm` xtask job shape (b5 item 16), the `util` gates (`util::command`, `util::process`; b5 item 10, b7 §3 "b5's util gates") and, with b1 (`vendor/yawc`, b1 §3.18), the `vendor/` layout of D10 that 3.1 joins (`vendor/README.md`, the `[workspace] exclude` list); b7 (`docs/briefs/b7-edge-gates-entry.md`) owns the wasm `util::paths::home_dir` (`/home/web` per D11; b7 §3.1), `activity_indicator` (b7 §3.10), `title_bar` (b7 §3.11), the `zed_web` entry crate and boot, and the `__wasm_call_ctors` question (b7 §7 item 3); b7 §3.27/§3.30 own the browser-side flush exports (`flush_client_state`, `set_hidden`) that b9's shell page calls on `visibilitychange` → hidden (b9 §4 item 6, b9:789; `pagehide` is best-effort only — D7 fixes the client-state flush triggers as the 15 s dirty timer, `visibilitychange` → hidden and `STOPPING`). This brief does not restate them; it makes the six crates (plus the two one-line `clock` swaps in 3.9) compile and behave on `wasm32-unknown-unknown` and says where the wasm boot calls them. Briefs not yet written that this one assumes: the `rpc` brief (keeps `rpc::Connection`/`Peer` on wasm with `async-tungstenite` default features), the `project`/`terminal_view`/`workspace` briefs (importers of `task::ExitStatus`, section 7 item 5).

## 1. Goal

Make the six leaf crates that the BUILD-SPEC identifies as needing real `cfg(target_family = "wasm")` gates compile for the browser while keeping every public type and constructor that `AppState`, `Project`, `workspace` and the panels use unchanged on native: `fs` gains a real in-memory `WasmFs` with change events so settings, keymap and snippet watchers work unchanged; `terminal` compiles on wasm with alacritty's PTY layer gated in a forked `alacritty_terminal` revision and every local-process path stubbed, so that b3's `TerminalType::Remote` (parsed on the foreground executor) is the only constructible terminal in the browser; `client` keeps `Client::new`/`production` and message handling but disables collab connect, proxying and browser sign-in; `acp_thread` drops `portable-pty` on wasm; `sqlez`/`db` swap `libsqlite3-sys` for `sqlite-wasm-rs` behind one process-wide reentrant lock and a single connection so b4's serialize/restore hooks run in the browser; `prompt_store` gets an in-memory backend in place of LMDB. Every gate is upstream-shaped (target-specific dependency tables, `#[cfg]` on items, a vendored path `[patch]` for alacritty per D10 until a fork exists), and every wasm-only path also builds under `cfg(test)` or `test-support` on the host so it is unit-tested natively.

## 2. Existing code that matters

Plan and cross-crate anchors

- `BUILD-SPEC.md:103-112` — the six-crate gate table (this brief's scope); `:114` dependency-edge gates that other briefs own (`gpui_tokio` at `client` is ours); `:134` the `agent`/`acp_thread` row ("sandboxing and proxy compile as dead code"); `:143` layer ordering (fs, db, rpc, client before project).
- `BUILD-SPEC.md:187-189` — settings and keymap are written into the in-memory Fs at the paths Zed expects; the Fs emits change events consumed by a debounced control-plane save hook.
- `BUILD-SPEC.md:245-247` — client side of terminals: `TerminalType::Remote` in `crates/terminal` feeds bytes into the existing alacritty grid (design in b3 §3.5).
- `BUILD-SPEC.md:262` — SQLite compiled to wasm with a memory VFS; `sqlite3_serialize` every 15 s and on `pagehide`. D7 amends this: one whole-database image (the `AppDatabase`, with `GlobalKeyValueStore` folded into it — 3.4), `serialize()`/`restore_from()` on `background_spawn`, flush triggers = 15 s dirty timer, `visibilitychange` → hidden, `STOPPING`; the store itself is b4 3.7.
- `Cargo.toml:1-3` `[workspace] resolver = "2" members = [...]` — there is no `exclude` list and no `vendor/` directory in the tree (re-verified 2026-09-02). A path package referenced only from a `[patch]` table is **not** an implicit workspace member: b5 §2 measured `corgi-patches/scratch` (`Cargo.toml:1001`, the sole path patch) — absent from `cargo metadata --no-deps`'s 253 members, and `cargo check -p scratch` panics in the feature resolver. Only a direct `path =` dependency of a member inside the root becomes a member automatically, which is why 3.1 also adds an `exclude` entry for the vendored crate. `:523` `alacritty_terminal = { git = "https://github.com/zed-industries/alacritty", rev = "4c129667..." }`; `:546` `async-tar` (git fork, default features `runtime-async-std`); `:549` `async-tungstenite = "0.33"`; `:634` `heed = { version = "0.21.0", features = ["read-txn-no-tls"] }`; `:667` `js-sys = "0.3"`; `:673` `libc = "0.2"`; `:674` `libsqlite3-sys = { version = "0.30.1", features = ["bundled"] }`; `:751` `portable-pty = "0.9.0"`; `:818` `smol = "2.0"`; `:819` `sqlformat = "0.2"`; `:827` `sysinfo = "0.37.0"`; `:829` `tempfile`; `:839` `tiny_http = "0.12"`; `:840` `tokio = { version = "1" }`; `:883` `uuid = { version = "1.1.2", features = ["v4", "v5", "v7", "serde"] }`; `:898` `wasm-bindgen = "0.2.120"`; `:902` `web-time = "1.1.0"`; `:976` `[patch.crates-io]` (patches crates.io sources with git sources by `rev`, e.g. `:987-988` `notify`; `:1001` `scratch = { path = "corgi-patches/scratch" }` is the only in-tree path patch; no `[patch."<git url>"]` table exists yet).
- `crates/gpui/src/gpui.rs:167-168` `#[cfg(not(target_family = "wasm"))] pub use pollster::block_on;` — the free function that `db::AppDatabase::new` (`db.rs:65`) and `db::kvp::GLOBAL_KEY_VALUE_STORE` (`kvp.rs:247`) call; it does not exist on wasm, which is what breaks `db`. (`crates/gpui/src/executor.rs:444-446` is the unrelated `BackgroundExecutor::block_on` method, also native-only; `db` never calls it.) `executor.rs:117` `BackgroundExecutor::spawn` requires `Send + 'static` futures on every target; `:197` `timer(duration)` is unconditional (used by `WasmFs::watch`).
- `crates/gpui/Cargo.toml:112-114` `[target.'cfg(target_family = "wasm")'.dependencies] getrandom = { version = "0.3.4", features = ["wasm_js"] }` and `uuid = { workspace = true, features = ["js"] }` — so every crate whose wasm graph contains gpui (`db`, `prompt_store`, `fs`, `terminal`, `acp_thread`, `client`) already has the `wasm_js` backend feature; `sqlez` does not depend on gpui (`crates/util/Cargo.toml` `[dependencies]` has no gpui either), so `cargo check -p sqlez --target wasm32-unknown-unknown` alone resolves `uuid` → `getrandom 0.3.4` without the feature and hits `getrandom-0.3.4/src/backends.rs:36-44` `compile_error!` even with b5's `getrandom_backend="wasm_js"` cfg (verified in the registry source). Section 5 mirrors gpui's two lines in `sqlez`'s wasm table.
- `crates/cloud_api_client/Cargo.toml:28` `[target.'cfg(not(target_family = "wasm"))'.dependencies] gpui_tokio` and `crates/cloud_api_client/src/websocket.rs:9-12` `#[cfg(not(target_family = "wasm"))] mod native; #[cfg(target_family = "wasm")] mod web;` — upstream's existing gate style; `CloudApiClient::connect` exists on wasm, so `Client::connect_to_cloud` stays ungated.
- `crates/rpc/src/conn.rs:1-24` — `Connection` is a boxed `Sink`/`Stream` of `async_tungstenite::tungstenite::Message`; nothing tokio-specific, so `client` can keep constructing/handling connections on wasm.
- `.github/workflows/run_tests.yml:637-676` — upstream's existing `check_wasm` job runs `cargo -Zbuild-std=std,panic_abort check --target wasm32-unknown-unknown -p gpui_platform -p cloud_api_client` with `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS=-C target-feature=+atomics,+bulk-memory,+mutable-globals` and `RUSTC_BOOTSTRAP=1`; the YAML is generated from `tooling/xtask/src/tasks/workflows/run_tests.rs:493-521` (`cargo_check_wasm()` at `:501-511`), so hand edits are overwritten. b5 item 16 changes that function to call `script/check-wasm` with no arguments, so the crate list is extended in the script's `default_packages` array (section 6), not in the generator.
- `crates/scheduler/Cargo.toml:23-26` — "a contended `std` lock parks with `Atomics.wait`, which the browser forbids on the main thread" (why `flume/spin` is used under `wasm-threads`). `parking_lot` parks the same way once its spin phase ends, so any lock that a worker and the main thread can both hold must be a spin lock or must never be contended; this constrains `sqlez` (4.3), `WasmFs` (4.1) and alacritty's `FairMutex` (section 7 item 3).
- `crates/settings/src/settings_file.rs:171-199` `watch_config_file`: on the **background** executor (`executor.spawn`), canonicalize, `fs.watch(&path, 100ms)`, initial `fs.load`, then reload on every event batch; `:201-240` `watch_config_dir`: matches `event.path` against `config_paths` and treats `Some(PathEventKind::Removed)` specially. `crates/settings/src/settings_store.rs:325-328` drains `setting_file_updates_rx` in a **foreground** `cx.spawn`, and each update calls `fs.atomic_write` (`:582-592`). So `WasmFs` is written from the main thread while it is read from workers — its locks are contended (4.1).
- `crates/title_bar/src/onboarding_banner.rs:91-99` `persist_dismissed`: `cx.spawn(async move |_| kvp.write_kvp(..).await)` — a **foreground** `ThreadSafeConnection::write`, while `db::write_and_log` (`db.rs:287-293`) runs writes on `background_spawn`. Both exist in the browser set, so the sqlez write queue on wasm is contended between the main thread and workers (3.3).
- `crates/worktree/src/worktree.rs:10-11` imports `copy_recursive`, `read_dir_items`; `:1359` calls `fs::requires_poll_watcher(&abs_path)`; `:496` `fs.open_handle` (local worktree only). These must keep resolving on wasm. The other `fs_watcher` consumers — `crates/zed/src/zed.rs:668,699` and `crates/worktree/tests/integration/worktree_tests.rs:1996` (`fs::fs_watcher::global(|_| {})`) — are desktop/native-only, so gating the module is safe for them.
- `crates/workspace/src/workspace.rs:1195-1204` `AppState { languages, client: Arc<Client>, user_store, workspace_store, fs: Arc<dyn fs::Fs>, build_window_options, node_runtime, session }`; `:1287` `Client::new(clock, http_client, cx)` in the test constructor. `crates/zed/src/main.rs:342` `db::AppDatabase::new()`, `:432` `RealFs::new(git_binary_path, executor)`, `:433-437` `watch_config_file(.., paths::keymap_file())`, `:523` `Client::production(cx)`, `:1383` `GlobalKeyValueStore::global()` — the desktop boot sequence that `zed_web` mirrors with `WasmFs::new`, `AppDatabase::open_with_image` and `GlobalKeyValueStore::init`.
- `crates/paths/src/paths.rs:122-141` `config_dir()` falls to `home_dir().join(".config").join("zed")` on non-mac/linux/windows targets (wasm's `target_os = "unknown"`); `:258-261` `database_dir() = data_dir().join("db")`; `:278-281` `settings_file()`; `:296-299` `keymap_file()`; `:386-392` `prompts_dir()`. `crates/util/src/paths.rs:23-38` `home_dir()` is `#[cfg(not(target_family = "wasm"))]` — the wasm `home_dir` is b7 §3.1's and returns `/home/web` (D11 — deliberately distinct from the native test-fixture root `/home/zed` at `paths.rs:29-36`, so browser paths never coincide with `FakeFs` fixtures; on wasm `config_dir()` is therefore `/home/web/.config/zed` and `settings_file()`/`keymap_file()` are `/home/web/.config/zed/{settings,keymap}.json`); it is a hard prerequisite for `paths::*` and therefore for `WasmFs` seeding, `db`, `prompt_store` and `telemetry::log_file_path`.
- `crates/path/src/path.rs:486-512` `normalize_path`: strips `.` and pops on `..` but leaves a relative path relative (no root is added) — `WasmFs` must reject non-absolute paths itself (4.1).
- `crates/clock/src/system_clock.rs:1` `use std::time::Instant;`, `:8-14` `RealSystemClock::utc_now()` returns `Instant::now()` — panics at runtime on `wasm32-unknown-unknown`. `Client::production` builds it (`client.rs:585`) and `Telemetry::log_edit_event` (`telemetry.rs:418`) reaches it through `event_coalescer` on every edit. `crates/clock/Cargo.toml` has no `web-time` dependency. Fixed in 3.9.

fs

- `crates/fs/Cargo.toml:11-13` `[lib] path = "src/fs.rs"`, `test = false` (no lib unit tests: all tests live in `tests/integration`); `:15-18` integration test target with `required-features = ["test-support"]`; `:20-48` deps — `async-tar` (23), `git` (27), `libc` (30), `smol` (40), `tempfile` (42), `is_executable = "1.0.5"` (46), `notify = "9.0.0-rc.4"` (47), `trash` git fork (48); `:50-51` `rustix` under `cfg(unix)`; `:69-70` `test-support` feature.
- `crates/fs/src/fs.rs:1` `pub mod fs_watcher;`, `:3` `pub use fs_watcher::requires_poll_watcher;`, `:8` `use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};` (`AtomicU8` is only `RealFs.is_case_sensitive` at `:423`), `:9` `use std::time::Instant;` (used by `JobInfo.start` at `:319-324`; `Instant::now` panics at runtime on wasm), `:10` `use util::maybe;` (only `:1306`, inside `RealFs`), `:13` `use futures::stream::iter;` (only `:1126`, inside `RealFs`), `:19-31` unix/macos-only imports (already excluded on wasm), `:21` `use util::command::new_command;`, `:34` `use async_tar::Archive;`, `:35` `use futures::{AsyncRead, Stream, StreamExt, future::BoxFuture};`, `:36` `use git::repository::{GitRepository, RealGitRepository};`, `:37` `use is_executable::IsExecutable;`, `:40` `use smol::io::AsyncWriteExt;`, `:43-49` `use std::{io::{self, Write}, ..}` (`Write` is only used by `RealFs` at `:934,962`), `:50` `use tempfile::TempDir;`, `:53-70` `test-support`-only imports (unchanged: the browser build never enables `test-support`).
- `fs.rs:72-75` `pub trait Watcher { add, remove }`; `:77-89` `PathEventKind { Removed, Created, Changed, Rescan }`, `PathEvent { path, kind: Option<PathEventKind> }`.
- `fs.rs:97-182` `pub trait Fs` — 34 items, of which 32 are required (`load` at `:132-134` and `as_fake` at `:178-181` have default bodies); all listed in section 4.1's table; `:107-111` `extract_tar_file(.., Archive<Pin<&mut (dyn AsyncRead + Send)>>)` is the only signature that names a native-only type; `:158-166` git methods.
- `fs.rs:184-224` `TrashedEntry` and its `trash::TrashItem` conversions; `:226-239` `TrashRestoreError { NotFound, Collision, AlreadyRestored, Unknown }` (kept; `WasmFs` uses it); `:241-251` `From<trash::Error>`.
- `fs.rs:253-267` `GlobalFs` + `impl dyn Fs { global, set_global }` (unchanged; `zed_web` calls `set_global`); `:269-293` `CreateOptions`, `CopyOptions`, `RenameOptions { overwrite, ignore_if_exists, create_parents }`, `RemoveOptions { recursive, ignore_if_not_exists }`; `:295-305` `Metadata { inode, mtime, is_symlink, is_dir, len, is_fifo, is_executable, is_writable }`; `:313-315` `MTime(SystemTime)`; `:366-371` `MTime::from_seconds_and_nanos` (the wasm-safe constructor: `UNIX_EPOCH + Duration` never calls the clock); `:407-415` `TrashId` slotmap key with `from_proto`/`to_proto`.
- `fs.rs:417-424` `pub struct RealFs { bundled_git_binary_path, executor, next_job_id, job_event_subscribers, trash, is_case_sensitive }`; `:426-428` `pub trait FileHandle { fn current_path(&self, fs: &Arc<dyn Fs>) -> Result<PathBuf>; }`; `:430-520` `impl FileHandle for std::fs::File` whose only method bodies are `cfg(target_os = macos|linux|freebsd|windows)`, so on wasm the impl has no `current_path` and fails to compile; `:522` `pub struct RealWatcher {}`; `:524-576` `impl RealFs { new, canonicalize(windows) }`; `:578-635` rename/CString helpers (already OS-gated); `:646-686` `read_dir_entries` (unix via `rustix`, `not(unix)` via `std::fs`); `:688-1384` `impl Fs for RealFs` (`:1129-1192` `watch`: `async_channel::unbounded`, `FsWatcher::new`, symlink parent watch, and the `rx.filter_map(|_| async { executor.timer(latency).await; take pending })` debounce that `WasmFs` copies verbatim; `:1285-1289` `subscribe_to_jobs`; `:1295-1352` `is_case_sensitive` probe with `TempDir`; `:1361-1383` `restore` spawns an OS thread for `trash::restore_all`); `:1386-1395` `impl Watcher for RealWatcher` (`cfg(not(linux|freebsd))`, so it would be compiled on wasm).
- `fs.rs:1397-3437` `FakeFs` (all `#[cfg(feature = "test-support")]`); the parts `WasmFs` mirrors: `:1692-1716` `emit_event`/`flush_events` (per-watcher `try_send` of `Vec<PathEvent>`), `:3141-3150` `open_handle` returning `FakeHandle { inode }`, `:3161-3190` `atomic_write`/`save`/`write` (create parents, then write; `save` uses `text::chunks_with_line_ending`), `:3219-3264` `metadata` (follows symlinks; `is_writable: true`, `is_executable: false`), `:3280-3295` `read_dir` as `stream::iter` of joined child names, `:3297-3335` `watch` with prefix filtering, `:3101-3131` `trash` and `:3389-3433` `original_path_for_trash_id`/`restore` on a `SlotMap<TrashId, ..>`.
- `fs.rs:3440-3487` `copy_recursive`, `read_dir_items`, `read_recursive` — generic over `&dyn Fs`; kept on wasm (worktree and project import them).
- `crates/fs/src/fs_watcher.rs:2` `use notify::{Event, EventKind};`, `:10` `time::{Duration, Instant}`, `:191` `pub fn requires_poll_watcher(path: &Path) -> bool`, `:225` `telemetry::event!` — the whole module is native.
- `crates/keymap_editor/src/keymap_editor.rs:3670,3723` `fs.write(..)` of `keymap.json`, and the settings UI's `update_settings_file` — both open the file in a local worktree over the in-memory fs, so `Worktree::local` over `WasmFs` (metadata with stable inodes, `read_dir` full paths, `canonicalize` of the root, `open_handle`, directory `watch`, `is_case_sensitive`) is exercised in production; section 6 adds the test.
- Fork evidence (`zed-web/crates/fs`): gated `fs_watcher`, `RealFs`, `TrashedEntry`, `FileHandle for File`, moved `async-tar/libc/tempfile/is_executable/notify/trash` under `not(wasm)` (its `git` and `smol` lines are duplicated in both tables, i.e. not actually moved), switched to `web_time::Instant`, gated `extract_tar_file` out of the trait, and gave the git trait methods default `bail!` bodies. Its `WasmFs` is a unit struct whose `load_bytes` returns empty and `watch` returns an empty stream — i.e. settings never load or reload. Not copied.

terminal

- `crates/terminal/Cargo.toml:22-48` deps: `alacritty_terminal` (24), `libc` (31), `sysinfo` (38), `task` (already present; home of b3's `ExitStatus`), `vte` (46); `:50-51` `windows` under `cfg(windows)`; `:53-57` dev-deps.
- `crates/terminal/src/terminal.rs:1-5` `mod mappings; mod alacritty; mod pty_info; pub mod terminal_settings;`; `:37-38` `#[cfg(unix)] use std::os::unix::process::ExitStatusExt;`; `:39-51` std imports (`process::ExitStatus` — b3 §3.5a replaces it with `pub use task::ExitStatus;`; `time::{Duration, Instant}` at `:50`); `:53` `use vte::ansi::{Attr, Handler, Processor, StdSyncHandler};`; `:63` `#[cfg(not(windows))] use crate::alacritty::current_child_signal_mask;`; `:64-75` the `crate::alacritty::{...}` import list (`open_pty`, `pty_options`, `spawn_event_loop` at `:69-71`); `:86-94` `HeadlessTerminal` global (kept).
- `terminal.rs:199,206` `Processor::<StdSyncHandler>::default()` in the `convert_lf_to_crlf` helpers, `:1022`/`:1309` `output_processor: Processor::<StdSyncHandler>::new()`, `:1509` the `Terminal.output_processor` field, `:1962-1972` `write_output` (`self.output_processor.advance(&mut *term, ..)` on the **foreground** thread — the path b3's `process_remote_output` reuses), `:3322` the same in `spawn_task_subprocess`'s pump (native). `vte-0.15.0/src/ansi.rs:23` `use std::time::Instant;`, `:456-475` `impl Timeout for StdSyncHandler` — `set_timeout` calls `Instant::now()` whenever the parser sees a synchronized-update begin (`CSI ?2026h`, sent by neovim, tmux, zellij, fzf and most modern TUIs), which panics at runtime on `wasm32-unknown-unknown`; `:478-490` `pub trait Timeout: Default { set_timeout, clear_timeout, pending_timeout }`; `:292` `sync_timeout()`, `:315` `stop_sync()`. Natively alacritty's `EventLoop` polls with `sync_timeout` and calls `stop_sync` when it elapses; `write_output` has no such timer even today.
- `terminal.rs:760-762` `enum PtyEvent { Event(TerminalBackendEvent) }` (b3 adds `Output`/`RemoteLost`); `:833` `TerminalError`; `:890-891` `DEFAULT_SCROLL_HISTORY_LINES`/`MAX_SCROLL_HISTORY_LINES`; `:935-968` `TerminalMode` and `TerminalModeKind { Interactive, InteractiveWithCompletion(Sender<Option<ExitStatus>>), Task { state, completion_tx } }` (`:937-943`), `interactive_with_completion` at `:953`; `:971-974` `TerminalBuilder { terminal, events_rx }`; `:976-1078` `new_display_only(_with_bounds)`; `:1080-1400` `TerminalBuilder::new` — `:1101` `HeadlessTerminal::is_enabled`, `:1103` `current_child_signal_mask()` call, `:1128-1136` `env` fixups, `:1240-1268` the `no_pty` subprocess branch, `:1270-1300` `pty_options`/`open_pty`/`PtyProcessInfo::new(ProcessIdGetter::from(&pty))`/`spawn_event_loop` (`:1290`), `:1294` `PtyResources::Active(pty_tx)`, `:1399` `cx.background_spawn(fut)`; `:1402-1486` `subscribe` (foreground `cx.spawn` draining `events_rx`; `events_tx` is created at `:1012`/`:1210` and moved into `new_term`/`spawn_event_loop`/`spawn_task_subprocess` — `Terminal` never retains it).
- `terminal.rs:1488-1491` `enum PtyResources { Active(PtySender), Released }`; `:1493-1499` `enum TerminalType { Pty { resources, info: Arc<PtyProcessInfo> }, DisplayOnly }`; `:1501-1558` `struct Terminal` (`:1505` `subprocess: Option<SubprocessHandle>`, `:1506` `completion_tx: Option<Sender<Option<ExitStatus>>>`, `:1529` `last_mouse_move_time: Instant`, `:1536` `child_exited: Option<ExitStatus>`, `:1540` `event_loop_task`, `:1554-1558` test-only fields); `:1560-1569` `CopyTemplate`; `:1573-1578` `TaskState { status, completion_rx (private), spawned_task }`.
- `terminal.rs:1617-1621` `process_pty_event`; `:1623-1700` `process_event` (`:1670` `Exit => register_task_finished(None)`, `:1677-1680` `Wakeup` arm polls `info` only for `TerminalType::Pty`, `:1696-1698` `ChildExit(status)`); `:1722-1728` resize site; `:2110-2128` `write_to_pty`; `:2142-2146` `start_init_command_startup_handshake` returns early unless `is_pty()`; `:2205-2207` `is_pty` (b3 §3.5k widens it to `Pty | Remote`; production consumer `crates/agent_ui/src/agent_panel.rs:2147`, test consumer `crates/agent/src/agent.rs:3935` inside a `#[gpui::test]` at `:3922-3952`); `:2890-2898` `foreground_process_command_name` (consumer `agent_panel.rs:1098`); `:2907-2915` `client_side_working_directory`; `:2969-3016` `title`; `:3021-3040` `kill_active_task`; `:3044-3052` `has_active_pty_resources` (consumers: only the `agent.rs:3924-3950` test); `:3057-3077` `release_pty_resources`; `:3079-3084` `pid() -> Option<sysinfo::Pid>` (consumer `crates/debugger_ui/src/session/running.rs:1389-1392`, which errors with "Terminal was spawned but PID was not available" on `None`); `:3086-3091` `pid_getter()` (consumer `crates/terminal_view/src/terminal_view.rs:1447`); `:3097-3107` `wait_for_completed_task() -> Task<Option<ExitStatus>>` (consumers that read the payload: `debugger_ui/session/running.rs:1225-1230` `.success()`, `agent_ui/src/conversation_view.rs:2171-2185` `.success()`/`.code()`, `terminal_view/src/terminal_panel.rs:1389,1842` (returned as `Task<Option<Result<ExitStatus>>>` through `workspace::TerminalProvider::spawn`, `workspace.rs:197`), `acp_thread/src/terminal.rs:441`); `:3109-3184` `register_task_finished` (`:3113-3118` `completion_tx.try_send(exit_status)` and `child_exited = Some(e)`, `:3132` `child_exited.is_none_or(|e| e.code() == Some(0))`, `:3143` `exit_status.and_then(|e| e.code())`); `:3187-3206` `clone_builder` (calls `TerminalBuilder::new`); `:3209-3247` `task_summary(task, Option<ExitStatus>)` (uses `ExitStatusExt::signal` under `cfg(unix)`; b3 widens the cfg); `:3269-3282` `SubprocessHandle { child: Arc<Mutex<Option<util::process::Child>>>, _reader }`; `:3285-3382` `spawn_task_subprocess` (`util::command::new_std_command`, `util::process::Child::spawn`, `std::process::Stdio`); `:3384-3390` `impl Drop for Terminal`; `:3565` `mod tests`; `:5602-5610` the exhaustive `terminal_type` match in a test helper (b3 adds the `Remote` arm).
- `std::process::ExitStatus::default()` is success on every target (`library/std/src/process.rs:1887-1894`, stable since 1.73), and the `wasm32-unknown-unknown` stub (`library/std/src/sys/process/unsupported.rs:201-212`) is a unit struct whose `code()` is always `Some(0)`; hence b3's `task::ExitStatus` struct on wasm. This brief adds nothing to the exit-status story.
- `crates/terminal/src/alacritty/hyperlinks.rs:15` `time::{Duration, Instant}`, `:328` `let search_start_time = Instant::now();`, `:331` `Instant::now().saturating_duration_since(..)` — the `path_hyperlink_timeout` budget, evaluated on the main thread on every mouse move over terminal content; panics at runtime on wasm unless swapped.
- `crates/terminal/src/alacritty.rs:9-30` the `alacritty_terminal::{ event::{..}, event_loop::{EventLoop, Msg, Notifier} (:11), grid, index, selection, sync::FairMutex, term::{..}, tty (:24), vi_mode, vte::ansi::{..} }` import; `:45-52` type aliases (`AlacrittyPty = tty::Pty` at `:49`, `AlacrittyTermLock = FairMutex<Term<ZedListener>>`); `:66-70` `#[cfg(unix)] impl From<&AlacrittyPty> for ProcessIdGetter`; `:73-83` windows variant; `:85-109` `PtySender { notifier: Notifier }` with `notify`, `resize`, `shutdown`; `:111-118` `window_size_from_terminal_bounds`; `:157-160` `current_child_signal_mask`; `:161-178` `pty_options`; `:180-186` `open_pty`; `:188-201` `new_term` (pure; kept); `:203-217` `spawn_event_loop`.
- `crates/terminal/src/pty_info.rs:8` `use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};`; `:13-29` `ProcessIdGetter { handle: i32, fallback_pid: u32 }` with `new` (`:20-26`) and `fallback_pid() -> Pid`; `:31-48` `#[cfg(unix)] fn pid()` (`libc::tcgetpgrp` at `:37`); `:50-66` `#[cfg(windows)] fn pid()`; no impl for other targets; `:86-115` `PtyProcessInfo::new`; `:149-160` `kill_current_process` (`libc::killpg` under `cfg(unix)`, `process.kill()` under `cfg(not(unix))`); `:166-175` `terminate_child_process` (unix / `not(unix)` returns false); `:241-243` `pid()`.
- `sysinfo-0.37.2/src/lib.rs:29-67` — `cfg_if!` chain whose final `else` selects `mod unknown` (stub backend) for every unsupported target; `sysinfo-0.37.2/Cargo.toml:230` excludes `libc` on `target_arch = "wasm32"`. So `sysinfo` compiles on `wasm32-unknown-unknown` with `System::new()`, `refresh_processes_specifics` and `process()` as no-ops, and `pty_info.rs` only lacks a `pid()` impl.
- `~/.cargo/git/checkouts/alacritty-20195d12a03fa0c5/4c12966/alacritty_terminal/Cargo.toml` — `[dependencies]` `home = "0.5.5"`, `libc`, `polling = "3.8.0"` (plus `base64`, `bitflags`, `log`, `parking_lot`, `regex-automata`, `unicode-width`, `vte`, optional `serde`); `[target.'cfg(unix)']` `rustix-openpty`, `rustix`, `signal-hook`; `[target.'cfg(windows)']` `piper`, `miow`, `windows-sys`. `src/lib.rs:7-16` `pub mod event; event_loop; grid; index; selection; sync; term; thread; tty; vi_mode;`. Native-only modules: `src/event_loop.rs:15` `use polling::{..}`, `src/tty/mod.rs:9` `use polling::{..}` and `:134` `home::home_dir()`, `src/thread.rs:1` `std::thread::Builder`. Everything else (`event.rs` — only `std::process::ExitStatus`, `grid/`, `index.rs`, `selection.rs`, `sync.rs`, `term/`, `vi_mode.rs`) has no native dependency; `src/sync.rs:5` `use parking_lot::{Mutex, MutexGuard};` is the only `parking_lot` user (`FairMutex` = two `parking_lot::Mutex`es). `polling-3.11.0/src/lib.rs:118` `compile_error!("polling does not support this target OS")` is the hard blocker.
- Fork evidence: `zed-web/crates/alacritty_terminal` is a vendored copy (the form D10 now prescribes for our tree too, at `vendor/alacritty_terminal`, 3.1) whose only gate deltas are `src/lib.rs:8,15,17` (`#[cfg(not(target_family = "wasm"))]` on `event_loop`, `thread`, `tty`) and `Cargo.toml` moving `home`, `libc`, `polling` into `[target.'cfg(not(target_family = "wasm"))'.dependencies]` (plus `rust-version = "1.85.0"` literal). In `crates/terminal` the fork gated `event_loop`/`tty` imports, `PtySender`, `pty_options`/`open_pty`/`spawn_event_loop`, `current_child_signal_mask`, removed `sysinfo` and rewrote `pty_info.rs` around `u32` pids (changing native API), and added a JSON-RPC `remote_pty.rs`. We keep `sysinfo` and the native pid API; the remote surface is b3's.

client

- `crates/client/Cargo.toml:18-62` deps: `async-tungstenite = { workspace = true, features = ["tokio", "tokio-rustls-manual-roots"] }` (21), `clock` (kept; see 3.9), `fs` (31), `gpui_tokio` (34), `http_client_tls` (36), `proxy_handshake = { .., features = ["tokio"] }` (41), `rpc = { .., features = ["gpui"] }` (45), `smol` (51), `tiny_http` (57), `tokio` (58), `worktree` (61), `zed_credentials_provider` (62); `:64-72` dev-deps; `:81-86` `tokio-native-tls` under `any(windows, macos)` and `rustls-pki-types`/`tokio-rustls` under `not(any(windows, macos))` — the latter matches wasm.
- `crates/client/src/client.rs:1-8` modules (`mod proxy;` at `:5`); `:10-15` `use async_tungstenite::tungstenite::{client::IntoClientRequest, error::Error as WebsocketError, http::{HeaderValue, Request, StatusCode}}`; `:23-25` `use futures::{AsyncReadExt, FutureExt, SinkExt, Stream, StreamExt, TryFutureExt as _, TryStreamExt, ..}` (`AsyncReadExt` is only used by `authenticate_as_admin`'s `read_to_string` at `:1593`, so it becomes unused on wasm); `:33` `use proxy::{connect_proxy_stream, excluded_from_proxy};`; `:49` `time::{Duration, Instant}`; `:54` `use tokio::net::TcpStream;`; `:64-86` env statics (all `std::env::var`, fine on wasm).
- `client.rs:207-243` `pub struct Client { id, peer: Arc<Peer>, http, cloud_client, telemetry, credentials_provider, state, handler_set, message_to_client_handlers, sign_out_tx, test-only hooks }`; `:245-258` `EstablishConnectionError` (`:253` `InvalidHeaderValue(#[from] tungstenite::http::header::InvalidHeaderValue)`, `:257` `Websocket(#[from] tungstenite::http::Error)` — plain `http` crate types, available without tokio); `:260-271` `From<WebsocketError>`; `:280-299` `Status` (`:296-298` `ReconnectionError { next_reconnection: Instant }` — constructed only at `:727`; no crate reads the field: `crates/title_bar/src/title_bar.rs:1160` and `crates/workspace/src/workspace.rs:10190` match `ReconnectionError { .. }`); `:333-340` `ClientState`; `:359-368` `ClientCredentialsProvider::new` → `zed_credentials_provider::global(cx)`.
- `client.rs:558-580` `Client::new(clock, http, cx)`; `:584-590` `production(cx)` (`clock::RealSystemClock` at `:585`; uses `cx.http_client()`, i.e. gpui's `FetchHttpClient` on web); `:686-748` `set_status` reconnect loop (`Instant::now() + delay` at `:727`); `:873-878` `has_credentials`; `:880-959` `sign_in` (on `authenticate` error sets `Status::AuthenticationError` and returns the error at `:933-934`); `:983-1040` `connect_to_cloud`/`run_cloud_connection` (`:1015`; via `CloudApiClient::connect`, which upstream already gates internally); `:1129-1172` `connect_with_credentials`; `:1177-1257` `set_connection` (`executor.spawn(handle_io)` at `:1184` — Peer's IO future is `Send`, fine on the wasm background executor; `smol::future::yield_now()` at `:1231`); `:1261-1268` `authenticate`; `:1270-1281` `establish_connection` → `establish_websocket_connection`; `:1283-1323` `rpc_url`; `:1326-1428` `establish_websocket_connection` (`gpui_tokio::Tokio::spawn_result` at `:1357`, proxy/`TcpStream` at `:1365-1371`, `async_tungstenite::tokio::client_async_tls_with_connector_and_config` + `http_client_tls::tls_config()` at `:1414-1420`); `:1430-1559` `authenticate_with_browser` (`tiny_http::Server::http("127.0.0.1:0")` at `:1470`, background OS threads); `:1561-1602` `authenticate_as_admin` (plain HTTP; only reachable from the browser flow); `:1693-1704` `sign_out`; `:2002-2003` `#[cfg(test)] mod tests`.
- `crates/client/src/proxy.rs:1-92` — entirely tokio (`tokio::net::TcpStream`, `tokio::net::lookup_host`, `proxy_handshake::tokio::establish`, `tokio_native_tls`/`tokio_rustls`).
- `crates/client/src/telemetry.rs:6` `use fs::Fs;`, `:17` `use std::fs::File;`, `:20` `use std::time::Instant;`, `:35` `use worktree::{UpdatedEntriesSet, WorktreeId};`, `:109-126` `os_name()` — a sequence of `#[cfg(target_os = ..)]` blocks with no wasm block (empty body → type error), `:128-176` `os_version()` `cfg_select!` with `feature = "test-support"`, macos, linux/freebsd, windows arms and no wasm arm (compile error), `:214-222` `File::create(Self::log_file_path())` inside `background_spawn` (runtime `Err` on wasm, harmless), `:284-286` `log_file_path() = paths::logs_dir().join("telemetry.log")`, `:419` `static LAST_EVENT_TIME: Mutex<Option<Instant>>` (the imported type), `:426` `let current_time = std::time::Instant::now();` (**fully qualified** — an import swap does not reach it; on wasm it is a type mismatch against `:419` and a runtime panic), `:427` `last_event.get_or_insert(current_time)`. `crates/client/src/telemetry/event_coalescer.rs:1-2` `use std::time; use std::{sync::Arc, time::Instant};`, `:12-13,29` `Instant` fields and return type — fed by `SystemClock::utc_now()` (`clock`).
- `crates/zed_credentials_provider/src/zed_credentials_provider.rs:39-43` `global(cx)`; `:45-66` `new` picks `DevelopmentCredentialsProvider` or `KeychainCredentialsProvider` (`:68-78` uses `cx.read_credentials`, a gpui platform call) — no native crate dependency (`Cargo.toml:14-21`: anyhow, credentials_provider, futures, gpui, paths, release_channel, serde_json), so it compiles on wasm and stays ungated.
- `crates/http_client_tls/Cargo.toml` deps `rustls`, `rustls-platform-verifier`, `webpki-roots`; `crates/gpui_tokio/Cargo.toml` `tokio = { features = ["rt", "rt-multi-thread"] }` — both dropped on wasm.
- `tungstenite-0.28.0/Cargo.toml:159-160` `[dependencies.rand] version = "0.9.0"` and `src/protocol/frame/mask.rs:4` `rand::random()` (frame masking) — so keeping `async-tungstenite` on wasm pulls `rand 0.9` → `getrandom 0.3`, satisfied by gpui's `wasm_js` feature in `client`'s graph (and by 3.3's line in `sqlez`).
- Fork evidence (`zed-web/crates/client`): moved `async-tungstenite`, `gpui_tokio`, `http_client_tls`, `proxy_handshake`, `tiny_http`, `tokio`, `zed_credentials_provider` (and, unnecessarily, `fs`, `paths`, `worktree`, `rpc`) under `not(wasm)`; gated `mod proxy`, the tungstenite import, `EstablishConnectionError::{InvalidHeaderValue, Websocket}`, `From<WebsocketError>`, `connect_to_cloud`, `run_cloud_connection`, `establish_websocket_connection`, `authenticate_with_browser`, `authenticate_as_admin`; added a wasm `WasmCredentialsProvider` and a `rpc::wasm_conn`-based connection (the collab-in-browser path we do not want); `telemetry.rs` got a `target_family = "wasm"` arm in `os_name`/`os_version`, `web_time::Instant`, and gates on `log_file`/`worktree`. We keep `async-tungstenite` (type-only) so the error enum and `From` impl stay ungated, keep `fs`/`paths`/`worktree`, and keep `zed_credentials_provider`.

acp_thread

- `crates/acp_thread/Cargo.toml:32` `http_proxy`, `:41` `portable-pty.workspace = true`, `:43` `sandbox`; `crates/sandbox/Cargo.toml` `[dependencies]` are pure (anyhow, futures, http_proxy, log) with all OS bits under `cfg(target_os = linux|macos|windows)`; `crates/http_proxy/Cargo.toml` deps are pure Rust (httparse, idna, proxyvars, url, ...). Both compile on wasm as dead code, per BUILD-SPEC `:134`.
- `crates/acp_thread/src/terminal.rs:11-19` std imports (`process::ExitStatus` at `:14`, `time::Instant` at `:19`); `:402-428` `Terminal { id, _sandbox, command, working_dir, terminal: Entity<terminal::Terminal>, started_at: Instant, output, .. }` and `TerminalOutput { ended_at, exit_status: Option<ExitStatus>, content, .. }` (`:424`); `:430-511` `Terminal::new` — `:441` `wait_for_completed_task`, `:476-489` the `this.update` block that stores `TerminalOutput` and calls `release_pty_resources` (and reads `get_content()` afterwards — the grid must stay readable after release), `:504-508` `exit_status.map(portable_pty::ExitStatus::from)` then `acp::TerminalExitStatus::new().exit_code(..).signal(..)`; `:540-580` `current_output` (`:542-548` second `portable_pty` conversion); `:595-597` `started_at() -> Instant`.
- `portable-pty-0.9.0/src/lib.rs:170-241` `ExitStatus { code: u32, signal: Option<String> }`, `exit_code()`, `signal()`, and `From<std::process::ExitStatus>`: on `cfg(unix)` maps `ExitStatusExt::signal()` through `libc::strsignal` to a name and forces `code = 1` for signalled children, otherwise `code = status.code() or (success ? 0 : 1)`.
- `crates/acp_thread/src/acp_thread.rs:38` `use std::time::{Duration, Instant};` (turn timing); `:2063-2070` `pub struct RetryStatus { last_error, attempt, max_attempts, started_at: Instant, duration, meta }` — constructed by `crates/agent/src/thread.rs:3030,3345` (import at `:67`) and read by `crates/agent_ui/src/conversation_view/thread_view.rs:3043` (`Instant::now().saturating_duration_since(state.started_at)`), so swapping the import here changes the field's type on wasm for those two crates (section 7 item 5); `:5335-5360` a test that builds a real PTY via `TerminalBuilder::new` (native only); `:5385-5399` a test using `std::time::Instant` explicitly (unaffected).
- Fork evidence: gated `portable-pty` under `not(wasm)`, added `terminal_exit_status_from_process` helper with a wasm branch, `web_time::Instant`, and (beyond our scope, dead code under the shim) gated `sandbox` calls.

sqlez and db

- `crates/sqlez/Cargo.toml:11-23` deps: `libsqlite3-sys` (16), `pollster` (19; used only by the test at `thread_safe_connection.rs:347`), `sqlformat` (20, pure Rust — kept), `thread_local = "1.1.4"` (21), `util` (22), `uuid` (23 — `Uuid::new_v4` in `ThreadSafeConnection::new` names; pulls `getrandom 0.3.4`). No `[features]` table.
- `crates/sqlez/src/lib.rs:1-11` module list.
- `crates/sqlez/src/connection.rs:10` `use libsqlite3_sys::*;`; `:12-18` `Connection { sqlite3: *mut sqlite3, persistent, write: RefCell<bool>, _sqlite }` + `unsafe impl Send`; `:21-44` `open_with_flags` (`sqlite3_open_v2`, `sqlite3_extended_result_codes`); `:46-52` `open` with `SQLITE_OPEN_CREATE | NOMUTEX | READWRITE`; `:56-58` `open_file` falls back to `open_memory(Some(uri))`; `:60-72` `open_memory` uses `file:{uri}?mode=memory&cache=shared` + `SQLITE_OPEN_URI`; `:82-94` `backup_main` (`sqlite3_backup_init/step/finish`); `:101-199` `sql_has_syntax_error` (opens a scratch memory connection for ALTER TABLE; `sqlite3_error_offset` under `cfg(not(linux|freebsd))` — on wasm `target_os = "unknown"`, so the offset call is compiled and must exist); `:201-221` `last_error`; `:223-228` `with_write` (flips the `RefCell` around the callback); `:269-273` `Drop` → `sqlite3_close`; `:275-531` `#[cfg(test)] mod test`.
- `crates/sqlez/src/statement.rs:6` `use libsqlite3_sys::*;`; `:11-21` `Statement<'a> { raw_statements: Vec<*mut sqlite3_stmt>, current_statement, connection: &'a Connection, phantom }`; `:40-86` `prepare` (`sqlite3_prepare_v2`, `sqlite3_stmt_readonly`, `sqlite3_sql`, and the "Write statement prepared with connection that is not write capable" guard reading `connection.can_write()`); `:273-290` `step`; `:383-391` `Drop` → `sqlite3_finalize`. Full FFI symbol set used by sqlez (verified by grep across `connection.rs`, `statement.rs`, `migrations.rs`): `sqlite3_open_v2`, `sqlite3_extended_result_codes`, `sqlite3_errcode`, `sqlite3_errmsg`, `sqlite3_close`, `sqlite3_backup_init/step/finish`, `sqlite3_prepare_v2`, `sqlite3_error_offset`, `sqlite3_finalize`, `sqlite3_exec`, `sqlite3_stmt_readonly`, `sqlite3_sql`, `sqlite3_reset`, `sqlite3_bind_parameter_count`, `sqlite3_bind_{blob,double,int,int64,null,text}`, `sqlite3_column_{blob,bytes,double,int,int64,text,type}`, `sqlite3_step`, `SQLITE_TRANSIENT()`, and the `SQLITE_OPEN_*`, `SQLITE_OK/ROW/DONE/MISUSE`, `SQLITE_INTEGER/FLOAT/TEXT/BLOB/NULL` constants; b4 adds `sqlite3_serialize`, `sqlite3_deserialize`, `sqlite3_malloc64`, `sqlite3_free`, `SQLITE_DESERIALIZE_*`.
- `crates/sqlez/src/migrations.rs:11` `use libsqlite3_sys::sqlite3_exec;` (a single-item import; compiles unchanged under the package rename); `:16-31` `Connection::eager_exec` — the function that makes the `sqlite3_exec` call at `:19-25` and then `last_error()`; `:92` `migrate` is its only caller.
- `crates/sqlez/src/thread_safe_connection.rs:9` `thread`, `:12` `use thread_local::ThreadLocal;`, `:28` `static QUEUES: RwLock<HashMap<Arc<str>, WriteQueue>>` (parking_lot), `:34-42` `ThreadSafeConnection { uri, persistent, connection_initialize_query, connections: Arc<ThreadLocal<Connection>> }` + `unsafe impl Send/Sync`, `:79-126` `build` (migrations inside `self.connection.write(..)`), `:130-141` `initialize_queues` (`write_queue_constructor.unwrap_or_else(background_thread_queue)` at `:135-136`, under `QUEUES.write()`), `:159-167` `open_file`/`open_shared_memory`, `:169-190` `write` (takes `QUEUES.read()`, then hands the closure to the queue; with `locking_queue` it runs synchronously on the caller's thread inside `connection.with_write`), `:192-243` `create_connection` (`:205-235` schema-lock retry loop with `thread::sleep` at `:216`; `:240` `*connection.write.get_mut() = false`), `:272-280` `Deref` → `self.connections.get_or(|| create_connection(..))`, `:282-304` `background_thread_queue` (`std::thread::Builder::spawn`), `:306-314` `locking_queue` — `let write_mutex = Mutex::new(())` (**parking_lot**) taken inline by every `write`, `:316-373` `#[cfg(test)] mod test`.
- `crates/sqlez/src/util.rs:1-32` `UnboundedSyncSender` (`ThreadLocal`; used only by `background_thread_queue`).
- `crates/sqlez_macros/src/sqlez_macros.rs:4-13` — under `#[cfg(not(any(target_os = "linux", target_os = "freebsd")))]` the proc macro opens a `ThreadSafeConnection::new(.., locking_queue())` at compile time (on Linux/FreeBSD it only formats); it is a host-target build of `sqlez` and is unaffected by the wasm target table.
- `crates/db/Cargo.toml:18-30` deps (`gpui`, `indoc`, `inventory`, `paths`, `release_channel`, `sqlez`, `sqlez_macros`, `util`, `uuid`, `zed_env_vars`); `crates/db/src/db.rs:21` `use std::fs::create_dir_all;`, `:38` `inventory::collect!(DomainMigration)`, `:60-91` `AppDatabase` (`:63-67` `new()` uses `gpui::block_on` at `:65`), `:125-134` `CONNECTION_INITIALIZE_QUERY`/`DB_INITIALIZE_QUERY` (`PRAGMA journal_mode=WAL` returns `memory` on an in-memory db; `PRAGMA busy_timeout=500` at `:131` installs SQLite's busy handler, whose waits go through the VFS `xSleep`), `:136` `FALLBACK_DB_NAME`, `:174-203` `open_db` (`create_dir_all` at `:185-189`), `:205-213` `open_main_db`, `:215-225` `open_fallback_db` (passes no write-queue constructor, so it gets the default), `:227-239` `open_test_db` (uses `locking_queue()`), `:287-293` `write_and_log` (runs the write on `background_spawn`).
- `crates/db/src/kvp.rs:224` `pub struct GlobalKeyValueStore(ThreadSafeConnection);`, `:244-250` `static GLOBAL_KEY_VALUE_STORE: LazyLock<GlobalKeyValueStore>` whose initializer calls `gpui::block_on(crate::open_db::<GlobalKeyValueStore>(db_dir, GlobalDbScope))` — a second native-only `block_on` in `db`; `:252-255` `global()`. Browser-set consumer: `crates/prompt_store/src/rules_to_skills_migration.rs:46,108,124,486,500`; desktop: `crates/zed/src/main.rs:1383`.
- `inventory-0.3.21/src/lib.rs:105-146` — on `wasm*-unknown-unknown` the registrations run from `__wasm_call_ctors`, which the linker only calls from exported functions under "command-style linkage"; a module driven by wasm-bindgen's threads transform may need the embedder to call it explicitly (b7 §7 item 3 owns the loader side).
- `libsqlite3-sys-0.30.1/build.rs:118-142` bundled flag set (`SQLITE_THREADSAFE=1`, `SQLITE_ENABLE_LOAD_EXTENSION=1`, FTS/JSON/RTREE, ...); `:242-256` the only wasm handling is `TARGET == "wasm32-wasi"` (`THREADSAFE=0`, WASI emulation defines, optional `wasm32-wasi-vfs.c`); nothing for `wasm32-unknown-unknown` (it would compile `sqlite3.c` for a unix OS layer against whatever `CC` is and fail to link). `sqlite3/sqlite3.h:149` version 3.46.0; `sqlite3/bindgen_bundled_version.rs:487-490` serialize/deserialize constants, `:2611`/`:2619` `sqlite3_serialize`/`sqlite3_deserialize`; `src/lib.rs:14-22` `SQLITE_STATIC()`/`SQLITE_TRANSIENT()` are functions.
- `sqlite-wasm-rs` 0.5.5 (crates.io, released 2026-05-25; repo `github.com/Spxg/sqlite-wasm-rs`, verified via the crates.io API, docs.rs and `gh api` on the repository at tag `0.5.5`): `Cargo.toml` — `links = "wsqlite3"`, deps `rsqlite-vfs = "0.1.0"`, `wasm-bindgen >= 0.2.104` (default-features off), `js-sys >= 0.3.81`; build-deps `cc = "1"` and optional `bindgen = "0.72"`; `[features]` lists only `sqlite3mc` (encryption; `bindgen` exists only as the optional build-dependency's implicit feature); `rust-version.workspace = true` = **1.81.0** (README "Minimum supported Rust version" agrees); docs target `wasm32-unknown-unknown` only. `build.rs` compiles `sqlite3/sqlite3.c` at build time with `cc` against a vendored musl subset (`shim/musl`, 36 C files: string/stdlib/math/errno/stdio/internal — `strlen`, `memchr`, `strcmp`, `qsort` and friends, but **not** `memcpy`/`memset`/`memmove`, which come from `compiler-builtins`) plus `shim/printf/printf.c` and `-include shim/wasm-shim.h`, so no wasi-sysroot is required (any clang that targets wasm32, i.e. the wasi-sdk clang b5 sets as `CC_wasm32_unknown_unknown`); flags `FULL_FEATURED`: `-DSQLITE_OS_OTHER -DSQLITE_USE_URI -DSQLITE_THREADSAFE=0 -DSQLITE_TEMP_STORE=2 -DSQLITE_DEFAULT_CACHE_SIZE=-16384 -DSQLITE_DEFAULT_PAGE_SIZE=8192 -DSQLITE_OMIT_DEPRECATED -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_ENABLE_UNLOCK_NOTIFY -DSQLITE_ENABLE_API_ARMOR -DSQLITE_ENABLE_BYTECODE_VTAB -DSQLITE_ENABLE_DBPAGE_VTAB -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_ENABLE_OFFSET_SQL_FUNC -DSQLITE_ENABLE_PREUPDATE_HOOK -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_STMTVTAB -DSQLITE_ENABLE_UNKNOWN_SQL_FUNCTION -DSQLITE_ENABLE_COLUMN_METADATA`. `src/lib.rs`: `#![no_std]`, `#![cfg_attr(target_feature = "atomics", feature(stdarch_wasm_atomic_wait))]`, `pub use bindings::*` at the crate root, the memory VFS (`rsqlite_vfs::memvfs`) registered as the default VFS from `sqlite3_os_init`. `src/shim.rs:12-56` `WasmOsCallback`: `sleep` is `memory_atomic_wait32` under `target_feature = "atomics"` (a no-op otherwise) — **it traps if reached on the browser main thread**, and SQLite only reaches `xSleep` through the busy handler, hence 3.4 drops `busy_timeout` on wasm; `random` calls `crypto.getRandomValues` per call (no `JsValue` is stored across calls, so any thread may call in); `epoch_timestamp_in_ms` is `js_sys::Date`. docs.rs "all items" confirms `sqlite3_open_v2`, `sqlite3_prepare_v2`, `sqlite3_step`, `sqlite3_finalize`, `sqlite3_exec`, `sqlite3_serialize`, `sqlite3_deserialize`, `sqlite3_backup_init`, `sqlite3_error_offset`, `sqlite3_stmt_readonly`, `sqlite3_extended_result_codes`, `sqlite3_vfs_register`, `sqlite3_malloc64` are present and that `SQLITE_TRANSIENT`/`SQLITE_STATIC` are functions (same shape as libsqlite3-sys); blocklisted: `sqlite3_close_v2`, `sqlite3_prepare` (non-v2), `sqlite3_create_function/collation/module`, all UTF-16 entry points, `sqlite3_profile/trace` — none used by sqlez. README `:68-73`: "This library is not thread-safe" (`JsValue` is not cross-thread; `THREADSAFE=0`), VFS comparison marks "Multiple connections" unsupported for every VFS, and a prebuilt `libsqlite3.a` can be substituted through the `links` override.
- Cargo rule verified in a scratch workspace (`cargo metadata` on a two-target manifest): a dependency named `libsqlite3-sys` that comes from crates.io in one target table and from a `path` in another — with or without `package = ".."` renaming — is rejected with "Dependency 'libsqlite3-sys' has different source paths depending on the build target. Each dependency must have a single canonical source path irrespective of build target." A per-target `package = "<other crates.io crate>"` rename parses and resolves. So the primary plan in 3.3 is valid and the fallback in section 7 item 1 must not use a path package under the same name.
- Fork evidence (`zed-web/crates/sqlez`): replaced `connection`/`statement`/`migrations` with `*_wasm.rs` files that forward SQL over synchronous XHR to a server-side SQLite (`remote_sql.rs`, 820 lines), used `wasm_thread` for a worker write queue, and defaulted `initialize_queues` to `locking_queue` on wasm; `db.rs` gained `prepare_web_database`/`open_in_memory_db`. We keep SQLite in the tab (BUILD-SPEC 5.4) and take only the "different default write queue on wasm" idea (with a spin lock, not `locking_queue`'s parking_lot mutex).

prompt_store

- `crates/prompt_store/Cargo.toml:26` `heed.workspace = true`; `:38-41` dev-deps (`fs` test-support, `gpui` test-support, `tempfile`).
- `crates/prompt_store/src/prompt_store.rs:11-14` `use heed::{Database, RoTxn, types::{SerdeBincode, SerdeJson, Str}};`, `:22` `use util::ResultExt;` (only used by `upgrade_dbs(..).log_err()` at `:233`), `:27-39` `init(cx)` (`paths::prompts_dir().join("prompts-library-db.0.mdb")`, `PromptStore::new(db_path, cx)`, `GlobalPromptStore`), `:157-161` `PromptStore { env: heed::Env, metadata_cache: RwLock<MetadataCache>, bodies: Database<SerdeJson<PromptId>, Str> }`, `:163-167` `MetadataCache`, `:169-200` `MetadataCache::from_db(db, txn)` (`:189-197` inserts built-ins not present in the db, then `sort`), `:202-208` `sort`, `:211-215` `global`, `:217-245` `new` (`std::fs::create_dir_all` at `:219`, `heed::EnvOpenOptions` at `:221-226`, `create_database`, `upgrade_dbs`, `from_db`), `:247-304` `upgrade_dbs` (v1 → v2 migration, heed-only), `:306-324` `load(id, cx)` (body from db or `built_in.default_content()`, `LineEnding::normalize`), `:326-328` `all_prompt_metadata`, `:331-348` V1 types (heed-only), `:350-353` `GlobalPromptStore`, `:355-395` the one test (`tempfile` + `PromptStore::new`).
- `crates/prompt_store/src/prompts.rs` and `rules_to_skills_migration.rs` use only the `Fs` trait (`fs.watch` at `prompts.rs:277,312-313`, `read_dir`/`load` at `:297-300`; `db::kvp::GlobalKeyValueStore` at `rules_to_skills_migration.rs:46`) and `std::env::consts` — nothing to gate here, but the KVP global must exist on wasm (3.4).
- Fork evidence: moved `heed` under `not(wasm)`, added a wasm `PromptStore { metadata_cache, bodies: RwLock<HashMap<PromptId, String>> }`, `MetadataCache::with_builtins`, and cfg-split `new`/`load`. We do the same with an internal `Backend` enum so the memory backend is also compiled under `cfg(test)` on the host.

## 3. Change list

Dependency order: the vendored alacritty copy and the workspace patch table first (everything in `terminal` needs it), then `fs`, `sqlez` → `db`, `prompt_store`, `clock`, `terminal`, `acp_thread`, `client`. Each crate is independently checkable with `cargo check -p <crate> --target wasm32-unknown-unknown` once its prerequisites land: `sqlez` today (with 3.3's `getrandom` line); `db`, `prompt_store`, `client`'s `telemetry` after b7's `home_dir`; `fs`, `terminal`, `acp_thread`, `client` after the `util` gates, b5's `zs_smol_shim` and the `rpc` brief.

### 3.1 `vendor/alacritty_terminal/` (new, vendored copy), `vendor/alacritty_terminal.patch` (new), `vendor/README.md` (new or extend) and workspace `Cargo.toml` (modify)

Per D10, until a GitHub fork exists the gate ships as a vendored copy of `alacritty_terminal` under `zed/vendor/alacritty_terminal`, referenced from the workspace through a path `[patch]` entry, so `Cargo.toml:523` stays byte-identical; `vendor/README.md` records the upstream revision and the intended git-patch form. No fork owner is named anywhere in this brief.

- Vendored copy: from the cargo git checkout of `4c129667ce56611becdc82de6e28218c80e2e88f` (`~/.cargo/git/checkouts/alacritty-20195d12a03fa0c5/4c12966/alacritty_terminal/`; verified contents: `Cargo.toml`, `CHANGELOG.md`, `LICENSE-APACHE -> ../LICENSE-APACHE`, `src/`, `tests/{ref,ref.rs}`), copy `Cargo.toml`, `CHANGELOG.md`, `src/**`, `tests/**` and the *target* of the `LICENSE-APACHE` symlink (the checkout root's `LICENSE-APACHE`; the vendored tree holds a regular file) into `vendor/alacritty_terminal/`. Nothing else from the checkout (`alacritty`, `alacritty_config*`, `extra/`, the root workspace manifest) is copied.
- The gate, applied on that copy and kept as `vendor/alacritty_terminal.patch` (a `git diff` against the pristine copy, so the rebase job can `patch -p1` it onto a fresh vendoring):
  - `src/lib.rs:8,14,15`: prefix `pub mod event_loop;`, `pub mod thread;`, `pub mod tty;` with `#[cfg(not(target_family = "wasm"))]`.
  - `Cargo.toml`: move `home = "0.5.5"`, `libc = { version = "0.2", features = ["extra_traits"] }` and `polling = "3.8.0"` from `[dependencies]` into a new `[target.'cfg(not(target_family = "wasm"))'.dependencies]` table. The `cfg(unix)` and `cfg(windows)` tables are untouched (neither matches wasm). `parking_lot` stays (`sync.rs`; see section 7 item 3 for why no spin variant is needed).
  - `Cargo.toml` standalone-manifest lines, because the copy sits outside alacritty's workspace and (via `exclude`, below) outside ours, so it inherits nothing: `edition.workspace = true` → `edition = "2024"` and `rust-version.workspace = true` → `rust-version = "1.85.0"` (the values at the checkout's root `Cargo.toml:10-11`); drop `readme = "../README.md"` (dangling in the copy; only `cargo package` reads it).
  - No other source line changes and no rustfmt run, so the patch is exactly those hunks; the six source/dependency lines are also the upstream PR.
- Workspace `Cargo.toml`: keep line 523 as is; add `exclude = ["vendor/alacritty_terminal"]` after `resolver = "2"` (line 2) — or extend the `exclude` list if b1's `vendor/yawc` or b5's `vendor/lsp-types`/`vendor/agent-client-protocol` (D10) landed first; and add, immediately before the `[patch.crates-io]` table at line 976:

```toml
[patch."https://github.com/zed-industries/alacritty"]
# Vendored copy of alacritty_terminal at 4c129667 plus vendor/alacritty_terminal.patch:
# gates alacritty's PTY/event-loop/thread modules and the `polling` dependency on
# wasm32; the grid, Term and vte layers are pure Rust and are what the browser
# terminal uses. vendor/README.md records the upstream rev and the git-patch form
# this entry becomes once a fork exists. See docs/briefs/b6-leaf-gates.md 3.1.
alacritty_terminal = { path = "vendor/alacritty_terminal" }
```

  A `[patch."<git url>"]` table is the documented way to replace a git-sourced dependency, and a git dependency carries no version requirement, so the vendored `0.26.1-dev` satisfies `:523`. Why `exclude`: a path package referenced only from `[patch]` is not an implicit member (section 2, b5 §2's `corgi-patches/scratch` measurement), so `cargo test --workspace`, `script/clippy --workspace` and xtask's package-conformity checks already skip it; the `exclude` entry pins that down against a later direct `path =` dependency (which *would* make it a member and run alacritty's tests and clippy under our config) and states the intent. Consequently the crate is not `-p`-targetable from our workspace (`cargo check -p alacritty_terminal` panics in the feature resolver, b5 §2); `cargo check -p terminal --target wasm32-unknown-unknown` is the check that covers it (section 6), and alacritty's own tests run in an upstream checkout, not here. `Cargo.lock`: the `alacritty_terminal` entry loses its `source = "git+…"` line and nothing else changes (`home`, `libc`, `polling` stay locked for native); run `cargo shear` and the `check_cargo_lock` job locally once (b5 item 5 lists both).
- `vendor/README.md` (shared with b1's `yawc` and b5's `lsp-types`/`agent-client-protocol` per D10; whichever brief lands first creates the file with a one-paragraph header, and each brief adds its own entry): the `alacritty_terminal` entry records upstream `https://github.com/zed-industries/alacritty` rev `4c129667ce56611becdc82de6e28218c80e2e88f`, the patch file, the reason (wasm32 gate of `event_loop`/`thread`/`tty` and of the `home`/`libc`/`polling` dependencies), the intended git-patch form — once a fork of `zed-industries/alacritty` exists, replace the path entry under the same `[patch."https://github.com/zed-industries/alacritty"]` table with a `git` + `rev` entry pointing at the commit that carries `vendor/alacritty_terminal.patch` (the shape upstream already uses for `[patch.crates-io]`, `:977-988`), then delete `vendor/alacritty_terminal{,.patch}` — and the end state: bump `alacritty_terminal.rev` at `:523` once the six-line PR merges upstream and drop the table.
- Rebase job (BUILD-SPEC 11.3): when upstream Zed bumps `rev` at `:523`, re-vendor `alacritty_terminal` from the new rev, `patch -p1 < vendor/alacritty_terminal.patch` (conflicts surface here, not at link time), and update the README entry's rev; `script/check-wasm -p terminal` is the acceptance check.

### 3.2 `crates/fs/Cargo.toml` (modify) and `crates/fs/src/fs.rs` (modify), `crates/fs/src/wasm_fs.rs` (new)

Cargo (section 5 has the exact tables): move `async-tar`, `libc`, `smol`, `tempfile`, `is_executable`, `notify`, `trash` into `[target.'cfg(not(target_family = "wasm"))'.dependencies]`; add `web-time.workspace = true` to `[dependencies]`. `git`, `path`, `slotmap`, `async-channel`, `parking_lot`, `futures`, `rope`, `text`, `proto`, `collections` stay.

`fs.rs` edits, by upstream line:

- `:1` → `#[cfg(not(target_family = "wasm"))] pub mod fs_watcher;`; `:3` → `#[cfg(not(target_family = "wasm"))] pub use fs_watcher::requires_poll_watcher;` and add
  ```rust
  /// The browser has no native watcher; worktree scanning never defers to polling.
  #[cfg(target_family = "wasm")]
  pub fn requires_poll_watcher(_path: &Path) -> bool { false }
  ```
  (`worktree.rs:1359` keeps compiling; the other `fs_watcher::global` callers, `zed.rs:668,699` and the worktree integration test, are native-only.)
- After `:3` add `#[cfg(any(target_family = "wasm", feature = "test-support"))] pub mod wasm_fs;` and `#[cfg(any(target_family = "wasm", feature = "test-support"))] pub use wasm_fs::WasmFs;`. The `test-support` arm exists because `[lib] test = false` (`Cargo.toml:13`) means the only test target is `tests/integration`, which enables `test-support`; the existing native test job therefore compiles and runs `WasmFs` on every PR.
- Imports that become unused on wasm (fatal under `script/clippy`'s `-D warnings`): `:8` split into `use std::sync::atomic::{AtomicUsize, Ordering};` plus `#[cfg(not(target_family = "wasm"))] use std::sync::atomic::AtomicU8;`; `:10` `use util::maybe;`, `:13` `use futures::stream::iter;`, `:21` `use util::command::new_command;`, `:34` `use async_tar::Archive;`, `:37` `use is_executable::IsExecutable;`, `:40` `use smol::io::AsyncWriteExt;`, `:50` `use tempfile::TempDir;` → each prefixed `#[cfg(not(target_family = "wasm"))]`; `:44` `io::{self, Write}` → `io::{self}` plus `#[cfg(not(target_family = "wasm"))] use std::io::Write;`; `:36` → `use git::repository::GitRepository;` plus `#[cfg(not(target_family = "wasm"))] use git::repository::RealGitRepository;`. `:35` (futures) stays.
- `:9` `use std::time::Instant;` → `use web_time::Instant;` (identical type on native; `JobInfo.start` keeps its public type natively; on wasm its type is `web_time::Instant`, which `activity_indicator.rs:23,477,489` must match — b7 §3.10, section 7 item 5).
- `:107-111` `extract_tar_file` → prefix `#[cfg(not(target_family = "wasm"))]` (its `Archive` parameter type does not exist on wasm; no browser-set crate calls it: users are `extension_cli`, `extension_host`, `dev_container`).
- `:189-224` (`TrashedEntry`, `From<trash::TrashItem>`, `into_trash_item`) and `:241-251` (`From<trash::Error> for TrashRestoreError`) → `#[cfg(not(target_family = "wasm"))]`. `TrashRestoreError` itself (`:226-239`) stays.
- `:417-424` `pub struct RealFs`, `:430-520` `impl FileHandle for std::fs::File`, `:522` `pub struct RealWatcher {}`, `:524-576` `impl RealFs`, `:646-686` both `read_dir_entries`, `:688` `impl Fs for RealFs`, `:1386-1395` `impl Watcher for RealWatcher` → `#[cfg(not(target_family = "wasm"))]`. Nothing inside `impl Fs for RealFs` changes.
- No change to the `FakeFs` block (`:1397-3437`): `test-support` is never enabled for the browser build, and the wasm CI check must not enable it for `fs`.

`wasm_fs.rs` (new, about 500 lines with tests excluded; `#![cfg]` is on the `mod` line): the full design is in section 4.1. Signatures:

```rust
pub struct WasmFs { /* private */ }

impl WasmFs {
    /// The executor is only used for the watch-debounce timer.
    pub fn new(executor: BackgroundExecutor) -> Arc<Self>;
    /// Boot helper: `write` without the async wrapper, for seeding settings/keymap
    /// before the app loop runs (b7 §3.24 `settings::seed_config_files`). Creates
    /// parent directories. Emits a change event. Panics on a non-absolute path (boot bug).
    pub fn insert_file(&self, path: &Path, contents: Vec<u8>);
    /// Boot helper: `create_dir` without the async wrapper, for the empty snippets,
    /// prompts and tasks directories b7 §3.24 seeds so their watchers start cleanly.
    /// `mkdir -p` semantics; emits `Created` for each new directory; an existing
    /// directory is a no-op; a file in the way or a non-absolute path panics (boot bug).
    pub fn insert_dir(&self, path: &Path);
    /// All file paths, sorted (tests and the control-plane save hook).
    pub fn files(&self) -> Vec<PathBuf>;
    /// Files written, renamed into place or removed since the previous call
    /// (`contents == None` means removed), in path order; clears the dirty set.
    /// Synchronous so the `visibilitychange` → hidden / `STOPPING` flush (D7 triggers;
    /// b7 §3.27 `flush_client_state`) can drain it without awaiting.
    pub fn take_dirty(&self) -> Vec<DirtyFile>;
}

pub struct DirtyFile { pub path: PathBuf, pub contents: Option<Vec<u8>> }

#[async_trait::async_trait]
impl Fs for WasmFs { /* every trait item; see 4.1 */ }

pub struct WasmWatcher { /* private */ }
impl Watcher for WasmWatcher {
    fn add(&self, path: &Path) -> Result<()>;
    fn remove(&self, path: &Path) -> Result<()>;
}
```

`insert_file`, `insert_dir` and `take_dirty` are the only API beyond the trait that `zed_web` needs: b7 §3.24 `settings::seed_config_files(&Arc<WasmFs>, settings_json, keymap_json)` (synchronous) calls `insert_file` for `paths::settings_file()`/`paths::keymap_file()` and `insert_dir` for the empty snippets/prompts/tasks directories before `watch_config_file` runs (BUILD-SPEC 3.4 step 3); b7 §3.24 `install_save_back` is BUILD-SPEC 3.7's debounced save hook over `fs.watch(paths::config_dir(), 500 ms)`; and `take_dirty` lets the `visibilitychange` → hidden / `STOPPING` flush (D7 triggers) pick up a write made inside that hook's 750 ms debounce window (`pagehide` is best-effort only, b4 §3.8; see section 7 item 8 for what b7 wires today).

### 3.3 `crates/sqlez/Cargo.toml` (modify), `crates/sqlez/src/lib.rs` (modify), `crates/sqlez/src/wasm_lock.rs` (new), `crates/sqlez/src/connection.rs` (modify), `crates/sqlez/src/statement.rs` (modify), `crates/sqlez/src/thread_safe_connection.rs` (modify), `crates/sqlez/src/migrations.rs` (modify)

Decision: use `sqlite-wasm-rs` 0.5.5 as a drop-in for `libsqlite3-sys` on wasm (rationale in section 7), with the following invariants enforced in sqlez: SQLite is `THREADSAFE=0` and `OMIT_SHARED_CACHE`, therefore (a) every FFI call happens under **one** process-wide reentrant spin lock (`wasm_lock`), which is also the write queue's lock, so there is a single lock and no lock-order question; (b) there is exactly one `Connection` per `ThreadSafeConnection` (no per-thread connections, no `cache=shared` URIs); (c) no `parking_lot` primitive is taken on a contended path (the only remaining one, `QUEUES` at `:28`, is written once per database during `build()` and thereafter only read-locked, which never parks).

Cargo (exact tables in section 5): `libsqlite3-sys` and `thread_local` move to the `not(wasm)` table; the wasm table declares `libsqlite3-sys = { package = "sqlite-wasm-rs", version = "0.5.5" }` so `use libsqlite3_sys::*;` at `connection.rs:10`, `statement.rs:6` and `use libsqlite3_sys::sqlite3_exec;` at `migrations.rs:11` compile unchanged, plus gpui's two `getrandom`/`uuid` lines (`crates/gpui/Cargo.toml:112-114`) so `-p sqlez` checks alone. Add `[features] test-support = []` so `db`'s tests can reach the wasm queue constructor (3.4, section 6).

`lib.rs`: `:9` becomes `#[cfg(not(target_family = "wasm"))] mod util;` (`util.rs` is `ThreadLocal`-based and only serves `background_thread_queue`), and add `#[cfg(any(target_family = "wasm", test, feature = "test-support"))] pub mod wasm_lock;` after it (public so `thread_safe_connection::wasm_lock_queue` and `db`'s test can use it; the `Guard` type stays crate-private).

`wasm_lock.rs` (new; full definition in 4.3): a reentrant spin lock with no `Atomics.wait` (parking_lot would trap on the browser main thread when contended).

```rust
pub(crate) struct Guard(());
pub(crate) fn lock() -> Guard;
pub fn is_held_by_current_thread() -> bool;
```

`connection.rs`:

- `:15` `write: RefCell<bool>` → `write: std::sync::atomic::AtomicBool` on all targets (the field is `pub(crate)`; `RefCell` is `!Sync`, and the wasm single connection is shared across threads). `:78-80` `can_write` → `self.write.load(Ordering::Acquire)`; `:223-228` `with_write` → `store(true)` / `store(false)` with, first, `#[cfg(target_family = "wasm")] debug_assert!(crate::wasm_lock::is_held_by_current_thread(), "with_write outside wasm_lock")`; `thread_safe_connection.rs:240` → `connection.write.store(false, Ordering::Release)`. Cross-thread meaning of the flag on wasm, stated as the invariant the guard in `Statement::prepare` relies on: the flag is only ever `true` while the write queue's closure runs, the queue holds `wasm_lock` for the whole closure, and `prepare` takes `wasm_lock` before reading `can_write()` — so no other thread can observe `true` or race the `store(false)`; the same thread re-entering (`with_savepoint`, nested `exec`) is the writer.
- After `:18` add `#[cfg(target_family = "wasm")] unsafe impl Sync for Connection {}` with a comment stating the invariant (all FFI under `wasm_lock`).
- `:21-44` `open_with_flags`: first statement `#[cfg(target_family = "wasm")] let _guard = crate::wasm_lock::lock();`. Same first line in `backup_main` (`:82`), `sql_has_syntax_error` (`:101`), `last_error` (`:201`), `Drop::drop` (`:270`), and in b4's `serialize_main`/`restore_main_from`.
- `:60-72` `open_memory`: keep the native body; on wasm the URI form is not used:
  ```rust
  #[cfg(target_family = "wasm")]
  pub fn open_memory(_uri: Option<&str>) -> Self {
      // SQLite is built with SQLITE_OMIT_SHARED_CACHE in the browser and there is
      // one connection per ThreadSafeConnection, so a private `:memory:` database
      // is equivalent to the shared-cache named database used natively.
      Self::open(":memory:", false).expect("Could not create in memory db")
  }
  ```
  (`open_file` at `:56-58` is unchanged: with the memory VFS `sqlite3_open_v2(path)` succeeds and yields a RAM "file"; persistence is b4's serialize path either way. b4's `restore_main_from` opens a scratch `:memory:` connection next to the main one; that is two private databases, which `OMIT_SHARED_CACHE` allows — a b4 dependency on this `open_memory` body, stated in section 7 item 12.)

`statement.rs`:

- `:11-21` add `#[cfg(target_family = "wasm")] _lock: crate::wasm_lock::Guard,` as the last field of `Statement<'a>` (private; the struct is constructed only in `prepare`).
- `:40-46` `prepare`: acquire `#[cfg(target_family = "wasm")] let _lock = crate::wasm_lock::lock();` as the first statement (before the `can_write()` guard) and move it into the struct. Because `Statement` is used synchronously (no `.await` while a statement is alive anywhere in sqlez, `db`, `workspace/persistence.rs` or `agent/db.rs`), holding the guard for the statement's lifetime serializes `bind`/`step`/`column`/`finalize` without touching each method. Nested prepares and `write()` calls from the same thread while a statement is alive (e.g. `with_savepoint`, `sql_has_syntax_error`'s scratch connection) are covered by reentrancy — the write queue uses the same lock (below), so there is no second lock to order against.

`migrations.rs`: in `Connection::eager_exec` (`:16-31`, the function containing the `sqlite3_exec` call at `:19`), add `#[cfg(target_family = "wasm")] let _guard = crate::wasm_lock::lock();` as its first statement. (`migrate` at `:92` is its only caller and runs inside `build()`'s `write`, so the guard is reentrant there.)

`thread_safe_connection.rs`:

- `:9` `thread,` and `:12` `use thread_local::ThreadLocal;` → `#[cfg(not(target_family = "wasm"))]`; `:14` `util::UnboundedSyncSender` → `#[cfg(not(target_family = "wasm"))]`.
- `:34-39` field `connections`:
  ```rust
  #[cfg(not(target_family = "wasm"))]
  connections: Arc<ThreadLocal<Connection>>,
  /// One connection shared by every thread; every FFI call is serialized by `wasm_lock`.
  #[cfg(target_family = "wasm")]
  connections: Arc<std::sync::OnceLock<Connection>>,
  ```
  (`Default::default()` initializers at `:151` and `:264` still compile.)
- `:130-141` `initialize_queues`: `write_queue_constructor.unwrap_or_else(background_thread_queue)` → `unwrap_or_else(default_write_queue)`, with
  ```rust
  /// The queue used when the builder passes none: an OS thread natively, the
  /// process-wide reentrant spin lock in the browser (std threads cannot be
  /// spawned on wasm32-unknown-unknown, and `locking_queue`'s parking_lot mutex
  /// would park the main thread when a worker holds it).
  fn default_write_queue() -> WriteQueueConstructor {
      #[cfg(not(target_family = "wasm"))] { background_thread_queue() }
      #[cfg(target_family = "wasm")] { wasm_lock_queue() }
  }
  /// Runs each queued write inline on the caller's thread under `wasm_lock`.
  #[cfg(any(target_family = "wasm", test, feature = "test-support"))]
  pub fn wasm_lock_queue() -> WriteQueueConstructor {
      Box::new(|| Box::new(|queued_write| { let _guard = crate::wasm_lock::lock(); queued_write(); }))
  }
  ```
  With this queue the migration in `build()` at `:85-123` runs inline and `build()` resolves without parking, which is what `db::open_fallback_db` needs. A main-thread `write` (e.g. `onboarding_banner.rs:94-98`) that collides with a worker's `write_and_log` spins for one statement's duration instead of parking. `locking_queue` (`:306-314`) stays for native tests and `sqlez_macros`.
- `:192-243` `create_connection`: keep the retry loop under `#[cfg(not(target_family = "wasm"))]`; the wasm arm executes `connection.exec(initialize_query).and_then(|mut s| s())` once and panics with the same message on error (a schema lock cannot occur with one connection; `thread::sleep` is unavailable).
- `:272-280` `Deref`: `#[cfg(target_family = "wasm")]` body `self.connections.get_or_init(|| Self::create_connection(..))`.
- `:282-304` `background_thread_queue` → `#[cfg(not(target_family = "wasm"))]`.
- b4's `write_generation` counter and `serialize`/`restore_from`/`with_restore_image` are unchanged by this brief; they work on wasm because `write` runs the closure inline under `wasm_lock_queue`, and `restore_main_from` (b4 3.4: scratch `:memory:` connection + `backup_main`) only ever uses two sequentially-locked connections. Consequence for b4 3.7, now binding per D7: `ClientStateStore`'s ticker and `flush_now` await `db.serialize()`/`restore_from()` from `background_spawn` (the closure runs on the awaiting thread on wasm; a 15 s serialize of a few MB on the main thread would jank a frame). Stated in section 7 item 12.

### 3.4 `crates/db/src/db.rs` (modify) and `crates/db/src/kvp.rs` (modify)

`db.rs`:

- `:21` `use std::fs::create_dir_all;` → `#[cfg(not(target_family = "wasm"))]`.
- `:63-67` `AppDatabase::new` and b4's `new_with_image` → `#[cfg(not(target_family = "wasm"))]` (they call `gpui::block_on`, the native-only `pollster` re-export at `gpui.rs:167-168`). b4's `pub async fn open_with_image(image: Option<Vec<u8>>) -> (Self, RestoreOutcome)` (b4 3.6; the tuple is what b7 §3.27 destructures and hands to `ClientStateStore::new`) is the browser constructor.
- Add `pub fn registered_migration_count() -> usize { inventory::iter::<DomainMigration>().count() }` for b7's boot assertion (b7 §7 item 3: if `__wasm_call_ctors` did not run, the count is 0 and `open_with_image` would silently create an empty schema; `zed_web::boot` must fail with `ctors_missing` before calling it; b7 §3.27 step 2 currently inlines `inventory::iter::<db::DomainMigration>().next().is_some()`, which reads the same registry, so either form satisfies the assertion).
- `:125-134` `DB_INITIALIZE_QUERY`: keep the native constant; add
  ```rust
  /// No busy handler in the browser: SQLite's busy wait goes through the VFS
  /// `xSleep`, which is `memory.atomic.wait32` in sqlite-wasm-rs and traps on
  /// the main thread. With a single connection SQLITE_BUSY cannot occur anyway.
  #[cfg(target_family = "wasm")]
  const DB_INITIALIZE_QUERY: &str = sql!(
      PRAGMA journal_mode=MEMORY;
      PRAGMA case_sensitive_like=TRUE;
      PRAGMA synchronous=OFF;
  );
  ```
  (`sqlez_macros::sql!` validates on the host; both texts are valid SQLite.)
- b4's `open_db_with_image<M>(db_dir, scope, image)` (generalization of `:174-203`): wrap the `create_dir_all` block (`:185-189`) in `#[cfg(not(target_family = "wasm"))]`, and on wasm return `open_fallback_db::<M>(image).await` (the `(ThreadSafeConnection, RestoreOutcome)` tuple) directly (the memory VFS would accept a fake path, but there is nothing to gain and `ALL_FILE_DB_FAILED` at `:199` must not be set on a normal browser boot). `open_fallback_db` (`:215-225`) keeps `FALLBACK_DB_NAME`; its builder does not pass a queue constructor, so it gets `wasm_lock_queue` on wasm via 3.3. For the host test in section 6 add `pub(crate) async fn open_fallback_db_with_queue<M>(image: Option<Vec<u8>>, queue: Option<WriteQueueConstructor>) -> (ThreadSafeConnection, RestoreOutcome)` (b4's `build_with_outcome()` shape) that `open_fallback_db` delegates to with `None`.
- Tests at `:295-417` use `tempfile` and `thread::spawn`; they stay native-only as they are.

`kvp.rs` (D7: the global store is folded into the `AppDatabase` image):

- `:244-250` `GLOBAL_KEY_VALUE_STORE` `LazyLock` — it calls `gpui::block_on(open_db::<GlobalKeyValueStore>(..))` (a second native-only `block_on`) and opens a second database, `0-global/db.sqlite`, which would not be in b4's image — → `#[cfg(not(target_family = "wasm"))]`; add
  ```rust
  #[cfg(target_family = "wasm")]
  static GLOBAL_KEY_VALUE_STORE: std::sync::OnceLock<GlobalKeyValueStore> = std::sync::OnceLock::new();

  impl GlobalKeyValueStore {
      /// The global store over the application database's own connection, so the
      /// one image (b4 3.5-3.7) carries it (D7). `kv_store` already exists there:
      /// `KeyValueStore`'s inventory-registered migration (`kvp.rs:23-29`,
      /// `static_connection!` at `:41` → `inventory::submit!` at `db.rs:276-277`)
      /// creates it with the same DDL as `GlobalKeyValueStore::MIGRATIONS` (`:228-233`),
      /// which therefore never runs on this connection. Same shape as
      /// `KeyValueStore::from_app_db` (`:15-17`).
      #[cfg(any(target_family = "wasm", test))]
      pub fn from_app_db(db: &crate::AppDatabase) -> Self {
          Self(db.0.clone())
      }
      /// Browser boot: called by `zed_web` right after `AppDatabase::open_with_image`
      /// and before anything calls `global()`. Synchronous; opens no database.
      #[cfg(target_family = "wasm")]
      pub fn init(db: &crate::AppDatabase) {
          GLOBAL_KEY_VALUE_STORE.set(Self::from_app_db(db)).ok();
      }
      #[cfg(target_family = "wasm")]
      pub fn global() -> &'static Self {
          GLOBAL_KEY_VALUE_STORE.get().expect("GlobalKeyValueStore::init must run before global()")
      }
  }
  ```
  `:252-255` native `global()` → `#[cfg(not(target_family = "wasm"))]`. `read_kvp`/`write_kvp` (`:257-`) are unchanged and, through `db.0.clone()`, use the app database's write queue and b4's `write_generation`, so a global write marks the `ClientStateStore` dirty like any other write. Invariant this introduces on wasm: the global and app stores share the `kv_store` table (natively they are two databases), so a `GlobalKeyValueStore` key must never equal a `KeyValueStore` key — verified for today's keys in section 7 item 12(c). Consumers are unchanged: `prompt_store/rules_to_skills_migration.rs:108,124,486,500` (the done-flag now survives resumes, so the migration runs once per workspace rather than once per boot) and, desktop-only, `zed/main.rs:1383`.

Boot call points (for b7 §3.27; nothing in `db` sends proto): assert `db::registered_migration_count() > 0`; `let (image, version) = workspace::client_state::load_client_state(&proto_client).await?;` (b4 3.8) → `let (db, outcome) = db::AppDatabase::open_with_image(image).await; db::kvp::GlobalKeyValueStore::init(&db); cx.set_global(db);` before `settings::init`/`workspace::init`, then `ClientStateStore::new(&db, sink, version, outcome, cx)` (b4 3.7) whose ticker calls `db.serialize()` every 15 s when dirty from `background_spawn` (D7); `flush_now` on `visibilitychange` → hidden (b7's `set_hidden`/`flush_client_state` exports, b7 §3.27/§3.30, called by b9's shell page) and on `LifecycleNotice STOPPING` after b7 has written the dirty buffers into `unsaved_buffers` (D6); a `pagehide` flush is best-effort only (b4 §3.8, b7 §7 item 20).

### 3.5 `crates/prompt_store/Cargo.toml` (modify) and `crates/prompt_store/src/prompt_store.rs` (modify)

Cargo: move `heed.workspace = true` (`:26`) into `[target.'cfg(not(target_family = "wasm"))'.dependencies]`.

`prompt_store.rs`:

- `:11-14` heed import and `:22` `use util::ResultExt;` → `#[cfg(not(target_family = "wasm"))]`.
- `:157-161` replace the struct with
  ```rust
  pub struct PromptStore {
      backend: Backend,
      metadata_cache: RwLock<MetadataCache>,
  }

  enum Backend {
      #[cfg(not(target_family = "wasm"))]
      Lmdb { env: heed::Env, bodies: Database<SerdeJson<PromptId>, Str> },
      /// Built-in prompts only; user prompts are not persisted in the browser.
      #[cfg(any(target_family = "wasm", test))]
      Memory { bodies: Arc<RwLock<HashMap<PromptId, String>>> },
  }
  ```
  (`cfg(test)` is enough here: the crate has lib unit tests, so the normal native test job compiles the arm. `fs` needs `test-support` instead because its lib has no test target; `sqlez` uses `any(wasm, test, feature = "test-support")` because `db`'s tests need its wasm queue. That is the whole cfg-alias story; no shared macro is worth adding for three crates.)
- `:169-200` `MetadataCache::from_db` → `#[cfg(not(target_family = "wasm"))]`, unchanged otherwise; add `fn builtins_only() -> Self` (a fresh cache, the built-in loop at `:189-197`, then `sort`) under `#[cfg(any(target_family = "wasm", test))]`.
- `:217-245` `new`: keep the body under `#[cfg(not(target_family = "wasm"))]` and construct `Backend::Lmdb { env: db_env, bodies }`; add
  ```rust
  #[cfg(target_family = "wasm")]
  pub fn new(_db_path: PathBuf, _cx: &App) -> Task<Result<Self>> {
      Task::ready(Ok(Self::in_memory()))
  }
  #[cfg(any(target_family = "wasm", test))]
  pub fn in_memory() -> Self {
      Self { backend: Backend::Memory { bodies: Default::default() },
             metadata_cache: RwLock::new(MetadataCache::builtins_only()) }
  }
  ```
- `:247-304` `upgrade_dbs`, `:331-348` V1 types → `#[cfg(not(target_family = "wasm"))]`.
- `:306-324` `load`: `match &self.backend { Lmdb { env, bodies } => <existing body>, Memory { bodies } => { let body = bodies.read().get(&id).cloned(); cx.background_spawn(async move { <same fallback to default_content + normalize> }) } }`. `all_prompt_metadata` unchanged. `init` (`:27-39`) unchanged (`paths::prompts_dir()` is string arithmetic once b7's `home_dir` exists).

### 3.6 `crates/terminal/Cargo.toml` (modify), `crates/terminal/src/alacritty.rs` (modify), `crates/terminal/src/alacritty/hyperlinks.rs` (modify), `crates/terminal/src/pty_info.rs` (modify), `crates/terminal/src/terminal.rs` (modify), `crates/terminal/src/sync_handler.rs` (new)

Scope, per D17 and b3 §7.12: this section makes the crate compile on wasm with no constructible local terminal; b3 owns `crates/terminal/src/remote_pty.rs` and `TerminalType::Remote`, calls `Terminal::expire_sync_update` at the end of `process_remote_output` and advances `Processor<SyncHandler>` (D17), which is why both items below are `pub(crate)`. `TerminalType::Remote`, `remote_pty.rs`, the new `PtyEvent` variants, `task::ExitStatus`, `is_pty`/`pid`/`title` arms, `clone_builder`'s `Remote` arm and the `:5602-5610` test helper arm are b3 §3.5 and are not specified here. The two briefs touch disjoint lines of `terminal.rs` except `:53` and the `output_processor` sites, which b3 must take from this section (b3 §3.5 `process_remote_output` calls `self.output_processor.advance`; the `SyncHandler` alias below is the type it advances).

Cargo: add `web-time.workspace = true`; move `libc.workspace = true` (`:31`) into `[target.'cfg(not(target_family = "wasm"))'.dependencies]`. `sysinfo` stays (compiles via its `unknown` backend; see section 7 item 4 for the fallback).

`alacritty.rs`:

- `:11` `event_loop::{EventLoop, Msg, Notifier},` and `:24` `tty,` → remove from the shared import and add `#[cfg(not(target_family = "wasm"))] use alacritty_terminal::{event_loop::{EventLoop, Msg, Notifier}, tty};` after `:30`.
- `:49` `pub(super) type AlacrittyPty = tty::Pty;` → `#[cfg(not(target_family = "wasm"))]`.
- `:66-70` (`#[cfg(unix)]`) stays (excluded on wasm by `unix`); `:73-83` windows stays.
- `:85-109` `PtySender` and its impl → `#[cfg(not(target_family = "wasm"))]`; add the wasm stub so `TerminalType::Pty` keeps existing on every target without ever being constructible:
  ```rust
  /// Local PTYs cannot exist in the browser; this keeps `TerminalType::Pty`
  /// and the pid/kill API compiling without a code path that constructs it.
  #[cfg(target_family = "wasm")]
  #[allow(dead_code)]
  pub(super) struct PtySender { never: std::convert::Infallible }
  #[cfg(target_family = "wasm")]
  #[allow(dead_code)]
  impl PtySender {
      pub(super) fn notify(&self, _input: impl Into<Cow<'static, [u8]>>) { match self.never {} }
      pub(super) fn resize(&self, _bounds: TerminalBounds) { match self.never {} }
      pub(super) fn shutdown(&self) { match self.never {} }
  }
  ```
- `:157-160` `current_child_signal_mask` → `#[cfg(all(not(windows), not(target_family = "wasm")))]`; `:161-178` `pty_options`, `:180-186` `open_pty`, `:203-217` `spawn_event_loop` → `#[cfg(not(target_family = "wasm"))]`. `:111-118` `window_size_from_terminal_bounds` and `:188-201` `new_term` stay (b3's `new_remote` uses `new_term`).

`hyperlinks.rs`: `:15` `time::{Duration, Instant}` → `time::Duration` plus `use web_time::Instant;` (`:328,331` unchanged; identical type natively).

`pty_info.rs`: after `:48` add
```rust
#[cfg(not(any(unix, windows)))]
impl ProcessIdGetter {
    fn pid(&self) -> Option<Pid> { None }
}
```
and put `#[cfg_attr(target_family = "wasm", allow(dead_code))]` on `ProcessIdGetter::new` (`:20`) and on `impl PtyProcessInfo` (`:86`): nothing constructs `TerminalType::Pty` on wasm, so `PtyProcessInfo::new`, `kill_current_process`, `terminate_child_process` and friends are dead there. Nothing else: `sysinfo::{Pid, System, ..}` resolve on wasm, `libc::tcgetpgrp`/`killpg` sit under `cfg(unix)`, and `kill_current_process`/`terminate_child_process` already have `not(unix)` arms.

`sync_handler.rs` (new, about 60 lines): vte's `StdSyncHandler` calls `std::time::Instant::now()` when a program begins a synchronized update (`CSI ?2026h`), which panics on wasm; and nothing outside alacritty's `EventLoop` ends a synchronized update whose `CSI ?2026l` never arrives.

```rust
//! Synchronized-update timeout for the terminal's own parser (`write_output`
//! and b3's remote path). Natively the alacritty event loop owns the PTY parser's
//! timeout; this one covers `Terminal::output_processor`.
#[cfg(not(target_family = "wasm"))]
pub(crate) type SyncHandler = vte::ansi::StdSyncHandler;

#[cfg(target_family = "wasm")]
#[derive(Default)]
pub(crate) struct WebSyncHandler { timeout: Option<web_time::Instant> }
#[cfg(target_family = "wasm")]
impl WebSyncHandler { pub fn sync_timeout(&self) -> Option<web_time::Instant> { self.timeout } }
#[cfg(target_family = "wasm")]
impl vte::ansi::Timeout for WebSyncHandler {
    fn set_timeout(&mut self, duration: Duration) { self.timeout = Some(web_time::Instant::now() + duration); }
    fn clear_timeout(&mut self) { self.timeout = None; }
    fn pending_timeout(&self) -> bool { self.timeout.is_some() }
}
#[cfg(target_family = "wasm")]
pub(crate) type SyncHandler = WebSyncHandler;

/// Deadline of a pending synchronized update, on either handler.
pub(crate) fn sync_deadline(p: &vte::ansi::Processor<SyncHandler>) -> Option<web_time::Instant>;
```

`terminal.rs`:

- `:50` `time::{Duration, Instant}` → `time::Duration` plus `use web_time::Instant;` (the struct field `last_mouse_move_time: Instant` at `:1529` keeps its type natively).
- `:53` `use vte::ansi::{Attr, Handler, Processor, StdSyncHandler};` → `use vte::ansi::{Attr, Handler, Processor};` plus `mod sync_handler; use sync_handler::{SyncHandler, sync_deadline};` next to `:3`; `:199`, `:206`, `:1022`, `:1309`, `:1509`, `:3322` `Processor::<StdSyncHandler>` / `Processor<StdSyncHandler>` → `SyncHandler`.
- Add `sync_timeout_task: Option<Task<()>>` to `Terminal` (`:1501-1558`; `None` in both literals) and
  ```rust
  /// Ends a synchronized update whose ESU never arrived. Natively alacritty's
  /// event loop does this for PTY terminals; this covers `output_processor`.
  pub(crate) fn expire_sync_update(&mut self, cx: &mut Context<Self>) {
      if let Some(deadline) = sync_deadline(&self.output_processor) {
          if Instant::now() >= deadline {
              self.output_processor.stop_sync(&mut *self.term.lock());
              self.sync_timeout_task = None;
              cx.emit(Event::Wakeup);
          } else {
              let wait = deadline - Instant::now();
              self.sync_timeout_task = Some(cx.spawn(async move |this, cx| {
                  cx.background_executor().timer(wait).await;
                  this.update(cx, |this, cx| this.expire_sync_update(cx)).ok();
              }));
          }
      }
  }
  ```
  called at the end of `write_output` (`:1962-1972`, after `advance`) and — b3, one line, per D17 — at the end of `process_remote_output`; `pub(crate)` so b3 may call it from `remote_pty.rs` as well as from `terminal.rs`.
- `:63` → `#[cfg(all(not(windows), not(target_family = "wasm")))] use crate::alacritty::current_child_signal_mask;`; `:69-71` remove `open_pty, pty_options, spawn_event_loop` from the shared import and add `#[cfg(not(target_family = "wasm"))] use crate::alacritty::{open_pty, pty_options, spawn_event_loop};`.
- `:1080-1400` `TerminalBuilder::new` → `#[cfg(not(target_family = "wasm"))]`; add a wasm twin with the identical signature (so `project/src/terminals.rs:240,409` and `clone_builder` compile unchanged on wasm; b3 §3.6 returns its own explicit error before reaching this in `project`):
  ```rust
  #[cfg(target_family = "wasm")]
  #[allow(clippy::too_many_arguments)]
  pub fn new(
      working_directory: Option<PathBuf>, mode: TerminalMode, shell: Shell,
      env: HashMap<String, String>, cursor_shape: SettingsCursorShape,
      alternate_scroll: AlternateScroll, max_scroll_history_lines: Option<usize>,
      path_hyperlink_regexes: Vec<String>, path_hyperlink_timeout: Duration,
      is_remote_terminal: bool, window_id: u64, cx: &App,
      activation_script: Vec<String>, path_style: PathStyle,
  ) -> Task<Result<TerminalBuilder>> {
      Task::ready(Err(anyhow::anyhow!(
          "local terminals are unavailable in the browser; spawn through the remote project"
      )))
  }
  ```
- `:1488-1491` `PtyResources` → `#[cfg_attr(target_family = "wasm", allow(dead_code))]` (`Active` is never constructed on wasm).
- `:1505` `subprocess: Option<SubprocessHandle>` stays; `:3269-3282` `SubprocessHandle` and `:3285-3382` `spawn_task_subprocess` → `#[cfg(not(target_family = "wasm"))]`, plus a wasm stub `#[cfg(target_family = "wasm")] struct SubprocessHandle; #[cfg(target_family = "wasm")] impl SubprocessHandle { fn kill(&self) {} }` so `Drop` (`:3384-3390`) and `kill_active_task` (`:3031-3036`) stay untouched.
- `:3187-3206` `clone_builder`: unchanged here (it calls `TerminalBuilder::new`, which returns the wasm error above; b3 adds the `Remote` arm).
- Everything else in `terminal.rs` compiles as is: `libc` is not named in this file, `sysinfo` resolves, and the `cfg(unix)` `ExitStatusExt` uses are excluded on wasm.

### 3.7 `crates/acp_thread/Cargo.toml` (modify) and `crates/acp_thread/src/terminal.rs` (modify), `crates/acp_thread/src/acp_thread.rs` (modify)

Cargo: move `portable-pty.workspace = true` (`:41`) to `[target.'cfg(not(target_family = "wasm"))'.dependencies]`; add `web-time.workspace = true`.

`terminal.rs`:

- `:14` `process::ExitStatus` → remove from the std import; add `use terminal::ExitStatus;` (b3 §3.5a re-exports `task::ExitStatus` from `terminal`; natively it is `std::process::ExitStatus`, so nothing else in this file changes type on native).
- `:19` `time::Instant` → remove from the std import; add `use web_time::Instant;`.
- Add one helper next to `TerminalOutput` (`:422-428`):
  ```rust
  /// ACP exit status from the terminal's exit status. Natively this is the
  /// portable-pty mapping used today (signal name via strsignal, code forced to
  /// 1 for signalled children); on wasm the status is b3's struct.
  fn acp_exit_status(status: Option<ExitStatus>) -> acp::TerminalExitStatus {
      #[cfg(not(target_family = "wasm"))]
      {
          let status = status.map(portable_pty::ExitStatus::from);
          acp::TerminalExitStatus::new()
              .exit_code(status.as_ref().map(|s| s.exit_code()))
              .signal(status.and_then(|s| s.signal().map(ToOwned::to_owned)))
      }
      #[cfg(target_family = "wasm")]
      {
          acp::TerminalExitStatus::new()
              .exit_code(status.map(|s| s.code().unwrap_or(1) as u32))
              .signal(status.and_then(|s| s.signal()).map(|s| format!("signal {s}")))
      }
  }
  ```
- `:504-508` → `acp_exit_status(exit_status)`; `:542-548` → `acp_exit_status(output.exit_status)`. `TerminalOutput.exit_status: Option<ExitStatus>` (`:424`) keeps its name and, natively, its type.
- `sandbox`/`http_proxy` call sites (`:219-223`, `:352-372`, `:380-450`) are left as they are (they compile on wasm; the sandbox is never created because `SandboxWrap` is only produced by the native agent server).

`acp_thread.rs:38` `use std::time::{Duration, Instant};` → `use std::time::Duration; use web_time::Instant;` (the test at `:5385-5399` keeps `std::time::Instant` explicitly). This changes `RetryStatus.started_at` (`:2066`) to `web_time::Instant` on wasm; `crates/agent/src/thread.rs:67,3030,3345` and `crates/agent_ui/src/conversation_view/thread_view.rs:3043` need the same one-line import swap when those crates are gated (section 7 item 5).

### 3.8 `crates/client/Cargo.toml` (modify), `crates/client/src/client.rs` (modify), `crates/client/src/telemetry.rs` (modify), `crates/client/src/telemetry/event_coalescer.rs` (modify)

Cargo (section 5): `async-tungstenite` becomes feature-less in `[dependencies]` and re-declared with the tokio features in the `not(wasm)` table; `gpui_tokio`, `http_client_tls`, `proxy_handshake`, `tiny_http`, `tokio` move to the `not(wasm)` table; lines 81-86 get `not(target_family = "wasm")` added to both cfg expressions; add `web-time.workspace = true`. `clock`, `fs`, `paths`, `worktree`, `rpc`, `smol` (b5's shim), `zed_credentials_provider` stay.

`client.rs`:

- `:5` `mod proxy;` → `#[cfg(not(target_family = "wasm"))]`.
- `:11-15` split: keep `use async_tungstenite::tungstenite::{error::Error as WebsocketError, http::StatusCode};` unconditional (used by `From<WebsocketError>` at `:260-271`, which stays), and `#[cfg(not(target_family = "wasm"))] use async_tungstenite::tungstenite::{client::IntoClientRequest, http::{HeaderValue, Request}};`.
- `:23-25` remove `AsyncReadExt` from the shared `futures` import and add `#[cfg(not(target_family = "wasm"))] use futures::AsyncReadExt;` (only `authenticate_as_admin` uses it).
- `:33` proxy import and `:54` `use tokio::net::TcpStream;` → `#[cfg(not(target_family = "wasm"))]`.
- `:49` `time::{Duration, Instant}` → `time::Duration` + `use web_time::Instant;` (`Status::ReconnectionError { next_reconnection: Instant }` at `:296-298` keeps its native type; no crate reads the field — `title_bar.rs:1160` and `workspace.rs:10190` match `{ .. }` — so no consumer changes).
- `:1326-1428` `establish_websocket_connection`, `:1430-1559` `authenticate_with_browser`, `:1561-1602` `authenticate_as_admin` → `#[cfg(not(target_family = "wasm"))]`; add wasm twins:
  ```rust
  #[cfg(target_family = "wasm")]
  fn establish_websocket_connection(self: &Arc<Self>, _credentials: &Credentials, _cx: &AsyncApp)
      -> Task<Result<Connection, EstablishConnectionError>> {
      Task::ready(Err(EstablishConnectionError::other(anyhow!(
          "Zed collaboration is not available in the browser"
      ))))
  }
  #[cfg(target_family = "wasm")]
  pub fn authenticate_with_browser(self: &Arc<Self>, _cx: &AsyncApp) -> Task<Result<Credentials>> {
      Task::ready(Err(anyhow!("Zed account sign-in is not available in the browser")))
  }
  ```
  `sign_in` (`:880-959`) then reports `Status::AuthenticationError` and returns the error, which is the "sign-in disabled" behaviour BUILD-SPEC asks for; `connect_to_cloud` and `run_cloud_connection` (`:983-1040`) stay ungated because `CloudApiClient::connect` is already gated inside `cloud_api_client`, and they are only reached after a successful sign-in.
- Add after `production` (`:590`): `pub fn sign_in_supported(&self) -> bool { cfg!(not(target_family = "wasm")) }` (for `title_bar` to hide the sign-in affordance; one-line consumer change owned by b7 §3.11).
- `:1231` `smol::future::yield_now().await` stays (b5's shim re-exports `futures_lite::future`); see section 7 item 11 if the shim drops `smol::future`.

`telemetry.rs`:

- `:20` `use std::time::Instant;` → `use web_time::Instant;` (covers the `:419` static's type).
- `:426` `let current_time = std::time::Instant::now();` → `let current_time = Instant::now();` (fully qualified today; without this line the static at `:419` and the value disagree on wasm, and the call panics at runtime).
- `:109-126` `os_name`: append `#[cfg(target_family = "wasm")] { "Web".to_string() }`.
- `:128-176` `os_version`: add an arm `target_family = "wasm" => { "unknown".to_string() }` before the `target_os` arms (after the `feature = "test-support"` arm so tests keep their value).
- `:214-222` unchanged (`File::create` returns `Err` at runtime on wasm and is already `.ok()`-guarded). `:17` `use std::fs::File;` stays (the type exists).

`telemetry/event_coalescer.rs`: `:1-2` `use std::time; use std::{sync::Arc, time::Instant};` → `use std::time; use std::sync::Arc; use web_time::Instant;` (`:12-13,29` keep compiling; the values come from `SystemClock::utc_now`, which 3.9 makes `web_time` too).

### 3.9 `crates/clock/Cargo.toml` (modify) and `crates/clock/src/system_clock.rs` (modify)

Not one of the six crates, but `client` cannot run in the browser without it: `RealSystemClock::utc_now()` (`system_clock.rs:8-14`) is `std::time::Instant::now()`, which panics on wasm on the first edit (`Telemetry::log_edit_event` → `EventCoalescer::log_event` → `clock.utc_now()`). Add `web-time.workspace = true` to `[dependencies]` and change `:1` `use std::time::Instant;` → `use web_time::Instant;`. `FakeSystemClock` (`:16-` under `any(test, feature = "test-support")`) uses the same alias and is unchanged. Natively `web_time::Instant` is `std::time::Instant`, so `SystemClock::utc_now()`'s public return type is unchanged for every native consumer.

## 4. New types and messages

### 4.1 `crates/fs/src/wasm_fs.rs` — `WasmFs` in full

```rust
//! In-memory filesystem for the browser client. Holds the few files Zed reads
//! and writes locally (settings, keymap, snippets, prompt overrides) and emits
//! change events so `settings::watch_config_file` and friends work unchanged.
//! Paths must be absolute POSIX paths; `path::normalize_path` strips `.`/`..`
//! (`/..` stays `/`), and every entry point rejects a relative path with an
//! error rather than guessing a root.

use crate::{
    CopyOptions, CreateOptions, FileHandle, Fs, JobEventReceiver, JobEventSender, MTime, Metadata,
    PathEvent, PathEventKind, RemoveOptions, RenameOptions, TrashId, TrashRestoreError, Watcher,
};
use anyhow::{Context as _, Result, anyhow, bail};
use futures::{AsyncRead, AsyncReadExt as _, Stream, StreamExt as _};
use gpui::BackgroundExecutor;
use path::normalize_path;
use rope::Rope;
use slotmap::SlotMap;
use std::{
    collections::BTreeMap, ffi::OsString, io, path::{Component, Path, PathBuf}, pin::Pin,
    sync::{Arc, Weak}, time::Duration,
};
use text::LineEnding;

/// `WasmFs` is written from the main thread (`SettingsStore`'s foreground update
/// task, `settings_store.rs:325-328`) and read from workers (`watch_config_file`,
/// `settings_file.rs:171-199`). A contended parking_lot mutex parks with
/// `Atomics.wait`, which traps on the browser main thread, so on wasm the state
/// lock is a spin lock: every critical section here is a tree walk or a Vec push
/// and never awaits. Natively (test-support builds) it is parking_lot.
#[cfg(not(target_family = "wasm"))]
type FsMutex<T> = parking_lot::Mutex<T>;
#[cfg(target_family = "wasm")]
type FsMutex<T> = SpinMutex<T>;

/// Minimal test-and-test-and-set spin lock (AtomicBool + `spin_loop`), ~25 lines,
/// with a `lock() -> SpinGuard<'_, T>` that derefs to `T`. Compiled on wasm and
/// under `cfg(test)` so it is unit-tested natively.
#[cfg(any(target_family = "wasm", test))]
pub(crate) struct SpinMutex<T> { locked: AtomicBool, value: UnsafeCell<T> }

pub struct WasmFs {
    this: Weak<WasmFs>,
    state: FsMutex<WasmFsState>,
    executor: BackgroundExecutor,
    job_event_subscribers: Arc<FsMutex<Vec<JobEventSender>>>,
}

struct WasmFsState {
    root: WasmEntry,                                  // always `Dir`
    next_inode: u64,
    last_mtime: MTime,                                // strictly increasing, see `next_mtime`
    watchers: Vec<Weak<WasmWatcher>>,
    trash: SlotMap<TrashId, (PathBuf, WasmEntry)>,   // (original absolute path, entry)
    dirty: BTreeMap<PathBuf, Option<Vec<u8>>>,        // for `take_dirty`; None = removed
}

#[derive(Clone, Debug)]
enum WasmEntry {
    File { inode: u64, mtime: MTime, content: Vec<u8> },
    Dir { inode: u64, mtime: MTime, entries: BTreeMap<OsString, WasmEntry> },
    Symlink { target: PathBuf },
}

pub struct WasmWatcher {
    prefixes: FsMutex<Vec<PathBuf>>,      // normalized; a file path watches itself
    pending: FsMutex<Vec<PathEvent>>,
    wake: async_channel::Sender<()>,      // unbounded; one `()` per emitted event
}

#[derive(Debug)]
struct WasmHandle { fs: Weak<WasmFs>, inode: u64 }

pub struct DirtyFile { pub path: PathBuf, pub contents: Option<Vec<u8>> }
```

Internal helpers (all take the state lock once; none await; lock order is `state` → one watcher's `pending`, and the stream side takes only `pending`, so there is no cycle):

```rust
impl WasmFs {
    pub fn new(executor: BackgroundExecutor) -> Arc<Self>;   // Arc::new_cyclic; root = Dir{inode 1}
    pub fn insert_file(&self, path: &Path, contents: Vec<u8>);
    pub fn insert_dir(&self, path: &Path);                   // sync mkdir -p; emits Created (b7 §3.24)
    pub fn files(&self) -> Vec<PathBuf>;
    pub fn take_dirty(&self) -> Vec<DirtyFile>;              // drains `dirty`
    fn abs(path: &Path) -> Result<PathBuf>;                  // normalize; bail!("path is not absolute: {path:?}")
}
impl WasmFsState {
    fn next_mtime(&mut self) -> MTime;       // web_time::SystemTime::now() as (secs, nanos) via
                                             // MTime::from_seconds_and_nanos; bumped by 1 ns when
                                             // not greater than `last_mtime`, so successive writes
                                             // always differ (buffers compare MTime for equality)
    fn next_inode(&mut self) -> u64;
    /// Resolves `path` (normalized, absolute). Follows symlinks in intermediate components
    /// always and in the final component when `follow_final`. Returns the canonical path too.
    fn resolve(&self, path: &Path, follow_final: bool) -> Option<(&WasmEntry, PathBuf)>;
    fn resolve_mut(&mut self, path: &Path) -> Option<&mut WasmEntry>;    // follows all symlinks
    fn parent_dir_mut(&mut self, path: &Path) -> Result<(&mut BTreeMap<OsString, WasmEntry>, OsString)>;
    fn mkdir_p(&mut self, path: &Path) -> Vec<PathBuf>;  // returns the dirs it created
    fn emit(&mut self, path: &Path, kind: PathEventKind);  // see below
    fn mark_dirty(&mut self, path: &Path, contents: Option<Vec<u8>>);  // files only
}
```

`emit`: prune dead `Weak<WasmWatcher>`; for each live watcher, if any prefix `p` satisfies `path.starts_with(p)`, push `PathEvent { path: path.to_path_buf(), kind: Some(kind) }` onto its `pending` and `wake.try_send(()).ok()`. Batches are formed on the stream side exactly like `RealFs::watch` (fs.rs:1172-1190): `rx.filter_map(move |()| async move { executor.timer(latency).await; let paths = take(pending); (!paths.is_empty()).then_some(paths) })`, so several writes within `latency` collapse into one batch and `watch_config_file` reloads once.

Trait behaviour, method by method (every path goes through `abs` first, so a relative path is `Err` everywhere; "Err" means `anyhow::Error`; missing → `Err("path does not exist: {path:?}")`):

| `Fs` item (fs.rs line) | `WasmFs` behaviour |
|---|---|
| `create_dir` (99) | `mkdir_p`; existing dir → Ok; a file in the way → Err. Emits `Created` for each new dir. |
| `create_symlink` (100) | parent must exist; target stored verbatim (relative targets resolve against the link's parent in `resolve`); exists → Err; emits `Created`. |
| `create_file` (101) | parent must exist (matches `OpenOptions::create` semantics); if exists: `overwrite` → truncate + `Changed`, `ignore_if_exists` → Ok, else `Err(io::Error::from(io::ErrorKind::AlreadyExists))` (downcastable like RealFs at 1325-1336); new → empty file + `Created`. Marks dirty. |
| `create_file_with` (102-106) | `read_to_end` the reader, then behave as `write`. |
| `extract_tar_file` (107-111) | trait item is `cfg(not(wasm))`; the `test-support` build of `WasmFs` implements it with `bail!("unsupported")`. |
| `copy_file` (112) | source must be a file; destination exists: `overwrite` → replace + `Changed`, `ignore_if_exists` → Ok, else Err; else new file + `Created`; new inode, new mtime; marks the destination dirty. |
| `rename` (113) | `source == target` → Ok (RealFs/POSIX); source missing → Err; target exists: `overwrite` → replace, `ignore_if_exists` → Ok leaving the source in place (RealFs at 815-833), else Err; `create_parents` → `mkdir_p(target.parent())`; moves the entry (inode preserved, so `WasmHandle::current_path` follows renames like `FakeHandle`); emits `Removed(source)` then `Created(target)`; marks source removed and target dirty (files). |
| `remove_dir` (118) | missing → `ignore_if_not_exists` ? Ok : Err; not a dir → Err; non-empty without `recursive` → Err; emits `Removed` for the dir and every descendant (deepest first); marks each file removed. |
| `trash` (123) | detaches the entry, stores `(path, entry)` in `trash`, emits `Removed`, marks removed, returns the `TrashId`. |
| `remove_file` (128) | file or symlink only (dir → Err); missing → per `ignore_if_not_exists`; emits `Removed`; marks removed. |
| `open_handle` (130) | `Arc::new(WasmHandle { fs: self.this.clone(), inode })` for files and dirs; `current_path` walks the tree for the inode (Err if gone). |
| `open_sync` (131) | `Box::new(io::Cursor::new(content.clone()))`. |
| `load` (132-134) | default (`load_bytes` + UTF-8). |
| `load_bytes` (135) | follows symlinks; dir → Err. |
| `atomic_write` (136) | `mkdir_p(parent)` then write (RealFs also creates nothing here, but `FakeFs` does and settings code relies on the parent existing after `create_dir` anyway); `Created`/`Changed`; marks dirty. |
| `save` (137) | `text::chunks_with_line_ending(text, line_ending).collect::<String>()` (FakeFs 3174) then as `write`. |
| `write` (138) | `mkdir_p(parent)`; new → `Created`, existing → `Changed`; new mtime, `len` updated; marks dirty. |
| `canonicalize` (139) | `resolve(path, true)` → canonical path; Err if missing. |
| `is_file` (140) | resolve with symlink following; `File`. |
| `is_dir` (141) | via `metadata`. |
| `metadata` (142) | `None` if missing; `is_symlink` when the final component is a link (then follows it; dangling → `Ok(None)`); `len` = content length (dirs: 0), `is_fifo: false`, `is_executable: false`, `is_writable: true`; inodes are stable across writes (worktree entry identity). |
| `read_link` (143) | link target or Err("not a symlink"). |
| `read_dir` (144-147) | `stream::iter` of `path.join(name)` (full paths, as worktree scanning expects) in `BTreeMap` order; not a dir → Err. |
| `watch` (149-156) | registers a `WasmWatcher` with prefix `[normalized path]`; if the path is a symlink, also its target (RealFs 1154-1170 does this so a settings file behind a link reloads); returns the debounced stream and the watcher. Does not require the path to exist (`watch_config_file` watches `settings.json` before it is written). |
| `open_repo` (158-162) | `Err(anyhow!("git repositories live on the remote host"))`. |
| `git_init` / `git_clone` / `git_config` (163-166) | same error. |
| `is_fake` (167) | `false` (the settings-import and "fake fs" branches in `project`/`workspace` must not trigger). |
| `is_case_sensitive` (168) | `true`. |
| `subscribe_to_jobs` (169) | new unbounded channel, sender retained in `job_event_subscribers` (RealFs 1285-1289); nothing is ever sent. |
| `original_path_for_trash_id` (172) | `trash.get(id).map(|(p, _)| p.clone())`. |
| `restore` (176) | missing id → `AlreadyRestored`; destination exists → `Collision { path }` (entry stays in trash so a retry can succeed, matching `restore_can_be_retried_after_collision` at fs_tests.rs:1207); parent missing → `Unknown`; reinserts, emits `Created`, marks dirty, returns the path. |
| `as_fake` (178-181) | default (panics). |

`WasmWatcher::add` pushes a normalized prefix (dedup); `remove` retains the others. Dropping the stream drops the `Sender` side's receiver, so `wake.try_send` fails and the watcher is pruned at the next `emit`.

### 4.2 `crates/terminal` wasm-only items (delta to upstream; the remote surface is b3 §3.5)

```rust
// alacritty.rs (wasm)                        // terminal.rs (wasm)
pub(super) struct PtySender { never: Infallible }   struct SubprocessHandle;
impl PtySender { notify, resize, shutdown }         impl SubprocessHandle { fn kill(&self) {} }

// sync_handler.rs (all targets)
pub(crate) type SyncHandler = /* StdSyncHandler | WebSyncHandler */;
pub(crate) fn sync_deadline(&Processor<SyncHandler>) -> Option<web_time::Instant>;

// terminal.rs (all targets)
impl Terminal { pub(crate) fn expire_sync_update(&mut self, cx: &mut Context<Self>); }   // b3 calls it at the end of process_remote_output (D17)
impl TerminalBuilder { #[cfg(target_family = "wasm")] pub fn new(/* identical signature */) -> Task<Result<TerminalBuilder>>; }
```

No public type changes on native. `TerminalType::Remote`, `RemotePtyTransport`, `RemotePtyHandle`, `RemoteTerminalOptions`, `task::ExitStatus` and `PtyEvent::{Output, RemoteLost}` are b3's (b3 §3.5b-e; D17).

### 4.3 `crates/sqlez/src/wasm_lock.rs` — process-wide reentrant lock

```rust
//! Serializes every SQLite call in the browser build (SQLite is compiled with
//! SQLITE_THREADSAFE=0) and is also the write queue's lock (`wasm_lock_queue`),
//! so sqlez holds exactly one lock on wasm. A spin lock rather than parking_lot
//! because a blocked `Atomics.wait` traps on the browser main thread; critical
//! sections are short (one statement, or one queued write) and never span an
//! `.await`.
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

static OWNER: AtomicU64 = AtomicU64::new(0);   // 0 = free, else the owner's thread token
static DEPTH: AtomicUsize = AtomicUsize::new(0);
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
thread_local! { static TOKEN: u64 = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed); }

pub(crate) struct Guard(());

pub(crate) fn lock() -> Guard {
    let me = TOKEN.with(|t| *t);
    if OWNER.load(Ordering::Acquire) == me {
        DEPTH.fetch_add(1, Ordering::Relaxed);
        return Guard(());
    }
    while OWNER.compare_exchange_weak(0, me, Ordering::Acquire, Ordering::Relaxed).is_err() {
        std::hint::spin_loop();
    }
    DEPTH.store(1, Ordering::Relaxed);
    Guard(())
}

impl Drop for Guard {
    fn drop(&mut self) {
        if DEPTH.fetch_sub(1, Ordering::Relaxed) == 1 {
            OWNER.store(0, Ordering::Release);
        }
    }
}

pub fn is_held_by_current_thread() -> bool {
    OWNER.load(Ordering::Acquire) == TOKEN.with(|t| *t)
}
```

`thread_safe_connection::wasm_lock_queue()` (3.3) wraps each queued write in `lock()`.

### 4.4 `sqlez::Connection` / `ThreadSafeConnection` wasm shape (delta to upstream and b4)

```rust
pub struct Connection {
    pub(crate) sqlite3: *mut sqlite3,
    persistent: bool,
    pub(crate) write: std::sync::atomic::AtomicBool,   // was RefCell<bool>
    _sqlite: PhantomData<sqlite3>,
}
unsafe impl Send for Connection {}
#[cfg(target_family = "wasm")] unsafe impl Sync for Connection {}   // all FFI under wasm_lock

pub struct Statement<'a> {
    pub raw_statements: Vec<*mut sqlite3_stmt>,
    current_statement: usize,
    connection: &'a Connection,
    phantom: PhantomData<sqlite3_stmt>,
    #[cfg(target_family = "wasm")] _lock: crate::wasm_lock::Guard,
}

pub struct ThreadSafeConnection {
    uri: Arc<str>,
    persistent: bool,
    connection_initialize_query: Option<&'static str>,
    #[cfg(not(target_family = "wasm"))] connections: Arc<ThreadLocal<Connection>>,
    #[cfg(target_family = "wasm")]      connections: Arc<std::sync::OnceLock<Connection>>,
    write_generation: Arc<AtomicU64>,   // b4
}

fn default_write_queue() -> WriteQueueConstructor;                                    // private
#[cfg(any(target_family = "wasm", test, feature = "test-support"))]
pub fn wasm_lock_queue() -> WriteQueueConstructor;
```

### 4.5 `prompt_store::PromptStore` (see 3.5)

```rust
pub struct PromptStore { backend: Backend, metadata_cache: RwLock<MetadataCache> }
enum Backend {
    #[cfg(not(target_family = "wasm"))] Lmdb { env: heed::Env, bodies: Database<SerdeJson<PromptId>, Str> },
    #[cfg(any(target_family = "wasm", test))] Memory { bodies: Arc<RwLock<HashMap<PromptId, String>>> },
}
impl PromptStore {
    pub fn new(db_path: PathBuf, cx: &App) -> Task<Result<Self>>;   // unchanged signature
    #[cfg(any(target_family = "wasm", test))] pub fn in_memory() -> Self;
    pub fn load(&self, id: PromptId, cx: &App) -> Task<Result<String>>;
    pub fn all_prompt_metadata(&self) -> Vec<PromptMetadata>;
}
```

### 4.6 `client` additions

```rust
impl Client {
    /// False in the browser: there is no localhost callback for the zed.dev sign-in flow.
    pub fn sign_in_supported(&self) -> bool;
}
```

### 4.7 `db` additions

```rust
pub fn registered_migration_count() -> usize;                       // all targets
impl GlobalKeyValueStore {
    #[cfg(any(target_family = "wasm", test))] pub fn from_app_db(db: &AppDatabase) -> Self;   // D7: the image's own connection
    #[cfg(target_family = "wasm")] pub fn init(db: &AppDatabase);   // synchronous; before any `global()`
}
#[cfg(target_family = "wasm")] const DB_INITIALIZE_QUERY: &str;     // no busy_timeout
```

No proto messages are added by this brief (client persistence messages are b4's; terminal messages are b3's).

## 5. Cargo/package changes

Checked against the workspace manifest (`Cargo.toml:273` `[workspace.dependencies]`): `web-time` (line 902), `libc` (673), `smol` (818), `tempfile` (829), `async-tar` (546), `tokio` (840), `tiny_http` (839), `async-tungstenite` (549), `heed` (634), `portable-pty` (751), `sysinfo` (827), `libsqlite3-sys` (674), `uuid` (883) already exist as workspace deps. New third-party crates: `sqlite-wasm-rs` 0.5.5 (wasm target only). One vendored crate: `vendor/alacritty_terminal` (D10, 3.1) — a path `[patch]`, not a workspace member.

Workspace `Cargo.toml`: add the `[patch."https://github.com/zed-industries/alacritty"]` table from 3.1 (path source, `vendor/alacritty_terminal`) and the `exclude = ["vendor/alacritty_terminal"]` entry. No new `[workspace.dependencies]` entries are required (`sqlite-wasm-rs` and `getrandom` are declared directly with versions, as `fs` already does for `is_executable`/`notify` at `crates/fs/Cargo.toml:46-47` and `gpui` does for `getrandom`).

`crates/fs/Cargo.toml` — `[dependencies]` loses `async-tar`, `libc`, `smol`, `tempfile`, `is_executable`, `notify`, `trash` and gains `web-time.workspace = true`; new table:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
async-tar.workspace = true
is_executable = "1.0.5"
libc.workspace = true
notify = "9.0.0-rc.4"
smol.workspace = true
tempfile.workspace = true
trash = { git = "https://github.com/zed-industries/trash-rs", rev = "41c6c800d884a89351f3b8856d12894cccee261d" }
```

`crates/sqlez/Cargo.toml` — remove `libsqlite3-sys.workspace = true` (16) and `thread_local = "1.1.4"` (21) from `[dependencies]`; add:

```toml
[features]
# Exposes `wasm_lock` and `wasm_lock_queue` to dependents' tests (db).
test-support = []

[target.'cfg(not(target_family = "wasm"))'.dependencies]
libsqlite3-sys.workspace = true
thread_local = "1.1.4"

[target.'cfg(target_family = "wasm")'.dependencies]
# libsqlite3-sys-compatible C API for wasm32-unknown-unknown: builds the
# amalgamation with `cc` against a vendored libc shim, memory VFS by default,
# SQLITE_THREADSAFE=0 (see sqlez::wasm_lock) and SQLITE_OMIT_SHARED_CACHE.
libsqlite3-sys = { package = "sqlite-wasm-rs", version = "0.5.5" }
# Same two lines as crates/gpui/Cargo.toml:112-114, so `-p sqlez` resolves
# uuid → getrandom with the wasm_js backend without gpui in the graph.
getrandom = { version = "0.3.4", features = ["wasm_js"] }
uuid = { workspace = true, features = ["js"] }
```

`crates/db/Cargo.toml` — beyond b4's `futures.workspace = true`: `[dev-dependencies]` gains `sqlez = { workspace = true, features = ["test-support"] }` (for the host test in section 6).

`crates/prompt_store/Cargo.toml` — remove `heed.workspace = true` (26); add:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
heed.workspace = true
```

`crates/clock/Cargo.toml` — add `web-time.workspace = true` to `[dependencies]`.

`crates/terminal/Cargo.toml` — add `web-time.workspace = true` to `[dependencies]`; remove `libc.workspace = true` (31); add:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
libc.workspace = true
```

`crates/acp_thread/Cargo.toml` — add `web-time.workspace = true`; remove `portable-pty.workspace = true` (41); add:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
portable-pty.workspace = true
```

`crates/client/Cargo.toml` — line 21 becomes `async-tungstenite.workspace = true`; remove `gpui_tokio` (34), `http_client_tls` (36), `proxy_handshake` (41), `tiny_http` (57), `tokio` (58) from `[dependencies]`; add `web-time.workspace = true`; add:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
async-tungstenite = { workspace = true, features = ["tokio", "tokio-rustls-manual-roots"] }
gpui_tokio.workspace = true
http_client_tls.workspace = true
proxy_handshake = { workspace = true, features = ["tokio"] }
tiny_http.workspace = true
tokio.workspace = true
```

and change lines 81-86 to

```toml
[target.'cfg(all(not(target_family = "wasm"), any(target_os = "windows", target_os = "macos")))'.dependencies]
tokio-native-tls = "0.3"

[target.'cfg(all(not(target_family = "wasm"), not(any(target_os = "windows", target_os = "macos"))))'.dependencies]
rustls-pki-types = "1.12"
tokio-rustls = { version = "0.26", features = ["tls12", "ring"], default-features = false }
```

`vendor/alacritty_terminal/Cargo.toml` — as in 3.1 (the `not(wasm)` target table plus the `edition`/`rust-version` literals, carried in `vendor/alacritty_terminal.patch`).

Build environment (b5's `.cargo/config.toml` and `script/wasm-cc`): `sqlite-wasm-rs`'s `cc` invocations must carry `-matomics -mbulk-memory -mmutable-globals` for the objects to link under `--shared-memory` (b5 already routes `CC_wasm32_unknown_unknown` through `script/wasm-cc`, which is where the flags belong). `sqlite-wasm-rs` does not need the wasi sysroot include path (it vendors its own libc headers) but tolerates it.

No TypeScript/package changes.

## 6. Tests

fs (`crates/fs/tests/integration/fs_tests.rs`, `test-support` feature; `WasmFs` is available there via the `test-support` cfg arm; each test takes `executor: BackgroundExecutor` like the existing `test_fake_fs` at line 21):

- `test_wasm_fs_write_load_metadata_read_dir`: `write("/home/web/.config/zed/settings.json", b"{}")` creates parents; `load` returns the text; `metadata` reports `is_dir=false`, `len=2`, `is_writable=true`; `read_dir("/home/web/.config/zed")` yields the full file path; `is_dir` on the parent is true; a second `write` yields a different `MTime` and the same inode.
- `test_wasm_fs_rejects_relative_paths`: `write("relative/x")`, `load`, `metadata`, `create_dir`, `watch` on a relative path all return `Err`; `write("/a/../b")` lands at `/b`; `canonicalize("/..")` is `/`.
- `test_wasm_fs_watch_file_debounces_and_batches`: `watch(settings_path, 100ms)` before the file exists; three `write`s within 10 ms; `executor.advance_clock(100ms)`; exactly one batch arrives containing `PathEvent { path: settings_path, kind: Some(Created) }` then `Changed` entries; dropping the stream and writing again does not panic.
- `test_wasm_fs_watch_dir_reports_child_paths`: watch `config_dir`; write `keymap.json`; the batch's `event.path` equals the file path (what `watch_config_dir` matches on); `remove_file` produces `Removed`.
- `test_wasm_fs_watch_config_file_end_to_end`: replicate `settings::watch_config_file`'s loop inline (`settings` depends on `fs`, so it cannot be a dev-dependency): canonicalize → watch → load → next batch → load; assert the receiver sees the initial content and then the updated content after a write.
- `test_wasm_fs_rename_semantics`: rename onto itself keeps the file; `ignore_if_exists` leaves both untouched; `overwrite` replaces; `create_parents` creates the target directory; inode preserved (`open_handle` before, `current_path` after → new path).
- `test_wasm_fs_symlinks`: `create_symlink("/a/link", "./dir")`; `canonicalize("/a/link/file")` resolves; `metadata("/a/link")` has `is_symlink=true`; `read_link` returns `./dir`; dangling link → `metadata` is `Ok(None)`.
- `test_wasm_fs_trash_and_restore`: `trash` removes the file and `original_path_for_trash_id` returns the path; `restore` brings it back and emits `Created`; restoring onto an existing file returns `TrashRestoreError::Collision`, and retrying after removing the blocker succeeds (mirrors `restore_can_be_retried_after_collision` at 1207).
- `test_wasm_fs_copy_recursive`: reuse `copy_recursive` with the `json!` tree from `test_copy_recursive` (211) built via `WasmFs::insert_file` instead of `FakeFs::insert_tree`, asserting `files()` equality.
- `test_wasm_fs_take_dirty`: `write(a)`, `write(a)`, `write(b)`, `remove_file(b)` → `take_dirty()` returns `[a: Some(latest), b: None]` once; a second call returns empty; `rename(a, c)` → `[a: None, c: Some(..)]`.
- `test_wasm_fs_insert_dir`: watch `/home/web/.config/zed`; `insert_dir("/home/web/.config/zed/snippets")` → `is_dir` is true, `read_dir` of it is empty, the batch carries `Created` for the new directory; a second `insert_dir` of the same path emits nothing; `insert_dir` of a path whose parent is a file panics (`#[should_panic]`); `take_dirty()` is empty (directories are never dirty). This is the shape b7 §3.24 `seed_config_files` uses for the snippets/prompts/tasks directories.
- `test_wasm_fs_unsupported_ops`: `open_repo`, `git_init`, `extract_tar_file` (host build) return `Err`; `is_fake()` is false; `is_case_sensitive()` is true.
- `spin_mutex_serializes` (`wasm_fs.rs` `#[cfg(test)]`): 8 threads × 10 000 increments through `SpinMutex<u64>` = 80 000.
- `test_wasm_fs_local_worktree` (`crates/worktree/tests/integration/worktree_tests.rs`, which already enables `fs/test-support`): `Worktree::local(WasmFs, paths::config_dir())` over a seeded `settings.json`; the snapshot has the entry with `is_dir=false`; `write` a new body; after `run_until_parked` the entry's mtime changed and `read_dir`/`canonicalize`/`open_handle` were exercised by the scan (this is the path the settings UI and `keymap_editor.rs:3670,3723` use in the browser).

sqlez (`crates/sqlez/src/wasm_lock.rs` `#[cfg(test)]` and `thread_safe_connection.rs` tests, host-run):

- `reentrant_same_thread`: two nested `lock()` guards; `is_held_by_current_thread()` true until the outer guard drops.
- `serializes_across_threads`: 8 `std::thread`s each lock and increment an unsynchronized counter (`Cell` behind the lock, via an `UnsafeCell` wrapper) 10 000 times; final count is 80 000.
- `wasm_lock_queue_runs_writes_inline_and_reentrantly`: `ThreadSafeConnection::builder(.., ).with_write_queue_constructor(wasm_lock_queue()).build()` resolves under `pollster::block_on` (like the existing test at `:347`); a `write` issued from inside another `write`'s closure completes (reentrancy), and two threads issuing 1 000 `write`s each leave a consistent row count.
- `write_flag_is_not_visible_across_threads`: on the host, with `wasm_lock_queue`, thread A runs a `write` whose closure blocks on a barrier while holding the queue lock; thread B's `connection.can_write()` cannot be observed as `true` because B's `prepare` must take the lock first — assert B's `select` completes only after A's closure returns and B saw `can_write() == false`. (Host build takes the guard in `prepare` under `cfg(any(wasm, test))` for this test only.)
- `connection.rs` tests (`:275-531`) and `thread_safe_connection.rs` tests (`:316-373`) keep passing natively; the `AtomicBool` change is covered by `Write statement prepared with connection that is not write capable` paths already exercised through `ThreadSafeConnection` migrations.
- Wasm-only behaviour that cannot run on the host (single `OnceLock` connection, `wasm_lock_queue` default, sqlite-wasm-rs itself) is covered by `cargo check --target wasm32-unknown-unknown -p sqlez` in CI plus one `wasm-bindgen-test`, `sqlite_image_round_trip_across_workers`, written by this brief into b7's browser suite at `crates/zed_web/tests/` (b7 §6 hosts the suite; b4 §6 cites the test as b6's), that opens `AppDatabase::open_with_image(None)` on the main thread, calls `GlobalKeyValueStore::init(&db)`, writes a KVP from a `spawn_dedicated` worker (the `write_and_log` shape) and a global KVP from the main thread, reads both back on the main thread, `serialize()`s, reopens with the image and reads both back (the round trip b4's `ClientStateStore` depends on, the D7 fold, plus the cross-thread use the sqlite-wasm-rs README warns about).

db: b4's tests (`open_with_image` round trip) plus `open_fallback_db_with_wasm_lock_queue_needs_no_parking`: in a `#[gpui::test]` without `allow_parking`, `open_fallback_db_with_queue::<TestDomain>(None, sqlez::thread_safe_connection::wasm_lock_queue()).await` resolves under `run_until_parked` (the host default would spawn `background_thread_queue`'s OS thread and the test dispatcher would panic on parking, so the test passes the wasm queue explicitly — that is the path the browser takes). `registered_migration_count() > 0` in the same test. `folded_global_kvp_round_trips_through_the_image` (D7): `let db = AppDatabase::test_new()`; `GlobalKeyValueStore::from_app_db(&db).write_kvp("rules_to_skills_migration_done", "1").await`; `let image = db.0.serialize().await` (b4 3.5); rebuild with `ThreadSafeConnection::builder::<AppMigrator>("fold-test", false).with_restore_image(Some(image)).with_write_queue_constructor(locking_queue()).build_with_outcome().await` (b4 3.5/3.6) and assert `GlobalKeyValueStore(conn).read_kvp("rules_to_skills_migration_done") == Ok(Some("1"))` and that `KeyValueStore::from_app_db`'s `read_kvp` of a `dismissed-*` key written before the serialize also survives — one table, one image.

prompt_store (`crates/prompt_store/src/prompt_store.rs` tests, host-run):

- `in_memory_store_serves_builtins`: `PromptStore::in_memory()`; `all_prompt_metadata()` contains `PromptId::BuiltIn(CommitMessage)`; `load` returns `default_content()` normalized (same assertions as `test_built_in_prompt_load` at 361-394 without `tempfile`).
- `in_memory_store_unknown_user_prompt_errors`: `load(PromptId::new())` is `Err("prompt not found")`.

clock: existing `FakeSystemClock` tests unchanged (type alias).

terminal (`crates/terminal/src/terminal.rs` `mod tests` at 3565, host-run, using `gpui::TestAppContext`; the remote-terminal tests are b3 §6):

- `write_output_ends_stale_synchronized_update`: display-only terminal; `write_output(b"\x1b[?2026hhello")` (BSU, no ESU) → content does not yet show `hello`; `advance_clock(150ms)` → `expire_sync_update` fired, `hello` is visible, one `Event::Wakeup` observed.
- `write_output_esu_cancels_timer`: BSU + text + ESU in one call → visible immediately and `sync_timeout_task` is `None`.
- `wasm_new_returns_error` is a compile-time property (`cargo check` for wasm); the existing PTY tests are untouched.

acp_thread (`crates/acp_thread/src/terminal.rs` new `#[cfg(test)]`): `acp_exit_status(Some(success))` → `exit_code == Some(0)`, `signal == None`; `acp_exit_status(None)` → both `None`; on unix `acp_exit_status(Some(ExitStatusExt::from_raw(15)))` → `exit_code == Some(1)` and `signal.is_some()` (the portable-pty mapping today).

client (`crates/client/src/client.rs` tests at 2002+): existing `FakeServer`-based tests keep passing (they override `establish_connection`/`authenticate`); add `sign_in_supported_is_true_natively`. `telemetry::os_name()`/`os_version()` are asserted non-empty in a new `telemetry.rs` test.

CI: extend the existing `check_wasm` job — the layer list lives in `script/check-wasm`'s `default_packages` array (b5 item 3, line ~212; day one `gpui_platform cloud_api_client smol`), not in the xtask: b5 item 16 makes `tooling/xtask/src/tasks/workflows/run_tests.rs:501-511` `cargo_check_wasm()` run `./script/check-wasm` with no arguments, so this brief appends `sqlez` now and `db prompt_store clock fs terminal acp_thread client` to `default_packages` as each crate's prerequisites land (b7's `home_dir` for `db`/`prompt_store`/`client`; the `util` gates, b5's shim and the `rpc` brief for `fs`/`terminal`/`acp_thread`/`client`). The xtask function and the generated `.github/workflows/run_tests.yml` are b5 item 16's diff (regenerated once with `cargo xtask workflows`; hand edits to the YAML are overwritten) and are not touched here. This composes with b7 §3.32 (same array; b7's `util paths settings` precede and its edge crates follow this brief's leaves, `zed_web` last). `-p terminal` is also the check that covers the vendored `alacritty_terminal` (D10; a path patch is not `-p`-targetable, 3.1). `sqlez` is the only crate whose wasm graph is self-contained today, and it is only self-contained because of section 5's `getrandom`/`uuid` lines. Native coverage of the wasm-only code needs no new job: `cargo test -p fs` (integration tests, `test-support`), `cargo test -p sqlez`, `cargo test -p db`, `cargo test -p prompt_store` already compile `WasmFs`, `wasm_lock`/`wasm_lock_queue` and `Backend::Memory` on every PR.

## 7. Risks and open questions

1. SQLite build route (decided, but with two unverified links). `sqlite-wasm-rs` 0.5.5 is chosen over building the amalgamation ourselves because it already provides a libsqlite3-sys-shaped API (root-level `sqlite3_*` functions, `SQLITE_TRANSIENT()` as a function), builds from source with `cc` and a vendored libc shim (no wasi-sysroot juggling), ships a default memory VFS, and has `target_feature = "atomics"` code paths. Not verified: (a) that its C objects link under `--shared-memory` — this requires `-matomics -mbulk-memory` on every `cc` invocation (b5's `script/wasm-cc`); if the `cc` crate strips or ignores them for this crate, fall back to the `links = "wsqlite3"` override with a `libsqlite3.a` we build ourselves from its `sqlite3/` and `shim/` sources with the same flags; (b) whether its musl-shim symbols (`strlen`, `strcmp`, `qsort`, `memchr`, …; `memcpy`/`memset` are not in the shim) collide with the wasi-libc `libc.a` the tree-sitter build (BUILD-SPEC 3.3) links — both define `strlen`; wasm-ld takes the first archive member that satisfies a reference and errors only on duplicate *strong definitions pulled into the link*, so this must be tested on the first full link. Fallback if it cannot be reconciled: a crate named `zs_sqlite_sys` (not `libsqlite3-sys` — cargo rejects a dependency whose source differs per target under one name, verified in section 2) at `crates/zs_sqlite_sys/` as a workspace member, containing libsqlite3-sys 0.30.1's `src/lib.rs`, `src/error.rs`, `sqlite3/bindgen_bundled_version.rs`, `sqlite3/sqlite3.c`/`.h` with a `build.rs` that compiles `sqlite3.c` with `-DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_TEMP_STORE=3 -DSQLITE_OMIT_WAL -DSQLITE_USE_URI -DSQLITE_DEFAULT_MEMSTATUS=0` plus the bundled feature flags at `build.rs:121-137` minus `LOAD_EXTENSION`, links `<wasi-sysroot>/lib/wasm32-wasip1-threads/libc.a`, and defines `sqlite3_os_init` in Rust registering a `sqlite3_vfs` whose `xOpen` returns `SQLITE_CANTOPEN` (only `:memory:`/memdb databases are ever opened), whose `xCurrentTimeInt64`/`xRandomness` call `web_time`/`getrandom`, and whose `xSleep` is a no-op; declared in `sqlez`'s wasm table as `zs_sqlite_sys = { path = "../zs_sqlite_sys" }` and aliased with `#[cfg(target_family = "wasm")] extern crate zs_sqlite_sys as libsqlite3_sys;` at `lib.rs:1` (an `extern crate .. as ..` in the crate root is added to the extern prelude, so `use libsqlite3_sys::*` in the submodules resolves). Same sqlez changes apply.
2. `SQLITE_THREADSAFE=0` plus `sqlez`'s cross-thread use. One reentrant spin lock (4.3) covers both the FFI and the write queue, so there is no parking and no lock order. The cost is that the main thread spins while a worker holds a long write (e.g. `workspace/persistence.rs` bulk writes or b4's `serialize()`); those already run on `background_spawn`, and b4's serialize must too (item 12). Measure `write()` durations in month one; if a main-thread `write` (`onboarding_banner.rs:94-98` is the known one) ever spins for more than a frame, route foreground writers through `db::write_and_log`.
3. `parking_lot` on the wasm main thread: this brief removes every contended parking_lot lock in its crates — `sqlez` (item 2), `WasmFs` (spin mutex, 4.1) — and leaves two uncontended ones: `sqlez::QUEUES` (read-locked only after `build()`) and alacritty's `FairMutex` around `Term`. The latter is uncontended in the browser because b3 parses remote bytes on the foreground executor (b3 §3.5, §7 "Remote: no parser thread") and every other `term.lock()` in `terminal.rs` (10 sites) and `terminal_view` is on the main thread; the native background parser (`spawn_task_subprocess`, `TerminalBuilder::new`'s `background_spawn`) is gated out. If b3 ever moves parsing to a worker on wasm (its §7 mentions the option), the vendored copy must gain a `#[cfg(target_family = "wasm")]` spin `FairMutex` in `vendor/alacritty_terminal/src/sync.rs` (through `vendor/alacritty_terminal.patch`, 3.1) first. gpui's own parking_lot use is the `scheduler`/gpui_web briefs' problem.
4. `sysinfo` on `wasm32-unknown-unknown`: the `unknown` backend is selected by `lib.rs:29-67` and `libc` is excluded by its manifest, and the crate has a CI feature (`unknown-ci`) for exactly this configuration, but I did not compile it. If it fails, gate `pty_info.rs` wholesale and change `Terminal::pid()`/`pid_getter()`/`ProcessIdGetter::fallback_pid()` to return `Option<u32>`/`u32` on all targets, touching `terminal_view.rs:1447` and `debugger_ui/session/running.rs:1389-1392` (the fork did this).
5. `web_time::Instant` and `task::ExitStatus` are distinct types from their `std` counterparts on wasm only; these one-line import swaps in other crates become compile errors on wasm once this brief lands and are owed by the owning briefs: `crates/activity_indicator/src/activity_indicator.rs:23,477,489` (`fs::JobInfo.start` and the git `JobInfo.start`; b7 §3.10); `crates/agent/src/thread.rs:67,3030,3345` and `crates/agent_ui/src/conversation_view/thread_view.rs:3043` (`acp_thread::RetryStatus.started_at`; the agent/agent_ui briefs); `use std::process::ExitStatus` → `task::ExitStatus` in `crates/workspace/src/tasks.rs:1`, `workspace.rs:134,197`, `crates/terminal_view/src/terminal_panel.rs:1`, `crates/debugger_ui/src/session/running.rs`, `crates/agent_ui/src/conversation_view.rs`, `crates/agent_servers/src/acp.rs:2109,2133` (b3 §3.5a lists them; natively the alias is identical). No crate reads `client::Status::ReconnectionError.next_reconnection`, so nothing follows from that swap.
6. Remote terminal behaviour that reviewers raised against this brief's former §3.6 and that now belongs to b3: host-reported PIDs for `debugger_ui`'s `RunInTerminal` (b3 §3.5l returns `None` from `pid()` for `Remote`, so `console: integratedTerminal` debugging against a remote terminal errors — b3 open question); `title`/`foreground_process_command_name`/`working_directory` for remote terminals (b3 §3.5l returns `None`; BUILD-SPEC 5.1's `ListTerminals { title, cwd }` suggests a `TerminalProcessChanged` notification later); a public `is_remote()`/`remote_pty()` accessor for `Project::clone_terminal` (`project/terminals.rs:453-470`; b3 §3.6); `RemoteLost` semantics and input while disconnected (b3 §3.5g/h); `has_active_pty_resources()` for `Remote` (b3 test 12: false after lost). Recorded here so they are not lost; not specified here. Terminal restore itself (persisting ids/titles/cwds, `ListTerminals`, `AttachTerminal { from_offset: 0 }` into restored panes on a fresh session) is in scope for b3 per D4, not deferred; PTYs outlive fresh sessions in the server-level `PtyManager` (D3), so nothing in this brief assumes a terminal dies with the page.
7. `Fs::extract_tar_file` disappears from the trait on wasm. Any browser-set crate that later calls it will fail to compile there, which is the intended signal (archives are unpacked on the server). Confirm no browser-set crate does today: the current callers are `extension_cli`, `extension_host` (excluded) and `dev_container` (excluded).
8. `WasmFs` and settings persistence: BUILD-SPEC 3.7's control-plane save hook is b7 §3.24 `install_save_back` — `fs.watch(paths::config_dir(), 500 ms)`, filtered to `settings.json`/`keymap.json`, a 750 ms debounce per document, then `JsHost::save_document`; `WasmFs` emits per-file events so the hook saves only the changed document. Decided by b7 (its R2-16 cites this item as "b6 §7 item 9"): v0 stores settings.json and keymap.json only; snippets (`snippet_provider` watches `paths::snippets_dir()` with 1 s latency), prompt overrides (`prompts.rs:277,312`), tasks.json and the global AGENTS.md live only in `WasmFs` for the tab's lifetime, seeded as empty directories by `seed_config_files` (`insert_dir`, 3.2). `take_dirty()` stays available so the `visibilitychange` → hidden / `STOPPING` flush (D7 triggers) can pick up a write made inside the 750 ms window; b7 §3.24 does not wire it yet (open for b7; `pagehide` is best-effort only, b4 §3.8), so the worst case today is losing an edit made in the last 750 ms before a hidden tab is discarded.
9. `getrandom`: the `wasm_js` backend needs both b5's `--cfg getrandom_backend="wasm_js"` and the `wasm_js` *feature*; gpui's wasm table (`crates/gpui/Cargo.toml:112-114`) supplies the feature to every crate whose graph contains gpui, and section 5 copies it into `sqlez` so the leaf check works alone. `tungstenite` 0.28 also pulls `rand 0.9` → `getrandom 0.3` (frame masking), covered the same way in `client`.
10. `client`: `telemetry` will attempt to POST events to zed.dev from the browser unless `TelemetrySettings` defaults are off for the web build; `Telemetry::new` also `File::create`s a log file (harmless `Err`). Policy decision for the zed_web/settings brief.
11. The `smol` shim (b5's `zs_smol_shim`) must keep `smol::future::yield_now` (client.rs:1231) and `smol::io` traits used by FakeFs on native; if the shim drops `smol::future`, replace the call with `futures_lite::future::yield_now` and add `futures-lite` to `client`.
12. b4 coordination, stated as requirements on b4 3.4-3.8 and b7 and now fixed by D7: (a) `ThreadSafeConnection::serialize()`/`restore_from()` are `self.write(..)` and therefore run inline on the awaiting thread on wasm — `ClientStateStore`'s ticker and `flush_now` await them from `background_spawn` (D7); the `visibilitychange` → hidden flush runs while the page's executor still ticks, so it takes the same background path; a `pagehide` flush is best-effort only (b4 §3.8, b7 §7 item 20), and the `STOPPING` flush, which follows the `unsaved_buffers` write (D6), is the authoritative last save — no main-thread serialize remains in the design; (b) `restore_main_from` opens a scratch `:memory:` connection while the main one exists — allowed only because 3.3's wasm `open_memory` ignores the URI and SQLite is built with `OMIT_SHARED_CACHE`; (c) resolved by D7: the `GlobalKeyValueStore` is folded into the `AppDatabase` image by sharing its connection (3.4), so the rules→skills migration flag and any other global key persist across resumes and the migration no longer re-runs per boot. Residual: on wasm the global and app stores share the `kv_store` table, so a `GlobalKeyValueStore` key must never reuse a `KeyValueStore` key. Verified by grep on this checkout: global keys in the browser set are `rules_to_skills_migration_done`/`rules_to_skills_migration_result` (`prompt_store/rules_to_skills_migration.rs:60,66`), `system_id` (`zed/main.rs:1382`) is desktop-only; app-side keys are the `Dismissable::KEY` consts (`dismissed-trial-upsell`, `dismissed-trial-end-upsell`, `dismissed-acp-thread-import`, `dismissed-cross-channel-thread-import`, `dismissed-edit-predict-upsell`, `basedpyright-banner`, `skills_announcement_dismissed`) and `thread-metadata-remote-connection-backfill` — disjoint. Any new global key gets a review-time grep against `KeyValueStore` users.
13. `inventory` on wasm: `db`'s migration registry, `settings`' and gpui's action registries all rely on constructors that the linker only calls from exported functions under command-style linkage (`inventory-0.3.21/src/lib.rs:105-146`); if they do not run, `AppDatabase::open_with_image` sees zero migrations and creates an empty schema. `db::registered_migration_count()` (3.4) gives b7's boot the assertion it planned (b7 §7 item 3, `ctors_missing`); calling `__wasm_call_ctors` twice is idempotent for `inventory`.
14. `sqlite-wasm-rs` and `busy_timeout`: with a single connection SQLite never returns `SQLITE_BUSY`, and 3.4 removes the pragma on wasm anyway so `xSleep` (`memory.atomic.wait32` under `atomics`) is unreachable; if b4's `restore_main_from` ever holds the scratch connection open across a main-connection write, the backup API returns `SQLITE_BUSY` synchronously (no sleep) and the caller sees an error rather than a trap.
15. Vendored alacritty (D10): `vendor/alacritty_terminal` freezes the gate at a copy of `4c12966`; upstream Zed bumps `alacritty_terminal.rev` periodically, so the rebase job re-vendors from the new rev, re-applies `vendor/alacritty_terminal.patch` and updates `vendor/README.md` (or, once a fork exists, rebases the six-line commit and switches the patch table to `git` + `rev`; once merged upstream, bumps `:523` and drops the table). Third-party code under `vendor/` is outside `script/clippy --workspace` and `cargo test --workspace` (not a member, 3.1); alacritty's own tests run in an upstream checkout. The gate set is complete for `4c12966`: `libc`, `polling` and `home` are referenced only from `src/tty/` and `src/event_loop.rs`, and `term/`, `grid/`, `index.rs`, `selection.rs`, `vi_mode.rs`, `sync.rs` import only `base64`, `bitflags`, `log`, `unicode-width`, `regex-automata`, `serde`, `parking_lot` and `vte`. A future bump that adds a native import to a pure module surfaces as a wasm compile error in `terminal`, not silently.
16. Not verified: that `async-tungstenite` 0.33 with default features (no runtime) compiles on wasm (`tungstenite` is pure Rust apart from `rand`, item 9; `std::net` types exist as stubs); the rpc brief depends on the same assumption.
17. vte synchronized updates: `sync_handler.rs` fixes the runtime panic and adds the missing timeout for `output_processor`; the two `Processor::<SyncHandler>::default()` in the `convert_lf_to_crlf` helpers (`:199,206`) never see a BSU because they only run on already-parsed text, so they need no timer. b3's `process_remote_output` must call `expire_sync_update` (one line) or a TUI that sends BSU without ESU over the wire freezes the remote grid until the next output.

## 8. Review log

Two adversarial reviewers checked the previous revision. Each finding was re-verified against `/Users/ray/Projects/play/wed/zed` before being accepted; "R1"/"R2" are the two reviewers in the order received.

R1 wrong claims

1. BUILD-SPEC line numbers (108-118/119/137). **Accepted** — table at 103-112, dependency-edge at 114, dead-code text at 134 (the `agent`/`acp_thread` row); header and section 2 corrected; the per-crate list is 116-139.
2. `executor.rs:444-445` cited for `gpui::block_on`. **Accepted** — `db.rs:65` and `kvp.rs:247` call the free function, the pollster re-export at `gpui.rs:167-168`; section 2 and 3.4 corrected.
3. `next_reconnection` compared by `title_bar`/`collab_ui`. **Accepted** — nothing reads the field (only constructed at `client.rs:727`; `title_bar.rs:1160` and `workspace.rs:10190` match `{ .. }`); the real wasm-only type consumers are `activity_indicator.rs:23,477,489`, `agent/src/thread.rs:67,3030,3345`, `agent_ui/.../thread_view.rs:3043`; section 7 item 5 rewritten.
4. `telemetry.rs:426` not covered by the import swap. **Accepted** — it is a fully qualified `std::time::Instant::now()`; 3.8 edits the line.
5. getrandom `wasm_js` already in gpui's wasm table; `-p sqlez` alone fails; tungstenite pulls rand. **Accepted** — verified `gpui/Cargo.toml:112-114`, `getrandom-0.3.4/src/backends.rs` `compile_error!`, `tungstenite-0.28.0` `rand 0.9`; section 5 adds the two lines to `sqlez`'s wasm table so the leaf check works alone; risk 10 → item 9.
6. `locking_queue` is a parking_lot mutex; foreground writers exist. **Accepted** — `thread_safe_connection.rs:306-314`, `onboarding_banner.rs:91-99`; 3.3 now defaults to `wasm_lock_queue()` (the same reentrant spin lock) on wasm, which also removes the lock-order issue (R1 missing 7).
7. `agent` does not call `wait_for_completed_task`. **Accepted** — consumers are `agent_ui/conversation_view.rs:2171,2185`, `debugger_ui/session/running.rs:1225`, `terminal_view/terminal_panel.rs:1389,1842`, `acp_thread/terminal.rs:441`; the former risk 5 is superseded by b3's `task::ExitStatus` (see R2-1).
8. `agent.rs:3935` is a test assertion. **Accepted** — `#[gpui::test]` at `:3922-3952`; wording corrected.
9. `fs.rs:35/36` anchors and trait item count. **Accepted** — `:35` futures, `:36` git, `:37` is_executable; 34 items, 32 required; 3.2 edits the right lines.
10. Fork moved `git`/`smol`. **Accepted** — both are duplicated in the fork's two tables; evidence line corrected.
11. `migrations.rs:11` is a single-item import; the function is `eager_exec`. **Accepted** — 3.3 guards `eager_exec` (`:16-31`).
12. `sqlez_macros` static is `cfg(not(linux|freebsd))`. **Accepted** — noted; conclusion unchanged.
13. Line-anchor drift in terminal/alacritty/pty_info/client/sqlez tests/websocket.rs. **Accepted** — every anchor re-derived by grep and corrected (e.g. `PtySender :85-109`, `spawn_event_loop :203-217`, `kill_current_process :149-160`, `client.rs` struct `:207`, `set_connection :1177`, `sign_out :1693`, `connection.rs` tests `:275-531`, `thread_safe_connection.rs` tests `:316-373`, `websocket.rs:9-12`).
14. sqlite-wasm-rs features/MSRV/`memcpy`. **Accepted** — `[features]` has only `sqlite3mc`; `rust-version` 1.81.0 (the tag's README also says 1.81.0, not 1.85.0 as the reviewer wrote); the shim has no `memcpy`/`memset`/`memmove`; section 2 and risk 1(b) corrected.
15. `fs_watcher` has other consumers. **Accepted** — `zed.rs:668,699` and `worktree_tests.rs:1996`, all native; listed.

R1 missing

1. vte `StdSyncHandler` panics on wasm and nothing calls `stop_sync`. **Accepted** — verified `vte-0.15.0/src/ansi.rs:23,456-475`; the hazard also applies to `Terminal.output_processor` used by `write_output` on the main thread (and by b3's remote path, since the brief no longer has a pump); new `sync_handler.rs` + `expire_sync_update` (3.6, 4.2, tests, item 17).
2. Path-package fallback rejected by cargo. **Accepted** — reproduced in a scratch workspace (both with and without `package =` renaming); risk 1 fallback rewritten as a differently named member crate plus `extern crate .. as libsqlite3_sys`.
3. `WasmOsCallback::sleep` traps on the main thread; `busy_timeout`. **Accepted** — verified `src/shim.rs:16-27`; 3.4 adds a wasm `DB_INITIALIZE_QUERY` without `busy_timeout`; item 14.
4. `inventory` on wasm. **Accepted** — `db/Cargo.toml:22`, `inventory-0.3.21/src/lib.rs:105-146`; b7 §7 item 3 already owns the loader side, so this brief adds `registered_migration_count()` for its assertion (3.4, 4.7, item 13).
5. Additional `web_time::Instant` swaps. **Accepted** — listed with owners in item 5; `telemetry.rs:426` fixed here.
6. Unused imports on wasm under `-D warnings`. **Accepted** — 3.2 gates `AtomicU8`, `maybe`, `iter`, `io::Write`; 3.8 gates `AsyncReadExt` (`TryFutureExt` is still used by ungated code and stays).
7. `Statement` guard vs `locking_queue` mutex deadlock. **Accepted in substance** — resolved by making the write queue use the same reentrant lock (3.3), so there is a single lock rather than a documented order.
8. Section 6 CI job depends on unwritten briefs; `-p sqlez` fails on getrandom. **Accepted** — CI paragraph rewritten: extend the existing xtask `check_wasm` list crate by crate; `sqlez` is the only self-contained leaf and only with section 5's lines.

R2 wrong claims

1. `ExitStatus::default()` is success, so `RemoteExited(None)` and `completion_tx` report success to every consumer. **Accepted in substance, fixed differently** — verified `library/std/src/process.rs:1887-1894` and `unsupported.rs:201-212`; but b3 §3.5a (ownership recorded in b3:9 and §7.12, which post-dates the reviewed revision) already puts a `task::ExitStatus` alias/struct where `workspace` can name it and builds a real status in `exit_status_from_remote`; this brief drops its `RemoteExited`/`exit_code`/`last_exit_code`/`code_override` design entirely and keeps only the `acp_thread` mapping over b3's type (3.7). The reviewer's `TerminalExitStatus` in `terminal` would not be nameable by `workspace` (`workspace.rs:197`), which is why b3 chose `task`.
2. `is_pty()` gates the init-command handshake; split the predicate. **Accepted as a fact, deferred to b3** — `terminal.rs:2143` and `agent_panel.rs:2147` verified; b3 §3.5k already widens `is_pty` to `Pty | Remote` and pins it with its integration test 13, and owns `has_active_pty_resources` (b3 test 12). Not specified here; recorded in item 6.
3. `reattach_remote` cannot be implemented (no retained `events_tx`). **Accepted as a fact, moot** — verified (`events_tx` only at `:1012/:1210`, moved into `new_term`/`spawn_event_loop`); the pump/reattach design is removed in favour of b3's `RemotePtyHandle { events_tx }` and `Project::reattach_remote_terminals`.
4. Vendoring alacritty vs a fork branch + rev bump. **Accepted** — verified no `vendor/`, no `exclude`, `[patch.crates-io]` uses git sources; 3.1 now uses a git-sourced patch to a fork branch carrying the six-line commit, with the vendored copy demoted to a stopgap that requires `exclude` up front. (A bare `rev` bump on line 523 is not possible without write access to `zed-industries/alacritty`; the patch table keeps line 523 identical until the PR merges.) Superseded by D10 (2026-09-02): the vendored path patch under `vendor/alacritty_terminal` is now the primary form and the fork branch the end state recorded in `vendor/README.md`; section 9.
5. `open_fallback_db_uses_locking_queue_without_block_on` would hit `background_thread_queue` on the host. **Accepted** — `thread_safe_connection.rs:135`; the db test now passes `wasm_lock_queue()` through a new `open_fallback_db_with_queue`, exposed via a `sqlez` `test-support` feature (3.3, 3.4, sections 5-6).
6. `telemetry.rs:426`, `event_coalescer.rs`, `clock/system_clock.rs` keep `std::time::Instant`; first keystroke panics. **Accepted** — verified `system_clock.rs:1,8-14`, `event_coalescer.rs:1-2,12-13,29`, `client.rs:585`; new 3.9 (`clock`) and the `event_coalescer.rs` edit in 3.8.
7. `hyperlinks.rs` uses `Instant::now()` on hover. **Accepted** — `hyperlinks.rs:15,328,331`; 3.6 swaps the import.
8. `kvp.rs:244-250` `GLOBAL_KEY_VALUE_STORE` uses `gpui::block_on`; reached from `prompt_store`. **Accepted** — verified; 3.4 replaces the `LazyLock` with a `OnceLock` + `GlobalKeyValueStore::init()` on wasm, and item 12(c) records the image question. D7 later answered it: `init(&AppDatabase)` folds the global store into the app database's connection instead of opening a second database; section 9.
9. `locking_queue`/`QUEUES.read()` park on the main thread; use `wasm_lock`. **Accepted** — 3.3 `default_write_queue()` → `wasm_lock_queue()`; `QUEUES` is only write-locked during `build()` and read-locked otherwise (stated in 3.3's invariant (c)); b4's serialize requirement recorded in item 12(a).
10. Pump holds `FairMutex` across a large `Output`; gate `FairMutex` to a spin variant. **Rejected as a change, analysis kept** — `FairMutex` is parking_lot (`sync.rs:5`; `terminal.rs` locks it at 10 sites, not 24), but the pump is gone: b3 parses on the foreground executor with a byte budget (b3 §3.5, `REMOTE_PARSE_BUDGET`), so on wasm only the main thread ever locks `term` and the lock is never contended. Item 3 records the condition under which a spin `FairMutex` becomes necessary.
11. `WasmFs` parking_lot locks are contended between main and workers. **Accepted** — verified `settings_store.rs:325-328` (foreground) vs `settings_file.rs:171-199` (background); 4.1 uses a spin mutex on wasm via `FsMutex`, and states the lock order.
12. A `check_wasm` job already exists and is generated by xtask. **Accepted** — verified `run_tests.yml:637-676`, `run_tests.rs:493-521`; section 6 extends `cargo_check_wasm()` and regenerates; coordinated with b5 item 16.
13. Test helper at `:5602-5610` and wasm dead code under `-D warnings`. **Accepted** — the helper's `Remote` arm is b3's (b3 §3.5d says so); the dead-code allowances on `PtyResources`, `PtyProcessInfo`, `ProcessIdGetter::new` and the `PtySender` stub are added in 3.6.

R2 missing

1. Host PID for remote terminals (`debugger_ui` `RunInTerminal`, `terminal_view.rs:1447`). **Deferred to b3** — verified the consumers; b3 §3.5l returns `None` for `Remote`; recorded as a b3 open question in item 6.
2. Public way to recognise a remote terminal for `Project::clone_terminal`. **Deferred to b3** — `project/terminals.rs:453-470` verified; b3 §3.6 owns `project::terminals`; item 6.
3. Foreground-process info for remote terminals. **Deferred to b3** — item 6.
4. Terminal state after resume/takeover; input while disconnected; `RemotePty` impl shape. **Deferred to b3** — b3 §3.5g/h (`RemoteLost`, `attached`) and §3.6 cover these; item 6.
5. `WasmFs` flush on `pagehide`. **Accepted** — `take_dirty()`/`DirtyFile` (3.2, 4.1, test), tied to b9:624. D7 later renamed the trigger to `visibilitychange` → hidden / `STOPPING` (`pagehide` best-effort only); section 9.
6. Relative and `..` paths. **Accepted** — verified `path.rs:486-512`; every entry point rejects non-absolute paths; test added.
7. `Worktree::local` over `WasmFs` untested. **Accepted** — `keymap_editor.rs:3670,3723` verified; `test_wasm_fs_local_worktree` added in `worktree`'s integration tests.
8. `sqlite-wasm-rs` across workers unverified; `busy_timeout`. **Accepted** — the `wasm-bindgen-test` now writes from a `spawn_dedicated` worker and reads on main; `busy_timeout` dropped on wasm (3.4); the shim stores no `JsValue` across calls (verified `src/shim.rs`), so per-thread JS realms are fine.
9. Inconsistent native cfg coverage. **Accepted with a smaller fix** — the three cfgs differ for stated reasons (3.5) and the existing native test jobs already compile all three wasm arms, so no new CI entry; `sqlez` gains `test-support` for `db`'s test.
10. Cross-thread `Connection.write` flag semantics. **Accepted** — invariant stated in 3.3 with a `debug_assert!` in `with_write` and a two-thread host test.
11. b4 coordination gaps. **Accepted** — item 12 (a)-(c).
12. Terminal test gaps (`Exited(None)`, reattach-once, grid readable after release, bounded `Output`). **Deferred to b3** — b3 §6 already has `lost_marks_detached_and_finishes`, `duplicate_prefix_is_dropped`, `test_remote_terminal_survives_disconnect` and the parse budget; the "grid readable after `release_pty_resources`" property (`acp_thread/terminal.rs:476-489`) is noted in section 2 for b3's `Remote` arm of `release_pty_resources`.

Not raised by either reviewer but found while verifying: b3 §7.12 records that this brief's former §3.6/§4.2 conflicted with b3 §3.5 and had to be amended before either brief starts on `terminal.rs`; this revision is that amendment.


## 9. Reconciliation log

Amended 2026-09-02 against `docs/briefs/DECISIONS.md` and the sibling briefs' sections 7-8. Every b1..b9 brief was grepped for `b6` (word-boundary); b1, b2, b5, b8 and b9 contain no item addressed to this brief (their only substring hits are base64/hash strings), so their impact below comes from the decisions and from cross-references in b3, b4 and b7. Every fact added was re-checked against `/Users/ray/Projects/play/wed/zed` (HEAD `c3cf80c`, clean tree — the same commit the previous revision was verified against, so no `crates/**` line anchor moved) or against the cargo git checkout named in 3.1; no cargo command was run.

Decisions

- D1 (identity), D2 (reconnect budget), D5 (control listener), D8 (private ports), D12 (web keymap), D13 (activity ping), D14/D15 (b10/b11), D16 (entry point), D18/D19 (supervisor, control plane), D20 (serve contract): none of the six crates, `clock`, `db` or the workspace manifest is touched; nothing changed.
- D3 (session semantics): no change to any item; section 7 item 6 now notes that PTYs outlive fresh sessions in the server-level `PtyManager`, so nothing here assumes a terminal dies with the page.
- D4 (terminal restore in b3): section 7 item 6 records that restore (`ListTerminals`, `AttachTerminal { from_offset: 0 }` into restored panes) is in scope for b3, not deferred.
- D6 (unsaved buffers): the boot call points in 3.4 and item 12(a) order the `STOPPING` flush after b7's `unsaved_buffers` write; the table itself is b4/b7's.
- D7 (client-state store): (i) `GlobalKeyValueStore` folded into the `AppDatabase` image — 3.4 `kvp.rs` rewritten from "open a second in-memory database in `init()`" to `from_app_db`/`init(&AppDatabase)` sharing the app connection (`kv_store` already exists there via `KeyValueStore`'s registered migration, `kvp.rs:23-29,41`, `db.rs:276-277`); 4.7 updated; item 12(c) closed with the residual key-namespace invariant and the keys enumerated by grep; new host test `folded_global_kvp_round_trips_through_the_image` and a fold check inside the browser test; (ii) `serialize()`/`restore_from()` on `background_spawn` is binding (3.3 consequence, item 12(a)); (iii) flush triggers renamed everywhere from `pagehide` to `visibilitychange` → hidden / `STOPPING` with `pagehide` best-effort (header, section 2 `BUILD-SPEC.md:262` cite, 3.2 `take_dirty` doc and consumer paragraph, 3.4 boot call points, items 8 and 12, review-log note on R2 missing 5); the `b9:624` anchor is gone (b9's hook is at b9:789 and only calls `flush_client_state`).
- D9 (rebuild tarball): no change; the image the tarball preserves is the one 3.4 describes.
- D10 (vendored dependencies): 3.1 rewritten — the vendored copy at `vendor/alacritty_terminal` with a path `[patch."https://github.com/zed-industries/alacritty"]` entry is the primary form (it was the stopgap), `vendor/alacritty_terminal.patch` and the shared `vendor/README.md` entry record the upstream rev and the intended git-patch form, the `<fork-owner>`/`<gate commit>` placeholders are gone, `exclude = ["vendor/alacritty_terminal"]` is added, and the copy's `Cargo.toml` gets `edition`/`rust-version` literals (the checkout's manifest inherits both from alacritty's workspace) and loses the dangling `readme`. Section 1 (goal), the section 2 `Cargo.toml:1-3` evidence (the implicit-member claim corrected using b5 §2's `scratch` measurement), the section 3 dependency-order line, section 5, section 6 (CI), items 3 and 15 and review-log R2-4 updated to match.
- D11 (wasm home `/home/web`): the section 2 line on `home_dir` and every literal test path in section 6 (`/home/zed/.config/zed/...` → `/home/web/.config/zed/...`) updated; b7 §3.1 owns the function.
- D17 (terminal ownership): already the shape of 3.6/4.2 after the b3 §7.12 amendment; now cited, `expire_sync_update` made `pub(crate)` so b3 can call it from `remote_pty.rs`, and the D17 sentence about b3 advancing `Processor<SyncHandler>` recorded in 3.6.

Sibling deltas

- b3 §1, §7.12, §8 R2 missing 1 (ownership; `RemoteTerminalOptions` adopted from b6): applied in the previous revision; D17 confirms it. b3 §3.5a's wasm `task::ExitStatus` API (`from_parts`, `code() -> Option<i32>`, `signal() -> Option<i32>`, `success()`, `Display`) re-checked against 3.7's `acp_exit_status` wasm branch — consistent. b3 §7.2 says b6 "switches the `ExitStatus` importers in §2 to `task::ExitStatus`": the importers outside the six crates stay listed in item 5 as owed by their owning briefs; `acp_thread` (ours) is done in 3.7.
- b4 §3.6 / §7 item 5 (`open_with_image` returns `(Self, RestoreOutcome)`; `ClientStateStore::new` takes the outcome): 3.4 and the boot call points destructure the tuple; `open_fallback_db_with_queue` given the same return shape.
- b4 §3.8 ("b6:232 and b9:624 should say `visibilitychange`"): applied (D7 (iii)).
- b4 §6 (the browser `open_with_image` + `serialize` round trip "belongs to b6's `wasm-bindgen-test` suite"): section 6 names the test (`sqlite_image_round_trip_across_workers`), says this brief writes it, and places it in b7's `crates/zed_web/tests/` suite (b7 §6), which is where wasm-bindgen tests live.
- b4:10, b4 §7 item 5 and b4 §8 R1-4 still describe b6's wasm default write queue as `locking_queue`; the contract is `wasm_lock_queue` (3.3, unchanged since the previous revision). Not changed here; listed for b4 under "unresolved".
- b7 §3.24 (`settings::seed_config_files(&Arc<fs::WasmFs>, ..)` is synchronous and also creates the empty snippets/prompts/tasks directories): `WasmFs::insert_dir` added (3.2, 4.1, test `test_wasm_fs_insert_dir`) so b7 needs no async `Fs` call at boot; the `insert_file` doc names the consumer. b7's save-back scope decision (settings.json + keymap.json in v0; b7 R2-16 cites it as "b6 §7 item 9", which is item 8 here) recorded in item 8; `take_dirty` kept and offered to the hidden/STOPPING flush.
- b7 §7 item 8 (`WasmFs` semantics b7 relies on: `new(BackgroundExecutor) -> Arc<WasmFs>`, `insert_file`, per-file events at the caller's latency, `canonicalize` erroring for a missing file, `test_wasm_fs_watch_config_file_end_to_end` as the guard) and b7 §2.4 / R1 missing 8 (`watch_config_file` falls back to the raw path): all present in 3.2/4.1/6; unchanged.
- b7 §3.4, §3.11, §8 R1-1..3, R2-4 (`client` edges owned here: TLS block re-gate, `From<WebsocketError>` kept, `authenticate_as_admin` gated, `EstablishConnectionError::other` stubs, `sign_in_supported()`): unchanged in 3.8/4.6/5; b7 consumes them as written.
- b7 §7 item 3 (`inventory` constructors): b7 §3.27 inlines `inventory::iter::<db::DomainMigration>().next().is_some()`; `db::registered_migration_count()` stays available and 3.4 notes either form satisfies the assertion.
- b7 §3.10 / item 5 here (`fs::JobInfo.start` becomes `web_time::Instant` on wasm): unchanged; b7 owns the `activity_indicator` swap.
- b7:398 ("b6 §7 item 7 swaps `next_reconnection`'s type"): that is item 5 here, which records that no crate reads the field, so no consumer change is needed. b7:1180 cites "b6 §7 item 10" for the `getrandom` feature — item 9 here. Numbering notes only.
- b7 §3.32 (staged `check_wasm` list): section 6's CI paragraph cites it as the same generator function; no conflict.
- b7 R2-18 (`/home/web` vs `/home/zed`): superseded by D11; applied.
- b5 §2 (`scratch` path patch is not a member; `-p` on it panics) and b5 §7 item 9 (fallback vendoring "listed in `[workspace.members]`"): the first is now the evidence in section 2 and 3.1; the second is superseded by D10's path-`[patch]` form, so 3.1 excludes rather than lists the vendored crate (a members entry would run alacritty's tests and clippy under our config). b5 item 5's `cargo shear`/`check_cargo_lock` note applied to 3.1's lockfile change.
- b1 §3.18 (`vendor/yawc` fallback): shares the `vendor/` directory, the `exclude` list and the README of D10; 3.1 says whichever brief lands first creates the README and the `exclude` key.
- b9 §4 item 6 (the shell calls `flush_client_state()` on `pagehide`/`visibilitychange` hidden): matches D7 (iii); the old `b9:624` reference is gone.

Not changed on purpose: the `sqlite-wasm-rs` decision and its fallback (item 1), the sqlez/`wasm_lock` design (3.3, 4.3, 4.4), the terminal gate set (3.6), the client gates (3.8), the `prompt_store` backend (3.5), the `clock` swap (3.9) and every review-log entry (sections 8 entries superseded by a decision carry a pointer to this section rather than being rewritten).

### Contract pass (2026-09-02)

Cross-brief mismatch found by the CONTRACTS.md audit and fixed here:

- Section 6 (CI) and the §2 `run_tests.yml` row: the `check_wasm` layer list is `script/check-wasm`'s `default_packages` array (b5 item 3/16; b7 §3.32 appends there too), not the `-p` list in `tooling/xtask/.../run_tests.rs` `cargo_check_wasm()`, which b5 item 16 leaves argument-free. The crate set (`sqlez db prompt_store clock fs terminal acp_thread client`) is unchanged; only where it is written moved.
