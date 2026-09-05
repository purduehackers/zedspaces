# Zed Codespaces: end-to-end build specification

Working title only; not affiliated with Zed Industries. Companion to `SCOPE.md` (the feasibility study, which holds the evidence behind the claims here). Written 2026-09-02 against Zed `main` at `c3cf80c` (v1.19.0-dev), the `zee295/zed` `zed-web` fork at `88db2d1`, and current Vercel Sandbox, Container Registry, Workflow and Functions docs.

This document specifies the complete product: a browser tab running Zed's real editor, every file, process, language server and terminal living in a per-workspace Vercel Sandbox, and a Vercel-hosted control plane that owns identity, repos, lifecycle, secrets, billing and delivery. No desktop-first staging. Where a feature is cut, the cut is stated and justified.

---

## 1. Definition of done

"Done" is feature parity with GitHub Codespaces as a developer experiences it, delivered with Zed instead of VS Code.

| Codespaces capability | This product | How |
|---|---|---|
| Create from any repo, branch, commit or PR | Yes | GitHub App installation token, sandbox `source: { type: 'git' }`, or from a prebuild snapshot |
| Machine types | 2, 4, 8 vCPU (4, 8, 16 GB) | Sandbox `resources.vcpus`; 32 vCPU on Enterprise |
| Full editor in the browser | Yes | Zed workspace compiled to wasm on `gpui_web`, WebGPU with WebGL2 fallback |
| Integrated terminal | Yes | New terminal messages in Zed's remote protocol; PTYs in `remote_server` |
| Language servers, formatters, diagnostics, go-to-def | Yes | Already run in `remote_server` today |
| Debugging | Yes | Zed's DAP store already runs in `remote_server` |
| Git UI, blame, diffs, push/pull with GitHub auth | Yes | Zed's git store in `remote_server`; credential helper backed by the control plane |
| Extensions | Yes, with a split | Extension host runs in the sandbox; themes, grammars and queries are streamed to the browser |
| Port forwarding, private and public | Yes | Sandbox exposed ports for public; authenticated proxy in the sandbox for private |
| `devcontainer.json` | Dockerfile and image, plus a curated subset of Features | Builder pipeline produces an OCI image pushed to Vercel Container Registry |
| Prebuilds | Yes | Snapshot per repo and branch, refreshed on push via GitHub webhook |
| Dotfiles | Yes | Cloned and installed by the in-sandbox supervisor on first boot |
| Secrets (user, org, repo) | Yes | Encrypted at rest, injected as environment at sandbox create |
| Settings sync | Yes | Zed settings and keymap stored by the control plane, loaded into the browser and pushed to the server |
| Idle stop, retention, delete | Yes | Activity-driven stop to snapshot; 30-day retention default; delete removes snapshots |
| Rebuild environment | Yes | Recreate from image, re-clone or restore workspace directory from snapshot |
| Open in desktop | Yes | Desktop Zed uses the same WebSocket transport; `zed://` deep link |
| AI assistance | Yes | Claude Code, Codex and Gemini CLI as in-sandbox ACP agents in Zed's agent panel; bring-your-own-key model providers via a proxy |
| Live Share | Optional module, not in parity scope | Zed's collab server could be hosted later; see section 15 |

Explicit non-goals for v1: multiplayer editing and calls, a mobile-optimized layout, Windows or macOS sandboxes, self-hosting outside Vercel, Zed-hosted AI features that require Zed account sign-in (not technically reachable from a third-party origin; see section 8).

---

## 2. Architecture

```
                 ┌────────────────────────────────────────────────────────────────┐
                 │ Browser tab  (wasm32, gpui_web, one canvas)                    │
                 │  Zed workspace · editor · panels · terminal view · agent panel  │
                 │  Project::remote  ──►  WebSocketRemoteConnection (new)         │
                 │  in-memory Fs (settings, keymap) · SQLite-in-wasm (db crate)   │
                 └───────┬──────────────────────────────────────┬─────────────────┘
        https, same origin│                                      │ wss://<session-id>.vercel.run/rpc
        (shell page, API, │                                      │ Sec-WebSocket-Protocol: zs.v1, <JWT>
         wasm bundle,     │                                      │ length-prefixed protobuf envelopes
         assets)          ▼                                      ▼
┌───────────────────────────────────────┐        ┌──────────────────────────────────────────────┐
│ Control plane · Next.js on Vercel     │        │ Vercel Sandbox · Firecracker microVM, amd64  │
│  Clerk (GitHub OAuth) · GitHub App    │  SDK   │  image: vcr …/zs-workspace:<build>            │
│  Postgres (Marketplace) · Redis       │──────► │  supervisor (zs-agent)                        │
│  Workflows: create/open/stop/prebuild │        │   ├─ zed-remote-server serve :8443 (new mode) │
│  Cron: idle sweep, GC, timeout extend │        │   │    worktrees · LSP · git · DAP · tasks     │
│  Webhooks: GitHub push → prebuild     │        │   │    extensions · MCP/ACP agents · PTYs (new)│
│  Token minting (ES256 JWT)            │        │   ├─ private-port auth proxy :8444            │
│  Usage metering · billing             │        │   ├─ git credential helper · dotfiles          │
│  Static: wasm bundle + COOP/COEP      │        │   └─ health, activity, log shipping           │
└───────────────────────────────────────┘        │  /workspaces/<repo> · toolchains · snapshots  │
                                                 └──────────────────────────────────────────────┘
```

Three principles fix the design.

1. **The data path is browser to sandbox, directly.** Vercel Functions close WebSockets at their max duration (800 s on Pro, 1800 s in beta), so the control plane never proxies editor traffic. It creates, resumes, extends and stops sandboxes and hands the browser a session URL and token.
2. **The wire protocol is Zed's existing remote protocol.** `Project::remote` and every store's remote variant already speak `AnyProtoClient`; `remote_server` already hosts the project. The transport is new; the protocol gains terminals, port forwarding, file transfer, client persistence and lifecycle notices, all as upstream-shaped additions to `zed.proto`.
3. **Everything that can be gated stays in upstream's crate layout.** The browser client is a fork branch of Zed carrying `cfg(target_family = "wasm")` gates and one new entry crate, rebased on a fixed cadence, with the transport and protocol work submitted upstream.

Trust boundaries: the browser is the user's; the sandbox runs the user's untrusted code under Vercel's VM isolation; the control plane is ours and holds the only long-lived secrets. The sandbox never receives a control-plane credential broader than its own identity token.

---

## 3. Browser client

### 3.1 Entry crate and manifest

A new crate, `crates/zed_web`, is the browser analogue of `crates/zed`: it wires registries, panels, keymaps, themes and the workspace, then opens a remote project. It does not depend on `crates/zed`. The compiled set:

- Core: `gpui`, `gpui_platform` (wasm target selects `gpui_web`), `gpui_wgpu`, `ui`, `theme`, `settings`, `settings_ui`, `keymap_editor`, `command_palette`, `workspace`, `editor`, `multi_buffer`, `language`, `languages` (built-in grammars and queries), `project` (remote-only mode), `worktree` (remote snapshot only), `client` (transport-less; collab off), `rpc` (`proto` and `proto_client` only), `remote` (WebSocket transport only), `fs` (in-memory implementation), `db` and `sqlez` (SQLite compiled to wasm, memory VFS).
- Panels and tools: `project_panel`, `outline_panel`, `terminal`, `terminal_view`, `git_ui`, `diagnostics`, `search`, `file_finder`, `tab_switcher`, `go_to_line`, `tasks_ui`, `debugger_ui`, `agent_ui`, `acp_thread`, `agent_servers`, `language_models` (API-key providers only), `edit_prediction` (only for providers reachable without Zed sign-in), `markdown_preview`, `svg_preview`, `image_viewer`, `repl` (kernels run in the sandbox via existing `SpawnKernel`), `vim`, `snippets_ui`, `theme_selector`, `extensions_ui`, `open_path_prompt` (remote path picker), `recent_projects` (workspace switcher only), `title_bar`.
- Excluded, with reason: `auto_update` and `install_cli` (no binary to update), `crashes` (replaced by a wasm panic hook), `call`, `channel`, `collab_ui`, `livekit_client` (multiplayer out of scope), `feedback`, `onboarding` and `welcome` (replaced by the web dashboard), `askpass` (git prompts already travel over proto), `node_runtime` local paths, `dev_container` (containers are built by the control plane), `extension_host` (wasmtime cannot run inside wasm; extensions execute in the sandbox), `remote_server`, `cli`.

