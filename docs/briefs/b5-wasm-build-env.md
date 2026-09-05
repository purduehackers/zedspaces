# b5-wasm-build-env: Browser build environment and the four shims

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` section 3.2 (line 86: build environment, the four shim decisions table, per-crate work list and ordering), 3.3 (145: tree-sitter in the browser), 3.5 (166: bundle flags), 11.2 (453: builds), 11.3 (461: rebase cadence), 15 (525: risks 1 and 4). Fork under modification: `/Users/ray/Projects/play/wed/zed` (branch `zs`, upstream `c3cf80c`). All paths below are relative to that checkout unless stated otherwise; registry and git checkouts are cited under `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/` and `~/.cargo/git/checkouts/`. The community fork at `/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad/zed-web` is cited as `fork:` and is evidence only; none of its RPC design is carried over. Per D10 (`/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md`) the two modified third-party crates this brief carries, `lsp-types` and `agent-client-protocol`, are vendored under `vendor/<name>` as path `[patch]` entries until a GitHub fork exists, with `vendor/README.md` recording the upstream revision and the intended git-patch form; no GitHub-organisation placeholder appears anywhere below. Section 9 is the reconciliation log against D1-D20 and the sibling briefs.

Sibling briefs: b1 (WebSocket transport), b2 (`serve` mode), b3 (terminals), b4 (proto additions), b6 (leaf gates: `fs`, `sqlez`/`db`, `terminal`, `client`), b7 (edge gates and the `zed_web` entry crate, bundle and boot), b8 (supervisor and image), b9 (control plane). This brief is the foundation the per-crate gating work (fs, client, project, workspace, language/tree-sitter linker, `zed_web` entry crate) builds on; the coordination points are called out in sections 3 and 7, and the contract items other briefs consume are listed at the end of section 9.

## 1. Goal

Make `cargo check --target wasm32-unknown-unknown` a one-command, repeatable operation on this checkout, driven entirely by `.cargo/config.toml` plus one script, without changing what native builds see. Land the four shim decisions from BUILD-SPEC 3.2 as upstream-shaped edits: a `[patch.crates-io]` replacement for `smol` that is byte-for-byte smol on native targets and stubs on wasm, a runtime-`PathStyle` file-URL helper in `util` plus a vendored `lsp-types` (`vendor/lsp-types`, a path `[patch]` for the git source at `Cargo.toml:680`, D10) with the wasm `Uri` gap closed, a vendored `agent-client-protocol` (`vendor/agent-client-protocol`, a `[patch.crates-io]` path entry, D10) with its process and stdio transports gated, and target-conditional tree-sitter `wasm` feature declarations so wasmtime and cranelift drop out of the browser closure. Every change is sized to the usage actually present in the tree (enumerated in section 2), not to the fork's larger surface: the wasm side of the smol shim exports only what a browser-set crate references.

## 2. Existing code that matters

Build configuration and CI

- `.cargo/config.toml:1-3` — `[build] rustflags = ["-C", "symbol-mangling-version=v0", "--cfg", "tokio_unstable"]`. Cargo ignores `[build].rustflags` for any target that has its own `target.<triple>.rustflags` (precedence: `CARGO_ENCODED_RUSTFLAGS` > `RUSTFLAGS` > `CARGO_TARGET_<triple>_RUSTFLAGS` > all matching `target.*.rustflags` concatenated > `build.rustflags`), so the two flags must be repeated in the wasm table; upstream already accepts this for Windows at `:11-17`.
- `.cargo/config.toml:19-21` — the aarch64 Linux block; the new wasm block goes after it. `:23-24` — `[env] MACOSX_DEPLOYMENT_TARGET`, the only `[env]` entry today; the C toolchain entries join it.
- `.cargo/ci-config.toml:10-12` — CI adds `[target.'cfg(all())'] rustflags = ["-D", "warnings"]` (copied to `./../.cargo/config.toml` by `steps::setup_cargo_config`, e.g. `.github/workflows/run_tests.yml:239`); `target.*` tables are cumulative, so it concatenates with our wasm table. Today the wasm job never sees it: `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS`, set by `check_wasm`, outranks every `target.*` table and replaces the `cfg(all())` one too. `-D warnings` first applies to a wasm check when item 16 removes that env var.
- `rust-toolchain.toml:2-9` — pinned stable `1.97.1` with `rust-src` and the `wasm32-unknown-unknown` target already installed; `-Zbuild-std` works on this toolchain with `RUSTC_BOOTSTRAP=1`.
- `tooling/xtask/src/tasks/workflows/run_tests.rs:493-525` — upstream's `check_wasm` job: `cargo -Zbuild-std=std,panic_abort check --target wasm32-unknown-unknown -p gpui_platform -p cloud_api_client` (`:500-504`), with `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS=-C target-feature=+atomics,+bulk-memory,+mutable-globals` (`:505-508`) and `RUSTC_BOOTSTRAP=1` (`:509`); `:517` `setup_cargo_config` installs `ci-config.toml`. It installs a nightly (`:494-498`) but runs plain `cargo`, i.e. the pinned stable with bootstrap — the same trick this brief adopts. The env var there replaces any `target.wasm32-unknown-unknown.rustflags` from config, which is why our script must never set it. `check_cargo_lock` (`:461-463`, used at `:487`) runs `cargo update --locked --workspace`.
- `tooling/xtask/src/tasks/web_examples.rs:65-83` and `:103-117` — upstream's gpui web-example build: `cargo build --target wasm32-unknown-unknown -p gpui --example …` with `RUSTC_BOOTSTRAP=1` and **no `-Zbuild-std`** (it links the prebuilt, non-atomics std), then `wasm-bindgen --target web --no-typescript`. Once a `[target.wasm32-unknown-unknown] rustflags` table exists in the root config, that build inherits `+atomics` and `--shared-memory`, and rust-lld refuses a shared-memory link that contains non-atomics objects (`'atomics' feature must be used in order to use shared memory`) — item 17. `crates/gpui_web/examples/hello_web/Cargo.toml:1` is `[workspace]`, so hello_web is its own workspace and unaffected.
- `crates/gpui_web/examples/hello_web/.cargo/config.toml:1-14` — upstream's only wasm rustflags in-tree: `+atomics,+bulk-memory,+mutable-globals`, `--shared-memory`, `--max-memory=1073741824`, `--import-memory`, the four TLS exports (`__wasm_init_tls`, `__tls_size`, `__tls_align`, `__tls_base`), and `[unstable] build-std`. Our block is this plus `--initial-memory`, the 4 GiB maximum from BUILD-SPEC 3.5, and the getrandom cfg. The fork additionally exported `__heap_base`, `__stack_pointer` and `__wasm_call_ctors` (`fork:web/build.sh:45`): `__wasm_call_ctors` because the fork calls the `inventory`/`ctor` static initialisers by hand after wasm-bindgen's thread transform (`fork:crates/zed_web_workspace/src/main.rs:2104-2121`, `fork:web/scripts/patch-wasm-bindgen-memory.sh:36-45`). None of the three affects `cargo check`; `gpui_web`'s `wasm_thread` bootstrap passes only `wasm_bindgen::module()`/`memory()` to workers (`wasm_thread-586cb4b723c583fe/0cf96c7/src/wasm32/mod.rs:337-338`). Whether the bundle needs them is b7's call: b7 §3.16 appends exactly one line to this block, `"-C", "link-arg=--export=__wasm_call_ctors"` (so its loader can run static constructors, b7 §3.30), and leaves `__heap_base`/`__stack_pointer` out unless its wasm-bindgen memory patch needs them. This block deliberately matches hello_web; b7's line is owned by b7 and must not be dropped when this block is edited.
- `crates/gpui_web/examples/hello_web/rust-toolchain.toml:1-4` — unpinned `nightly`; we do not adopt it.
- `script/download-wasi-sdk:4-5,44-56` — downloads wasi-sdk 25 into `./target/wasi-sdk` relative to the cwd (must be run from the repo root); `bin/clang` and `share/wasi-sysroot` are what the C toolchain entries point at. `:34-36` maps `mingw*|msys*|cygwin*` to a Windows tarball. No checksum, and it re-downloads (~100 MB) whenever `target/wasi-sdk` is absent, so CI must cache that directory.
- `fork:web/build.sh:44-51` — evidence for the C environment that produced a working browser build: `RUSTFLAGS` with `--cfg getrandom_backend="wasm_js"`, `--initial-memory=134217728 --max-memory=4294967296`, and `CC_wasm32_unknown_unknown=$wasi_sdk/bin/clang`, `CFLAGS_wasm32_unknown_unknown="-isystem $wasi_sdk/share/wasi-sysroot/include/wasm32-wasi"`. `fork:.cargo/config.toml:23-24` — the getrandom cfg in a `[target.wasm32-unknown-unknown]` table.
- `cc-1.4.3/src/lib.rs:3699-3712` (`Cargo.lock:2873-2874` pins cc 1.4.3) — for `wasm32` targets `cc` does not use the host `ar`: it asks the configured compiler for its search dirs and looks for `llvm-ar` there, and only if the compiler was detected as clang-like (`tool.rs:140-163`, via `__clang__` in a preprocessor probe). Through a wrapper script both steps depend on the wrapper forwarding `-print-search-dirs`, so the `AR_wasm32_unknown_unknown` pin is required, not optional.

getrandom, time, chrono, web-time

- `Cargo.lock:7024-7052` — three getrandom versions: 0.2.16, 0.3.4, 0.4.1. `getrandom-0.3.4/src/backends.rs:188-200` selects the `wasm_js` backend for `wasm32-unknown-unknown` from the `wasm_js` feature alone; `:34-41` is the alternative `--cfg getrandom_backend="wasm_js"` route (mandatory only in getrandom 0.3.0-0.3.3); in 0.3.4 **both** routes still require the `wasm_js` feature (`:36-44` and `:194-199` `compile_error!` without it), so the cfg alone never suffices and the feature alone always does. That is why upstream's `check_wasm` passes with no cfg at all, and why b6 §2 hit the `compile_error!` on a bare `cargo check -p sqlez --target wasm32-unknown-unknown` (no gpui in that graph) despite this brief's cfg — b6 mirrors gpui's two feature lines in `sqlez`'s wasm table, and b7 §5 repeats them in `zed_web`. `getrandom-0.4.1/src/backends.rs:170-181` needs only the feature; `getrandom-0.2.16/src/lib.rs:338-346` needs the `js` feature or it `compile_error!`s.
- `crates/gpui/Cargo.toml:112-114` — `[target.'cfg(target_family = "wasm")'.dependencies] getrandom = { version = "0.3.4", features = ["wasm_js"] }` and `uuid = { workspace = true, features = ["js"] }`; with resolver 2 (`Cargo.toml:2`) these features unify across the wasm graph. The cfg line in item 2 is therefore parity with the fork, not load-bearing.
- getrandom 0.2.16 **is** in the browser closure and already compiles there. `cargo tree --target wasm32-unknown-unknown -p gpui_platform -i getrandom@0.2.16` → `fastrand 2.3.0` ← `flume` ← `scheduler` ← gpui (and `futures-lite 2.6.1` ← `futures-concurrency`); from `-p language` also `fastrand` ← `async-executor` ← `smol`. It compiles because fastrand's target-table dependency turns on getrandom's `js` feature (`fastrand-2.3.0/Cargo.toml:79-82`; `cargo tree --target wasm32-unknown-unknown -p language -e features -i getrandom@0.2.16 | grep -c 'getrandom feature "js"'` = 3). Nothing in Zed sets that feature. Natively, `cargo tree -i getrandom@0.2.16 -e normal --depth 4` → `rand_core 0.6.4` ← `rand 0.8.6` ← `ipc-channel` (cli), `nanoid` (livekit_client), `num-bigint-dig` (rsa), `yawc` (cloud_api_client); and `ring 0.17.14` ← `rustls 0.23.40` ← `http_client_tls` ← `client`, `ring` ← `aws-config` ← `language_models` ← `agent`, `agent_ui`. So `client`, `agent` and `agent_ui` will pull `ring` (which needs `getrandom 0.2` with `js`, already unified) until TLS and aws-config are gated by their briefs; `ring`'s own C/asm is the actual wasm blocker there, not getrandom.
- getrandom 0.4.1: `cargo tree -i getrandom@0.4.1 -e normal --depth 3` → `rand 0.10.2` ← `wasmtime-wasi 48.0.1` ← `extension_host` only (`cargo tree -i wasmtime-wasi --depth 1`). tree-sitter's `wasm` feature pulls `wasmtime-c-api-impl`, not `wasmtime-wasi`, so gating that feature does not remove getrandom 0.4.1; dropping `extension_host`'s edge (`crates/extension_host/Cargo.toml:55-56`, another brief) does.
- `Cargo.toml:831-838` — workspace `time = { version = "0.3", features = ["macros", "parsing", "serde", "serde-well-known", "formatting", "local-offset"] }`; no `wasm-bindgen`. `time-0.3.47/src/offset_date_time.rs:104-115`, `utc_date_time.rs:118-129`, `sys/local_offset_at/mod.rs:12-14` — `now_utc()` and `current_local_offset()` use `js_sys::Date` only under `feature = "wasm-bindgen"`; otherwise they fall back to `SystemTime::now()`, which panics on wasm32-unknown-unknown. `time-0.3.47/Cargo.toml:107` — `wasm-bindgen = ["dep:js-sys"]`.
- `crates/time_format/Cargo.toml:15-17` — the lowest browser-set crate depending on `time` (`sys-locale`, `time`); `crates/git_ui/src/blame_ui.rs:317,345`, `commit_view.rs:715-716`, `stash_picker.rs:256,278` call `OffsetDateTime::now_utc()` and `UtcOffset::current_local_offset()`. `sys-locale-0.3.2/src/lib.rs:29-39` — the wasm provider exists only under its `js` feature; without it `get_locale()` returns `None` (compiles).
- `Cargo.toml:575` — `chrono = { version = "0.4", features = ["serde"] }`, default features on, so chrono's `wasmbind` default is already active.
- `Cargo.toml:902` — `web-time = "1.1.0"`; `crates/scheduler/src/clock.rs:5` `pub use web_time::Instant;`; `crates/gpui/Cargo.toml:108`, `crates/scheduler/Cargo.toml:36`, `crates/ui/Cargo.toml`, `crates/gpui_web/Cargo.toml:31` already use it. `web_time::Instant` is a re-export of `std::time::Instant` on native, so swapping is a no-op there. Files importing `std::time::Instant` (`grep -rlE 'std::time::\{?[^}]*Instant|use std::time::Instant' crates/*/src --include='*.rs' | awk -F/ '{print $2}' | sort | uniq -c`), browser-set crates only: agent_ui 3, tabular_data_preview 3, project 2, workspace 2, util 2, terminal_view 2, rpc 2 (`peer.rs:27,78,463`, `message_stream.rs:8,84-86` — the heartbeat/ack path b1 relies on), and one each in acp_thread, agent, client, edit_prediction, editor, extension, fs, multi_buffer, proto, recent_projects, remote, repl, search, sidebar, theme, zlog; vim has none. Fully-qualified uses without a `use` are not counted. Those swaps belong to the per-crate briefs (BUILD-SPEC 3.2 "Instant swaps"); section 7 item 17 proposes the clippy rule that locks them in afterwards.
- `Cargo.toml:898-899` — `wasm-bindgen = "0.2.120"`, `wasm-bindgen-futures = "0.4"`; `Cargo.lock:20054-20055` pins wasm-bindgen 0.2.120, so `wasm-bindgen-cli` must be exactly 0.2.120 (the fork pinned 0.2.127 against its own lock, `fork:web/build.sh:14,60-66`).

smol and the async stack

- `Cargo.toml:818` — `smol = "2.0"`; `Cargo.lock:16940-16941` smol 2.0.2. `smol-2.0.2/src/lib.rs:49-65` — the whole crate is a facade: `pub use async_executor::{Executor, LocalExecutor, Task}; async_io::{block_on, Async, Timer}; blocking::{unblock, Unblock}; futures_lite::{future, io, pin, prelude, ready, stream}`, `async_channel as channel, async_fs as fs, async_lock as lock, async_net as net`, `async_process as process`, and `mod spawn; pub use spawn::spawn` (`src/spawn.rs:33-64`, a global `Executor` on one thread plus `async_process::driver()`). `smol-2.0.2/Cargo.toml:129-151` — its requirements: async-channel 2, async-executor 1.5, async-fs 2, async-io 2.1, async-lock 3, async-net 2, blocking 1.3, futures-lite **2**.
- `async-executor-1.13.3/src/lib.rs:62` — `pub use async_task::{FallibleTask, Task};` so `smol::Task<T>` is `async_task::Task<T>`; `Cargo.toml:982` patches every `async-task` to one git revision, so the shim's `async_task::spawn` produces the identical type.
- `polling-3.11.0/src/lib.rs:118` — `compile_error!("polling does not support this target OS")`: the reason `smol → async-io → polling` cannot compile on wasm. `cargo tree --target wasm32-unknown-unknown --workspace -i polling --depth 1` → `async-io`, `alacritty_terminal` (direct, unconditional — the terminal brief's vendoring must drop that edge; the shim does not help it) and `minidumper` (native).
- `Cargo.toml:627` — workspace `futures-lite = "1.13"`; `Cargo.lock:6874-6890` has both 1.13.0 and 2.6.1. The shim must depend on futures-lite 2 explicitly or `smol::io` types would differ from real smol's.
- `Cargo.toml:534,538-540,543,547` — workspace `async-channel 2.5.0`, `async-fs 2.1`, `async-io 2.6.0`, `async-lock 3.4.2`, `async-process 2.5.0` (patched to zed's fork at `:981`), `async-task 4.7`. `async-executor`, `async-net`, `blocking` are not workspace dependencies (lock: 1.13.3, 2.0.0, 1.6.2).
- Direct `async-fs` users bypass the shim: `cargo tree -i async-fs -e normal --depth 1` → `http_client` (gated, `crates/http_client/Cargo.toml:41-43`), `languages` (**unconditional**, `crates/languages/Cargo.toml:24`; `python.rs:518` `async_fs::create_dir_all`, `:1227` `async_fs::File::open`), `smol`, `util` (gated, `crates/util/Cargo.toml:49-54`). `async-fs 2.2.0 → blocking 1.6.2` compiles on wasm (no async-io in that chain), but `blocking::grow_pool` (`blocking-1.6.2/src/lib.rs:326-345`) swallows the thread-spawn failure and leaves the task queued forever, so a direct `async_fs::*` call in the browser hangs instead of erroring. Languages brief: gate it like util does.
- `async-std`/`async-tar` are in the closure but not a compile break: `cargo tree --target wasm32-unknown-unknown --workspace -i async-std --depth 1` → `async-tar` (zed-industries fork; used by dap, dev_container, extension_host, fs, languages, node_runtime), `runtimelib`, `zeromq`. async-std has its own `target_os = "unknown"` split (gloo-timers/wasm-bindgen-futures instead of async-io); `http_client`'s gated `async-tar` already passes upstream's wasm check.
- `runtimelib` (`Cargo.toml:789-791`, features `async-dispatcher-runtime` + `aws-lc-rs`) → `zeromq 0.5.0` (`tcp-transport`, async-std sockets) and `aws-lc-rs` → `aws-lc-sys` (C/asm): neither compiles for wasm32-unknown-unknown. `repl` is in the browser set (BUILD-SPEC 3.1) but the smol facade does nothing for it; its brief must gate `runtimelib`. `rustls 0.23.40`/`rustls-webpki` also reach `aws-lc-rs` and `ring` (client/http_client_tls).
- `cargo tree -i smol -e normal --depth 1` — 23 dependents: askpass, auto_update, auto_update_ui, client, collab_ui, dap, dap_adapters, debugger_tools, fs, git, install_cli, languages, miniprofiler_ui, net, node_runtime, openai_subscribed, project, remote, repl, runtimelib (third-party, via repl), search, util, zed. All declare `smol.workspace = true` unconditionally except `util`.
- `crates/util/Cargo.toml:49-54` — `[target.'cfg(not(target_family = "wasm"))'.dependencies] smol, which, async-fs, walkdir, dirs` and `crates/util/src/util.rs:4-17` — `archive`, `command`, `fs`, `process`, `shell`, `shell_builder`, `shell_env` are already `#[cfg(not(target_family = "wasm"))]`. All 29 `smol::block_on` occurrences in util (`archive.rs`, `command/darwin.rs`) are in those gated modules; `command/darwin.rs:6` `use smol::Async` likewise.
- Per-crate `smol::` usage in every direct dependent (grep of `crates/<crate>/src`, brace imports expanded; T = test-only):
  - askpass (excluded from the browser set): `process::Command` 1, `lock::Mutex` 1, `fs::write` 2 (`askpass.rs:24,353,368`).
  - auto_update (excluded): `fs::{remove_dir 3, metadata 3, rename, remove_file, remove_dir_all, read_dir, File::create 2, create_dir_all, create_dir}`, `io::copy` 1. auto_update_ui (excluded): `io::AsyncReadExt` 1.
  - client: `future::yield_now` 1.
  - collab_ui (excluded): `fs::write` 1. install_cli (excluded): `process::Command::new`, `fs::unix::symlink`, `fs::remove_file`, `fs::read_link`. dap_adapters (depends only on `zed`, replaced by `zed_web`): `fs::File`, `io::AsyncReadExt`, `lock::OnceCell` (`python.rs:13-15`). miniprofiler_ui (not in the browser set): `fs::write` 1. zed (replaced by `zed_web`): `fs::{read_dir 2, read 2, create_dir_all 2, remove_file}`, `stream::StreamExt`, `future::poll_once`.
  - dap: `lock::Mutex` 2; `transport.rs:14-18` `channel::{Receiver, Sender, unbounded}`, `io::{AsyncBufReadExt, AsyncWriteExt, BufReader}`, `net::{TcpListener, TcpStream}` (`:493-495` `TcpListener::bind(SocketAddr).await?.local_addr()?`); `adapters.rs:16,321-323` `fs::File::{create, open}` with `futures::io::copy` into the file.
  - debugger_tools: `future::yield_now` 2.
  - fs: `unblock` 4 (`fs.rs:884,928,945,3542`, all inside `RealFs`/Windows-only code), `fs::{metadata 3, rename 2, OpenOptions 2 (`:721-732` `new/write/create/truncate/create_new/open`), File 2 (`:740,979` `File::create` + `BufWriter` + `flush`), symlink_metadata, remove_file, remove_dir_all, remove_dir, create_dir_all, copy}`, `fs::unix::symlink` (`:696`, `#[cfg(unix)]`), `fs::windows::symlink_file` (`:714`, `#[cfg(windows)]`), `fs::windows::OpenOptionsExt` (`:3525`, Windows-only cfg), `channel::Sender` 2, `io::{BufWriter, AsyncWriteExt, AsyncReadExt}`.
  - git: `fs::write` 28, `fs::read_to_string` 8, `fs::remove_file` 5, `fs::{symlink_metadata, read_link, metadata, copy}` 1 each, `io::AsyncBufRead` 3, `io` 2, `spawn` 1 (`repository.rs:3809`, `untracked_files_for_checkpoint`, `RealGitRepository`-only), `future::yield_now` 1, `channel::{unbounded, bounded}`.
  - languages: `use smol::fs` in `c.rs:11`, `go.rs:18`, `rust.rs:19`, `eslint.rs:17` (`fs, stream::StreamExt`), `json.rs:19-22` (`fs, io::BufReader`); calls: `fs::read_dir` (`c.rs:391`, `eslint.rs:128,582`, `json.rs:561`, `go.rs:552`, `rust.rs:166,1408`) with `entry.path()`, `entry.file_name()`, `entry.file_type().await` (`c.rs:394`, `go.rs:555`), `fs::metadata` (`eslint.rs:116,169,575,578`, `json.rs:509`, `go.rs:140`, `rust.rs:244`), `fs::rename`, `fs::remove_file`, `fs::create_dir_all`, `fs::copy`; `lock::{RwLock, OnceCell}`; `block_on` 1 (`rust.rs:2310`, T).
  - net: `crates/net/src/async_net.rs:1-2` `pub use smol::net::unix::{UnixListener, UnixStream}` (`cfg(not(target_os = "windows"))`, so compiled on wasm), `:16-19` `smol::{Async, io::{AsyncRead, AsyncWrite}}` (Windows-only); `net.rs:73,79` `block_on`/`spawn` (T). `net.rs:16` also re-exports `std::os::unix::net`, which does not exist on wasm (net brief). `net` is in the browser closure through `crates/context_server/src/listener.rs:13`.
  - node_runtime: `fs::metadata` 2 (`node_runtime.rs:815,819`), `io::BufReader`, `lock::Mutex` (`:10-11`).
  - openai_subscribed: `io::AsyncReadExt` 5.
  - project: `future::yield_now` 4, `channel::{Receiver 4, Sender 2}`, `process::Command` (`terminals.rs:521,573`: `Task<Result<smol::process::Command>>` and `smol::process::Command::from(std::process::Command)`, consumed by `crates/vim/src/command.rs:2547-2562` which calls `.stdout/.stderr/.stdin(Stdio::…)`; b3 §3.6 adds a `#[cfg(target_family = "wasm")]` early return in `exec_in_shell` for remote PTYs, and the shim's `process::Command` type keeps that signature and vim's builder calls compiling either way — no signature change from this brief), `process::Stdio` (`debugger/locators/cargo.rs:6`, a file that also uses `util::command::new_command`, which is gated out on wasm — project brief), `fs::{write 2, create_dir_all 2, rename, read_dir, metadata}`, `net::{TcpListener, TcpStream}` (`debugger/session.rs:48,3060,3168`: `TcpStream::connect(&addr).await`, `TcpListener::bind("127.0.0.1:0")`), `future::race` 1, `stream::StreamExt` 1, `unblock` 1 (`tests/integration/project_tests.rs:121`, T).
  - remote: `future::or` 2, `fs::{metadata 2, remove_file, canonicalize}`, `io::{BufReader, AsyncBufReadExt}`, `transport/wsl.rs:14-17` `smol::{fs, io::{self, AsyncWriteExt}}`, `transport/ssh.rs:21` `use smol::fs`.
  - repl: `net::TcpListener` (`kernels/wsl_kernel.rs:18`, `kernels/native_kernel.rs:14`), `net::TcpStream::connect` (`kernels/ssh_kernel.rs:154`), `io::AsyncReadExt` (`kernels/remote_kernels.rs:10`). runtimelib: `process::Command` only (`runtimelib-1.4.0/src/dirs.rs:11`, `kernelspec.rs:14`).
  - search: `future::yield_now` 4.
  - Nobody in `crates/` uses `smol::Timer` at all (`clippy.toml:15` bans `smol::Timer::after` workspace-wide in favour of `gpui::BackgroundExecutor::timer`), and nobody in the browser closure uses `smol::Executor`, `smol::LocalExecutor`, `smol::Unblock`, `smol::Async` (outside Windows/macOS-only code), `smol::unblock` (outside `RealFs`) or `smol::block_on` outside tests (`net.rs:73` `#[cfg(test)]`, `languages/rust.rs:2310` test, `sandbox` native helper). The only `smol::spawn` a browser-set crate compiles is `git/src/repository.rs:3809`. `crates/agent/src/tools/evals/*.rs:396,454,658` use `async_io::Timer` from a `[dev-dependencies]` entry (`crates/agent/Cargo.toml:87-89`): tests/evals only, in no wasm check closure. `crates/net/Cargo.toml:18-19` declares `async-io` for Windows only.
- `fork:crates/smol_wasm/Cargo.toml:15-31` and `src/lib.rs:8-35` — the fork's patch keeps `channel`, `lock`, `future`, `io`, `stream` shared and gates `fs`, `net`, `process`, `Timer`, `Async`, `Unblock`, `block_on`, `unblock` behind `target_family = "wasm"`; it implements smol's `spawn` for native by copying smol's `spawn.rs` (`fork:src/spawn.rs:6-48`). The crate is 1,760 lines (native and wasm sides together) and wrong in two places we must not copy: `Timer` never fires (`lib.rs:45-81`), `spawn` drops the future (`spawn.rs:50-58`), and `process.rs:115` routes `Command::spawn` over its RPC.
- `crates/gpui_web/src/dispatcher.rs:184-205` — background workers run `loop { receiver.pop() … runnable.run() }` and never return to their worker's JS event loop; `:271-286` `dispatch_after` uses `setTimeout` on the main thread and otherwise posts `MainThreadItem::Delayed` to the main-thread mailbox; `:331` `fn browser_window()`. Consequence: a `setTimeout` issued from a background worker never fires, so anything that must run from a gpui_web worker has to go through gpui's executor, not through a smol-level fallback.
- `crates/gpui/src/executor.rs:444-447` `BackgroundExecutor::block_on` and `crates/scheduler/src/executor.rs:109-110` `ForegroundExecutor::block_on` are `#[cfg(not(target_family = "wasm"))]`. Browser-set callers that therefore do not compile on wasm: `crates/settings/src/settings_store.rs:372,376`, `crates/agent_ui/src/language_model_selector.rs:336`, `profile_selector.rs:464`, `completion_provider.rs:2387,2396`, `crates/project_symbols/src/project_symbols.rs:69,78`, `crates/tabular_data_preview/src/renderer/table_header.rs:209`. `settings` is a dependency of `language` (`crates/language/Cargo.toml:59`), so it is the first expected failure of `script/check-wasm -p language` (test 7).
- `fastrand-2.3.0/src/global_rng.rs:189-201` — `Instant::now()` seeding is compiled only for non-wasm targets; on `wasm32-unknown-unknown` `random_seed()` reads getrandom under `feature = "js"` (`:203-213`) or returns `None` (`:215-226`) and the generator starts from `DEFAULT_RNG_SEED` (`:10,:31`). With `js` on in our graph (above), nothing panics either way.
- `clippy.toml:8-19` `disallowed-methods` (denied via `Cargo.toml:1107` `disallowed_methods = "deny"`): `std::process::Command::{spawn,output,status,stdin,stdout,stderr}` and `smol::Timer::after`. `script/clippy:5-10` runs `cargo clippy --workspace --release --all-targets --all-features -- --deny warnings` on the host target only, so wasm-only modules are never linted by it, but the shim's native test module is.

url, lsp-types, call sites

- `url-2.5.7/src/lib.rs:2542-2553` and `:2715-2733` — `Url::from_file_path` and `Url::to_file_path` are compiled only for `any(unix, windows, target_os = "redox", target_os = "wasi", target_os = "hermit")`; wasm32-unknown-unknown is none of these. `:2948-2977` — the Unix `path_to_file_url_segments`: require absolute, skip the root, percent-encode every `components()` entry with `SPECIAL_PATH_SEGMENT` and write the serialization directly (no re-parse, so a `..` component stays raw). `:2726-2733` `to_file_path`: host must be `None` or `localhost` (any host on Windows for `file`); there is **no scheme check**. `:2996-3055` the Windows arm: `Disk`/`VerbatimDisk` → `/X:`, `UNC`/`VerbatimUNC` → host + `/share`, any other prefix → `Err(())`, then every non-root component percent-encoded with `PATH_SEGMENT` (`..` also raw). `src/parser.rs:20,23,38,42` — `FRAGMENT = CONTROLS + ' " < > \``, `PATH = FRAGMENT + # ? { }`, `PATH_SEGMENT = PATH + / %`, `SPECIAL_PATH_SEGMENT = PATH_SEGMENT + \`. `url-2.5.7/src/path_segments.rs:236-247` — `PathSegmentsMut::extend` silently drops `.` and `..`, and `Url::parse`/`set_path` resolve them, so a `Url` with a raw `..` segment cannot be built through the public API.
- `crates/util/src/paths.rs:20` — `pub use path::PathStyle;`; `:1322-1327` `pub trait UrlExt { fn to_file_path_ext(&self, path_style: PathStyle) -> Result<PathBuf, ()>; }`; `:1329-1467` the implementation, a runtime-`PathStyle` copy of `Url::to_file_path` (already pure and wasm-clean; `file_url_segments_to_pathbuf_posix` at `:1359-1391` requires `host == None`, no scheme check); `:1469` `#[cfg(test)] mod tests`, with `test_url_to_file_path_ext_*` at `:3084-3290`. `crates/util/Cargo.toml:43-44` — `url` and `percent-encoding` are already dependencies. `crates/path/src/path.rs:30-44` — `PathStyle::{Unix, Windows}` and `const fn local()` (Windows only on `target_os = "windows"`, so `local()` is `Unix` on wasm); `:81` `is_windows()`.
- `Cargo.toml:680` — `lsp-types = { git = "https://github.com/zed-industries/lsp-types", rev = "f1783e63a7f4eb4397bf51d4148b4895a1f7ab16" }` (`:678` is `log`); only `crates/lsp/Cargo.toml:28` depends on it; `crates/lsp/src/lsp.rs:3-4` re-exports `lsp_types::*`, so `lsp::Uri` is `lsp_types::Uri`.
- `lsp-types-da1727dff60dd2b5/f1783e6/`: a single crate (no workspace, no dev-dependencies, no `[lints]` table — `Cargo.toml:16-20` deps: bitflags 1, serde, serde_json, `url` at `:20`; `version = "0.95.1"`, `edition = "2018"`, `license = "MIT"`). Checkout contents: `Cargo.toml`, `src/`, `tests/` (`lsif.rs` + `tsc-unix.lsif` fixture, integration tests needing only the normal dependencies), `LICENSE`, `README.md`, `CHANGELOG.md`, `release.sh`, `release.toml`, `.clog.toml`, `.github/`, `.gitignore`. This checkout is what `vendor/lsp-types` is copied from (D10, item 7). `src/uri.rs:7` `pub struct Uri(url::Url);`, `:61-78` `impl Uri { pub fn from_file_path<P: AsRef<Path>>(path: P) -> Result<Self, ()> { url::Url::from_file_path(path).map(Self) } }`, `:80` `impl Deref for Uri { type Target = url::Url }` (which is how `uri.to_file_path()` resolves today), `:109-459` `#[cfg(test)] mod tests`, with `test_from_file_path*` at `:348-407`. `src/lib.rs:33-34` `mod uri; pub use uri::Uri;`.
- `fork:crates/lsp_types_wasm/src/uri.rs:82-103` — the fork's gate: `from_file_path` calls its patched `url`, and a wasm-only inherent `to_file_path` returns `PathBuf::from(self.0.path())` without percent-decoding (a bug we do not repeat). `fork:crates/url_wasm/` — the fork vendored `url` (a 3,261-line `lib.rs`, 8,423 lines of Rust in the crate) only to add `target_arch = "wasm32"` to those two cfg lists (`lib.rs:2548-2561,2750-2754`) and implement them as `Url::parse(format!("file://{path}"))` (no encoding) and `PathBuf::from(self.path())`.
- Call sites of `from_file_path`/`to_file_path` in `crates/*/src` (grep hits; BUILD-SPEC's 146 was a line count that includes tests): editor 59 — one live `url::Url::to_file_path` at `hover_popover.rs:1007`, one already-correct `to_file_path_ext(path_style)` at `clangd_ext.rs:86`, and 57 `Uri::from_file_path` in test code: 56 under `#[cfg(test)]` (`editor_tests.rs` 27, `inlays/inlay_hints.rs` 23 after `:1003`, `diagnostics.rs:657`, `document_colors.rs:490,685`, `document_symbols.rs:666`, `runnables.rs:1167,1380`) plus `test/editor_lsp_test_context.rs`, a `#[cfg(any(test, feature = "test-support"))]` module (`editor.rs:59-60`); project 24 (`lsp_store.rs` 12 `Uri::from_file_path` at `:3066,3226,5935,8880,9439,9660,10970,10973,11008,11011,12794,13067` and 10 `uri.to_file_path()` at `:2171,3559,3584,3588,3660,3939,4023,8736,12423,13577`, `lsp_command.rs:68`, `lsp_store/lsp_ext_command.rs:214`; all on `lsp::Uri`), diagnostics 27 (`diagnostics_tests.rs`, T), copilot 15 (`copilot.rs:332,1297` live, `:1603` and all 12 in `copilot_edit_prediction_delegate.rs` after `:230` T), languages 7 (`eslint.rs:234,491`, `json.rs:275` `uri.to_file_path()` on `Uri`; `eslint.rs:261` `Uri::from_file_path`; `python.rs:431` **`url::Url::from_file_path`**; `eslint.rs:1131`, `rust.rs:1496` T), lsp 7 (`lsp.rs:62,801` `to_file_path` and `:444` `from_file_path` on `Uri`; `:1934,1939` inside `#[cfg(any(test, feature = "test-support"))] impl FakeLanguageServer` (`:1846`) — compiled whenever `lsp/test-support` is on, which `language`'s `test-support` enables; `:2428,2440` under `#[cfg(test)] mod tests` at `:2098`), edit_prediction_context 5 (`fake_definition_lsp.rs`, a `#[cfg(test)]` module per `edit_prediction_context.rs:27-28`), terminal 3 (`alacritty/hyperlinks.rs:180` already uses `to_file_path_ext(path_style)`; `:1393,1710` T after `:484`), agent_ui 1 (`message_editor.rs:3520`, T), project_symbols 1 (`:628`, T), call_hierarchy 1 (`:2555`, T), language_tools 1 (`lsp_log_view.rs:321`, not in the browser set), gpui_linux 5 and remote_server 4 (native only). Net: exactly two live `url::Url` sites need an edit; every live `lsp::Uri` site compiles unchanged once the vendored `lsp-types` gains the wasm implementations. `lsp.rs:1934` (`Uri::from_file_path("C:/").unwrap()`) will return `Err` on wasm and panic only if a `FakeLanguageServer` is constructed there, which no browser build does.

agent-client-protocol

- `Cargo.toml:521` — `agent-client-protocol = { version = "=2.0.0", features = ["unstable"] }`; `Cargo.lock:331-332,365-366` 2.0.0 and schema 1.5.0. No Zed crate depends on `agent-client-protocol-schema` or `-derive` directly.
- `agent-client-protocol-2.0.0/Cargo.toml:143-150` (registry-normalised manifest) — unconditional `async-io = "2"`, `async-process = "2"`, `blocking = "1"`; `:213-219` `rustix` (unix) and `:221-223` `windows-sys` (windows) target tables. The source repository is `agentclientprotocol/rust-sdk`, a workspace; the published crate came from commit `ce023279824149008659dd8f4b8b70266a7e8210` (tag `v2.0.0`) at `src/agent-client-protocol` (`.cargo_vcs_info.json`). In that tree the manifest is `src/agent-client-protocol/Cargo.toml` (`Cargo.toml.orig`): `async-io.workspace = true`, `async-process.workspace = true`, `blocking.workspace = true` at `:48-50`, `[target.'cfg(unix)'.dependencies] rustix.workspace = true` at `:52-53`, `[target.'cfg(windows)'.dependencies]` at `:55-56`, `[dev-dependencies] agent-client-protocol-test.workspace = true` at `:58-59`; `agent-client-protocol-derive` is a workspace **path** dependency (root `Cargo.toml:32`), `agent-client-protocol-schema` is crates-io `=1.5.0` (root `:41`). `src/lib.rs:138-142` — `mod acp_agent; pub use acp_agent::{AcpAgent, AcpAgentConfig, LineDirection}; mod stdio; pub use stdio::Stdio;`. `src/acp_agent.rs:13,254-256,276-279,522,553,606,745` — the only `async_process`/`async_io::Timer` users; `src/stdio.rs:52-53` — the only `blocking::Unblock` user. `src/component.rs:52,100` and `src/jsonrpc.rs:904-907,1588-1591,1637` reference them only in doc comments. `examples/simple_agent.rs`, `examples/yolo_one_shot_client.rs` use `Stdio` (native-only targets). `agent-client-protocol-schema-1.5.0/Cargo.toml:79-121` — anyhow, derive_more, diffy, schemars, serde, serde_json, serde_with, strum, tracing: nothing OS-bound. No Zed crate references `AcpAgent`, `AcpAgentConfig`, `LineDirection` or `acp::Stdio` (grep over `crates/`), so gating them has no Zed-side fallout.
- The registry package directory `agent-client-protocol-2.0.0/` is what `vendor/agent-client-protocol` is copied from (D10, item 11): `.cargo_vcs_info.json` (`{"git":{"sha1":"ce023279824149008659dd8f4b8b70266a7e8210"},"path_in_vcs":"src/agent-client-protocol"}`), `.cargo-ok`, `Cargo.toml` (258 lines, registry-normalised), `Cargo.toml.orig`, `Cargo.lock` (the rust-sdk workspace lock), `CHANGELOG.md`, `README.md`, `src/`, `tests/` (16 files: `derive_macros.rs`, `jsonrpc_*.rs` ×9, `match_dispatch.rs`, `meta_propagation.rs`, `protocol_v2.rs`, `schema_elicitation.rs`, `schema_session_delete.rs`, `session_ordering.rs`, matching the 16 `[[test]]` entries at `Cargo.toml:72-134`), `examples/` (`simple_agent.rs`, `yolo_one_shot_client.rs`, `:64-71`). In the normalised manifest `:136-137` `[dependencies.agent-client-protocol-derive] version = "2.0.0"` is a plain crates-io dependency — so vendoring the crate does **not** drag the derive crate along (the git-fork variant would have, because in the source workspace it is a path dependency); `:139-141` `agent-client-protocol-schema = "=1.5.0"`; `:189-211` `[dev-dependencies]` clap 4.5 (`derive`), expect-test 1.5, tokio 1.52 (`io-std, io-util, macros, rt, rt-multi-thread, sync, time`, no defaults), tokio-util 0.7 (`compat`) — all crates-io, no unpublished workspace crate; `:225-258` `[lints.clippy]` (nine `allow`s, `pedantic = warn` at priority -1) and `[lints.rust]` (`let-underscore`, `missing_debug_implementations`, and the groups `future_incompatible`, `nonstandard_style`, `rust_2018_idioms`, `unused`, all `warn`). Those `[lints]` tables matter once the crate is a path package: path-sourced packages are compiled without `--cap-lints allow`, so every warning they raise becomes an error under `ci-config.toml`'s `-D warnings` (item 11 drops the tables; risk 14).
- `fork:crates/agent_client_protocol_patch/Cargo.toml:41-45` and `src/lib.rs:138-145` — the fork's five gates are exactly these (one target table, four `#[cfg(not(target_family = "wasm"))]` attributes).