### 3.2 The port, crate by crate

The compile probe in `SCOPE.md` shows the frontier of failures at Zed `main`; the fork shows the full extent. This is the plan of record for each affected layer. Effort sizes: S under 1 day, M 1 to 3 days, L 1 to 2 weeks, XL over 2 weeks.

**Shape of the problem.** The normal-dependency closure of the browser crate set at Zed `main` is 947 crates: 173 Zed workspace crates and 774 third-party. Every hard compile blocker is third-party; `std::process`, `std::fs`, `std::thread` and `std::time::Instant` all compile on wasm32 and only fail at runtime. Not in the closure at all: `git2`, `rusqlite`, `openssl`, `ipc-channel`, the crash reporter, and every tree-sitter grammar crate except `tree-sitter-json` (grammars are behind the `load-grammars` feature, which the browser build turns on deliberately). 82 Zed crates compile as-is; 91 need work, most of it small.

**Build environment** (matches upstream CI plus the fork's additions): nightly, `-Zbuild-std=std,panic_abort`, `-C target-feature=+atomics,+bulk-memory,+mutable-globals`, `--cfg getrandom_backend="wasm_js"`, `CC_wasm32_unknown_unknown=<wasi-sdk>/bin/clang` with `-isystem <wasi-sysroot>`. The C toolchain alone unblocks the tree-sitter runtime, `tree-sitter-json` and `zstd-sys`. `time` needs its `wasm-bindgen` feature on the wasm target.

**Four shim decisions that each unblock 10 to 20 crates at once**

| Decision | Why | Direct dependents | Approach |
|---|---|---|---|
| `smol` | `smol → async-io → polling` has a `compile_error!` on wasm; `async-process` and `async-fs` likewise | askpass, auto_update, client, collab_ui, dap, debugger_tools, fs, git, languages, net, node_runtime, openai_subscribed, project, remote, search | `[patch.crates-io] smol` with a shim whose `fs`, `net` and `process` modules return `Unsupported` (about 1,800 lines in the fork; ours is smaller because process spawning goes over the protocol, not over RPC) |
| `url` file paths | `Url::from_file_path` and `to_file_path` do not exist on wasm; 146 call sites in 9 crates (util 49, editor 32, project 26, copilot 15, languages 7, lsp 7, edit_prediction_context 5, terminal 4, agent_ui 1); Zed's `lsp-types` fork has the same gap in `Uri` | util, editor, project, copilot, languages, lsp, edit_prediction_context, terminal, agent_ui | One `paths::url` helper that assumes Unix paths on wasm, plus a small patch to the `lsp-types` fork; or a `[patch]` of `url` (the fork vendored 6,500 lines; the helper is the better trade) |
| `agent-client-protocol` | Version 2.0 depends unconditionally on `async-io` and `async-process` | acp_thread, agent_servers, agent, agent_ui | `[patch]` with the process and I/O transports gated; upstream the gate to the ACP crate |
| tree-sitter `wasm` feature | Declared unconditionally in `language`, `multi_buffer`, `migrator`, `edit_prediction_context`, `languages`; drags wasmtime and cranelift into the browser | those five plus `settings_json` optional | Make the feature target-conditional; extension grammars load through the browser linker (section 3.3) instead of wasmtime |

**Six leaf crates that need real gates**

| Crate | Native surface | Gate |
|---|---|---|
| `fs` | `RealFs`, file watcher (`notify`), `libc`, `trash` | Keep the `Fs` trait; add `WasmFs` (in-memory, about 300 lines; `FakeFs` is test-only) used for settings, keymap and snippets |
| `terminal` | alacritty's `tty`, `event_loop` and thread modules, `libc`, `portable-pty` via `acp_thread` | Vendor or patch `alacritty_terminal` to gate those modules; `Term`, grid and `vte` are pure Rust and are what the browser needs; add `TerminalType::Remote` |
| `client` | tokio, `tiny_http`, `http_client_tls`, `proxy_handshake`, `async-tungstenite` with tokio features | Gate collab connect, proxy and TLS; keep the `Client` type so `AppState` is unchanged; sign-in disabled |
| `acp_thread` | `portable-pty` | Gate; terminals for agents go through the terminal messages |
| `sqlez` | `libsqlite3-sys` bundled C (its build script only handles `wasm32-wasi`) | Build SQLite for `wasm32-unknown-unknown` with wasi-sdk and a memory VFS (the `sqlite-wasm-rs` crate does this); persistence per section 5.4 |
| `prompt_store` | `heed` (LMDB, C) | In-memory store on wasm |

**Dependency-edge gates that drop whole subtrees**: `title_bar` and `git_ui` → `call` (removes LiveKit, WebRTC, reqwest, aws-lc); `language_models` → `bedrock` (removes the AWS SDK); the ten references to `extension_host` in `agent_ui`, `language_models`, `recent_projects` and `settings_ui` (removes wasmtime); `gpui_tokio` at its eight dependents (`livekit_client`, `language_models`, `extension_host`, `agent`, `call`, `client`, `agent_ui`; `cloud_api_client` is already gated); `http_client_tls` (the browser does TLS).

**Per-crate work list** (fork gate deltas shown as evidence of how much each crate changed there)

| Crate | What needs doing | Fork Δ gates | Effort |
|---|---|---|---|
| `gpui`, `scheduler`, `http_client`, `cloud_api_client`, `oauth_callback_server`, `language_core` | Done upstream | — | 0 |
| `util` | `archive.rs` (async-tar), `process.rs`, `shell_env.rs`, `command.rs`, 49 `from_file_path` sites | +34 | S to M |
| `fs` | `WasmFs`, gate `RealFs`, watcher, `libc`, `trash` | +51 | M |
| `project` | Local LSP, git, prettier and node paths compile as dead code under the smol shim; `which` 6 sites, `tempfile` 4, 26 `from_file_path` | +26 | M with the shim, L if gated properly |
| `languages` | Gate adapter installers (server runs LSP); enable `load-grammars` with the wasi-sdk C build | +15 | M |
| `language`, `multi_buffer`, `migrator`, `tasks_ui`, `edit_prediction_context` | tree-sitter feature change; C runtime via wasi-sdk | +3, +2, 0, 0, 0 | S each |
| `client` | Gate collab, proxy, `tiny_http`, TLS | +49 | M |
| `rpc` | Depend on `tungstenite` types only; drop the connection module on wasm; zstd via clang or gated | +18 | S |
| `remote` | Gate the SSH, WSL and Docker transports (43 of 45 native hits); add `WebSocketRemoteConnection` | 0 (fork rewrote it) | M |
| `db`, `sqlez`, `sqlez_macros` | SQLite-in-wasm build; `workspace/persistence.rs` and `agent/db.rs` sit on top unchanged | +2, +56 | M to L |
| `workspace` | Persistence follows the db choice; gate `node_runtime` and local file opens | +15 | M |
| `editor` | url helper, `Instant` to `web_time` | +12 | S |
| `terminal`, `terminal_view` | Section above; `TerminalType::Remote` | +36, +7 | M, S |
| `git`, `git_ui` | `RealGitRepository` dead under the shim; gate `call`, `sysinfo` process picker, db | 0, +19 | S to M |
| `agent`, `agent_ui`, `acp_thread`, `agent_servers` | Gate db, zstd, `gpui_tokio`, `extension_host`, `portable-pty`; sandboxing and proxy compile as dead code | +13, +14, +21, +3 | M, M, S to M, S |
| `language_models` | Gate `bedrock`, `extension_host`, `gpui_tokio` | +5 | S to M |
| `settings`, `settings_json`, `settings_ui` | Follow `WasmFs`; gate extension and Copilot panels | +13, +16, +24 | S, S, S to M |
| `recent_projects`, `title_bar`, `auto_update`, `collab_ui`, `call`, `livekit_*`, `extension_host`, `node_runtime` | Gate or drop as described; `NodeRuntime::unavailable()` already exists | +10, 0, +2, 0, 0, 0, 0, +4 | S each |
| `net`, `askpass`, `context_server`, `dap`, `debugger_tools`, `debugger_ui`, `prompt_store`, `lsp`, `copilot`, `edit_prediction` | Small gates; url helper; in-memory prompt store | +6, 0, +1, +1, 0, +5, +11, +5, 0, +9 | S each |
| `worktree`, `project_panel`, `search`, `vim`, `file_finder`, `command_palette`, `markdown_preview`, `paths`, `zlog`, `rope`, `sum_tree` and 70 more | Compile today or need only `Instant` swaps and dead-code tolerance (`rayon` degrades to sequential on wasm) | mostly 0 | S or 0 |

A compiling, remote-only browser workspace is about four engineer-weeks on top of the build environment. The months in section 14 are spent on what happens after it compiles: exercising every runtime-hazard path, tree-sitter, browser input, performance and cross-browser parity.

Ordering: leaf crates first (`paths`, `task`, `fuzzy`, `util`, `http_client`, `lsp` types), then `fs`, `db`, `rpc`, `client`, `remote`, then `project` and `worktree`, then `workspace` and `editor`, then panels. Each layer gets a CI check on `wasm32-unknown-unknown` the day it compiles, so drift is caught per crate rather than at the end.

### 3.3 Tree-sitter in the browser

Zed parses on the client, not the server: highlighting, outline, brackets, indentation, folding and injections all come from tree-sitter trees held next to the buffer. A browser client therefore needs the tree-sitter runtime and grammars in wasm.

- **Runtime and built-in grammars, statically linked.** The `grammars` crate links about twenty grammars through `tree_sitter_<lang>::LANGUAGE` under the `load-grammars` feature. For wasm32 the C runtime (`tree-sitter/lib/src`) and each grammar's `parser.c` and `scanner.c` compile with the wasi-sdk clang that Zed already downloads for extensions (`script/download-wasi-sdk`), targeting `wasm32-unknown-unknown` with wasi-libc's freestanding subset for `malloc`, `memcpy` and friends. Statically linked languages are `Send`, so they work across parsing workers without the per-thread resolver.
- **Extension grammars, dynamically linked.** Extensions ship grammars as wasm modules compiled with wasi-sdk. In the browser each parsing worker is its own wasm instance, so a grammar module must be instantiated per worker with imports satisfied from that instance (memory, indirect function table, wasi-libc shims), and the resulting `tree_sitter_<lang>` export becomes a `TSLanguage` pointer valid only in that worker. This is exactly what upstream's `language_core::ParseableLanguage::from_resolver` anticipates; upstream has the type and no loader yet. We write the loader: a `GrammarLinker` in `zed_web` that fetches the module from the sandbox (section 9), instantiates it against the worker's instance, and registers a resolver.
- **Parsing off the main thread.** Zed pins parsing to dedicated threads via `BackgroundExecutor::spawn_dedicated`; on wasm this requires the `scheduler` crate's `wasm-threads` feature and shared memory. The multithreaded build is mandatory for this product; the single-threaded fallback is for diagnostics only.

Size budget: about 20 built-in grammars add an estimated 8 to 15 MB raw wasm (2 to 4 MB brotli). Extension grammars load on demand and are cached by the browser.

### 3.4 Boot sequence

The editor page at `/w/{workspaceId}` is a Next.js route behind authentication. It renders the canvas and a boot overlay, then:

1. `POST /api/workspaces/{id}/connect` resumes the sandbox if stopped, waits for the supervisor's health check, and returns `{ wsUrl, token, sessionId, serverBuild, sessionExpiresAt }`. The `wsUrl` is per session and is never cached across resumes (Vercel routes are attached to the session).
2. In parallel the page fetches the wasm bundle (immutable, content-hashed, brotli at the edge), instantiates it with streaming compilation, fetches the asset tarball (fonts, icons, themes, bundled queries), and fetches the user's settings and keymap JSON.
3. `zed_web::main` starts GPUI, installs the in-memory Fs with the settings and keymap files, restores the client SQLite database (section 5.4), registers languages, opens the workspace and connects `Project::remote` over the WebSocket. The server's `RemoteStarted` handshake, worktree snapshot and LSP startup stream in.
4. The overlay dissolves when the first worktree snapshot arrives. Targets: under 4 s to an editable buffer on a warm browser cache and a resumed sandbox; under 10 s on a cold cache and a fresh sandbox from a prebuild.

Measured baseline from the fork's published image: 69.5 MB raw wasm, 19.5 MB gzip, 12.3 MB brotli, plus a 6.5 MB asset tarball (2.6 MB brotli) and 180 KB of JS glue. With tree-sitter added, plan for 15 to 18 MB brotli.

### 3.5 Assets and bundle pipeline

- Fonts: Zed Plex Mono, Zed Plex Sans and an emoji fallback embedded in the asset tarball and registered on startup via `text_system().add_fonts`. No system fonts exist on the web.
- Icons, themes, sounds, prompts and bundled queries ship in one tarball fetched once and cached in the browser's Cache Storage keyed by build id.
- Build: nightly Rust, `-Zbuild-std=std,panic_abort`, `+atomics,+bulk-memory,+mutable-globals`, shared memory with a 128 MiB initial and 4 GiB maximum, `wasm-bindgen --target web`, `wasm-opt -Oz` with bulk-memory enabled, profile `opt-level = "z"`, thin LTO, one codegen unit, symbols stripped.
- Delivery: uncompressed `.wasm` with a hashed filename served from the same origin; Vercel's edge applies brotli (precompressed `.br` files are re-compressed and must be avoided). `Cache-Control: public, max-age=31536000, immutable` on hashed files; `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the editor route and all its subresources, set in `vercel.ts` headers.
- A service worker precaches the current build's bundle and assets so a reload during a network blip still boots.

### 3.6 Browser-specific behavior

- **Keyboard.** Browsers own Cmd/Ctrl+W, T, N, Q, Shift+T, and Ctrl+Tab. Ship a `web` keymap layer that remaps those Zed bindings (close tab to Cmd+Shift+W and so on), and use `navigator.keyboard.lock()` when the page is fullscreen so Chrome and Edge hand over the reserved keys. Show the active remaps in the command palette.
- **IME and composition.** Upstream's hidden textarea mirror handles CJK, Gboard and dead keys; we keep it and add end-to-end tests per platform.
- **Clipboard.** Async clipboard read and write exist upstream, including image paste. Paste of files from the OS becomes an upload (below).
- **Files in and out.** Drag-and-drop onto the project panel and paste of files upload through `POST https://<session>.vercel.run/files?path=…` on `remote_server` (multipart, token-authenticated), not through the protocol. "Download" on a file or folder hits `GET /files?path=…` (folders as tar). The existing `DownloadFileByPath` message stays for images.
- **Dialogs.** Native open and save dialogs are unavailable; "Open folder" uses Zed's remote path picker (`open_path_prompt`) against the sandbox. Window prompts use GPUI's in-canvas prompt.
- **Links.** `open_url` opens a new tab. Forwarded-port URLs and PR links from the git panel go through it.
- **Tabs.** One live session per workspace. A second tab presents a "take over" button; taking over closes the first with code 4001 and a message.
- **Connectivity.** A reconnect overlay appears after the heartbeat misses; the transport retries with backoff, re-fetching the session URL and token from the control plane, since the URL may have changed if the sandbox resumed.
- **Visibility.** When the tab is hidden the client keeps the socket open and stops rendering; the server's activity clock still counts input only.
- **PWA.** Installable manifest so the editor gets its own window and icon; no offline editing.

### 3.7 Settings and keymap

User settings and keymap are documents in the control plane, versioned. On boot they are written into the in-memory Fs at the paths Zed expects, so every settings code path works unchanged, including the settings UI and JSON editing. The in-memory Fs emits change events; a debounced hook saves the new document to the control plane, and Zed's existing `UpdateUserSettings` message carries it to the server. Project settings live in the repo and are handled by the server's settings observer as today.

### 3.8 Performance targets

Input latency under 16 ms at 60 Hz on a 2020 laptop in Chrome; 120 Hz where the display allows. Opening a 10k-line file with highlighting under 300 ms. Project search on a 100k-file repo returns first results under 1 s (runs on the server). Memory under 1.5 GB for a large monorepo in the tab. Multithreaded build required; parsing and search result marshalling off the main thread.

---

## 4. Transport

### 4.1 Client: `WebSocketRemoteConnection`

A new `RemoteConnectionOptions::WebSocket { url, session_id, token }` variant in `crates/remote`, and a `WebSocketRemoteConnection` implementing `RemoteConnection`:

- `start_proxy` opens a `yawc::WebSocket` (the crate upstream already uses in the browser), sends a `Hello` control frame carrying the client build id, then maps one binary frame to one `Envelope` in each direction using the existing `read_message`/`write_message` framing helpers. Activity on the socket feeds `connection_activity_tx` exactly as stdio activity does today, so the 5-second heartbeat and reconnect state machine work unchanged.
- `remote_platform()` returns Linux x86_64 from the `Hello` reply; `path_style()` is Unix; `shell()` is what the server reports; `kill()` closes the socket; `upload_directory`, `build_command` and `build_forward_ports_command` return errors, because terminals and forwarding become protocol messages.
- `RemoteClientDelegate` is trivial: `set_status` drives the boot overlay; `ask_password`, `get_download_url` and `download_server_binary_locally` are unreachable because the sandbox provisions the binary.
- Reconnect: on `HeartbeatMissed`, the transport calls back into `zed_web` to refresh `{ wsUrl, token }` before dialing again; `ChannelClient::reconnect` and `FlushBufferedMessages` resync then replay unacked envelopes as they do over SSH.

The same transport compiles natively, so desktop Zed opens the same workspaces.

### 4.2 Server: `zed-remote-server serve`

A new subcommand alongside `proxy` and `run`:

```
zed-remote-server serve --listen 0.0.0.0:8443 --jwt-public-key <path> --workspace <id> [--allow-build <id>]
```

- Accepts HTTP on the port. `GET /health` reports build, uptime, session state and last input activity. `GET /rpc` upgrades to WebSocket after verifying the JWT in `Sec-WebSocket-Protocol` (browsers cannot set headers; the subprotocol carries the token). Invalid or expired tokens are rejected before the upgrade with no timing side channel on the signature check.
- One session at a time; arbitration happens at the in-band `Hello` frame, not before the upgrade (D3). A *reconnect* (`Hello.reconnect = true`, epoch matches, server still holds state) attaches warm and replays per Zed's ack/replay protocol. A *fresh* session (`Hello.reconnect = false`, or a stale epoch) resets the `HeadlessProject` (worktrees, language servers, git, settings observer restart); this is the accepted cost of a page reload. PTYs live in a server-level `PtyManager` outside `HeadlessProject` and survive fresh sessions: `detach_all` on session detach, `kill_all` only on process shutdown or an explicit `CloseTerminal`. Close codes: 4001 superseded (takeover), 4005 session active (busy, no takeover), 1001 server going away. The client sends a `Heartbeat` control frame every 5 s; a 16 MiB inbound frame ceiling applies on both sides. The accept loop keeps `run`'s channel-pair shape, with the pid-file and socket bridging removed.
- The channel pair `(incoming_rx, outgoing_tx)` feeds `RemoteClient::proto_client_from_channels` unchanged.
- Idle: the 10-minute idle exit in `run` is replaced by "keep running until stopped"; idle policy is the control plane's.
- `/files` upload and download, `/extensions/{id}/assets/*` and `/ports` endpoints (sections 3.6, 5.2, 9) live on the same listener under the same token check.
- TLS terminates at Vercel's edge; the listener is plain HTTP inside the VM.

### 4.3 Session tokens

ES256 JWT minted by the control plane: `{ iss, sub: userId, ws: workspaceId, sid: sessionId, aud: sandboxName, iat, exp: +1h, jti }`. The public key is baked into the sandbox at create time as an environment variable and rotated by issuing new sandboxes; two keys are accepted during rotation. Tokens are single-audience so a token for one workspace cannot open another. Reconnects fetch a fresh token. Revocation is by stopping the sandbox (which also kills the server) or by rotating the workspace's `aud` on the next resume.

### 4.4 Wire details

Unchanged from Zed: `u32` little-endian length prefix, prost `Envelope`, `RemoteStarted` handshake, `ack_id` replay buffer, `Ping` heartbeat every 5 s with reconnect after five misses. WebSocket frames are binary, one envelope per frame, with a 16 MiB frame ceiling. Compression is left off; brotli at the edge does not apply to WebSockets and the payloads are already compact. Backpressure: the client's send buffer is bounded; when it fills, the UI shows "reconnecting" rather than growing unbounded.

---

## 5. Protocol additions

All additions go into `crates/proto/proto/zed.proto` with handlers registered in `HeadlessProject` on the server and in the relevant store on the client, following the existing `Background`/`Foreground` message conventions.

### 5.1 Terminals

Today a remote terminal is a local `ssh -t` process. New messages:

- `SpawnTerminal { working_directory, shell, env, cols, rows, task_id? } → { terminal_id }`
- `TerminalInput { terminal_id, bytes }`, `TerminalOutput { terminal_id, bytes }` (server-initiated), `ResizeTerminal`, `CloseTerminal`, `TerminalExited { code }`
- `ListTerminals → { terminals: [{ id, title, cwd, scrollback_bytes }] }` and `AttachTerminal { terminal_id, from_offset }` for reattach after reconnect with scrollback replay.

Server: a `PtyManager` in `remote_server` using the `terminal` crate's alacritty PTY layer, keeping a bounded scrollback ring per terminal, surviving client disconnects, and killed on sandbox stop. Client: a `TerminalType::Remote` in `crates/terminal` that feeds bytes from the stream into the existing alacritty grid, so `terminal_view`, tasks and the agent panel's terminal tools work unchanged. Tasks (`TaskStore`) already resolve on the server; their spawn path switches from `build_command` to `SpawnTerminal`.

### 5.2 Port forwarding

- The supervisor watches listening TCP sockets and the server sends `PortsChanged { ports: [{ port, pid, process_name }] }`; the client shows Zed's ports panel (new UI, modeled on the tasks panel).
- Public forward: `ForwardPort { port, visibility: PUBLIC }` → the server asks the supervisor, which calls the control plane (`POST /api/sandboxes/{name}/ports`) to `sandbox.update({ ports })` and returns the `https://….vercel.run` URL. Because updating ports re-registers routes, the RPC route is on a port declared at create and never updated; a pool of forward ports is declared at create (for example 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888) so the common case needs no route update.
- Private forward (D8): four proxy slots (ports 8444 to 8447) are declared at sandbox create; the control plane allocates one slot per private forward (four concurrent private forwards per workspace). The supervisor's proxy on each slot validates the `zs_port_session` HMAC cookie. The forward's `url` in the UI is the control plane `/open` link, which redirects to `https://<slot-host>/__zs/auth?zs_port_token=...&next=/` to set the cookie. This is how Codespaces' "private" visibility is delivered on a platform whose exposed ports are public.
- `UnforwardPort`, and the port panel persists forwards per workspace in the control plane.

### 5.3 File transfer

Upload and download use HTTP endpoints on the server (section 3.6) rather than the protocol, to avoid pushing multi-megabyte binaries through the envelope stream. A `FilesUploaded { paths }` notification lets the project panel refresh immediately instead of waiting for the file watcher.

### 5.4 Client persistence

Zed's `db` crate (workspace layout, pane state, scroll positions, key-value store) is SQLite. On wasm, SQLite compiles with wasi-sdk into the bundle with a memory VFS, so `sqlez` and every caller are unchanged. Persistence (D7): the client keeps one whole-database image (the `AppDatabase`, with `GlobalKeyValueStore` folded into it); `serialize()` (`sqlite3_serialize`) and `restore_from()` run on `background_spawn`. Flush triggers are exactly three: a 15 s dirty timer, `visibilitychange` to hidden, and `LifecycleNotice STOPPING`. Each flush sends `SaveClientState { sqlite, version }` to the server, which writes it under its data directory inside the sandbox filesystem. On boot, `LoadClientState` restores it. Because the sandbox filesystem is what gets snapshotted, workspace state survives resumes with no extra storage: the workspace layout follows the workspace across resumes (and rebuilds, whose tarball carries the data directory). The image is not importable into desktop Zed's shared database.

### 5.5 Lifecycle notices

`LifecycleNotice { kind: IDLE_STOP_IN | SESSION_CAP_IN | STOPPING | RESUMED, seconds }` from server to client, raised by the supervisor. The client shows a toast with "keep alive" for idle stops and a countdown for the 24-hour session cap, which requires a resume cycle (section 7.5).

### 5.6 Extensions

`ListExtensions`, `InstallExtension { id, version }`, `UninstallExtension { id }`, `ExtensionsChanged { installed }`. The server installs from the Zed extension registry into its extensions directory and runs them in its `HeadlessExtensionStore`. Asset delivery is section 9.

### 5.7 Existing messages that now carry more

`AskPassRequest` already forwards git credential prompts to the client; with the credential helper (section 6.2) it becomes a fallback for non-GitHub remotes. `UpdateUserSettings` already carries settings; the keymap travels alongside so server-side tasks see the user's bindings. `SyncExtensions` and `upload_directory` are replaced by `InstallExtension`.

---

## 6. Inside the sandbox

### 6.1 Image

Built from a Dockerfile on `vercel/sandbox/universal` (Ubuntu 26.04, Node 24, Python 3.14, git, tmux, ripgrep, uv, coding-agent CLIs) and pushed to Vercel Container Registry with `vercel vcr build docker . zs-workspace:<build> --push` from CI (`docker login vcr.vercel.com` with team id and token). Vercel precompiles pushed images into snapshot format, so boot is sub-second regardless of size; limits are 500 MB per compressed layer and 15 GB per image.

Layers, in order of change frequency:

1. Toolchains: Rust stable, Go, Node LTS matrix via corepack, Python via uv, Java, .NET, Ruby, PHP; Docker CLI and dockerd (Vercel supports rootful Docker inside a sandbox).
2. Language servers preinstalled for the top twenty languages so first-open does not wait on Zed's downloader: rust-analyzer, gopls, typescript-language-server, vtsls, pyright, ruff, clangd, jdtls, omnisharp, solargraph, intelephense, lua-language-server, taplo, yaml-language-server, json, css, html, bash, docker, eslint, prettier. Zed's adapters find them on `PATH`; anything else downloads into the persisted data directory.
3. Agents: `@anthropic-ai/claude-code`, `@openai/codex`, Gemini CLI, `opencode`, `pi`.
4. `zed-remote-server` (static musl, 120 MB, version-pinned to the client build) and `zs-agent` (the supervisor, a small static Rust binary).
5. Users: `ubuntu` with passwordless sudo, uid 1000, home on the persisted filesystem.

Image is `linux/amd64` only, which matches the published Zed server binary.

### 6.2 Supervisor (`zs-agent`)

Started by the control plane with `runCommand({ detached: true })` on create and in `onResume`. Responsibilities:

- Fetch the workspace manifest (`GET /api/sandboxes/{name}/manifest` with the sandbox identity token): repo, revision, env, secrets, dotfiles, forwards, settings.
- First boot: clone (or restore), install dotfiles, run `postCreateCommand` from `devcontainer.json` if present, warm LSP caches.
- Start `zed-remote-server serve`, supervise it (restart on crash with backoff, ship the crash log), start the private-port proxy.
- Git credential helper: `git credential-zs` returns a fresh GitHub App installation token from the control plane; tokens are one hour and never written to disk.
- Health and activity: `GET :8445/health` for the control plane; activity is the server's last-input timestamp plus terminal input.
- Log shipping: server stderr (JSON lines) and supervisor logs batched to the control plane ingest endpoint.
- Resume: on `onResume`, re-run start, re-register forwards, emit `LifecycleNotice RESUMED`.
- Stop: on `SIGTERM` from a control-plane stop, ask the server to flush client state and buffers, then exit.

### 6.3 `devcontainer.json` support

Supported: `image`, `build.dockerfile` with `build.context` and `build.args`, `features` from a curated allowlist (common-utils, node, python, go, rust, java, docker-in-docker, github-cli), `postCreateCommand`, `postStartCommand`, `postAttachCommand`, `remoteEnv`, `forwardPorts`, `portsAttributes` (label and visibility), `customizations.zed` (settings and extensions; we define the key). Not supported: `dockerComposeFile`, `runArgs`, `mounts` beyond the workspace, VS Code customizations.

Builder: a Workflow run creates a builder sandbox with Docker, checks out the repo, runs the devcontainer CLI's build to produce an image layered on our base (so the supervisor and server are present), pushes to the registry as `zs-workspace-<repo>:<config-hash>`, and records it. Workspaces for that repo use the resulting image; a config change triggers a rebuild on next create or on "rebuild".

### 6.4 Prebuilds

A prebuild is a snapshot: create a sandbox from the repo image, clone the branch, run `postCreateCommand`, warm language servers by opening the project once with a headless client (the desktop transport in a Vercel Function, connecting long enough to trigger LSP downloads), then `snapshot({ expiration })`. New workspaces for that branch are created with `source: { type: 'snapshot', snapshotId }`; a snapshot fans out to any number of sandboxes. Prebuilds refresh on push via GitHub webhook (debounced, per branch), keeping the last three. Snapshots are region-locked; prebuilds run in the workspace's region.

---

## 7. Control plane

### 7.1 Stack

Next.js App Router on Vercel with Fluid Compute. Clerk for identity (GitHub OAuth; Sign in with Vercel added later once its API permissions leave private beta). A GitHub App for repository access and webhooks. Postgres from the Vercel Marketplace (Neon, Supabase or Prisma Postgres; pick via `vercel integration discover --category storage`). Upstash Redis for rate limits, session cache and idle bookkeeping. Vercel Workflow for durable orchestration, Vercel Cron for sweeps, Vercel Queues for webhook fan-out. Stripe via the Marketplace `payments` category for billing. Vercel Firewall and BotID on public endpoints. Vercel AI Gateway as the optional model proxy.

### 7.2 Data model

- `users` (Clerk id, GitHub id, plan), `orgs`, `memberships`
- `github_installations` (installation id, account, repos scope)
- `repos` (owner, name, default branch, devcontainer hash, image ref)
- `workspaces` (id, owner, repo, branch or revision, machine type, region, sandbox name, image ref, state: creating | running | stopping | stopped | rebuilding | deleting | error, last_active_at, idle_minutes, created_at, deleted_at)
- `sessions` (workspace, user, session id, sandbox session id, ws host, started_at, ended_at, client build, active cpu ms, ingress, egress)
- `prebuilds` (repo, branch, commit, snapshot id, size, created_at, status)
- `forwards` (workspace, port, visibility, label, url)
- `secrets` (scope: user | org | repo, name, ciphertext, key version)
- `settings_docs` (user, kind: settings | keymap, json, version)
- `usage_ledger` (user, period, vcpu-seconds, gb-hours, egress bytes, snapshot gb-days) and `invoices`
- `audit_log` (actor, action, target, metadata)

### 7.3 API surface

Route handlers under `/api`, Clerk-authenticated, with typed responses:

- Workspaces: `POST /workspaces` (repo, branch or PR, machine, region), `GET /workspaces`, `GET /workspaces/{id}`, `POST /workspaces/{id}/connect`, `POST /workspaces/{id}/stop`, `POST /workspaces/{id}/rebuild`, `DELETE /workspaces/{id}`, `POST /workspaces/{id}/keepalive`
- Ports: `GET|POST|DELETE /workspaces/{id}/ports`
- Repos and prebuilds: `GET /repos`, `POST /repos/{id}/prebuilds`, `GET /repos/{id}/prebuilds`
- Settings: `GET|PUT /me/settings`, `GET|PUT /me/keymap`, `GET|PUT /me/dotfiles`
- Secrets: `GET|PUT|DELETE /secrets` scoped
- Sandbox-facing (authenticated by the sandbox identity token, not by a user): `GET /sandboxes/{name}/manifest`, `POST /sandboxes/{name}/git-token`, `POST /sandboxes/{name}/ports`, `POST /sandboxes/{name}/activity`, `POST /sandboxes/{name}/logs`, `POST /sandboxes/{name}/client-errors`
- Webhooks: `POST /webhooks/github` (push, installation, pull_request), `POST /webhooks/stripe`
- Admin: `/admin/*` behind an org role

### 7.4 Workflows

Each is a `"use workflow"` function with `"use step"` steps so sandbox SDK calls retry and resume across function boundaries.

- **createWorkspace**: reserve name → pick image (prebuild snapshot if fresh, else repo image, else base) → `Sandbox.create({ name, image | source, ports: [8443, 8444, …pool], resources, region, env, networkPolicy, timeout: 24h, persistent: true, onResume })` → start supervisor → wait for health → mark running → return connect info. Failure paths: `image_not_ready` retries with backoff; quota errors surface to the user.
- **connectWorkspace**: `Sandbox.get({ name })` resumes if needed → wait for health → mint token → record session → return `{ wsUrl: sandbox.domain(8443), token }`.
- **stopWorkspace**: notify client → `SIGTERM` supervisor → `sandbox.stop()` → record `activeCpuDurationMs`, ingress, egress into the usage ledger → mark stopped.
- **rebuildWorkspace**: stop → snapshot the workspace directory to a tarball in Vercel Blob (private) → delete sandbox → create from the current image → restore tarball → start.
- **deleteWorkspace**: stop → delete sandbox and snapshots → purge forwards, sessions.
- **prebuild**: section 6.4, triggered by webhook or manually, deduplicated per branch.
- **buildDevcontainerImage**: section 6.3.
- **gc**: nightly: stopped workspaces past retention, orphaned sandboxes not in the table, snapshots beyond keep count.

### 7.5 Lifecycle and idle policy

- Idle: the cron sweep runs every minute on Pro and reads each running workspace's last activity from Redis (populated by the supervisor's activity pings). Past the workspace's idle threshold (30 minutes default, 5 to 240 configurable), it runs `stopWorkflow`. Five minutes before, the supervisor raises `IDLE_STOP_IN` so the tab can keep alive.
- Session cap: sandboxes stop at 24 hours. The sweep calls `extendTimeout` while a workspace is active and under 23.5 hours; at 23.5 hours with an active session it raises `SESSION_CAP_IN` and performs a controlled stop and resume (the client sees a 3 to 6 second "restarting environment" overlay, then reconnects with a new session URL).
- Timeouts at create are 24 hours; the sweep extends as needed, so the platform's per-session timer never fires unexpectedly.
- Retention: stopped workspaces keep their snapshot 30 days after last use by default (platform default; configurable per plan), then are deleted with notice.
- Regions: workspace region defaults to the nearest of `iad1`, `sfo1`, `cle1`, `cdg1` by the user's location and is fixed for the workspace's life because snapshots are region-locked.

### 7.6 Editor shell page

Server-rendered Next.js page: canvas, boot overlay with staged progress (fetching editor, starting environment, connecting), reconnect overlay, takeover dialog, lifecycle toasts, "open in desktop" button, a slim top strip outside the canvas for workspace name, machine, region, stop and settings. Strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self' wss://*.vercel.run`, `worker-src 'self' blob:`), COOP and COEP.

### 7.7 Dashboard

Workspace list with state, repo, branch, machine, last active and cost to date; create flow (pick installation, repo, branch or PR, machine type, region, devcontainer detection); repo settings (prebuild branches, default machine, idle timeout); secrets; dotfiles; settings and keymap editor (or "edit in a workspace"); usage and billing; org management and audit log.

### 7.8 GitHub App and webhooks

App permissions: Contents read and write, Metadata read, Pull requests read, Webhooks. Events: `installation`, `push` (prebuilds), `pull_request` (create-from-PR links). Installation tokens are minted on demand, one hour, never stored. Repo cloning uses `source: { type: 'git', url, username: 'x-access-token', password: token, depth, revision }`. Pushes from the sandbox use the credential helper. Org policies can restrict which installations may create workspaces.

### 7.9 Secrets and environment

Secrets are AES-256-GCM encrypted with a key held in Vercel environment variables (versioned for rotation) and decrypted only inside the create and resume workflows to build the sandbox `env`. AI provider keys are the one exception (D43, b11 §7 item 1b): they live in their own `ai_keys` table and `resolveAiKey` decrypts one inside the `/api/ai/*` route handler on every proxied request, so the plaintext exists for the life of that request and never reaches the browser. Repo secrets override org, which override user. Secrets are never included in logs, manifests or client payloads; the manifest carries names only, values arrive as environment.