tree-sitter

- `Cargo.toml:848` — `tree-sitter = { git = "https://github.com/tree-sitter/tree-sitter", rev = "43623ec…" }` (0.27.0); `:976-980` `[patch.crates-io] tree-sitter-language` pinned to the same rev.
- `tree-sitter-a21c02e4b1d6dd0c/43623ec/lib/Cargo.toml:40-54` — `default = ["std"]`, `std = ["regex/std", "regex/perf"]` (`regex` is a plain dependency, not a feature), `wasm = ["std", "wasmtime-c-api"]` with `wasmtime-c-api-impl 48` (features `cranelift`, `gc`, `gc-null`). `lib/binding_rust/lib.rs:42-43` — `wasm_allocator` (C `malloc/calloc/realloc/free` backed by Rust's allocator) is compiled for `wasm32-unknown-unknown` unconditionally; `:460`, `:772-779` — `WasmStore`, `LanguageError::Wasm`, `Parser::set_wasm_store` exist only under `feature = "wasm"`. `lib/binding_rust/build.rs:18-23` — the feature adds `TREE_SITTER_FEATURE_WASM` and wasmtime's headers; `:31-33,61-70` — for any `wasm32-unknown*` target the C runtime is built with `TREE_SITTER_WASM_STDLIB` and the header dir published through `DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS` by the `tree-sitter-language` crate's build script — that is the tree-sitter checkout's `crates/language/build.rs:1-14` (`links = "tree-sitter-language"`, `Cargo.toml:16-17`; emits `cargo::metadata=wasm-headers=<crate>/wasm/include`), **not** Zed's `crates/language/build.rs`, which is a 5-line `ZED_BUNDLE` forwarder. `wasm/include` holds `assert.h ctype.h endian.h inttypes.h stdint.h stdio.h stdlib.h string.h wchar.h wctype.h`; `lib/src/lib.c:15-17` then links `wasm-stdlib/libc.c` and `stdio.c` (vendored wasi-libc `ctype` and `string` subsets, `lib/src/wasm-stdlib/imports.txt` lists the 25 symbols: `calloc free iswalnum iswalpha iswblank iswdigit iswlower iswpunct iswspace iswupper iswxdigit malloc memchr memcmp memcpy memmove memset realloc strcmp strlen strncat strncmp strncpy towlower towupper`). So the runtime compiles for the browser with only a wasm-capable clang; grammar `scanner.c` files still need standard headers, which is what the wasi-sysroot `-isystem` supplies.
- Declarations enabling the `wasm` feature (grep of every `Cargo.toml`): `crates/language/Cargo.toml:76`, `crates/multi_buffer/Cargo.toml:44`, `crates/migrator/Cargo.toml:22`, `crates/edit_prediction_context/Cargo.toml:28`, `crates/languages/Cargo.toml:62` (optional, behind `load-grammars` at `:15-19`) and `:81` (dev-dependency), `crates/settings_json/Cargo.toml:20` (optional, behind `editing` at `:16`), `crates/language_tools/Cargo.toml:35`, `crates/extension_cli/Cargo.toml:37`, plus `crates/grammars/Cargo.toml:60` `test-support = ["load-grammars", "tree-sitter/wasm"]`. `cargo tree -i tree-sitter -e normal --depth 1` lists 11 dependents and no third-party crate (12 with `--workspace`: `extension_cli` is not reachable from the default member): the above plus `edit_prediction_metrics` (`:22`, optional, no feature), `grammars` (`:20`, optional), `language_core` (`:25`), `tasks_ui` (`:26`) — those four never enable `wasm`. Features are not target-conditional once enabled: `grammars/test-support` or `languages`'s dev-dependency re-enable wasmtime in any build that activates them (`--all-features`, `--all-targets`, a `test-support` feature on `zed_web`), see item 12 and risk 15.
- Code that uses the feature: `crates/language/src/language.rs:99` `use tree_sitter::{self, QueryCursor, WasmStore, wasmtime};`, `:134` `static PARSERS`, `:141-147` `with_parser` builds a `Parser` and calls `.set_wasm_store(WasmStore::new(&WASM_ENGINE).unwrap())`, `:168-170` `static WASM_ENGINE: LazyLock<wasmtime::Engine>`; `crates/language/src/language_registry.rs:838-860` the `AvailableGrammar::Unloaded(wasm_path)` branch (`:838` binds `wasm_path` in the pattern, `:840` `let this = self.clone();` inside the body) reads the `.wasm` from disk and calls `parser.take_wasm_store()`/`store.load_language`/`set_wasm_store`. No other crate in the closure touches `WasmStore` or `wasmtime` (grep over multi_buffer, migrator, edit_prediction_context, settings_json, languages). `crates/language_core/src/grammar.rs:41-85` — upstream already has the `#[cfg(target_family = "wasm")]` resolver-based `Grammar` shape the linker brief builds on.
- `crates/extension_host/Cargo.toml:55-56` — the only direct `wasmtime`/`wasmtime-wasi` users besides `extension_cli`; dropping those edges is the dependency-edge work in BUILD-SPEC 3.2, not this brief.

Workspace layout

- `Cargo.toml:1-3` `[workspace] resolver = "2" members = [...]`; `:236-248` the last `crates/*` members (`zlog_settings`, `ztracing`, `ztracing_macro`) before the extensions and tooling sections; `:267` `default-members = ["crates/zed"]`; `:269-271` `[workspace.package] edition = "2024"` (the shim inherits it: edition-2024 `impl Trait` return types capture all in-scope lifetimes unless `use<>` says otherwise).
- `Cargo.toml:976-990` `[patch.crates-io]` (tree-sitter-language, async-process, async-task, windows-capture, calloop, livekit, libwebrtc, notify, notify-types, webrtc-sys) — every modified third-party crate in the tree is a git fork referenced by `git` + `rev` (`:981-989`, `zed-industries/*`). `:992-1001` `scratch = { path = "corgi-patches/scratch" }` is the sole path patch and its comment explains it exists only because a git checkout of cxx breaks Windows CI. No `[patch."https://…"]` git-source tables exist and there is no `vendor/` directory — both appear with this brief: D10 puts `lsp-types` and `agent-client-protocol` under `vendor/` (b1 adds `vendor/yawc`, b6 §3.1 `vendor/alacritty_terminal`, same rule), and because `lsp-types` is a git dependency its path patch needs a `[patch."https://github.com/zed-industries/lsp-types"]` table (item 4); the `agent-client-protocol` path patch is a normal `[patch.crates-io]` entry.
- Path patches are **not** workspace members: `cargo metadata --format-version 1 --no-deps` lists 253 members and `scratch` is not among them (there is no `exclude` key either) — cargo's implicit-member rule covers path entries in a member's `[dependencies]`, not `[patch]` tables (b6 §2 line 19 states the `[dependencies]` half of that rule). `cargo check -p scratch` panics in the feature resolver (`did not find features for (PackageId { name: "scratch", … }, NormalOrDev)`), but that is cargo's known failure for a package reachable only through the host graph — `scratch`'s only dependents are `cxx-build` (`Cargo.lock:4576`) and `webrtc-sys-build` (`:20811`), both build-dependencies — not a property of path patches; a path patch in the normal graph is expected to be `-p`-targetable exactly like a git-patched non-member (`cargo check -p async-process` succeeds), and test 7's first `-p lsp-types -p agent-client-protocol` run is what confirms it (risk 20). `cargo test -p` on a non-member is refused when it has dev-dependencies (`package async-process cannot be tested because it requires dev-dependencies and is not a member of the workspace`). Consequences: `crates/zs_smol_shim` must be listed in `[workspace.members]`; the two vendored crates (D10) stay non-members and are named in `[workspace] exclude` so that `cargo test --manifest-path vendor/<name>/Cargo.toml` treats each as a standalone package (without `exclude`, cargo refuses with "current package believes it's in a workspace when it's not"), which is where their own test suites run (section 6). Path-sourced packages are compiled without `--cap-lints allow` whether or not they are members, so the vendored code now sees CI's `-D warnings` (risk 14).
- Two packages with the same name and version: a second **path** package collides (`package collision in the lockfile: … only one can be written to lockfile unambiguously`, verified in a scratch workspace); a **git** package of the same name and version alongside the path patch resolves and locks fine (the lockfile qualifies the git one by source); a **crates-io** package of any other 2.x version conflicts with the patched 2.0.2 (`all possible versions conflict with previously selected packages`), because cargo allows one semver-compatible version per registry source. This is the evidence behind item 5's design note.
- `Cargo.toml:1003-1091` profiles (`dev`, `dbg`, `release`, `release-fast`); no browser profile (the bundle brief adds one, cf. `fork:Cargo.toml:1104-1110`).
- `Cargo.toml:1097-1098` — `[workspace.lints.rust] unexpected_cfgs = { level = "allow" }`, so new `cfg(target_family = "wasm")` gates and the `getrandom_backend` cfg raise no lint. `:1107` `disallowed_methods = "deny"`.
- `tooling/xtask/src/tasks/package_conformity.rs:15-36` — reports workspace packages that do not use workspace lints or declare non-workspace dependencies; not wired into any CI workflow (grep of `.github/workflows` and `tasks/workflows`).
- `script/clippy:1-3` (`#!/usr/bin/env bash`, `set -euo pipefail`, run from repo root) is the convention the new scripts follow; `script/download-wasi-sdk:1` uses `#!/bin/bash`.

## 3. Change list

Dependency order; each entry says what changes, the exact new or changed signatures, and the existing lines touched.

1. **`script/wasm-cc`** (new, executable). C compiler wrapper for `wasm32-unknown-unknown`. Resolves `${WASI_SDK_PATH:-<repo>/target/wasi-sdk}` at run time so `.cargo/config.toml` can reference it with a repo-relative path (an `[env]` value cannot carry a repo-relative path inside a `-isystem` flag, which is why `CFLAGS` is not used). Passes the same target features the Rust side uses so C objects get `memory.copy`/`memory.fill` lowering and correct atomics if any C code (SQLite, a scanner) uses them; mixed links are accepted by wasm-ld either way, this keeps the objects consistent.
   ```bash
   #!/usr/bin/env bash
   # C compiler for `--target wasm32-unknown-unknown`, referenced from .cargo/config.toml [env].
   # bash only: wasm builds are supported on macOS and Linux (see check-wasm).
   set -euo pipefail
   root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
   sdk="${WASI_SDK_PATH:-$root/target/wasi-sdk}"
   if [[ ! -x "$sdk/bin/clang" ]]; then
       echo "script/wasm-cc: wasi-sdk not found at $sdk; run script/download-wasi-sdk" >&2
       exit 1
   fi
   # -isystem ranks below cc-rs's -I dirs, so tree-sitter's own wasm/include (published by the
   # tree-sitter-language crate's build.rs in the tree-sitter checkout) and zstd-sys's wasm-shim
   # keep precedence; grammar scanners and SQLite get wasi-libc's headers. The -m flags mirror
   # `-C target-feature=+atomics,+bulk-memory,+mutable-globals` in .cargo/config.toml.
   exec "$sdk/bin/clang" --target=wasm32-unknown-unknown \
       -matomics -mbulk-memory -mmutable-globals \
       -isystem "$sdk/share/wasi-sysroot/include/wasm32-wasi" "$@"
   ```

2. **`.cargo/config.toml`** — insert after line 21 (end of the aarch64 block) and extend `[env]` at lines 23-24. Native builds are untouched: `target.wasm32-unknown-unknown` is consulted only with `--target wasm32-unknown-unknown`, and `CC_/AR_wasm32_unknown_unknown` are only read by `cc` when compiling for that target. `[env]` never overrides a variable already set in the environment (no `force`), so a developer's own `CC_wasm32_unknown_unknown` wins. Known impact on an existing wasm workflow: `cargo xtask web-examples` (item 17). b7 §3.16 appends exactly one more line to the `rustflags` list below, `"-C", "link-arg=--export=__wasm_call_ctors"`; that line is b7's and is listed here only so it is not lost when this block is edited. b6 §6 relies on `script/wasm-cc` (item 1) passing `-matomics -mbulk-memory -mmutable-globals` so `sqlite-wasm-rs`'s `cc` objects link under `--shared-memory`, and tolerates the `-isystem` (it vendors its own libc headers).
   ```toml
   # Browser client (Zed Codespaces). Only consulted for `--target wasm32-unknown-unknown`.
   # NOTE: a target-specific rustflags table makes cargo drop `[build].rustflags` for that
   # target, so the two flags from `[build]` are repeated. `-Zbuild-std=std,panic_abort` is
   # passed by script/check-wasm; an `[unstable]` table here would affect stable native builds.
   # getrandom 0.3.4 picks its wasm_js backend from the feature alone (gpui enables it); the
   # cfg below is only required by getrandom 0.3.0-0.3.3 and is kept for parity with the fork.
   [target.wasm32-unknown-unknown]
   rustflags = [
       "-C", "symbol-mangling-version=v0",
       "--cfg", "tokio_unstable",
       "--cfg", "getrandom_backend=\"wasm_js\"",
       "-C", "target-feature=+atomics,+bulk-memory,+mutable-globals",
       "-C", "link-arg=--shared-memory",
       "-C", "link-arg=--import-memory",
       "-C", "link-arg=--initial-memory=134217728",
       "-C", "link-arg=--max-memory=4294967296",
       "-C", "link-arg=--export=__wasm_init_tls",
       "-C", "link-arg=--export=__tls_size",
       "-C", "link-arg=--export=__tls_align",
       "-C", "link-arg=--export=__tls_base",
   ]

   [env]
   MACOSX_DEPLOYMENT_TARGET = "10.15.7"
   # wasi-sdk clang/llvm-ar for C code in the browser closure (tree-sitter runtime and grammars,
   # zstd-sys, later SQLite). `relative = true` resolves against the repository root. The AR
   # entry is required: for wasm32 targets cc-rs only looks for llvm-ar next to a clang-like
   # compiler and gives up otherwise. wasm-cc is a bash script: wasm builds are macOS/Linux only.
   CC_wasm32_unknown_unknown = { value = "script/wasm-cc", relative = true }
   AR_wasm32_unknown_unknown = { value = "target/wasi-sdk/bin/llvm-ar", relative = true }
   ```
   Lines touched: insert 22 lines after `:21`; `:23-24` become the extended `[env]` table.

3. **`script/check-wasm`** (new, executable). The incremental check. Uses the pinned stable toolchain plus `RUSTC_BOOTSTRAP=1` exactly like `run_tests.rs:500-509`; refuses to run if any rustflags environment variable would replace the config table, and refuses on Windows shells (the `[env]` compiler is a bash script).
   ```bash
   #!/usr/bin/env bash
   # Incremental `cargo check` of Zed crates for wasm32-unknown-unknown.
   #   script/check-wasm                      # default crate list below
   #   script/check-wasm -p util -p fs        # explicit crates; other args pass through to cargo
   #   ZS_WASM_MODE=build script/check-wasm -p zed_web
   #   ZS_WASM_MODE=build ZS_BUILD_ID=<id> script/check-wasm -p zed_web --profile <profile>   # b7 §3.31 step 3;
   #                                          # unknown args (--profile, --features) and the environment pass through
   #   ZS_WASM_TOOLCHAIN=nightly-2026-08-01 script/check-wasm   # use a nightly instead of bootstrap
   set -euo pipefail
   cd "$(dirname "${BASH_SOURCE[0]}")/.."

   case "$(uname -s)" in
       MINGW*|MSYS*|CYGWIN*)
           echo "check-wasm: wasm builds are supported on macOS and Linux only (script/wasm-cc is bash)" >&2
           exit 2 ;;
   esac

   for var in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS; do
       if [[ -n "${!var:-}" ]]; then
           echo "check-wasm: $var is set and would replace [target.wasm32-unknown-unknown] rustflags in .cargo/config.toml" >&2
           exit 2
       fi
   done

   ./script/download-wasi-sdk >/dev/null

   mode="${ZS_WASM_MODE:-check}"
   if [[ -n "${ZS_WASM_TOOLCHAIN:-}" ]]; then
       rustup toolchain install "$ZS_WASM_TOOLCHAIN" --profile minimal \
           --component rust-src --target wasm32-unknown-unknown >/dev/null
       cargo=(rustup run "$ZS_WASM_TOOLCHAIN" cargo)
   else
       cargo=("${CARGO:-cargo}")
       export RUSTC_BOOTSTRAP=1   # -Zbuild-std on the pinned stable, as upstream CI does
   fi

   # Crates known to pass; append as layers go green (BUILD-SPEC 3.2 ordering). This list is
   # the per-layer CI gate: CI runs this script with no arguments. Sibling briefs append here
   # (b6 §6: sqlez, db, prompt_store, clock, fs, terminal, acp_thread, client; b7 §3.32: util,
   # paths, settings, its leaf crates, zed_web last), never in the xtask job.
   default_packages=(gpui_platform cloud_api_client smol)

   packages=()
   passthrough=()
   while [[ $# -gt 0 ]]; do
       case "$1" in
           -p|--package) packages+=(-p "$2"); shift 2 ;;
           *) passthrough+=("$1"); shift ;;
       esac
   done
   if [[ ${#packages[@]} -eq 0 ]]; then
       for p in "${default_packages[@]}"; do packages+=(-p "$p"); done
   fi

   exec "${cargo[@]}" -Zbuild-std=std,panic_abort "$mode" --target wasm32-unknown-unknown \
       "${packages[@]}" ${passthrough[@]+"${passthrough[@]}"}
   ```
   (`${arr[@]+"${arr[@]}"}` keeps macOS bash 3.2 happy under `set -u`.) Every rustc invocation prints `warning: unstable feature specified for -Ctarget-feature: atomics` on stable-with-bootstrap; it is not a lint and survives `-D warnings` (verified, risk 1). `ZS_WASM_TOOLCHAIN=nightly-…` silences it.

4. **`Cargo.toml` (workspace)** — six edits.
   - `[workspace.members]`: add `"crates/zs_smol_shim",` after `"crates/ztracing_macro",` (line 248). Required: a path referenced only from `[patch]` is not a member (section 2, `scratch`), and the shim must be a member so that `cargo test -p smol`, `script/clippy` and `cargo test --workspace` treat it as Zed code (it is).
   - `[workspace] exclude` (new key, after the closing `]` of `members` at `:266` and before `default-members` at `:267`): `exclude = ["vendor/lsp-types", "vendor/agent-client-protocol"]`. The vendored crates (D10) are deliberately **not** members — third-party code is neither linted by `script/clippy` nor run by `cargo test --workspace` as ours — and `exclude` makes each a standalone package for `cargo test --manifest-path vendor/<name>/Cargo.toml` (section 2). b1 (`vendor/yawc`) and b6 §3.1 (`vendor/alacritty_terminal`) append to the same array.
   - `[workspace.dependencies]`: add, in alphabetical position, `async-executor = "1.13"` (after `:537`), `async-net = "2.0"` (after `:540`), `blocking = "1.6"` (after `:567` `block = "0.1"`).
   - `[patch.crates-io]` (`:976`): add after `:982` (`async-task`):
     ```toml
     # Zed Codespaces: smol is a facade over async-* crates; on wasm32 the OS-bound halves are stubs.
     smol = { path = "crates/zs_smol_shim" }
     # Zed Codespaces (D10): agent-client-protocol 2.0.0 (rust-sdk ce023279, src/agent-client-protocol)
     # with the process/stdio transports gated for the browser. vendor/README.md records the diff and
     # the git-patch form this line becomes once a fork exists.
     agent-client-protocol = { path = "vendor/agent-client-protocol" }
     ```
   - New table immediately before `[patch.crates-io]` at `:976` (the first `[patch."<git url>"]` table in the file; the key must be the exact URL used at `:680`):
     ```toml
     [patch."https://github.com/zed-industries/lsp-types"]
     # Zed Codespaces (D10): f1783e63 plus a wasm32-unknown-unknown implementation of
     # Uri::from_file_path/to_file_path. The vendored version (0.95.1) must stay equal to the
     # version at the rev on the `lsp-types` line above, or cargo reports the patch as unused;
     # vendor/README.md records the upstream rev, the diff and the git-patch form.
     lsp-types = { path = "vendor/lsp-types" }
     ```
   - `:680` — **unchanged** (`lsp-types = { git = "https://github.com/zed-industries/lsp-types", rev = "f1783e63…" }`); the path patch shadows it. The line stays byte-identical to upstream, so a rebase never conflicts there; the price is that an upstream rev bump is silently shadowed by the vendored copy as long as the version stays 0.95.1, which the rebase check (item 18) catches by comparing `:680`'s rev with the rev recorded in `vendor/README.md`.
   Cargo.lock: `smol 2.0.2` switches to the path source (its `source`/`checksum` lines disappear); `agent-client-protocol 2.0.0` likewise loses `source`/`checksum` (path), while `agent-client-protocol-derive 2.0.0` and `agent-client-protocol-schema 1.5.0` stay on crates-io (the normalised manifest depends on both by version, section 2); `lsp-types 0.95.1` loses its `git+https://…#f1783e6…` source line. No version changes elsewhere (`cargo update -p smol -p agent-client-protocol -p lsp-types` regenerates the entries).

5. **`crates/zs_smol_shim/Cargo.toml`** (new). Package name must be `smol` (a patch replaces by name) and version must satisfy every `smol = "2…"` requirement in the graph (`Cargo.toml:818` and `runtimelib`).
   ```toml
   [package]
   name = "smol"
   version = "2.0.2"
   edition.workspace = true
   publish = false
   license = "MIT OR Apache-2.0"
   description = "Zed Codespaces: smol 2.0.2 on native targets, browser stubs on wasm32-unknown-unknown"

   [lints]
   workspace = true

   [lib]
   path = "src/lib.rs"
   doctest = false

   # Pure-Rust parts of smol, identical on every target.
   [dependencies]
   async-channel.workspace = true
   async-executor.workspace = true
   async-lock.workspace = true
   futures-lite = "2.6"   # smol 2 re-exports futures-lite 2; the workspace pin (1.13) is a different crate

   [target.'cfg(not(target_family = "wasm"))'.dependencies]
   async-fs.workspace = true
   async-io.workspace = true
   async-net.workspace = true
   async-process.workspace = true
   blocking.workspace = true

   [target.'cfg(target_family = "wasm")'.dependencies]
   async-task.workspace = true
   js-sys.workspace = true
   log.workspace = true
   wasm-bindgen.workspace = true
   ```
   Why the patch is effectively wasm-only: `[patch]` cannot be scoped to a target, so the shim is *the* `smol` on every target and re-exports smol's constituent crates on non-wasm — which is literally what `smol-2.0.2/src/lib.rs:49-65` does, so every type (`Task`, `Timer`, `fs::File`, …) is the same crates-io type as before. The alternative in the task hint — a renamed dependency on the real `smol` — cannot come from crates-io (any registry `smol 2.x` conflicts with the patched 2.0.2: one semver-compatible version per registry source, verified), but it can come from git at the same version (verified, section 2 "Workspace layout"). It was rejected because it puts a second `smol` (and on native a second copy of nothing useful) in the graph for no gain; the facade keeps the byte-identical types with one package. `futures-lite = "2.6"` is a deliberate non-workspace pin; `cargo xtask package-conformity` (not in CI) will report it — acceptable, or add `futures-lite2 = { package = "futures-lite", version = "2.6" }` to `[workspace.dependencies]` if that report becomes gating.

6. **`crates/zs_smol_shim/src/lib.rs`** (new).
   ```rust
   //! `smol` for Zed Codespaces. Native targets: smol 2.0.2's public surface, assembled from the
   //! same crates smol re-exports. wasm32-unknown-unknown: only the surface a browser-set crate
   //! references exists — `fs`, `net`, `process` as stubs returning `io::ErrorKind::Unsupported`,
   //! `spawn`, and `runtime`, through which the entry crate hands `spawn` gpui's background
   //! executor (`zed_web`, b7 §3.27). `Timer`, `block_on`, `unblock`, `Unblock` and `Async` are
   //! deliberately absent on wasm so that a new use fails to compile instead of blocking or
   //! trapping the worker; timers and blocking belong to gpui's executor there.
   #[doc(inline)]
   pub use async_executor::{Executor, LocalExecutor, Task};
   #[doc(inline)]
   pub use futures_lite::{future, io, pin, prelude, ready, stream};
   #[doc(inline)]
   pub use {async_channel as channel, async_lock as lock};

   #[cfg(not(target_family = "wasm"))]
   #[doc(inline)]
   pub use {
       async_fs as fs, async_net as net, async_process as process,
       async_io::{block_on, Async, Timer},
       blocking::{unblock, Unblock},
   };
   #[cfg(not(target_family = "wasm"))]
   mod native_spawn;                       // verbatim copy of smol-2.0.2/src/spawn.rs:1-64
   #[cfg(not(target_family = "wasm"))]
   pub use native_spawn::spawn;

   #[cfg(target_family = "wasm")]
   mod wasm;
   #[cfg(target_family = "wasm")]
   pub use wasm::{fs, net, process, spawn};

   #[cfg(target_family = "wasm")]
   pub mod runtime;                        // smol::runtime::{Runtime, Runnable, install_runtime, runtime_installed}
   #[cfg(all(test, not(target_family = "wasm")))]
   mod runtime;                            // same file, compiled natively only for its unit test (test 1)
   ```
   Files: `src/native_spawn.rs` (smol's `pub fn spawn<T: Send + 'static>(future: impl Future<Output = T> + Send + 'static) -> Task<T>`, unchanged, keeps the `SMOL_THREADS` executor and `async_process::driver()`), `src/runtime.rs` (target-neutral: a `OnceLock<Arc<dyn Runtime>>` and the three public functions; exported as `smol::runtime` on wasm only), `src/wasm/mod.rs` (the `unsupported()` helper and `js_set_timeout`), `src/wasm/spawn.rs`, `src/wasm/fs.rs`, `src/wasm/net.rs`, `src/wasm/process.rs`. Full definitions in section 4. Stub semantics:
   - Always present, on every target, exactly as smol exports them: `Task`, `Executor`, `LocalExecutor`, `future`, `io`, `pin`, `prelude`, `ready`, `stream`, `channel`, `lock`. b6 §7 item 11 relies on `smol::future::yield_now` (`client.rs:1231`) and the `smol::io` traits (`FakeFs`, native) staying available; this brief guarantees they never go behind a cfg.
   - `spawn` really runs: `async_task::spawn(future, schedule)`, returning `async_task::Task<T>`, the same type as `smol::Task<T>`. `schedule` hands the `Runnable` to the installed `smol::runtime::Runtime` when there is one — `zed_web` installs `GpuiSmolRuntime(cx.background_executor().clone())` as the first statement inside `run_embedded` (b7 §3.27 step 2, section 4), after which a `smol::spawn` from any thread, gpui_web background workers included, runs on gpui's background executor. Before a runtime is installed (nothing in Zed spawns that early) it falls back to `setTimeout(0)` on the current JS global (`js_sys::global()`), which works on the main thread and in any worker that yields to its event loop; a gpui_web background worker never does (dispatcher.rs:184-205), so the fallback logs once at `warn` when used off the main thread. The only compiled caller today is `git/src/repository.rs:3809` (dead on wasm); new browser code should still prefer `cx.background_spawn`, but an accidental `smol::spawn` no longer hangs.
   - `fs`, `net`, `process` types exist with smol's signatures; every operation returns `io::Error::new(io::ErrorKind::Unsupported, "<api> is not available in the browser; use the Fs trait / the remote protocol")`. `process::Command` keeps a real `std::process::Command` so builder calls and `From<std::process::Command>` work; `spawn()`, `status()`, `output()` fail. `smol::net`/`smol::process` returning `Unsupported` (never hanging) is the guarantee b1/b2 rely on if any transport code accidentally reaches them.
   - Not exported on wasm: `block_on` (the browser cannot block; with `panic = "abort"` a panic traps every worker), `unblock`/`Unblock` (callers are all in `RealFs`, gated by the fs brief), `Async` (Windows/macOS-only callers), `Timer` (no callers anywhere; banned by clippy). A stray use surfaces as a compile error in `script/check-wasm`.

7. **`vendor/lsp-types`** (new, vendored per D10). Copy `Cargo.toml`, `src/`, `tests/`, `LICENSE`, `README.md` and `CHANGELOG.md` from the git checkout `lsp-types-da1727dff60dd2b5/f1783e6/` (the exact rev at `Cargo.toml:680`; drop `release.sh`, `release.toml`, `.clog.toml`, `.github/`, `.gitignore`, `.cargo-ok`), apply the diff below, and add the `[patch."https://github.com/zed-industries/lsp-types"]` table (item 4). The copy inherits nothing from Zed's workspace and needs nothing from it: `version = "0.95.1"`, `edition = "2018"` and `license = "MIT"` are literals already (section 2). Record in `vendor/README.md` (item 19): upstream `https://github.com/zed-industries/lsp-types` @ `f1783e63a7f4eb4397bf51d4148b4895a1f7ab16`, the two files changed, and the intended git-patch form — `lsp-types = { git = "<a fork of zed-industries/lsp-types carrying this diff as one commit on top of f1783e63>", rev = "<that commit>" }` in the same `[patch."https://github.com/zed-industries/lsp-types"]` table — which replaces the path entry the day a fork exists. Upstream PR: the same diff against `zed-industries/lsp-types`; once merged the patch table is deleted, `:680` bumps to the merged rev and `vendor/lsp-types` is removed.
   - `Cargo.toml:20` — after the `url` line add `percent-encoding = "2.3"`.
   - `src/uri.rs:61-78` — replace the `impl Uri` block:
     ```rust
     impl Uri {
         /// Create a URI from a file path (host platform rules, via `url::Url::from_file_path`).
         #[cfg(not(target_family = "wasm"))]
         pub fn from_file_path<P: AsRef<std::path::Path>>(path: P) -> Result<Self, ()> {
             url::Url::from_file_path(path).map(Self)
         }

         /// wasm32-unknown-unknown: `url` does not compile `Url::from_file_path` there. Paths
         /// are the remote (Unix) host's paths, so this is the Unix branch of `Url::from_file_path`.
         /// Differs from native in one documented way: a `.` or `..` component is rejected
         /// (`Err(())`) because a `Url` cannot carry a raw `..` segment and silently resolving it
         /// would make browser and desktop clients name different files.
         #[cfg(target_family = "wasm")]
         pub fn from_file_path<P: AsRef<std::path::Path>>(path: P) -> Result<Self, ()> {
             unix_file_path::to_url(path.as_ref()).map(Self)
         }

         /// wasm32-unknown-unknown counterpart of `url::Url::to_file_path` (Unix rules). On native
         /// targets `uri.to_file_path()` keeps resolving to `Url::to_file_path` through `Deref`.
         #[cfg(target_family = "wasm")]
         pub fn to_file_path(&self) -> Result<std::path::PathBuf, ()> {
             unix_file_path::from_url(&self.0)
         }
     }

     /// Unix-only re-implementation of url 2.5's file-path conversions (url/src/lib.rs:2948-2977
     /// and the Unix arm of `to_file_path`). Compiled on every target so it can be tested against
     /// `url` natively; only the `Uri` wrappers above are target-gated.
     pub(crate) mod unix_file_path {
         pub(crate) fn to_url(path: &std::path::Path) -> Result<url::Url, ()>;
         pub(crate) fn from_url(url: &url::Url) -> Result<std::path::PathBuf, ()>;
     }
     ```
     `to_url`: `Err(())` unless the path starts with `/`; `Err(())` for any `Component::CurDir`/`ParentDir` (`Path::components` already drops interior `.`, so only `..` and a leading `.` reach this); serialization starts as `"file://"`; for every `components().skip(1)` push `'/'` and `percent_encode(component.as_os_str().to_str().ok_or(())?.as_bytes(), SPECIAL_PATH_SEGMENT)` where `SPECIAL_PATH_SEGMENT` is rebuilt from `percent_encoding::CONTROLS` per `url/src/parser.rs:20-42` (`' ' " < > \` # ? { } / % \`); an empty path gets a single `/`; finish with `url::Url::parse(&serialization)`. `from_url`: `url.path_segments()` must be `Some`, host must be `None` or `localhost` (no scheme check — identical to `Url::to_file_path` on Unix and to `util::paths::file_url_segments_to_pathbuf_posix`, `paths.rs:1359-1391`), then `"/" + segments.map(percent_decode(..)).join("/")` as bytes, `String::from_utf8(..).map_err(|_| ())` (non-UTF-8 paths cannot exist in the browser).
   - `src/uri.rs` tests (`:109-459`) keep running natively; add `unix_file_path` tests (section 6).

8. **`crates/util/src/paths.rs`** — extend `UrlExt` (`:1322-1327`) and its impl (`:1329-1467`).
   ```rust
   pub trait UrlExt {
       fn to_file_path_ext(&self, path_style: PathStyle) -> Result<PathBuf, ()>;          // existing, :1326

       /// `url::Url::from_file_path` with the platform decided at run time by `path_style`
       /// (counterpart of `to_file_path_ext`). It is also the only way to build a `file://`
       /// URL on wasm32-unknown-unknown, where `Url::from_file_path` is not compiled.
       /// Unlike `url`, a `..` component (or a leading `.`) is rejected for both styles.
       fn from_file_path_ext<P: AsRef<Path>>(path: P, path_style: PathStyle) -> Result<url::Url, ()>
       where
           Self: Sized;
   }
   ```
   `impl UrlExt for url::Url` gains `from_file_path_ext`: `PathStyle::Unix` mirrors `url/src/lib.rs:2948-2977` (absolute per `PathStyle::Unix.is_absolute`, split on `/`, drop empty and `.` segments as `Path::components` does, `..` → `Err(())`, percent-encode with a local `SPECIAL_PATH_SEGMENT` `AsciiSet` built from `percent_encoding::CONTROLS`, then `Url::parse`); `PathStyle::Windows` mirrors `url/src/lib.rs:2996-3055` for prefixes (`X:` or `X:\` drive → `/X:`, `\\server\share` → host `server` + `/share`, any other prefix → `Err(())`), remaining components split on `\` or `/`, `.` dropped, `..` → `Err(())`, percent-encoded with `PATH_SEGMENT`. The `..` rejection is where this helper knowingly differs from `url` (which writes `..` raw; `Url::parse` would resolve it): documented on the method and covered by a test. Add `use percent_encoding::{percent_encode, AsciiSet, CONTROLS};` next to `:1-19`. No new dependency (`crates/util/Cargo.toml:43-44`).

9. **`crates/languages/src/python.rs:431`** — `url::Url::from_file_path(toolchain.environment.executable.as_ref()?).ok()?` → `url::Url::from_file_path_ext(toolchain.environment.executable.as_ref()?, PathStyle::local()).ok()?`. Line 39 already reads `use util::paths::PathStyle;`; change that line to `use util::paths::{PathStyle, UrlExt};` (adding a second `PathStyle` import would be `E0252`). (`PathStyle::local()` is `Unix` on wasm, `crates/path/src/path.rs:37-44`.)

10. **`crates/editor/src/hover_popover.rs:1007`** — `uri.to_file_path()` (receiver is `url::Url`, `:31,1005`) → `uri.to_file_path_ext(PathStyle::local())`; add `use util::paths::{PathStyle, UrlExt};` next to `:32` (`use util::TryFutureExt;`, the file's only `util` import). The fallback branch at `:1007-1010` stays.
    Every other live `from_file_path`/`to_file_path` call in the browser set is on `lsp::Uri` (section 2) and is untouched: project `lsp_store.rs` (22 sites), `lsp_command.rs:68`, `lsp_store/lsp_ext_command.rs:214`; copilot `copilot.rs:332,1297`; languages `eslint.rs:234,261,491`, `json.rs:275`; lsp `lsp.rs:62,444,801`. Mechanical fallback if a reviewer prefers explicit helpers instead of the vendored `Uri` methods: `sd 'lsp::Uri::from_file_path\((.*?)\)' 'lsp::Uri::from_str(url::Url::from_file_path_ext($1, PathStyle::local())?.as_str())'` is not recommended (it changes error types at 27 sites); keep the vendored implementation.

11. **`vendor/agent-client-protocol`** (new, vendored per D10). Copy the registry package directory `agent-client-protocol-2.0.0/` (section 2: the published 2.0.0, cut from `agentclientprotocol/rust-sdk` commit `ce023279824149008659dd8f4b8b70266a7e8210`, tag `v2.0.0`, at `src/agent-client-protocol`) verbatim, keeping `.cargo_vcs_info.json` (provenance), `Cargo.lock` (lets the standalone test run resolve offline), `src/`, `tests/`, `examples/`, `README.md`, `CHANGELOG.md`; delete `.cargo-ok` and `Cargo.toml.orig` (the workspace-inheriting manifest, which does not build outside the rust-sdk workspace). Apply the gates below to the **registry-normalised** `Cargo.toml` (every `workspace = true` is already resolved to a literal there, so the copy builds standalone), then the `[patch.crates-io]` path entry (item 4). `agent-client-protocol-derive` stays a crates-io dependency (section 2); nothing else is vendored. Record in `vendor/README.md` (item 19): the upstream rev, the files changed, the intended git-patch form — `[patch.crates-io] agent-client-protocol = { git = "<a fork of agentclientprotocol/rust-sdk carrying this diff as one commit on top of ce023279>", rev = "<that commit>" }` — and the source-tree form of the manifest edit (`src/agent-client-protocol/Cargo.toml:48-50` → a `[target.'cfg(not(target_family = "wasm"))'.dependencies]` table with `async-io.workspace = true`, `async-process.workspace = true`, `blocking.workspace = true`, placed before the `cfg(unix)` table at `:52`), which is what the upstream PR edits.
    - `vendor/agent-client-protocol/Cargo.toml:143-150` — the three dotted tables `[dependencies.async-io] version = "2"`, `[dependencies.async-process] version = "2"`, `[dependencies.blocking] version = "1"` become `[target.'cfg(not(target_family = "wasm"))'.dependencies.async-io]`, `[target.'cfg(not(target_family = "wasm"))'.dependencies.async-process]` and `[target.'cfg(not(target_family = "wasm"))'.dependencies.blocking]` with the same `version` lines (the normalised manifest uses one dotted table per dependency; semantically the same edit as the source-tree form above), the first preceded by the comment `# Process-backed transports are host-only; the browser reaches external agents over Zed's protocol.`
    - `vendor/agent-client-protocol/Cargo.toml:225-258` — delete the `[lints.clippy]`, `[lints.clippy.pedantic]`, `[lints.rust]`, `[lints.rust.future_incompatible]`, `[lints.rust.nonstandard_style]`, `[lints.rust.rust_2018_idioms]` and `[lints.rust.unused]` tables. They are upstream's opt-in warn-level lints; as a registry dependency they were neutralised by `--cap-lints allow`, as a path package they are live and `ci-config.toml`'s `-D warnings` would turn any hit into a build failure in Zed's CI (risk 14). Deleting them changes nothing about the crate's behaviour; it is recorded in `vendor/README.md` as a local modification that is **not** part of the upstream PR.
    - `vendor/agent-client-protocol/src/lib.rs:138` `mod acp_agent;` → prefix `#[cfg(not(target_family = "wasm"))]`.
    - `:139` `pub use acp_agent::{AcpAgent, AcpAgentConfig, LineDirection};` → prefix the same attribute.
    - `:141` `mod stdio;` → prefix.
    - `:142` `pub use stdio::Stdio;` → prefix.
    No other source line changes (`acp_agent.rs` and `stdio.rs` are the sole users of the gated crates; doc references in `component.rs:52,100` and `jsonrpc.rs:904-1637` are comments). Upstream PR: the same diff (dependency table and `lib.rs` gates, not the `[lints]` removal) against `agentclientprotocol/rust-sdk`; once released, `Cargo.toml:521` bumps, the patch line is deleted and `vendor/agent-client-protocol` is removed.

12. **tree-sitter feature declarations** — every enabling line becomes a pair of target tables; the wasm side keeps tree-sitter's default (`std`, which is `regex/std` + `regex/perf`, plus the C runtime) and drops `wasm` (`wasmtime-c-api-impl` with `cranelift`, `gc`, `gc-null`). Resolver 2 does not unify features from a target table whose cfg does not match, so native builds keep `WasmStore`.
    - `crates/language/Cargo.toml:76` — delete; add before `[dev-dependencies]`:
      ```toml
      [target.'cfg(not(target_family = "wasm"))'.dependencies]
      # `wasm` = wasmtime-backed `WasmStore` for extension grammars; the browser links grammars itself.
      tree-sitter = { workspace = true, features = ["wasm"] }

      [target.'cfg(target_family = "wasm")'.dependencies]
      tree-sitter.workspace = true
      ```
    - `crates/multi_buffer/Cargo.toml:44`, `crates/migrator/Cargo.toml:22`, `crates/edit_prediction_context/Cargo.toml:28`, `crates/language_tools/Cargo.toml:35` — same replacement (delete the line, add the two tables). None of these crates reference the feature's API.
    - `crates/languages/Cargo.toml:62` — delete; add the two tables with `optional = true` on both entries (`tree-sitter = { workspace = true, optional = true, features = ["wasm"] }` / `tree-sitter = { workspace = true, optional = true }`); the `load-grammars` feature at `:15-19` still names `"tree-sitter"` and enables whichever entry applies. `:81` (dev-dependency) unchanged.
    - `crates/settings_json/Cargo.toml:20` — same optional split; `editing = ["dep:tree-sitter", "dep:tree-sitter-json"]` at `:16` unchanged.
    - `crates/extension_cli/Cargo.toml:37` unchanged (native-only tool that needs wasmtime); `crates/grammars/Cargo.toml:60` `test-support = ["load-grammars", "tree-sitter/wasm"]` unchanged. Features cannot be target-conditional, so `grammars/test-support` and `languages`'s dev-dependency re-enable wasmtime in any wasm build that activates them; the browser build must never enable `test-support` on a crate that reaches `grammars`, and test 5 pins the exact feature set `zed_web` will use.

13. **`crates/language/src/language.rs`** — three gates.
    - `:99` `use tree_sitter::{self, QueryCursor, WasmStore, wasmtime};` → `use tree_sitter::{self, QueryCursor};` plus `#[cfg(not(target_family = "wasm"))] use tree_sitter::{WasmStore, wasmtime};`.
    - `:141-147` in `with_parser`:
      ```rust
      let mut parser = PARSERS.lock().pop().unwrap_or_else(|| {
          #[allow(unused_mut)]
          let mut parser = Parser::new();
          #[cfg(not(target_family = "wasm"))]
          parser
              .set_wasm_store(WasmStore::new(&WASM_ENGINE).unwrap())
              .unwrap();
          parser
      });
      ```
    - `:168-170` `static WASM_ENGINE` → prefix `#[cfg(not(target_family = "wasm"))]`.

14. **`crates/language/src/language_registry.rs:838-860`** — the `AvailableGrammar::Unloaded(wasm_path)` arm: wrap the existing body (from `:839` `log::trace!` through the end of the arm; `let this = self.clone();` at `:840` is inside it) in `#[cfg(not(target_family = "wasm"))] { … }` and add
    ```rust
    #[cfg(target_family = "wasm")]
    {
        let error = Arc::new(anyhow::anyhow!(
            "grammar {name:?} ({wasm_path:?}) must be linked by the browser grammar linker"
        ));
        *grammar = AvailableGrammar::LoadFailed(error.clone());
        tx.send(Err(error)).ok();
    }
    ```
    The wasm arm must mention `wasm_path` (as above) or bind the pattern as `_wasm_path` — otherwise the pattern binding is unused on wasm and CI's `-D warnings` (first applied to wasm by item 16) fails on `unused_variables`. The tree-sitter-in-the-browser brief replaces that arm with the `GrammarLinker` path (BUILD-SPEC 3.3); this keeps `language` compiling until then.

15. **`crates/time_format/Cargo.toml`** — after `:17` add
    ```toml
    [target.'cfg(target_family = "wasm")'.dependencies]
    time = { workspace = true, features = ["wasm-bindgen"] }   # now_utc()/current_local_offset() via js_sys::Date
    sys-locale = { workspace = true, features = ["js"] }        # navigator.language instead of None
    ```
    Feature unification carries `wasm-bindgen` to every `time` user in the wasm graph (git_ui, git, client, command_palette, notifications). The `zed_web` entry crate (its own brief) should repeat the `time` line so the guarantee does not depend on `time_format` staying in the closure.

16. **`tooling/xtask/src/tasks/workflows/run_tests.rs:500-509`** (required, not deferrable — it is the only per-layer CI mechanism this plan has, BUILD-SPEC 3.2 "each layer gets a CI check the day it compiles") — make `cargo_check_wasm` run `./script/check-wasm` (no arguments; `default_packages` is the layer list) and drop the `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS` env so `.cargo/config.toml` is the single source of truth; keep `RUSTC_BOOTSTRAP` out (the script sets it). Add a cache step for `target/wasi-sdk` keyed on `wasi-sdk-25` next to `cache_rust_dependencies_namespace` (`:518`) so `download-wasi-sdk` does not fetch 100 MB per run. Regenerate `.github/workflows/run_tests.yml` with `cargo xtask workflows`. The layer list lives in the script's `default_packages`, not in the xtask: b6 §6 (`sqlez`, then `db`, `prompt_store`, `clock`, `fs`, `terminal`, `acp_thread`, `client`) and b7 §3.32 (`util`, `paths`, `settings`, its leaf crates, `zed_web` last) append there as each crate goes green, and b7 adds its `check_forbidden_crates` step to the same job; the job invocation itself stays argument-free (b7 §3.32 describes it as "`./script/check-wasm -p gpui_platform -p cloud_api_client`", which is the same thing with the day-one list spelled out). Removing the env var is what first exposes the wasm check to `ci-config.toml`'s `-D warnings` (section 2), so before regenerating: `cp .cargo/ci-config.toml ../.cargo/config.toml && ./script/check-wasm -p gpui_platform -p cloud_api_client` locally and fix or `#[allow]` any pre-existing wasm-only warnings in those two crates; once items 7 and 11 are in, repeat with `-p lsp-types -p agent-client-protocol` (path-sourced, therefore uncapped, risk 14) and natively with `cargo check -p lsp-types -p agent-client-protocol` under the same config, fixing any warning in the vendored copy and recording it in `vendor/README.md`.

17. **`tooling/xtask/src/tasks/web_examples.rs:66-73`** — insert `"-Zbuild-std=std,panic_abort"` before `"build"` in `cmd.args([...])` (the `-Z` flag precedes the subcommand). Without it the example build links the prebuilt non-atomics std under the new `--shared-memory`/`+atomics` rustflags and rust-lld fails. `RUSTC_BOOTSTRAP=1` is already set at `:75`.

18. **Rebase check (script contract only)** — BUILD-SPEC 11.3's rebase-check job is: merge upstream `main`, run `./script/check-wasm` (no arguments), run `cargo tree -p zed -e features -i tree-sitter | grep -q 'feature "wasm"'` and the section 6 test 5 invariants, and compare the two upstream pins against `vendor/README.md`: the `rev` at `Cargo.toml:680` must equal the rev recorded for `vendor/lsp-types` (a `[patch."<git url>"]` path entry keeps applying across an upstream rev bump as long as the version is still 0.95.1, so a mismatch means the vendored copy is silently shadowing new upstream code and must be re-synced), and the `=2.0.0` at `:521` must equal the version recorded for `vendor/agent-client-protocol` (a bump there makes cargo report the patch as unused). `cargo metadata --format-version 1 | jq -r '.packages[] | select(.name=="lsp-types" or .name=="agent-client-protocol") | .source'` must print `null` twice (test 5). The workflow YAML belongs to the CI brief; this brief guarantees the script is argument-free and deterministic.

19. **`vendor/README.md`** (new; shared with b1 and b6 §3.1, who append their own crates). One section per vendored crate, in this shape (D10):
    ```markdown
    # Vendored dependencies

    Path `[patch]` entries that stand in for GitHub forks until one exists (docs/briefs/DECISIONS.md D10).
    Each section records the upstream revision, every local change, and the git-patch form that replaces
    the path entry once the change lives on a fork. Re-sync a copy whenever its upstream pin in Cargo.toml
    moves (rebase contract: docs/briefs/b5-wasm-build-env.md item 18).

    ## lsp-types (vendor/lsp-types)
    - Upstream: https://github.com/zed-industries/lsp-types @ f1783e63a7f4eb4397bf51d4148b4895a1f7ab16 (version 0.95.1; the rev on the `lsp-types` line in Cargo.toml)
    - Patched by: `[patch."https://github.com/zed-industries/lsp-types"] lsp-types = { path = "vendor/lsp-types" }`
    - Local changes: `Cargo.toml` (`percent-encoding = "2.3"`); `src/uri.rs` (wasm32 `Uri::from_file_path`/`to_file_path`, the `unix_file_path` module and its tests). See docs/briefs/b5-wasm-build-env.md item 7.
    - Git-patch form: `lsp-types = { git = "<a fork of zed-industries/lsp-types>", rev = "<one commit on top of f1783e63 with the changes above>" }` in the same table.
    - Upstream PR: the same diff against zed-industries/lsp-types; when merged, delete the table, bump the Cargo.toml rev, delete this directory.

    ## agent-client-protocol (vendor/agent-client-protocol)
    - Upstream: crates.io agent-client-protocol 2.0.0 = https://github.com/agentclientprotocol/rust-sdk @ ce023279824149008659dd8f4b8b70266a7e8210 (tag v2.0.0), path src/agent-client-protocol (see .cargo_vcs_info.json)
    - Patched by: `[patch.crates-io] agent-client-protocol = { path = "vendor/agent-client-protocol" }`
    - Local changes: `Cargo.toml` (`async-io`, `async-process`, `blocking` moved to `cfg(not(target_family = "wasm"))` tables; upstream's `[lints]` tables removed because Zed CI builds path crates uncapped with `-D warnings`); `src/lib.rs:138-142` (`acp_agent`, `stdio` and their re-exports gated on `cfg(not(target_family = "wasm"))`). See docs/briefs/b5-wasm-build-env.md item 11.
    - Git-patch form: `agent-client-protocol = { git = "<a fork of agentclientprotocol/rust-sdk>", rev = "<one commit on top of ce023279 with the dependency-table and lib.rs changes>" }` (the `[lints]` removal is not part of the fork or the PR).
    - Upstream PR: the same diff against agentclientprotocol/rust-sdk (`src/agent-client-protocol/Cargo.toml:48-56`, `src/lib.rs:138-142`); when released, bump the `=2.0.0` pin, delete the patch line, delete this directory.
    ```
    The README is prose for humans, but the rebase check (item 18) greps the `- Upstream:` lines for the 40-hex rev and the `2.0.0` version, so that line format is part of the contract.

## 4. New types and messages

`crates/zs_smol_shim/src/wasm/mod.rs`

```rust
pub mod fs;
pub mod net;
pub mod process;
mod spawn;
pub use spawn::spawn;

/// `ErrorKind::Unsupported`, "<what> is not available in the browser; use the Fs trait / the remote protocol".
pub(crate) fn unsupported(what: &'static str) -> std::io::Error;

/// `globalThis.setTimeout(callback, millis)` through js-sys (no web-sys features). Logs once at
/// `warn` if called off the main thread: gpui_web workers never return to their event loop.
pub(crate) fn js_set_timeout(callback: Box<dyn FnOnce() + 'static>, millis: i32);
```

`crates/zs_smol_shim/src/wasm/spawn.rs`

```rust
/// Runs `future` to completion on the installed `smol::runtime::Runtime` (gpui's background
/// executor once `zed_web` has installed it, b7 §3.27) or, before that, on the current thread's
/// JS event loop. Exists so that `git::repository::untracked_files_for_checkpoint`
/// (RealGitRepository-only) keeps compiling; live browser code should still prefer gpui's
/// executor directly (`cx.background_spawn`).
pub fn spawn<T: Send + 'static>(future: impl Future<Output = T> + Send + 'static) -> async_task::Task<T> {
    let (runnable, task) = async_task::spawn(future, schedule);
    runnable.schedule();
    task
}
fn schedule(runnable: async_task::Runnable) {
    match crate::runtime::installed() {
        Some(runtime) => runtime.schedule(runnable),                              // gpui's executor, any thread
        None => super::js_set_timeout(Box::new(move || { runnable.run(); }), 0),  // before install: main-thread event loop
    }
}
```

`crates/zs_smol_shim/src/runtime.rs` — `smol::runtime` on wasm32-unknown-unknown (the file is target-neutral and is also compiled natively, unexported, for test 1). This is the surface b7 §3.27 step 2 consumes; it is deliberately the minimum: no `Timer`, no `block_on`, no executor of its own.

```rust
pub use async_task::Runnable;

/// Where `smol::spawn` hands its runnables once the app is up. The entry crate installs one
/// adapter over gpui's `BackgroundExecutor` as the first statement inside `run_embedded`
/// (b7 §3.27 step 2), before any `cx.spawn` or timer.
pub trait Runtime: Send + Sync + 'static {
    /// Run `runnable` (one poll of a `smol::spawn` future) on the runtime's executor. May be
    /// called from any thread, including gpui_web background workers; must not block.
    fn schedule(&self, runnable: Runnable);
}

/// Installs the process-wide runtime. `Err(runtime)` hands the argument back if one is already
/// installed (b7 calls `.ok()` on the result and then asserts `runtime_installed()`).
pub fn install_runtime(runtime: Arc<dyn Runtime>) -> Result<(), Arc<dyn Runtime>>;

/// `true` once `install_runtime` has succeeded.
pub fn runtime_installed() -> bool;

/// `Some` after installation; read by `wasm::spawn::schedule`.
pub(crate) fn installed() -> Option<&'static Arc<dyn Runtime>>;

// static RUNTIME: std::sync::OnceLock<Arc<dyn Runtime>>  (OnceLock works on wasm with +atomics)
```

`GpuiSmolRuntime` — the adapter. Defined here so both briefs agree on its shape; the type **lives in `crates/zed_web`** (b7 §3.27, b7 §5 lists `smol.workspace = true` for it), not in the shim, because the shim must not depend on gpui.

```rust
pub struct GpuiSmolRuntime(pub gpui::BackgroundExecutor);

impl smol::runtime::Runtime for GpuiSmolRuntime {
    fn schedule(&self, runnable: smol::runtime::Runnable) {
        // `Runnable<()>` is `Send`; `BackgroundExecutor::spawn` (executor.rs:117-122) takes a
        // `Send + 'static` future. One poll per gpui task; a pending future re-enters `schedule`
        // through its waker.
        self.0.spawn(async move { runnable.run(); }).detach();
    }
}
```
Install sequence (b7's code, quoted for the contract): `smol::runtime::install_runtime(Arc::new(GpuiSmolRuntime(cx.background_executor().clone()))).ok();` then `assert!(smol::runtime::runtime_installed())` (boot error `runtime_missing`).

`crates/zs_smol_shim/src/wasm/fs.rs` (async-fs 2 surface, sized to section 2)

```rust
pub async fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf>;
pub async fn copy(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<u64>;
pub async fn create_dir(path: impl AsRef<Path>) -> io::Result<()>;
pub async fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()>;
pub async fn hard_link(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<()>;
pub async fn metadata(path: impl AsRef<Path>) -> io::Result<std::fs::Metadata>;
pub async fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>>;
pub async fn read_dir(path: impl AsRef<Path>) -> io::Result<ReadDir>;
pub async fn read_link(path: impl AsRef<Path>) -> io::Result<PathBuf>;
pub async fn read_to_string(path: impl AsRef<Path>) -> io::Result<String>;
pub async fn remove_dir(path: impl AsRef<Path>) -> io::Result<()>;
pub async fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()>;
pub async fn remove_file(path: impl AsRef<Path>) -> io::Result<()>;
pub async fn rename(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<()>;
pub async fn set_permissions(path: impl AsRef<Path>, perm: std::fs::Permissions) -> io::Result<()>;
pub async fn symlink_metadata(path: impl AsRef<Path>) -> io::Result<std::fs::Metadata>;
pub async fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()>;

pub struct DirBuilder { recursive: bool }
impl DirBuilder { pub fn new() -> DirBuilder; pub fn recursive(&mut self, recursive: bool) -> &mut Self; pub async fn create(&self, path: impl AsRef<Path>) -> io::Result<()>; }

pub struct ReadDir { _private: () }
impl futures_lite::Stream for ReadDir { type Item = io::Result<DirEntry>; }   // never constructed; returns Ready(None)

pub struct DirEntry { path: PathBuf }
impl DirEntry {
    pub fn path(&self) -> PathBuf;
    pub fn file_name(&self) -> std::ffi::OsString;
    pub async fn metadata(&self) -> io::Result<std::fs::Metadata>;
    pub async fn file_type(&self) -> io::Result<std::fs::FileType>;
}

pub struct File { path: PathBuf }
impl File {
    pub async fn open(path: impl AsRef<Path>) -> io::Result<File>;
    pub async fn create(path: impl AsRef<Path>) -> io::Result<File>;
    pub async fn sync_all(&self) -> io::Result<()>;
    pub async fn sync_data(&self) -> io::Result<()>;
    pub async fn set_len(&self, size: u64) -> io::Result<()>;
    pub async fn metadata(&self) -> io::Result<std::fs::Metadata>;
    pub async fn set_permissions(&self, perm: std::fs::Permissions) -> io::Result<()>;
}
impl futures_lite::AsyncRead for File {}    // Poll::Ready(Err(unsupported("smol::fs::File")))
impl futures_lite::AsyncWrite for File {}
impl futures_lite::AsyncSeek for File {}

pub struct OpenOptions { read: bool, write: bool, append: bool, truncate: bool, create: bool, create_new: bool }
impl OpenOptions {
    pub fn new() -> OpenOptions;
    pub fn read(&mut self, v: bool) -> &mut Self;  pub fn write(&mut self, v: bool) -> &mut Self;
    pub fn append(&mut self, v: bool) -> &mut Self; pub fn truncate(&mut self, v: bool) -> &mut Self;
    pub fn create(&mut self, v: bool) -> &mut Self; pub fn create_new(&mut self, v: bool) -> &mut Self;
    pub async fn open(&self, path: impl AsRef<Path>) -> io::Result<File>;
}
// No `unix`/`windows` submodules: their only users are `#[cfg(unix)]`/`#[cfg(windows)]` code in
// `fs.rs:696,714,3525` and `install_cli`, none of which is compiled on wasm.
```

`crates/zs_smol_shim/src/wasm/net.rs` (async-net 2 surface, sized to section 2; `net::unix` is needed because `crates/net/src/async_net.rs:1-2` is `cfg(not(target_os = "windows"))`)

```rust
pub use std::net::{AddrParseError, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, SocketAddrV4, SocketAddrV6};

pub struct TcpStream { _private: () }
impl TcpStream {
    pub async fn connect(addr: impl std::net::ToSocketAddrs) -> io::Result<TcpStream>;
    pub fn local_addr(&self) -> io::Result<SocketAddr>;
    pub fn peer_addr(&self) -> io::Result<SocketAddr>;
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()>;
    pub fn nodelay(&self) -> io::Result<bool>;
    pub fn set_nodelay(&self, v: bool) -> io::Result<()>;
    pub async fn peek(&self, buf: &mut [u8]) -> io::Result<usize>;
}
impl Clone for TcpStream {}
impl futures_lite::AsyncRead for TcpStream {}  impl futures_lite::AsyncWrite for TcpStream {}

pub struct TcpListener { _private: () }
impl TcpListener {
    pub async fn bind(addr: impl std::net::ToSocketAddrs) -> io::Result<TcpListener>;
    pub fn local_addr(&self) -> io::Result<SocketAddr>;
    pub async fn accept(&self) -> io::Result<(TcpStream, SocketAddr)>;
    pub fn incoming(&self) -> Incoming<'_>;
}
pub struct Incoming<'a>(std::marker::PhantomData<&'a ()>);
impl futures_lite::Stream for Incoming<'_> { type Item = io::Result<TcpStream>; }

pub struct UdpSocket { _private: () }
impl UdpSocket {
    pub async fn bind(addr: impl std::net::ToSocketAddrs) -> io::Result<UdpSocket>;
    pub fn local_addr(&self) -> io::Result<SocketAddr>;
    pub async fn send_to(&self, buf: &[u8], addr: impl std::net::ToSocketAddrs) -> io::Result<usize>;
    pub async fn recv_from(&self, buf: &mut [u8]) -> io::Result<(usize, SocketAddr)>;
}

pub mod unix {
    pub struct UnixStream { _private: () }
    impl UnixStream {
        pub async fn connect(path: impl AsRef<Path>) -> io::Result<UnixStream>;
        pub fn pair() -> io::Result<(UnixStream, UnixStream)>;
        pub fn shutdown(&self, how: std::net::Shutdown) -> io::Result<()>;
    }
    impl Clone for UnixStream {}
    impl futures_lite::AsyncRead for UnixStream {}  impl futures_lite::AsyncWrite for UnixStream {}

    pub struct UnixListener { _private: () }
    impl UnixListener {
        pub fn bind(path: impl AsRef<Path>) -> io::Result<UnixListener>;   // sync, as in async-net
        pub async fn accept(&self) -> io::Result<(UnixStream, ())>;
    }
}
```

`crates/zs_smol_shim/src/wasm/process.rs` (async-process 2 surface, sized to section 2). The file starts with `#![allow(clippy::disallowed_methods)]` — the `stdin`/`stdout`/`stderr` forwarders call the `std::process::Command` methods `clippy.toml:12-14` bans (only relevant if clippy is ever run for the wasm target).

```rust
pub use std::process::{ExitStatus, Output, Stdio};

pub struct Command { inner: std::process::Command, kill_on_drop: bool, reap_on_drop: bool }
impl Command {
    pub fn new<S: AsRef<OsStr>>(program: S) -> Command;
    pub fn arg<S: AsRef<OsStr>>(&mut self, arg: S) -> &mut Command;
    pub fn args<I, S>(&mut self, args: I) -> &mut Command where I: IntoIterator<Item = S>, S: AsRef<OsStr>;
    pub fn env<K: AsRef<OsStr>, V: AsRef<OsStr>>(&mut self, key: K, val: V) -> &mut Command;
    pub fn envs<I, K, V>(&mut self, vars: I) -> &mut Command where I: IntoIterator<Item = (K, V)>, K: AsRef<OsStr>, V: AsRef<OsStr>;
    pub fn env_remove<K: AsRef<OsStr>>(&mut self, key: K) -> &mut Command;
    pub fn env_clear(&mut self) -> &mut Command;
    pub fn current_dir<P: AsRef<Path>>(&mut self, dir: P) -> &mut Command;
    pub fn stdin<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Command;
    pub fn stdout<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Command;
    pub fn stderr<T: Into<Stdio>>(&mut self, cfg: T) -> &mut Command;
    pub fn kill_on_drop(&mut self, kill: bool) -> &mut Command;
    pub fn reap_on_drop(&mut self, reap: bool) -> &mut Command;
    pub fn get_program(&self) -> &OsStr;
    pub fn get_args(&self) -> std::process::CommandArgs<'_>;
    pub fn get_envs(&self) -> std::process::CommandEnvs<'_>;
    pub fn get_current_dir(&self) -> Option<&Path>;
    pub fn spawn(&mut self) -> io::Result<Child>;                                              // Err(unsupported("smol::process::Command::spawn"))
    pub fn status(&mut self) -> impl Future<Output = io::Result<ExitStatus>> + Send + use<>;   // ready Err
    pub fn output(&mut self) -> impl Future<Output = io::Result<Output>> + Send + use<>;       // ready Err
}
impl From<std::process::Command> for Command {}
impl AsRef<std::process::Command> for Command {}  impl AsMut<std::process::Command> for Command {}
impl std::fmt::Debug for Command {}

pub struct Child { pub stdin: Option<ChildStdin>, pub stdout: Option<ChildStdout>, pub stderr: Option<ChildStderr> }
impl Child {
    pub fn id(&self) -> u32;
    pub fn kill(&mut self) -> io::Result<()>;
    pub fn try_status(&mut self) -> io::Result<Option<ExitStatus>>;
    pub fn status(&mut self) -> impl Future<Output = io::Result<ExitStatus>> + Send + use<>;
    pub fn output(self) -> impl Future<Output = io::Result<Output>> + Send + use<>;
}
pub struct ChildStdin { _private: () }   impl futures_lite::AsyncWrite for ChildStdin {}
pub struct ChildStdout { _private: () }  impl futures_lite::AsyncRead for ChildStdout {}
pub struct ChildStderr { _private: () }  impl futures_lite::AsyncRead for ChildStderr {}

/// async-process's global reaper driver; smol's native `spawn` runs it. Nothing to drive here.
pub async fn driver() {}
```
`+ use<>` matters: the shim is edition 2024 (`Cargo.toml:269-271`), where a bare `impl Future` returned from `fn status(&mut self)` captures the `&mut self` lifetime; async-process is edition 2021 (`async-process-…/0b6d671/Cargo.toml:8`) and its originals (`src/lib.rs:411,441,1159,1181`) do not, so callers may drop the `Command` before awaiting. `use<>` keeps the API identical (the returned futures are `std::future::Ready`, so nothing is captured).

`crates/util/src/paths.rs` — `UrlExt` (section 3 item 8) and the local encode sets:

```rust
/// url 2.5's `PATH_SEGMENT` and `SPECIAL_PATH_SEGMENT` (url/src/parser.rs:20-42), which `url` does not export.
const PATH_SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
    .add(b' ').add(b'"').add(b'<').add(b'>').add(b'`')
    .add(b'#').add(b'?').add(b'{').add(b'}')
    .add(b'/').add(b'%');
const SPECIAL_PATH_SEGMENT: &percent_encoding::AsciiSet = &PATH_SEGMENT.add(b'\\');
```

`vendor/lsp-types/src/uri.rs` — `Uri::from_file_path` (both cfgs), wasm-only `Uri::to_file_path`, and `pub(crate) mod unix_file_path { to_url, from_url }` as in section 3 item 7.

No protocol messages change in this brief.

## 5. Cargo/package changes

Workspace `Cargo.toml` (all verified against the existing tables; nothing else is added to `[workspace.dependencies]` because `async-channel 2.5.0`, `async-fs 2.1`, `async-io 2.6.0`, `async-lock 3.4.2`, `async-process 2.5.0`, `async-task 4.7`, `js-sys 0.3`, `log`, `wasm-bindgen 0.2.120`, `percent-encoding 2.3.2`, `sys-locale 0.3.1`, `time 0.3` already exist at `:534,538,539,540,543,547,667,678,898,742,826,831`):

```toml
# [workspace.members]           (after "crates/ztracing_macro", line 248)
    "crates/zs_smol_shim",

# [workspace.dependencies]      (alphabetical)
async-executor = "1.13"          # after async-dispatcher, line 537
async-net = "2.0"                # after async-lock, line 540
blocking = "1.6"                 # after block = "0.1", line 567

# [workspace] exclude          (new key after the members array's closing "]" at line 266;
#                                b1 appends "vendor/yawc", b6 §3.1 "vendor/alacritty_terminal")
exclude = ["vendor/lsp-types", "vendor/agent-client-protocol"]

# line 680 (existing entry)    — unchanged; shadowed by the [patch] table below (D10)

# [patch."https://github.com/zed-industries/lsp-types"]   (new table immediately before [patch.crates-io], line 976)
lsp-types = { path = "vendor/lsp-types" }

# [patch.crates-io]             (after async-task, line 982)
smol = { path = "crates/zs_smol_shim" }
agent-client-protocol = { path = "vendor/agent-client-protocol" }
```

`crates/zs_smol_shim/Cargo.toml` — full text in section 3 item 5 (`futures-lite = "2.6"` is the one non-workspace pin, on purpose). `src/runtime.rs` needs nothing beyond the wasm table's `async-task` (`Runnable`) and `std::sync::OnceLock`.

`vendor/lsp-types/Cargo.toml:20` — add `percent-encoding = "2.3"` after the `url` line (the only manifest change; the copy is otherwise the `f1783e6` checkout, item 7).

`vendor/agent-client-protocol/Cargo.toml` — the registry-normalised 2.0.0 manifest with `[dependencies.async-io]`, `[dependencies.async-process]`, `[dependencies.blocking]` (`:143-150`) moved under `[target.'cfg(not(target_family = "wasm"))'.dependencies.<name>]` and the `[lints.*]` tables (`:225-258`) removed (item 11); `agent-client-protocol-derive = "2.0.0"` and `agent-client-protocol-schema = "=1.5.0"` stay crates-io dependencies. `vendor/README.md` (item 19) records both crates.

Per-crate manifests (section 3 items 12 and 15): `crates/language/Cargo.toml:76`, `crates/multi_buffer/Cargo.toml:44`, `crates/migrator/Cargo.toml:22`, `crates/edit_prediction_context/Cargo.toml:28`, `crates/languages/Cargo.toml:62`, `crates/settings_json/Cargo.toml:20`, `crates/language_tools/Cargo.toml:35` → target-split `tree-sitter` tables; `crates/time_format/Cargo.toml` → wasm table with `time` (`wasm-bindgen`) and `sys-locale` (`js`).

Cargo.lock: `smol 2.0.2` → path; `agent-client-protocol 2.0.0` → path; `lsp-types 0.95.1` → path (its git source line is dropped). `agent-client-protocol-derive 2.0.0` and `agent-client-protocol-schema 1.5.0` unchanged on crates-io.

No package.json changes. Tooling prerequisites outside cargo: wasi-sdk 25 (`script/download-wasi-sdk`, cached in CI per item 16), and for bundle work later `wasm-bindgen-cli 0.2.120` exactly (`Cargo.lock:20054-20055`).

## 6. Tests

Native (run with the normal toolchain; none of these need wasm):

1. `crates/zs_smol_shim/src/lib.rs` `#[cfg(all(test, not(target_family = "wasm")))] mod native_tests`: `type_identity` — `fn f(t: smol::Task<u8>) -> async_task::Task<u8> { t }` and `fn g(t: smol::Timer) -> async_io::Timer { t }` compile; `spawn_and_timer` — `smol::block_on(async { let t = smol::spawn(async { 1 + 2 }); smol::Timer::at(Instant::now() + Duration::from_millis(5)).await; assert_eq!(t.await, 3) })` (`Timer::at`, because `clippy.toml:15` bans `smol::Timer::after` and `script/clippy` lints this module with `--deny warnings`); `fs_roundtrip` — `smol::fs::write` then `read_to_string` in a `tempfile::tempdir()`; `process_output` — `smol::process::Command::new("true").output().await` succeeds on unix. These prove the facade is smol. In the same crate, `src/runtime.rs` `#[cfg(test)] mod tests`: `runtime_install_once` — `install_runtime(Arc::new(CountingRuntime::default()))` is `Ok(())`, `runtime_installed()` flips to `true`, a second `install_runtime` returns `Err` carrying the rejected runtime, and `installed().unwrap().schedule(runnable)` for a `async_task::spawn(async { 1 }, |_| {})` runnable runs it exactly once (`CountingRuntime` calls `runnable.run()` inline and counts).
2. `crates/util/src/paths.rs` tests, next to `:3084-3290`: `test_url_from_file_path_ext_unix_matches_url` — on `cfg(unix)`, for `/`, `/a`, `/a/b c`, `/tmp/100%.txt`, `/x/#?{}\`y`, `/ünïcode/日本`, `/a/./b`, assert `Url::from_file_path_ext(p, PathStyle::Unix) == Url::from_file_path(p)`; `test_url_from_file_path_ext_unix_rejects_relative` (`"a/b"` → `Err`); `test_url_from_file_path_ext_rejects_parent_dir` — `"/a/../b"` → `Err(())` for `Unix` and `C:\a\..\b` → `Err(())` for `Windows` (documents the divergence from `url`, which would write `..` raw); `test_url_from_file_path_ext_windows_drive` (`C:\Users\x y` → `file:///C:/Users/x%20y`), `_unc` (`\\srv\share\f` → `file://srv/share/f`), `_rejects` (`C:relative`, `\\?\C:\x`); `test_url_file_path_ext_roundtrip` — `to_file_path_ext(style)` of `from_file_path_ext(p, style)` returns `p` for both styles.
3. `vendor/lsp-types/src/uri.rs` tests: `unix_file_path::to_url` equals `url::Url::from_file_path` for the table in test 2 minus the `..` case (on `cfg(unix)`), `to_url("/a/../b")` is `Err(())`, `unix_file_path::from_url` equals `Url::to_file_path` for `file:///home/u/a%20b`, `file://localhost/x`, `https://localhost/x` (both `Ok`: no scheme check, matching `url`), rejects `file://host/x`; the existing `test_from_file_path*` at `:348-407` stay green. Run from Zed as `cargo test -p lsp-types` (allowed for a non-member: the crate has no dev-dependencies) and standalone as `cargo test --manifest-path vendor/lsp-types/Cargo.toml` (works because of `[workspace] exclude`, item 4; the `tests/lsif.rs` integration test runs there too).
4. `vendor/agent-client-protocol`: `cargo test --manifest-path vendor/agent-client-protocol/Cargo.toml` runs the crate's own 16 `tests/*` unchanged (native gates are no-ops; the first run resolves the crates-io dev-dependencies clap/expect-test/tokio/tokio-util against the vendored `Cargo.lock`, so it needs network once). From the Zed workspace `cargo test -p agent-client-protocol` is refused (non-member with dev-dependencies, section 2); `cargo check -p agent-client-protocol` from Zed works and is what test 7 uses.
5. Manifest invariants (shell, in CI's `check-wasm` job and the rebase check): `cargo tree --target wasm32-unknown-unknown -e normal -p language -i wasmtime-c-api-impl` prints "nothing to print" (feature gone); `! cargo tree --target wasm32-unknown-unknown -e features -p language -i tree-sitter | grep -q 'tree-sitter feature "wasm"'`; the same with the feature set `zed_web` will use, `-p languages --features load-grammars` (and, once it exists, `-p zed_web`), which is what catches `grammars/test-support` or a dev-dependency sneaking wasmtime back in; `cargo tree -p zed -e features -i tree-sitter | grep -q 'feature "wasm"'` (native keeps it); `cargo metadata --format-version 1 | jq -r '.packages[] | select(.name=="smol") | .source'` is `null` (path) and there is exactly one `smol`; `cargo tree -e normal -p repl -i smol` still resolves (runtimelib keeps compiling against the facade); `cargo metadata --no-deps` lists `smol` among the workspace members; `cargo metadata --format-version 1 | jq -r '.packages[] | select(.name=="lsp-types" or .name=="agent-client-protocol") | .source'` prints `null` twice (both path, D10) while `select(.name=="agent-client-protocol-derive") | .source` is the crates-io registry, and `cargo metadata --no-deps` lists neither vendored crate among the members (excluded, item 4).

Browser target (`script/check-wasm`, compile-only; they are the acceptance tests for this brief):

6. Baseline unchanged: `script/check-wasm -p gpui_platform -p cloud_api_client` passes before and after every step (this is upstream's job), including with `../.cargo/config.toml` set to `ci-config.toml` (item 16).
7. After items 4-6: `script/check-wasm -p smol` passes; after 7-10: `-p util -p paths -p lsp-types`; after 11: `-p agent-client-protocol` (these two are also the first `-p` on an excluded, non-member path patch — expected to work per section 2's `scratch` analysis; if cargo refuses, list the two crates in `[workspace.members]` instead of `exclude` and accept risk 9's consequences); after 12-14: `-p language_core -p settings_json -p migrator` and `-p language`. `-p language` is expected to fail first on `settings` (`settings_store.rs:372,376` call the wasm-less `BackgroundExecutor::block_on`, section 2) and then on `fs`/`http_client` surface — record which; the goal for this brief is that no error mentions `wasmtime`, `polling`, `async-io`, `async-process`, `from_file_path`, or `to_file_path`.
8. `script/check-wasm --release -p smol`; `RUSTFLAGS=x script/check-wasm` (must exit 2 with the guard message); `cargo xtask web-examples` still builds an example after item 17.
9. `cargo check -p zed` (native), `cargo test -p smol -p util -p lsp-types`, `script/clippy -p smol -p util` produce no new warnings under `.cargo/ci-config.toml`'s `-D warnings`; the two `--manifest-path` runs of tests 3-4; and `cargo check -p lsp-types -p agent-client-protocol` natively plus `script/check-wasm -p lsp-types -p agent-client-protocol` under the same `-D warnings` config (path-sourced, uncapped: item 16, risk 14).

Runtime behaviour of the wasm stubs (needs a browser harness; `crates/gpui/Cargo.toml:150-152` shows upstream uses `wasm-bindgen` dev-dependencies on wasm but no runner is wired in CI, so these are manual until the `zed_web` brief lands its Playwright smoke test): a page that asserts `smol::fs::metadata("/")` yields `ErrorKind::Unsupported`, `smol::net::TcpStream::connect("127.0.0.1:1")` yields `Unsupported` rather than hanging, `smol::process::Command::new("sh").output().await` yields `Unsupported`, `smol::spawn(async { 1 })` resolves from the main thread before any runtime is installed, `smol::runtime::install_runtime` returns `Ok` once and `Err` on a second call, and after `zed_web` has installed `GpuiSmolRuntime` a `smol::spawn` issued from a gpui_web background worker resolves (it runs on gpui's executor, not on `setTimeout`, which that worker never services).

## 7. Risks and open questions

1. **Toolchain choice.** The brief uses the pinned stable `1.97.1` with `RUSTC_BOOTSTRAP=1` for `-Zbuild-std` (what upstream's `check_wasm` effectively does, `run_tests.rs:500-509`). `-C target-feature=+atomics` is an unstable target feature: rustc 1.97.1 prints `warning: unstable feature specified for -Ctarget-feature: atomics` once per invocation, with and without `RUSTC_BOOTSTRAP=1`, and `-D warnings` leaves the exit status at 0 (verified with `rustc --target wasm32-unknown-unknown --emit=metadata -D warnings …`). It is noise, not a CI risk; `ZS_WASM_TOOLCHAIN=nightly-…` silences it and BUILD-SPEC 11.2 wants a hash-pinned nightly eventually.
2. **`[env] relative = true` and `cc` parsing.** `cc` splits `CC_*` on whitespace to allow `ccache clang`; a checkout path containing spaces breaks the wrapper reference. Zed CI paths are space-free; document it. `AR_wasm32_unknown_unknown` is required (section 2, `cc-1.4.3/src/lib.rs:3699-3712`): without it cc-rs looks for `llvm-ar` through the wrapper's `-print-search-dirs`, and on macOS there is no `llvm-ar` on `PATH` to fall back to.
3. **4 GiB `--max-memory` on Safari** (BUILD-SPEC risk 4). `hello_web` uses 1 GiB; the fork shipped 4 GiB. Keep 4 GiB in config and verify in the month-one Safari pass; fall back per-bundle rather than in the shared config.
4. **`[build].rustflags` are dropped for the wasm target** (cargo precedence). Repeating `symbol-mangling-version=v0` and `tokio_unstable` keeps parity; if anyone later adds a flag to `[build]`, it must be mirrored. Upstream's Windows table already has this property.
5. **Patch scope.** `[patch.crates-io] smol` replaces smol for `runtimelib` and every native crate too; the native side is byte-equivalent to smol 2.0.2, but `cargo shear`/`check_cargo_lock` (`run_tests.rs:461-463,487`) may flag the shim's re-export-only dependencies and the lockfile churn; run them locally. The "renamed dependency on the real smol" variant would need a git source (a registry 2.x conflicts with the patched 2.0.2; a git 2.0.2 coexists — both verified in a scratch workspace); it was rejected for adding a second `smol` to the graph, not for any lockfile impossibility.
6. **`spawn` off the main thread.** Before a runtime is installed, the wasm `spawn` schedules through `setTimeout(0)`, which a gpui_web background worker never services (`dispatcher.rs:184-205`); the shim logs a warning when used there. b7 §3.27 step 2 installs `GpuiSmolRuntime` (section 4) as the first statement inside `run_embedded` and asserts `smol::runtime::runtime_installed()` (boot error `runtime_missing`), so in the running app every `smol::spawn` lands on gpui's background executor from any thread. The `runtime` module is exactly what b7 consumes — a trait, an install-once slot and a query — and nothing more: no `Timer` (nothing calls one; `clippy.toml:15` already pushes timers to gpui), no `block_on`, no executor of its own. The only compiled caller is dead code in `git`; a live caller should still prefer `cx.background_spawn`.
7. **Not exporting `block_on`/`unblock`/`Unblock`/`Async`/`Timer` on wasm** couples `fs` to the fs brief: `fs` compiles on wasm only after `RealFs` (`fs.rs:884,928,945,3542`) is gated, which that brief must do anyway (`notify`, `libc`, `std::fs`). Every other crate in the browser set compiles against the reduced surface today (section 2 inventory).
8. **Duplicated Unix file-URL logic** in `util::paths` and the vendored `lsp-types` (lsp-types cannot depend on `util`). Both are tested against `url` natively; keep them in sync, and upstream the lsp-types change so the vendored copy can be dropped. Both reject `..` (native `url` writes it raw; `Url::parse` would resolve it), so a non-normalised path fails loudly instead of naming a different file on desktop and browser; non-UTF-8 paths are rejected on wasm (they cannot exist there).
9. **Vendored-copy drift (D10).** On rebase, an upstream rev bump at `Cargo.toml:680` no longer conflicts textually (the line is untouched) but is silently shadowed by `vendor/lsp-types` for as long as the version stays 0.95.1; an `agent-client-protocol` bump at `:521` beyond `=2.0.0` makes cargo report the patch as unused. The rebase check (item 18) compares both pins against the revisions recorded in `vendor/README.md` and fails on a mismatch; the fix is to re-copy the new upstream and re-apply the recorded diff. D10 made the path form the baseline and the git form the recorded exit path: when forks exist, the two patch entries become `git` + `rev` and `vendor/<name>` is deleted with no other change. The vendored crates are excluded non-members (section 2, item 4), so `script/clippy --workspace --all-targets --all-features -- --deny warnings`, `cargo shear`, `cargo test --workspace` and xtask package-conformity do not treat them as ours — but being path-sourced they compile uncapped (risk 14). Listing them in `[workspace.members]` instead is the fallback only if `-p` on an excluded path patch turns out not to work (test 7), at the cost of exactly those four tools treating third-party code as Zed's.
10. **Remaining OS-bound edges not covered by these shims** (for the per-crate briefs): gpui `block_on` callers (`settings`, `agent_ui`, `project_symbols`, `tabular_data_preview`, section 2 — rewrite as async, or `block_on` only under `cfg(not(target_family = "wasm"))` with a wasm branch that awaits); `crates/languages/Cargo.toml:24` direct `async-fs` (hangs, not errors — gate it like `crates/util/Cargo.toml:49-54`, and reject new direct `async-fs` dependencies in browser-set crates); `alacritty_terminal → polling` (the `compile_error!` that kills `terminal`, terminal brief); `repl → runtimelib → zeromq/async-std` and `aws-lc-sys` (repl brief); `rustls`/`ring` and `aws-config` behind `client` and `agent` (their briefs); `crates/net/src/net.rs:16` `std::os::unix::net`; `crates/project/src/debugger/locators/cargo.rs:9` `util::command` (gated out on wasm); `crates/dap/src/adapters.rs:321-324` (uses `util::archive`, gated out); `crates/language/src/language_registry.rs` grammar loading (replaced by the linker brief); `crates/extension_host` and `crates/extension_cli` (`wasmtime`); and the `std::time::Instant` swaps listed in section 2 — `rpc` (`peer.rs`, `message_stream.rs`) and `remote` first, since b1's heartbeat/reconnect path cannot run until they land.
11. **getrandom 0.2** is already in the browser closure (fastrand via `scheduler`'s `flume` and the shim's `async-executor`) and compiles only because fastrand's target table enables its `js` feature. That unification also covers `ring` if `rustls`/`aws-config` reach the wasm graph before being gated; the blocker there is `ring`'s C/asm, not getrandom. No `zed_web`-side feature is needed unless fastrand ever drops that table dependency.
12. **fastrand seeding on wasm** does not panic: without `js` it seeds from a constant, with `js` from getrandom (section 2). Only entropy quality, not correctness, would change if `js` went away.
13. **Grammar scanner symbols.** The tree-sitter runtime's wasm libc subset covers the 25 symbols in `imports.txt`; a bundled grammar whose `scanner.c` uses anything else (`strtol`, `qsort`, `iswcntrl`, …) will fail to link and needs wasi-libc's `libc.a` or a shim — the tree-sitter brief owns this, but `script/wasm-cc` already provides the headers. b6 §7 item 1 flags the related link-time hazard: `sqlite-wasm-rs` vendors a musl subset (`strlen`, `strcmp`, `qsort`, `memchr`, …; `memcpy`/`memset`/`memmove` come from `compiler-builtins`) and a wasi-libc `libc.a` added for grammar scanners would define the same symbols; wasm-ld errors only on duplicate strong definitions actually pulled into the link, so this is settled on the first full link (b7's bundle), not in `script/wasm-cc`, which stays symbol-agnostic.
14. **`-D warnings` reaches the wasm check for the first time with item 16.** `gpui_platform` and `cloud_api_client` have never been compiled for wasm with warnings denied; item 16 requires the local run first. Path-sourced crates are compiled without `--cap-lints allow` whether or not they are workspace members, so the shim **and both vendored crates (D10)** must be warning-free natively and on wasm under `-D warnings`; git-sourced dependencies are capped like any other. That is why item 11 deletes upstream's `[lints]` tables from `vendor/agent-client-protocol/Cargo.toml` (their warn-level `unused`, `missing_debug_implementations`, `rust_2018_idioms`, … would become errors) and item 16 extends the local `-D warnings` run to `-p lsp-types -p agent-client-protocol`; `vendor/lsp-types` (edition 2018, bitflags 1) has no lints table, and any rustc-default warning it raises on 1.97.1 is fixed in the copy and recorded in `vendor/README.md`. Whether cargo applies a non-member path package's `[lints]` table at all is not verified here (risk 20); deleting the tables is correct either way.
15. **Feature unification of tree-sitter `wasm`.** `grammars/test-support` (`crates/grammars/Cargo.toml:60`) and `languages`'s dev-dependency (`:81`) re-enable wasmtime for any build that activates them. `script/clippy`'s `--all-features --all-targets` is native-only and unaffected; a `zed_web` profile that turns on any `test-support` feature reaching `grammars` would drag wasmtime back into the wasm graph. Test 5's exact-feature-set invariant is the guard; a `compile_error!` cannot see a transitive feature.
16. **Path patches are not members.** The shim is listed in `[workspace.members]`; the two vendored crates are named in `[workspace] exclude` (D10, item 4). Anyone adding another path patch must pick one of the two: listed (Zed code — linted, tested and `-D warnings`-checked by `script/clippy`) or excluded (third-party — `-p`-checkable from Zed, tested standalone with `--manifest-path`); an entry that is neither works for `-p` but cannot run its own tests. The `scratch` panic that first motivated this risk is cargo's host-only-package failure (section 2), not a rule about path patches.
17. **Central `std::time::Instant` enforcement (recommendation for after the swaps).** Add `disallowed-types = [{ path = "std::time::Instant", replacement = "web_time::Instant", reason = "Instant::now() panics on wasm32-unknown-unknown" }]` to `clippy.toml:20-25` once the per-crate briefs have done their swaps; it is a native no-op (`web_time::Instant` is `std::time::Instant` there) and mirrors what upstream did in `scheduler`/`gpui`/`ui`/`gpui_web`. Not done here because ~45 files across native-only crates (`gpui_linux`, `gpui_windows`, `remote_server`, benchmarks, …) would each need a swap or an `#[allow]` first.
18. **Windows contributors.** `CC_wasm32_unknown_unknown` is a bash script, so a wasm build from a Windows checkout fails inside `cc` with an opaque error; native Windows builds are untouched. `script/check-wasm` refuses on `MINGW*/MSYS*/CYGWIN*` with a clear message; the `[env]` comment says "macOS/Linux only".
19. **Out of scope, and the touchpoints other briefs depend on.** Reconnect, takeover, resume with a changed URL, token expiry mid-session, unsaved buffers, large files and path traversal involve no change here: no protocol messages change; heartbeat and reconnect use gpui timers, never smol; `time`'s `wasm-bindgen` feature only affects blame/commit timestamps. b1/b2 depend on (a) the `std::time::Instant` swaps in `rpc` and `remote` (risk 10) and (b) the guarantee that `smol::net`/`smol::process` stubs return `Unsupported` immediately, so an accidental use in transport code surfaces as an error, not a hang. b7 depends on (c) `smol::runtime::{Runtime, Runnable, install_runtime, runtime_installed}` on wasm (section 4) and on the `.cargo/config.toml` block accepting its one extra `--export=__wasm_call_ctors` line (item 2); b6 depends on (d) `script/wasm-cc`'s `-m` flags (item 1) and on `smol::future`/`smol::io` staying unconditional (item 6); b3 depends on (e) the wasm `smol::process::Command` type keeping `exec_in_shell`'s signature (section 2). D1-D9 and D11-D20 change none of these touchpoints (section 9).
20. **Not verified in this session:** no wasm `cargo check`/`build` was run, so line-exact compile behaviour of the stubs and `cc`'s handling of the wrapper through `-print-search-dirs` remain to be confirmed by the first `script/check-wasm` run. Also unverified, because the D10 reconciliation pass ran no cargo commands: that `cargo check -p <excluded path patch>` works (expected, since the `scratch` panic is the host-only case; test 7 names the fallback), that `cargo test --manifest-path vendor/<name>/Cargo.toml` runs standalone under `exclude` (cargo's documented behaviour), and whether cargo applies a non-member path package's `[lints]` table (item 11 deletes it regardless). Verified this session: the `+atomics` warning under `-D warnings` (risk 1), the three same-name-package experiments (section 2), `cargo check -p scratch` panicking, `cargo check -p async-process` succeeding and `cargo test -p async-process` being refused; and, in the reconciliation pass, that `scratch`'s only dependents are `cxx-build` and `webrtc-sys-build` (`Cargo.lock:4576,20811`, both build-dependencies), the registry layout of `agent-client-protocol-2.0.0` (section 2: `.cargo_vcs_info.json`, `derive` as a version dependency, crates-io dev-dependencies, `[lints]` tables at `:225-258`), the `f1783e6` lsp-types checkout layout (no dev-dependencies, no lints table), getrandom 0.3.4 requiring the feature on both routes (`backends.rs:36-44,194-199`), and `BackgroundExecutor::spawn`'s `Send + 'static` bound (`executor.rs:117-122`) that the `GpuiSmolRuntime` adapter relies on. The rust-lld behaviour behind item 17 (shared-memory link refusing non-atomics objects) and wasm-ld accepting mixed atomics/non-atomics C objects (item 1) are taken from the reviewers' runs, not reproduced.

## 8. Review log

Each finding from the two adversarial reviews, with what was done. "R1" = first reviewer, "R2" = second reviewer.

Wrong claims

1. R1 — fastrand seeds from `Instant::now()` on wasm. **Accepted.** `global_rng.rs:189-201` is `cfg(not(wasm32/wasm64 + target_os = "unknown"))`; on wasm `random_seed()` returns `None` (or uses getrandom under `js`). Section 2 bullet and risk 12 rewritten.
2. R1 — getrandom 0.2.16 reverse deps: `ring` via rustls/aws-config natively; on wasm via fastrand ← async-executor/flume, kept by the shim. **Accepted** (both `cargo tree` runs reproduced; `-p gpui_platform` also shows it). Section 2 getrandom bullets and risk 11 rewritten.
3. R1 — getrandom 0.4.1 comes from `wasmtime-wasi` ← `extension_host`, not from tree-sitter's `wasm` feature. **Accepted** (reproduced). Section 2 corrected.
4. R1/R2 — `[patch]` path packages are not workspace members; `cargo -p` on one panics. **Accepted** (253 members without `scratch`; `cargo check -p scratch` panics with `did not find features for … NormalOrDev`). Item 4 rewritten; the two forks moved to git sources (see "missing" 1 below); risk 16 added. *Refined in the D10 pass (section 9): the `scratch` panic is cargo's host-only-package failure — `scratch` is reachable only through `cxx-build`/`webrtc-sys-build` build-dependencies — so it says nothing about `-p` on a path patch in the normal graph; the membership finding stands.*
5. R1/R2 — `crates/language/build.rs` citation points at Zed's 5-line `ZED_BUNDLE` script, not the tree-sitter checkout's `tree-sitter-language` build script. **Accepted.** Section 2 tree-sitter bullet and the `wasm-cc` comment corrected.
6. R1 — `python.rs` already imports `PathStyle` at `:39`; adding `use util::paths::{PathStyle, UrlExt};` duplicates it (E0252). **Accepted.** Item 9 now edits line 39.
7. R1 — `crates/agent/Cargo.toml:89` `async-io` is a dev-dependency. **Accepted** (`[dev-dependencies]` at `:87`; `cargo tree -i async-io` lists no `agent`). Removed from risk 10; section 2 notes it is test/eval-only.
8. R1 — smol has 23 dependents, not 24. **Accepted.**
9. R1 — tree-sitter has 11 dependents (12 with `--workspace`). **Accepted.**
10. R1 — 29 `smol::block_on` occurrences in util, not 27. **Accepted.**
11. R1 — `lsp.rs:1934,1939` are `cfg(any(test, feature = "test-support"))`, and editor has an occurrence in `test/editor_lsp_test_context.rs` (same cfg). **Accepted**, with one refinement: my grep counts 59 editor hits because `clangd_ext.rs:86` already uses `to_file_path_ext`; section 2 now lists 1 live + 1 already-correct + 57 test/test-support.
12. R1 — `log` is at `Cargo.toml:678`, `lsp-types` at `:680`. **Accepted.**
13. R1 — `RUSTC_BOOTSTRAP` at `run_tests.rs:509`; `check_cargo_lock` defined at `:461`, used at `:487`. **Accepted.**
14. R1 — acp `rustix` table at `:213-219`, `windows-sys` at `:221-223`. **Accepted**; item 11 now cites the source-repo manifest (`Cargo.toml.orig:48-56`) since the fork edits that file, not the registry-normalised one. *Under D10 it is the other way round: the vendored copy edits the registry-normalised `Cargo.toml` (`:143-150`, `:225-258`), and the `Cargo.toml.orig:48-56` form is recorded in `vendor/README.md` as the upstream-PR form (item 11).*
15. R1 — fork `url` vendoring is 3,261 lines (`lib.rs`) / 8,423 total, not 6,500. **Accepted.**
16. R1 — fork `smol_wasm` totals 1,760 lines, not "1,791 wasm side". **Accepted.**
17. R1 — `script/download-wasi-sdk` uses `#!/bin/bash`. **Accepted.**
18. R1 — `std::os::unix::net` re-export is `net.rs:16`. **Accepted.**
19. R1 — `UrlExt` impl ends at `paths.rs:1467`; lsp-types tests span `uri.rs:109-459`, `test_from_file_path*` at `:348-407`. **Accepted.**
20. R1 — tree-sitter `wasmtime-c-api` features are `cranelift, gc, gc-null`; there is no `regex` feature. **Accepted.** Item 12 and section 2 corrected.
21. R1 — `std::time::Instant` file counts were not reproducible. **Accepted**; replaced with the reviewer's grep (reproduced) and the command itself, noting fully-qualified uses are not counted.
22. R2 — getrandom 0.3.4 selects `wasm_js` from the feature alone (`backends.rs:188-200`); the cfg is not load-bearing. **Accepted.** Rationale fixed in section 2 and the config comment; the line is kept as parity with the fork.
23. R2 — `+atomics` warning survives `-D warnings` (exit 0) with and without `RUSTC_BOOTSTRAP`. **Accepted and reproduced** with rustc 1.97.1. Risk 1 rewritten as noise.
24. R2 — a crates-io `real_smol = { package = "smol", version = "=2.0.1" }` would resolve without collision. **Rejected**: in a scratch workspace with the path patch, cargo fails with `all possible versions conflict with previously selected packages` (one semver-compatible version per registry source). However the brief's own claim that a **git** source at the same version "cannot both be written unambiguously" was also wrong: a git `smol 2.0.2` next to the path patch resolves and locks fine (only a second *path* package collides). Item 5's design note and risk 5 now state the verified facts; the facade design is unchanged.
25. R2 — `AR_wasm32_unknown_unknown` is required, not optional: cc-rs looks for `llvm-ar` next to a clang-like compiler for wasm32 and otherwise gives up. **Accepted** (`cc-1.4.3/src/lib.rs:3699-3712`, `tool.rs:140-163`). Risk 2 and the `[env]` comment rewritten.
26. R2 — `smol::fs::unix` stub is unused (only `#[cfg(unix)]` fs.rs:696 and `install_cli`). **Accepted**; the `unix` module is dropped from `wasm/fs.rs`; `net::unix` is kept (`async_net.rs:1-2` is `cfg(not(windows))`).
27. R2 — today's wasm job never sees `-D warnings` because `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS` outranks `target.*` tables; item 16 turns it on and must not be deferrable. **Accepted.** Section 2 ci-config bullet, item 16 (required, local run first) and risk 14.

Missing items

1. R2 — carry the two modified crates as git forks, matching `Cargo.toml:981-989`, rather than `vendor/` path patches. **Accepted**, with one correction to the reviewer's expectation: a git-sourced non-member is `cargo check -p`-targetable (verified with `async-process`) but `cargo test -p` on it is refused when it has dev-dependencies (verified: "cannot be tested because it requires dev-dependencies and is not a member of the workspace"), so ACP's tests run in its fork repo; lsp-types has no dev-dependencies and can be tested from Zed. Items 4, 7, 11, section 5, tests 3-4/7/9 and risk 9 rewritten; the source commit for ACP 2.0.0 (`ce023279`, `src/agent-client-protocol`) and the fork's `derive` path dependency are documented. *Superseded by D10 (section 9): until a fork exists both crates are vendored under `vendor/` as excluded, non-member path patches; the git form this entry describes is recorded in `vendor/README.md` as the exit path, and the vendored ACP copy takes `derive` from crates-io rather than as a path dependency.*
2. R1 — `language_registry.rs` wasm arm leaves `wasm_path` unused under `-D warnings`. **Accepted** (the pattern binding at `:838`; `this` at `:840` is inside the wrapped body, so only `wasm_path` matters). Item 14 uses it in the error message.
3. R1/R2 — `crates/languages/Cargo.toml:24` unconditional `async-fs`, hangs rather than errors on wasm. **Accepted**; section 2 and risk 10.
4. R1 — `async-std`/`async-tar` survey. **Accepted**; section 2 (not a compile break).
5. R1 — edition-2024 capture rules on the `impl Future` returns. **Accepted**; `+ use<>` added in section 4 with the reason.
6. R1 — `Unblock<T>` forwarding needs `T: Unpin`. **Superseded**: `Unblock`, `unblock`, `Async`, `block_on` are no longer exported on wasm (R2's "fail at compile time" item), so the type does not exist there.
7. R1 — vendored patches' tests would not run under `--workspace`. **Accepted** via the git-fork decision (section 6 says where each suite runs). *Under D10 the vendored copies are excluded non-members, so `--workspace` still does not run their tests; they run with `--manifest-path` (tests 3-4).*
8. R1 — the fork also exported `__heap_base`, `__stack_pointer`, `__wasm_call_ctors`; say why we drop them. **Accepted**; section 2 explains what `__wasm_call_ctors` was for in the fork and defers the decision to the bundle brief.
9. R1 — getrandom 0.2 is kept compiling only by fastrand's `js` feature. **Accepted**; section 2 and risk 11.
10. R1 — inventory omissions (`fs::windows::symlink_file`, node_runtime `lock::Mutex`). **Accepted**; also added the direct dependents the inventory skipped (auto_update_ui, dap_adapters, install_cli, miniprofiler_ui, repl, zed) — `repl`'s `smol::net` use is in the browser set and is now listed.
11. R2 — `cargo xtask web-examples` regresses once the root config gains wasm rustflags. **Accepted** (reasoning verified from `web_examples.rs:65-75`, no `-Zbuild-std`; the rust-lld message is from the reviewer's run). Item 17 added; hello_web confirmed to be its own workspace.
12. R2 — the `WasmRuntime`/`Timer` machinery has no callers; do not export `Timer` on wasm; keep `spawn` minimal. **Accepted** (no `smol::Timer` anywhere in `crates/`; `clippy.toml:15` bans `Timer::after`; the sole `smol::spawn` in the browser set is `repository.rs:3809`). `runtime.rs`, `timer.rs`, the gpui adapter and the old risk 6 are gone; the wasm side exports `fs`, `net`, `process`, `spawn`. *Partially reinstated by b7's delta (section 9): b7 §3.27 installs gpui's executor through `smol::runtime::install_runtime` and asserts `runtime_installed()`, so a minimal `runtime` module (trait, install-once slot, query; `src/runtime.rs`) and the `GpuiSmolRuntime` adapter definition return (item 6, section 4, risk 6); `Timer`, `block_on` and any shim-owned executor stay out, as R2 asked.*
13. R2 — wasm `block_on` (and `unblock`/`Unblock`/`Async`) should fail at compile time, not trap at runtime. **Accepted**; not exported on wasm; risk 7 records the coupling to the fs brief.
14. R2 — gpui `BackgroundExecutor::block_on`/`ForegroundExecutor::block_on` are `cfg(not(wasm))`; `settings` is the first expected failure for `-p language`. **Accepted** (`executor.rs:444-447`, `scheduler/executor.rs:109-110`, call sites verified). Section 2, test 7 and risk 10.
15. R2 — direct `async-fs` users hang (blocking's `grow_pool`). **Accepted** (same as missing 3; `blocking-1.6.2/src/lib.rs:326-345` verified).
16. R2 — risk 10 misses `alacritty_terminal → polling`, `repl → runtimelib → zeromq/async-std` + `aws-lc-sys`, `rustls → ring`, and `rpc`'s `Instant` uses. **Accepted** (all four reproduced with `cargo tree --target wasm32-unknown-unknown --workspace`). Section 2 and risk 10.
17. R2 — enforce the `Instant` swap centrally with `clippy.toml` `disallowed-types`. **Partially accepted**: recorded as risk 17 (recommendation) to be applied after the per-crate swaps, because ~45 files including native-only crates would each need a swap or `#[allow]` first; not a change item of this brief.
18. R2 — clippy `disallowed_methods` bites the shim (`Timer::after` in the test; `Command::{stdin,stdout,stderr}` forwarders); package-conformity reports `futures-lite`. **Accepted**: test 1 uses `Timer::at`; `wasm/process.rs` carries `#![allow(clippy::disallowed_methods)]`; item 5 notes the package-conformity report (not in CI) and the optional workspace alias.
19. R2 — feature-unification hazard for tree-sitter `wasm` via `grammars/test-support` and dev-dependencies. **Accepted**; item 12, test 5 exact-feature-set invariant, risk 15.
20. R2 — `Uri::from_file_path` on wasm would silently normalise `..`; return `Err` instead, keep `from_url` without a scheme check. **Accepted** (verified `url` writes `..` raw and `to_file_path` has no scheme check, `lib.rs:2726-2733`, `path_segments.rs:236-247`). Item 7 (`..` → `Err`, no scheme check), item 8 (util helper made consistent), tests 2-3, risk 8. One wording fix on the reviewer's side: url's Windows arm does not itself reject `.`/`..`; the rejection is this brief's rule for both helpers.
21. R2 — `script/wasm-cc` should pass `-matomics -mbulk-memory -mmutable-globals`. **Accepted** (advisory; the link behaviour is from the reviewer's run, not reproduced).
22. R2 — no change item creates the rebase check; item 16 must be required; cache wasi-sdk. **Accepted**: item 16 required with the cache step, item 18 defines the script contract, risk 9 names what the check compares.
23. R2 — say explicitly that reconnect/takeover/etc. are outside b5 and name the b1/b2 touchpoints. **Accepted**; risk 19.
24. R2 — Windows contributors and the bash `[env]` compiler. **Accepted**; `check-wasm` refuses on MINGW/MSYS/CYGWIN, `[env]` comment, risk 18.

## 9. Reconciliation log

Against `docs/briefs/DECISIONS.md` (D1-D20) and the sibling briefs' sections 7 and 8 (every mention of b5 in b1-b9 was read; b1, b2, b4, b8 and b9 address nothing to this brief — b8 §8 item 4 retracts an earlier misattribution of the activity ping to b5). Nothing was shortened; review-log entries that a decision or delta supersedes carry an italic note instead of being deleted. Everything added was checked against the checkout (section 2 cites the lines; risk 20 lists what was and was not verified).

Decisions

| Decision | Touches this brief? | What changed |
|---|---|---|
| D1 identity, D2 reconnect budget, D3 session semantics, D4 terminal restore, D5 control listener, D6 unsaved buffers, D7 client-state store, D8 private ports, D9 rebuild tarball | No — protocol, server, persistence and platform contracts owned by b1/b2/b3/b4/b6/b7/b8/b9; this brief changes no message, route, env var, file path or persistence shape (risk 19 already said so) | Nothing; risk 19 re-read against D1-D9 and still accurate, and now says so. |
| **D10 vendored dependencies** | **Yes** — both third-party crates this brief modifies | `lsp-types` and `agent-client-protocol` moved from "git fork + rev" to `vendor/lsp-types` and `vendor/agent-client-protocol` path patches: intro and Goal; section 2 (the `f1783e6` checkout and the `agent-client-protocol-2.0.0` registry directory documented as the vendoring sources; workspace-layout bullets: first `vendor/` and first `[patch."<git url>"]` table, `exclude`, corrected `scratch` analysis, uncapped lints); item 4 (six edits: `exclude`, `[patch."https://github.com/zed-industries/lsp-types"]`, two path entries, `:680` unchanged, lockfile); items 7 and 11 rewritten for the vendored copies (registry-normalised manifest edits, `[lints]` removal, README records, upstream-PR forms); item 16 (`-D warnings` run extended to the vendored crates); item 18 (rebase check compares pins with README); new item 19 (`vendor/README.md`); section 4 tail; section 5; tests 3, 4, 5, 7, 9; risks 8, 9, 14, 16, 20; review-log notes on wrong-claim 4 and missing 1/7. Every GitHub-organisation placeholder removed from the patch entries, item headings, section 4/5, tests and risks (the `fork:` prefix that remains is the citation for the community fork used as evidence, not a placeholder). |
| D11 wasm home `/home/web`, D12 web keymap layer, D13 activity ping, D14 prebuild/devcontainer (b8, b10), D15 AI proxy (b11), D16 shell entry point (b1/b7), D17 terminal ownership (b3/b6), D18 supervisor contract, D19 control-plane contract, D20 serve contract | No — none names a file, flag, constant, env var or type this brief defines | Nothing. |

Sibling deltas

| From | Item | What changed here |
|---|---|---|
| b3 §2 line 23, §3.6 line 348 | `exec_in_shell` returns `smol::process::Command`; b3 adds a wasm early return and asks that this brief stay signature-compatible | Section 2 project bullet: the stub `process::Command` type keeps `Task<Result<smol::process::Command>>` and vim's builder calls compiling; no signature change from this brief; risk 19 (e). |
| b6 §2 line 21, §7 item 9 | a bare `-p sqlez` hits getrandom's `compile_error!` even with this brief's cfg | Section 2 getrandom bullet: both 0.3.4 routes require the `wasm_js` feature (`backends.rs:36-44,194-199`); the cfg alone never suffices; b6 mirrors gpui's feature lines in `sqlez`, b7 in `zed_web`. |
| b6 §3 line 528, §7 item 11 | the shim must keep `smol::future::yield_now` and the `smol::io` traits | Item 6: explicit "always present on every target" guarantee for `Task`, `Executor`, `LocalExecutor`, `future`, `io`, `pin`, `prelude`, `ready`, `stream`, `channel`, `lock`; risk 19 (d). |
| b6 §6 line 918, §7 item 1 | `sqlite-wasm-rs` needs `-matomics -mbulk-memory -mmutable-globals` from `script/wasm-cc` and tolerates `-isystem`; possible musl-shim vs wasi-libc symbol collision | Item 2 note; risk 13 extended with the collision hazard (settled at the first full link, b7). |
| b6 §6 line 968, §8 item 12; b7 §3.32, §8 R2 wrong-claim 5 | both extend the `check_wasm` package list on top of item 16 | Item 3 script comment and item 16: the layer list is `default_packages` in `script/check-wasm`; b6 and b7 append there in dependency order; the xtask job stays argument-free (b7's "`-p gpui_platform -p cloud_api_client`" phrasing is the same day-one list spelled out); b7's `check_forbidden_crates` step noted. |
| b7 header line 9, §3.27 step 2, §5 line 1173, §8 R2 missing 1 | b7 calls `smol::runtime::install_runtime(Arc::new(GpuiSmolRuntime(cx.background_executor().clone()))).ok()` and asserts `smol::runtime::runtime_installed()`, citing an earlier revision of this brief (its "lines 435-456", "§7 item 6") whose runtime machinery the review pass had removed | Reinstated as the minimum b7 consumes: `crates/zs_smol_shim/src/runtime.rs` (`Runtime` trait, `Runnable` re-export, `install_runtime`, `runtime_installed`, crate-private `installed`), exported as `smol::runtime` on wasm; wasm `spawn` routes through it with the `setTimeout(0)` fallback before install; the `GpuiSmolRuntime` adapter is defined in section 4 and lives in `zed_web`; item 6, section 4, test 1, the browser-harness tests, risk 6, risk 19 (c) and review-log missing 12 updated. `Timer`/`block_on` stay out. b7 should re-cite section 4 "`crates/zs_smol_shim/src/runtime.rs`" and risk 6 instead of the stale line numbers. |
| b7 §3.16, §7 item 14 | one extra rustflag `--export=__wasm_call_ctors` on top of item 2's block; the config applies to `cargo xtask web-examples` too | Section 2 hello_web bullet and item 2: b7's line recorded as b7-owned so it is not dropped; item 17 already covers the examples pipeline. |
| b7 §3.31 step 3 | `ZS_WASM_MODE=build ZS_BUILD_ID=<id> script/check-wasm -p zed_web --profile <profile>` (+ `--features util/debug-embed` for dev) | Item 3 usage comment: unknown arguments and the environment pass through untouched (already true of the parser; now stated). |
| b7 §5 line 1066 | `zed_web` repeats `time = { workspace = true, features = ["wasm-bindgen"] }` as item 15 asked | No change; item 15's request is satisfied. |
| b1 §3.18 / §7 item 1 (`vendor/yawc`), b6 §3.1 / §8 item 4 (`vendor/alacritty_terminal`) | other briefs' vendored crates under D10 | Item 4 `exclude` and item 19 README are written as shared: b1 and b6 append their entries in the same format. |

Shared contract items this brief defines or consumes (`NAME: value/shape — defined by / consumed by`)

- `.cargo/config.toml [target.wasm32-unknown-unknown] rustflags`: `-C symbol-mangling-version=v0`, `--cfg tokio_unstable`, `--cfg getrandom_backend="wasm_js"`, `-C target-feature=+atomics,+bulk-memory,+mutable-globals`, `--shared-memory`, `--import-memory`, `--initial-memory=134217728`, `--max-memory=4294967296`, `--export=__wasm_init_tls/__tls_size/__tls_align/__tls_base` — defined by b5 item 2 / consumed by b6, b7 (b7 §3.16 appends `--export=__wasm_call_ctors`).
- `.cargo/config.toml [env] CC_wasm32_unknown_unknown = script/wasm-cc`, `AR_wasm32_unknown_unknown = target/wasi-sdk/bin/llvm-ar` (both `relative = true`, never forced) — defined by b5 item 2 / consumed by b6 (`sqlite-wasm-rs` C objects).
- `script/wasm-cc`: wasi-sdk 25 clang, `--target=wasm32-unknown-unknown -matomics -mbulk-memory -mmutable-globals -isystem <wasi-sysroot>/include/wasm32-wasi`, `WASI_SDK_PATH` override, exit 1 if the SDK is missing — defined by b5 item 1 / consumed by b6 §6.
- `script/check-wasm`: `[-p <crate>]… [passthrough args]`; env `ZS_WASM_MODE=check|build`, `ZS_WASM_TOOLCHAIN=<toolchain>`; exit 2 on `RUSTFLAGS`/`CARGO_ENCODED_RUSTFLAGS`/`CARGO_BUILD_RUSTFLAGS`/`CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS` or a Windows shell; runs `script/download-wasi-sdk`; passes `-Zbuild-std=std,panic_abort` with `RUSTC_BOOTSTRAP=1`; `default_packages` is the CI layer list — defined by b5 item 3 / consumed by b7 §3.31 (build), b6 §6 and b7 §3.32 (CI list).
- `cargo_check_wasm` xtask job: `./script/check-wasm` with no arguments, no rustflags env var, `target/wasi-sdk` cached under key `wasi-sdk-25` — defined by b5 item 16 / consumed by b6 §6, b7 §3.32.
- `smol` = `crates/zs_smol_shim` (`[patch.crates-io] smol = { path = "crates/zs_smol_shim" }`, workspace member, package name `smol` 2.0.2): native = smol 2.0.2's surface; wasm = `Task, Executor, LocalExecutor, future, io, pin, prelude, ready, stream, channel, lock, spawn, fs, net, process, runtime`; no `Timer`/`block_on`/`unblock`/`Unblock`/`Async` on wasm — defined by b5 items 5-6 / consumed by b1, b2 (`Unsupported` guarantee), b3 (`process::Command` type), b6 (`future`/`io`), b7 (`runtime`).
- `smol::fs`/`smol::net`/`smol::process` on wasm: every operation returns `io::ErrorKind::Unsupported` immediately, never hangs — defined by b5 item 6 / consumed by b1, b2 (risk 19 b).
- `smol::runtime` (wasm only): `trait Runtime { fn schedule(&self, runnable: Runnable) }`, `pub use async_task::Runnable`, `install_runtime(Arc<dyn Runtime>) -> Result<(), Arc<dyn Runtime>>`, `runtime_installed() -> bool`; adapter `GpuiSmolRuntime(pub gpui::BackgroundExecutor)` implementing it, living in `crates/zed_web` — defined by b5 section 4 / consumed by b7 §3.27 step 2.
- `util::paths::UrlExt::from_file_path_ext<P: AsRef<Path>>(path: P, path_style: PathStyle) -> Result<url::Url, ()>` (rejects `..` and a leading `.`) — defined by b5 item 8 / consumed by b5 items 9-10 (`languages`, `editor`); available to b6/b7.
- `lsp::Uri::from_file_path` (both targets) and wasm-only `Uri::to_file_path` (Unix rules, `..` → `Err(())`, no scheme check) via `vendor/lsp-types` — defined by b5 item 7 / consumed by the existing `project`, `copilot`, `languages`, `lsp` call sites unchanged.
- `vendor/<name>` layout: excluded non-member path patch, `[workspace] exclude = ["vendor/lsp-types", "vendor/agent-client-protocol", …]`, `vendor/README.md` with one section per crate whose `- Upstream:` line carries the 40-hex rev or the crates-io version — defined by b5 items 4 and 19 (D10) / consumed by b1 (`vendor/yawc`), b6 (`vendor/alacritty_terminal`), item 18's rebase check.
- `[patch."https://github.com/zed-industries/lsp-types"] lsp-types = { path = "vendor/lsp-types" }` (version 0.95.1 must equal `Cargo.toml:680`'s rev) and `[patch.crates-io] agent-client-protocol = { path = "vendor/agent-client-protocol" }` (`=2.0.0` at `:521`) — defined by b5 item 4 / consumed by cargo; checked by item 18.
- tree-sitter `wasm` feature absent on wasm in `language`, `multi_buffer`, `migrator`, `edit_prediction_context`, `language_tools`, `languages`, `settings_json`; `zed_web` must enable no `test-support` feature that reaches `grammars` — defined by b5 item 12 / consumed by b7 (`zed_web` feature set), the tree-sitter linker brief.
- `time` feature `wasm-bindgen` and `sys-locale` feature `js` from `crates/time_format`'s wasm table — defined by b5 item 15 / consumed by b7 §5 (repeats the `time` line in `zed_web`).
- getrandom 0.3.4 on wasm: the `wasm_js` **feature** is what selects the backend; the `getrandom_backend="wasm_js"` cfg is parity only — documented by b5 section 2 / consumed by b6 §5 (`sqlez`), b7 §5 (`zed_web`).
- `-D warnings` reaches path-sourced crates uncapped (shim and every `vendor/<name>`): they must be warning-free natively and on wasm — defined by b5 risk 14 / consumed by b1, b6 (their vendored crates).
- `cargo xtask web-examples` passes `-Zbuild-std=std,panic_abort` — defined by b5 item 17 / consumed by b7 §7 item 14.