### 7.10 Usage metering and billing

Each `stop()` returns active CPU milliseconds and network transfer; the ledger accrues vCPU-hours, provisioned GB-hours (from wall-clock and machine size), egress and snapshot GB-days. Plans: Free (Hobby-equivalent limits, 2-core only, one workspace), Pro (per-seat plus metered), Team (org features). Metered prices are set above Vercel's list (Active CPU $0.128 per hour, memory $0.0212 per GB-hour, egress $0.15 per GB, snapshots $0.08 per GB-month) with margin. Stripe subscriptions plus monthly metered invoices. Spend caps per user and org stop workspace creation when exceeded.

### 7.11 Abuse and limits

Per-user concurrent workspaces and total vCPU by plan; egress caps; sustained-CPU-with-no-session detection stops the workspace and flags the account; network policy defaults to allow-all for developer ergonomics with an org option to allowlist (GitHub, npm, crates.io, PyPI and so on); Vercel Spend Management as the backstop. Vercel's terms need confirmation with sales for running thousands of end-user sandboxes on one team; Vercel's own templates and v0 do this, but no document blesses it explicitly.

---

## 8. AI

- **In-sandbox agents.** Zed's agent panel already drives ACP agents through `AgentServerStore::local` on the server; Claude Code, Codex, Gemini CLI and OpenCode ship in the image. Users authenticate them inside the terminal or via secrets. This is the primary AI experience and requires no client-side model access.
- **Model providers.** Zed's `language_models` crate talks to Anthropic, OpenAI, Google, Mistral, DeepSeek, Ollama and others over the GPUI HTTP client, which on wasm is `FetchHttpClient`. Most providers do allow browser CORS today (D43, b11 §7 item 1a: Anthropic with its opt-in header, OpenAI, Google, Mistral, OpenRouter, xAI, DeepSeek and the AI Gateway were all checked), so the control plane offers `/api/ai/{provider}/…` as an authenticated pass-through for key custody instead — the key never reaches the tab — and for the editor CSP (`connect-src 'self'`), rate limits and metering. Vercel AI Gateway is available as the configured `api_url` for OpenAI- and Anthropic-compatible endpoints with the user's gateway key. Keys are user secrets, never sent to the browser.
- **Zed-hosted features** (Zed's cloud models, edit prediction via Zed Cloud, Zed account sign-in) are unreachable: the sign-in flow redirects to a localhost callback server, and session authentication is cookie-based on zed.dev. Edit prediction is offered through providers that do not need Zed sign-in (Copilot via its language server in the sandbox, or Codestral with a key).

---

## 9. Extensions

Split by where a capability must execute:

| Capability | Executes | Delivery to browser |
|---|---|---|
| Language servers, debug adapters, context servers, agent servers | Sandbox (`HeadlessExtensionStore` today) | Not needed |
| Grammars | Browser (parsing is client-side) | `GET /extensions/{id}/assets/grammars/{lang}.wasm` from the server, linked per worker (section 3.3) |
| Queries (highlights, outline, brackets, indents, injections) | Browser | `GET /extensions/{id}/assets/languages/{lang}/*.scm`, registered in `LanguageRegistry` |
| Themes and icon themes | Browser | `GET /extensions/{id}/assets/themes/*.json`, registered in `ThemeRegistry` |
| Snippets | Browser | Same asset route |
| Slash commands | Sandbox (new: run the extension's wasm on the server, results over proto) | Not needed |

Install and uninstall flow through the new messages (section 5.6). The extensions UI lists the registry through the server (which already has the registry client). The server keeps installed extensions in its data directory, which is inside the snapshot, so they persist per workspace; the control plane records the list so a rebuild reinstalls them.

---

## 10. Security

Threat model, in order of consequence:

1. **Sandbox escape.** Vercel's responsibility (Firecracker). We do not run anything with more privilege than the user's own code.
2. **Cross-workspace access via the public RPC port.** Mitigated by single-audience one-hour JWTs verified before upgrade, one session at a time, random high ports for the auth proxy, and rate limiting on upgrade attempts at the server and via Vercel Firewall rules on the control plane.
3. **XSS in the shell page leading to RCE in the user's sandbox.** The editor is a canvas; the shell has strict CSP with no inline script, all state in HttpOnly cookies, and the WebSocket token is fetched per session and held in wasm memory. Third-party scripts are excluded from the editor route entirely (analytics load only on dashboard routes).
4. **Token or secret leakage.** Sandbox identity tokens are per sandbox and rotated on resume; GitHub tokens are one hour and never written to disk; user secrets only exist as sandbox environment; the manifest carries names only; logs are scrubbed for known token shapes.
5. **Abuse of compute.** Section 7.11.
6. **Supply chain.** Image builds are reproducible from a pinned base digest and pinned tool versions; images are referenced by digest at create; the wasm bundle and server binary are built from the same commit in CI with attestations.

Also: audit log of every lifecycle and secret operation; per-org SSO through Clerk; data residency by region choice; export and delete on request; a documented incident process; an external penetration test before general availability.

---

## 11. Delivery pipeline and upstream strategy

### 11.1 Repository layout

```
zed-codespaces/
  zed/                 git submodule → our fork, branch `zs`, rebased on upstream main
  apps/web/            Next.js control plane, editor shell, dashboard
  packages/sdk/        TypeScript client for the control plane API
  sandbox/image/       Dockerfile, supervisor sources (Rust), devcontainer builder
  infra/               vercel.ts, cron, queues, workflow config
  .github/workflows/   wasm build, server build, image build, deploy, rebase-check
```

### 11.2 Builds

- **Client**: nightly toolchain pinned by hash; `cargo build --release --target wasm32-unknown-unknown -p zed_web` with build-std; `wasm-bindgen`; `wasm-opt`; assets tarball; outputs to `apps/web/public/editor/<build>/`. Cold build about 60 minutes on 8 cores; sccache and a warm runner bring it to 10 to 15 minutes.
- **Server**: `cargo zigbuild --release --target x86_64-unknown-linux-musl -p remote_server` (Zed's own remote-server script does this), producing the static binary.
- **Image**: `docker buildx build --platform linux/amd64` and push to the registry, tagged with the build id and referenced by digest.
- **Deploy**: Vercel Git integration for `apps/web`; the build id is an environment variable; preview deployments get their own image tag so previews exercise real sandboxes.
- **Version coupling**: Zed's client rejects a server whose version string differs. Both binaries embed `ZS_BUILD_ID = <zed-commit>-<patch>`, and the sandbox image for a build is created before the web deploy promotes.

### 11.3 Upstream cadence

Zed cuts a preview weekly and promotes to stable weekly. We rebase the `zs` branch every two weeks with a `rebase-check` job that merges upstream `main` daily and runs the wasm check so conflicts surface early. Transport, `serve`, terminal and port-forward messages, client persistence and the extension messages are submitted upstream as they stabilize; they are the parts Zed's own web client will need, and the iPadOS draft shows Zed is already interested in thin clients. The gates in `fs`, `db`, `rpc`, `client`, `project` and the panels are submitted in the order upstream shows appetite.

---

## 12. Observability and operations

- **Logs**: server and supervisor JSON lines shipped to the control plane ingest route, forwarded to a Marketplace logging provider (choose via `discover --category logging`) with workspace and session ids as fields; Vercel Observability for functions, workflows and crons.
- **Client errors**: the wasm panic hook posts message, stack and build id to the client-errors route; sampled performance marks (boot stages, first paint, connect) go to the same route.
- **Metrics**: create and resume latency, boot-to-editable, connect success rate, reconnects per session, heartbeat misses, LSP start time, session length, active CPU per session, egress per session, snapshot sizes, image readiness.
- **Alerts**: create failure rate, `image_not_ready` after 5 minutes, health-check timeouts, ledger drift versus Vercel usage, spend thresholds.
- **Runbooks**: stuck sandbox (force stop and resume), region incident (create in failover region from image; snapshots are region-locked so warn users), key rotation, image rollback (pin previous digest), client rollback (previous build id; server versions must roll with it).

---

## 13. Testing and QA

- **Rust unit and integration**: transport framing and reconnect, JWT verification, PTY manager, port watcher, file endpoints, client persistence round trip, extension asset serving. Protocol conformance between a native client and `serve`.
- **Wasm tests**: `wasm-bindgen-test` in headless Chrome for the in-memory Fs, SQLite-in-wasm, grammar linker and keymap layer.
- **End to end**: Playwright against a preview deployment with real sandboxes: sign in, create from a private repo, edit with LSP completions, run a task, use the terminal, commit and push, forward a port and load it, stop and resume, reconnect after a forced disconnect, take over from a second tab, rebuild, delete. Browser matrix: Chrome, Edge, Firefox, Safari; macOS, Windows, Linux, iPadOS Safari for smoke.
- **Load**: 200 concurrent sessions on Pro limits; measure create latency at the provisioning rate ramp (150 vCPU per minute rising to 5,000).
- **Chaos**: kill the server mid-edit, expire the token, hit the session cap during a terminal job, resume with a changed session URL, stop with unsaved buffers.
- **Upstream drift**: nightly rebase-check as above.

---

## 14. Work breakdown, team and timeline

Estimates in person-weeks for engineers already fluent in Rust and Zed's codebase after a two-week ramp. Ranges reflect the fork's evidence and the compile probe; the browser port carries the most variance.

| Workstream | Items | Person-weeks |
|---|---|---|
| W1 Transport and server mode | `WebSocketRemoteConnection`, `serve`, JWT verification, takeover, health, tests | 4 |
| W2 Protocol additions | Terminals 3, port forwarding 2.5, file transfer 1.5, client persistence 2, lifecycle notices 0.5, extension messages 1, settings and keymap sync 1 | 11.5 |
| W3 Browser client port | Build environment and the four shims 1.5, compile-clean across the six gated leaf crates and edge gates 3, SQLite-in-wasm 1.5, runtime correctness of `project`, `workspace`, `editor` and panels in remote-only mode 8, tree-sitter runtime and built-in grammars 4, extension grammar linker 3, `zed_web` entry and boot 3, browser UX (keyboard, IME, clipboard, upload, dialogs, tabs) 3, bundle pipeline and service worker 2, performance 3, cross-browser QA 2 | 34 |
| W4 Sandbox | Image and registry pipeline 3, supervisor 3, credential helper and dotfiles 1, prebuild workflow 2, devcontainer builder 3 | 12 |
| W5 Control plane | Scaffold and auth 2, data model and API 3, workflows and lifecycle 3.5, editor shell 2, dashboard 3.5, GitHub App and webhooks 2, secrets and settings sync 2, metering and billing 2.5, abuse controls and admin 1.5 | 22 |
| W6 Security | Threat model, CSP, token design review, firewall rules, pen test and fixes | 4 |
| W7 Observability and ops | Log pipeline, metrics, alerts, runbooks | 3 |
| W8 Testing and CI | Wasm CI, e2e suite, load and chaos harness | 5 |
| W9 Upstream | Rebase cadence, upstream PRs for W1 and W2 | 3, then 15% ongoing |
| **Total** | | **98.5 person-weeks** |

Team: two Rust engineers (A: browser port; B: transport, protocol, server, image), one full-stack TypeScript engineer (control plane, shell, dashboard), a designer at half time for the dashboard and shell, and a QA engineer from month four. A tech lead who has read Zed's `project`, `remote` and `workspace` crates is the difference between the low and high end of every Rust estimate.

Calendar with that team:

| Month | Rust A (client port) | Rust B (server and protocol) | TypeScript (control plane) | Milestone |
|---|---|---|---|---|
| 1 | Leaf gating, Fs, SQLite-in-wasm, `rpc`/`client`/`remote` gating; hello-web on three browsers | W1 transport and `serve`; image v0 with the stable server binary; supervisor skeleton | Scaffold, Clerk, GitHub App, data model, create and connect workflows | Desktop Zed edits a repo in a Vercel Sandbox over WebSocket |
| 2 | `project` remote-only mode; `workspace` and `editor` compiling on wasm | Terminals and file transfer; client persistence; lifecycle notices | Dashboard v1, editor shell, idle sweep, stop and resume, secrets | Browser boots the workspace against the sandbox; editing and LSP work |
| 3 | Tree-sitter runtime and built-in grammars; panel crates | Port forwarding and private proxy; extension messages and asset routes; prebuild workflow | Ports UI backend, prebuilds, webhooks, settings sync, usage ledger | Terminal, git, tasks, ports and prebuilds work in the browser |
| 4 | Extension grammar linker; browser UX (keyboard, IME, uploads, tabs) | Devcontainer builder; supervisor hardening; upstream PRs for W1 and W2 | Billing, org features, admin, abuse controls | Private beta: invited users on real repos |
| 5 | Performance, bundle pipeline, service worker, cross-browser | Load and chaos fixes; region failover runbook | Observability, alerts, dashboard polish | Open beta |
| 6 | Bug burn-down, Safari and Firefox parity | Security review fixes, pen test remediation | Same | Release candidate |
| 7 | Stabilization | Stabilization | Stabilization | General availability |

Seven months to general availability with three engineers plus half a designer and a QA engineer from month four. The critical path is Rust A through month five; a third Rust engineer on tree-sitter and extensions in months two to four would pull GA to about five and a half months.

Infrastructure cost per active user, for planning: a 4 vCPU workspace used six hours a day with idle stop, at 20 percent average CPU, costs about $0.27 per hour to run (memory dominated), about $35 per month, plus under $3 per month for a 32 GB snapshot at its actual used size. Comparable to Codespaces' $0.36 per hour list price for 4 cores, leaving room for margin.

---

## 15. Risks and open decisions

Risks, ranked by expected impact:

1. **Browser port scope and upstream timing.** The largest workstream and the one Zed may ship itself. Every gate is kept upstream-shaped so their port can replace ours crate by crate; W1 and W2 are submitted upstream early to reduce the surface we maintain alone.
2. **Tree-sitter dynamic linking for extension grammars.** Novel engineering with wasm-bindgen; if it slips, v1 ships with built-in grammars plus a curated set of extension grammars precompiled into a secondary bundle, and dynamic loading follows.
3. **Session URL churn on resume.** Designed around from day one (connect always re-resolves); the residual risk is edge behavior for long-idle WebSockets on `vercel.run`, which is undocumented and is measured in month one.
4. **Nightly Rust and shared memory.** Cross-origin isolation is required; embedding third-party content in the editor route is therefore impossible, and Safari's shared-memory and WebGPU behavior is verified in month one.
5. **Vercel terms for end-user sandboxes.** Confirm with Vercel sales before beta; fallback is an enterprise agreement or Vercel for Platforms.
6. **GPL-3 obligations.** Modified client source is offered under GPL-3 (it is distributed to browsers); server-side changes are ours; the name and marks need clearance from Zed Industries before launch.
7. **Image size and readiness.** Toolchain-rich images approach several GB; readiness after push is undocumented in duration, so image builds run ahead of deploys and previews pin the previous image until the new one reports ready.
8. **Cost surprises.** Exposed-port traffic is billed; large forwarded-port workloads (video, big downloads) need caps per plan.

Open decisions to make in month one:

- Postgres provider and Redis provider from the Marketplace.
- Whether the free tier exists at launch (Hobby limits are tight: 10 concurrent sandboxes team-wide, 45-minute sessions), or whether all tiers run on Pro with a trial.
- Region default and whether users can choose.
- Idle threshold defaults per plan.
- Whether to include Zed collaboration as a hosted collab server in v1.5 (adds a Postgres-backed service, LiveKit for calls, and multiplayer editing through Zed's existing `ShareProject.is_ssh_project` path, which already bridges a remote project into a room).

---

## Appendix A: proto sketch

```proto
message SpawnTerminal { string working_directory = 1; optional string shell = 2; map<string,string> env = 3; uint32 cols = 4; uint32 rows = 5; optional uint64 task_id = 6; }
message SpawnTerminalResponse { uint64 terminal_id = 1; }
message TerminalInput { uint64 terminal_id = 1; bytes data = 2; }
message TerminalOutput { uint64 terminal_id = 1; bytes data = 2; uint64 offset = 3; }
message ResizeTerminal { uint64 terminal_id = 1; uint32 cols = 2; uint32 rows = 3; }
message CloseTerminal { uint64 terminal_id = 1; }
message TerminalExited { uint64 terminal_id = 1; int32 code = 2; }
message ListTerminals {}
message ListTerminalsResponse { repeated TerminalInfo terminals = 1; }
message AttachTerminal { uint64 terminal_id = 1; uint64 from_offset = 2; }

message PortsChanged { repeated ListeningPort ports = 1; }
message ForwardPort { uint32 port = 1; PortVisibility visibility = 2; optional string label = 3; }
message ForwardPortResponse { string url = 1; }
message UnforwardPort { uint32 port = 1; }

message SaveClientState { bytes sqlite = 1; uint64 version = 2; }
message LoadClientState {}
message LoadClientStateResponse { bytes sqlite = 1; uint64 version = 2; }

message LifecycleNotice { LifecycleKind kind = 1; uint32 seconds = 2; }
message FilesUploaded { repeated string paths = 1; }

message ListExtensions {}
message InstallExtension { string id = 1; optional string version = 2; }
message UninstallExtension { string id = 1; }
message ExtensionsChanged { repeated InstalledExtension installed = 1; }
```

## Appendix B: sequence flows

**Create.** Dashboard → `POST /workspaces` → `createWorkspace` workflow → pick prebuild snapshot or image → `Sandbox.create` → `runCommand(zs-agent start, detached)` → health → running → dashboard redirects to `/w/{id}`.

**Open.** `/w/{id}` → `POST /workspaces/{id}/connect` → `Sandbox.get({ name })` (resumes from snapshot if stopped, sub-second to a few seconds) → `onResume` runs `zs-agent start` → health → mint JWT → `{ wsUrl, token }` → browser dials `wss://…/rpc` with subprotocol → `RemoteStarted` → worktree snapshot → editable.

**Reconnect.** Heartbeat misses ×5 → transport asks shell for fresh connect info → new dial (URL may differ) → `FlushBufferedMessages` → replay → editing continues; terminals reattach with scrollback.

**Idle stop.** Activity pings stop → sweep sees threshold −5 min → `LifecycleNotice IDLE_STOP_IN` → no keepalive → `stopWorkspace` → supervisor flushes client state → `sandbox.stop()` (auto snapshot) → ledger updated → tab shows "stopped, click to resume".

**Prebuild.** GitHub push → webhook → queue → `prebuild` workflow → create from repo image → clone → post-create → headless warm → snapshot → record; old prebuild beyond keep count deleted.

**Push code.** Git panel commit and push → server git store runs `git push` → credential helper → `POST /sandboxes/{name}/git-token` with sandbox identity → GitHub App installation token (1 h) → push succeeds; nothing written to disk.

## Appendix C: sources

Zed: `crates/remote/src/{remote_client.rs, protocol.rs, transport.rs}`, `crates/remote_server/src/{server.rs, headless_project.rs}`, `crates/project/src/terminals.rs`, `crates/gpui_web/src/*`, `crates/cloud_api_client/src/websocket/web.rs`, `crates/language_core/src/grammar.rs`, `crates/grammars/src/grammars.rs`, `crates/client/src/client.rs` (sign-in), `.github/workflows/run_tests.yml` (`check_wasm`); PRs #50228, #62165, #62784, #63484, #63547; zed.dev/blog/introducing-delta; zed.dev/roadmap. Fork: github.com/zee295/zed tree `zed-web`, image `ghcr.io/zee295/zed-web:latest` (measured sizes). Vercel: docs/sandbox (concepts, persistent-sandboxes, snapshots, images, firewall, regions, tags, multi-agent, drives, pricing, sdk-reference, cli-reference), docs/container-registry (limits-and-pricing, getting-started), docs/functions/websockets and limitations, docs/workflows/pricing, docs/queues/pricing, docs/cron-jobs, docs/sign-in-with-vercel, docs/marketplace-storage, docs/how-vercel-cdn-works/compression, docs/caching/cache-control-headers, kb/guide/sandbox-private-github-repositories, kb/guide/how-to-use-snapshots-for-faster-sandbox-startup, kb/guide/running-opencode-securely-with-the-vercel-sandbox, changelog entries for 24-hour sessions, custom images, 10,000 concurrent sandboxes.
