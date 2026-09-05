# Zed in the browser, backed by a Vercel Sandbox

Scoping study, 2026-09-02. Research was done against Zed `main` at commit `c3cf80c` (v1.19.0-dev), the `zee295/zed` `zed-web` fork at `88db2d1`, and current Vercel Sandbox docs.

## Verdict

Feasible, and the shape is clearer than expected, but it splits into one cheap half and one expensive half.

- **Cheap half (weeks):** the VM side and the transport. Zed already ships a static x86_64 Linux `remote_server` binary that hosts worktrees, LSP, git, debug adapters, tasks and extensions. Its client talks to it through a transport trait that just moves protobuf envelopes through two channels, so a WebSocket transport is a modest addition on both ends. Vercel Sandbox is a good fit for the VM: 24-hour sessions, custom x86_64 images, root, persistent disk via snapshot, public HTTPS URLs for exposed ports.
- **Expensive half (months, uncertain):** getting Zed's editor UI to run in a browser tab. GPUI itself runs in the browser today (Zed's own `gpui_web` crate, WebGPU with WebGL2 fallback, actively developed by Zed staff since February 2026). But nothing above GPUI, meaning `editor`, `project`, `workspace`, `language`, compiles to wasm upstream yet. A community fork proves it can be done, at the cost of a large patch set that is hard to keep rebased.
- **Strategic wrinkle:** Zed lists "Zed on the Web" under "Coming Up Next" on its public roadmap, and its web platform work exists because Zed's new Delta product ships as wasm in a browser. Zed may do most of the client port themselves within the year. The durable value in this project is the hosting and control plane on Vercel, the WebSocket transport, and a terminal protocol, all of which Zed's own web client would also need.

Recommended path: build the sandbox, control plane and WebSocket transport first, and ship them with the desktop Zed app as the client (a "Codespaces backend for Zed"). Start the browser client port in parallel as a tracked risk, aligned with upstream's crate layout so it can be upstreamed or replaced by Zed's own port.

## What exists today

### GPUI runs in the browser

Zed's repository contains a first-party browser platform for GPUI.

| Fact | Evidence |
|---|---|
| `gpui_web` crate: canvas-backed platform for `wasm32-unknown-unknown` | `crates/gpui_web/src/gpui_web.rs` header: "one document-owned canvas and supports one top-level window. Browser WebGPU is preferred by default, with an automatic WebGL2 fallback." |
| `gpui_wgpu` crate: wgpu renderer with WebGL and WebGPU shader variants, cosmic-text shaping | `crates/gpui_wgpu/src/{wgpu_renderer.rs, shaders_webgl.wgsl, cosmic_text_system.rs}` |
| Multi-threaded via web workers and SharedArrayBuffer | `crates/gpui_web/Cargo.toml` feature `multithreaded`, `crates/scheduler` feature `wasm-threads`, Zed fork of `wasm_thread` |
| Fetch-based HTTP client, clipboard, IME, touch, mobile keyboards | `crates/gpui_web/src/{http_client.rs, platform.rs, ime_mirror.rs, events.rs}` |
| Checked in Zed's CI on every run | `.github/workflows/run_tests.yml` job `check_wasm` runs `cargo -Zbuild-std=std,panic_abort check --target wasm32-unknown-unknown -p gpui_platform -p cloud_api_client` |
| Workspace toolchain file lists the target with the comment "gpui on the web" | `rust-toolchain.toml` |
| Landed by Zed staff in PR #50228 ("GPUI on the web", 2026-02-26); 40 follow-up commits through 2026-09-01 by Zed staff: WebGL backend, IME rewrite, worker-pinned tree-sitter parsing, fonts, keyboard feel, long-press | GitHub PR history |

I reproduced the CI check locally. It builds 363 crates for wasm in 9 minutes on this machine with the nightly toolchain and `-Zbuild-std`.

Constraints that matter for an editor:

- Nightly Rust, `build-std`, and `+atomics,+bulk-memory,+mutable-globals` are required for the threaded build. The page must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`) to get SharedArrayBuffer.
- One canvas, one window. No native menus, no file dialogs, no reopening a closed window.
- Blocking on the main thread panics on wasm. Zed gated its blocking executor APIs behind this in August 2026 (PR #63484).
- The app must ship its own fonts; there are no system fonts.
- WebGPU on Linux browsers is spotty, hence the WebGL2 fallback.

### The editor stack does not compile to wasm upstream

I ran `cargo check --target wasm32-unknown-unknown -p editor --keep-going` on Zed `main`. It stops at a small set of leaf crates; everything above them (`project`, `workspace`, `editor`) is never reached.

| Blocker | Failure | What it means |
|---|---|---|
| `mio`, `polling` | "This wasm target is unsupported" | The async I/O runtime (tokio net, smol/async-io). Anything that opens sockets or child processes. |
| `errno`, `home`, `trash` | no wasm implementation | libc-flavored helpers pulled by `fs`, `util`, `paths` |
| `paths` (Zed) | `util::paths::home_dir` missing | Zed's `util` crate already gates `home_dir`, `command`, `shell`, `fs` out on wasm; `paths` has not caught up |
| `task` (Zed) | `util::shell` missing | Same gate |
| `fuzzy` (Zed) | `BackgroundExecutor::scoped` missing | Scoped threads are not available in the wasm executor |
| `lsp-types` (Zed fork) | `Url::from_file_path` missing | The `url` crate has no file-path support on wasm |
| `async-tar` | needs `async_std::fs` | Archive extraction for LSP/adapter downloads |
| C build scripts: `aws-lc-sys`, `libsqlite3-sys`, `tree-sitter-json`, `wasmtime-c-api-impl` | build script failed | rustls crypto, SQLite for workspace persistence, tree-sitter grammars, the extension host |

The list is short because it is the frontier, not the total. Behind each blocker are the crates that depend on it. Zed has started the groundwork in leaf crates only: `util`, `http_client`, `scheduler`, `ztracing`, `cloud_api_client` (which has a working browser WebSocket via the `yawc` crate) and `language_core` (which resolves tree-sitter grammars per thread because `tree_sitter::Language` is not `Send` on wasm). No gating exists in `editor`, `project`, `workspace`, `language`, `rope`, `text`, `settings`, `theme`, `fs`, `rpc`, `remote`, `client`, `worktree` or `terminal`.

### Zed's remote development is the right seam

Zed's SSH remoting already splits the app the way a Codespace needs.

**Server.** `remote_server` is published per release as `zed-remote-server-linux-x86_64.gz`. The stable v1.17.2 asset is a 120 MB static-pie musl ELF (41 MB gzipped) with no runtime dependencies. In process it runs worktree scanning and file watching, buffers, language servers (downloading Node into its data dir when needed), git, debug adapters, tasks, prettier, toolchains, the wasm extension host for language and DAP extensions, MCP context servers and ACP agents (`crates/remote_server/src/headless_project.rs`). It reads the host's `~/.config/zed/settings.json` and receives the client's user settings over the wire.

**Client.** `crates/remote/src/remote_client.rs` defines `trait RemoteConnection`. Its one real job is `start_proxy(...)`, which receives an `UnboundedSender<Envelope>` and an `UnboundedReceiver<Envelope>` and must move envelopes between them and the remote. Nothing above that trait knows about SSH. `Project::remote` and every `*Store::remote` speak `AnyProtoClient`, the same abstraction used for collaboration.

**Wire protocol.** `u32` little-endian length prefix, then a prost-encoded `proto::Envelope` (`crates/remote/src/protocol.rs`). No compression, no TLS, no auth; security is entirely the transport. Both ends run the same `ChannelClient`: a `RemoteStarted` handshake, `ack_id` on every envelope with a replay buffer, a 5-second heartbeat with reconnect after 5 misses, and a `FlushBufferedMessages` resync on reconnect. Reconnect assumes the server process survived; if it did not, the client gets exit code 90 (`ServerNotRunning`) and opens a fresh connection.

**Transports that exist.** SSH (via a local `ssh` ControlMaster), WSL (`wsl.exe`), and Docker/Podman `exec` for dev containers. All three end in the same function that multiplexes a child process's stdin/stdout/stderr (`crates/remote/src/transport.rs`). There is no TCP, WebSocket or Unix-socket transport on the client, and `remote_server` never listens on a network port; its `proxy` and `run` subcommands talk over Unix sockets on the remote host.

**Two things the protocol does not cover.**

1. Terminals. There are no terminal messages in `zed.proto`. A remote terminal is a separate local `ssh -t <shell>` process driven by the client's own PTY code. A browser client cannot do that.
2. Port forwarding. Also a separate local `ssh -N -L` process.

**Vestigial history.** Zed once had "dev servers" reachable through the collab server; only stubs remain (`--dev-server-token` is documented as not implemented). The collab server never talks to a `remote_server` directly, so collab is not a shortcut here, although its client already has a browser WebSocket path and the server URL is configurable.

### The community fork proves the UI can run in a tab

`zee295/zed`, branch `zed-web`, synced to Zed v1.17.2 on 2026-08-26, ships a Docker image (`ghcr.io/zee295/zed-web`) that serves the real GPUI workspace to a browser.

What it demonstrates: the actual `editor`, `workspace`, `project`, `terminal_view`, `git_ui`, `agent_ui`, `debugger_ui`, project and outline panels, settings UI and extensions UI all build for wasm and render through `gpui_web`. Terminals, LSP, debuggers, ACP agents, MCP servers and pane persistence work end to end. It has Playwright coverage for five flows and multi-arch CI.

How it does it, and why I would not build on it:

- It opens the project as a **local** project with a fake filesystem, then trampolines every syscall over a home-grown JSON RPC on one WebSocket: 147 methods across `Fs::*` (33), `GitRepository::*` (60, shelling out to `git`), `Process::*`, `Terminal::*`, `Sql::*`, and more. Binary data is base64 inside JSON. This is a 12,172-line server that re-implements what `remote_server` already provides with typed protobuf.
- It replaces `smol`, `which`, `url`, `lsp-types`, `async-tar`, `tree-sitter`, `alacritty_terminal` and `agent-client-protocol` with vendored or shimmed copies via `[patch]`. Several shims fail silently: timers never fire, `smol::spawn` drops futures, every exit status is 0, tar extraction returns Ok without extracting.
- It adds roughly 540 wasm `cfg` gates across about 47 upstream crates, 3,800 lines of new files inside upstream crates, and a 2,237-line hand-mirrored copy of `zed::init`.
- **There is no tree-sitter in the browser.** Syntax highlighting is a server-side keyword tokenizer for about 20 languages. Outline, bracket matching, indentation, folding, injections and extension grammars are gone.
- Workspace persistence is a synchronous XMLHttpRequest to `POST /sql` on the UI thread, and GPUI runs single-threaded.
- Single shared token, arbitrary process execution behind a cookie, no multi-tenancy.
- The fork's own README lists "reuse the existing `rpc::Peer` / `proto::Envelope` path" as its next step.

What to harvest from it: the per-crate `cfg` gating in `fs`, `db`/`sqlez`, `client`, `terminal`, `util` and `project` as a map of what has to change; the `RemotePty` and process-reattach semantics; the `std::time::Instant` audit script; the wasm-bindgen shared-memory patch; the LLM proxy route.

### Zed's roadmap

- PR #50228 "GPUI on the web" (Lukas Wirth, Zed staff, 2026-02-26) created `gpui_web`. The July to September push (text input, IME, touch, mobile keyboards, WebGL, an iOS backend PR) matches shipping Delta.
- "Introducing Delta" (2026-08-12): "the same Rust application, compiled to WebAssembly and rendered through WebGL, so your teammate gets the same experience you do." Delta is a separate GPUI app, not the editor.
- zed.dev/roadmap lists "Zed on the Web: Open projects from any device" under "Coming Up Next." A closed draft PR (#63547, 2026-09-01) ran Zed on iPadOS as a thin GPUI client over in-process SSH to bundled `remote_server` binaries, which is the same split this project needs.
- Nobody at Zed has replied to the "Run Zed in the browser" discussion (#60629).

### Vercel Sandbox fits the VM role

From current docs (Pro plan unless noted):

| Limit | Value |
|---|---|
| Session timeout | 5 min default, 24 h max (45 min on Hobby); extendable with `extendTimeout` |
| Resources | 1 to 8 vCPU, 2 GB RAM per vCPU (32 vCPU on Enterprise) |
| Disk | 32 GB ephemeral; persisted across stop/start via automatic snapshot |
| Persistence | on by default: `stop()` snapshots, `Sandbox.get({name})` resumes with a fresh timeout; running processes and memory are lost on resume, `onResume` hook to restart them |
| Snapshot retention | 30 days after last use by default, configurable to never |
| Images | `vercel/sandbox/universal` (Ubuntu 26.04, Node 24, Python 3.14, git, tmux, ripgrep) or any OCI image via Vercel Container Registry, `linux/amd64` only |
| Privileges | user `ubuntu` with passwordless sudo; Docker, FUSE and VPN clients supported |
| Inbound | up to 15 declared ports, each at a public `https://<id>.vercel.run` URL, unauthenticated; HTTPS only, WebSocket upgrade undocumented but v0's dev-server HMR runs over it |
| Egress | allow-all by default, or domain/CIDR allowlists |
| PTY | CLI `sandbox connect` gives a TTY; the JS SDK exposes no PTY, so a browser terminal needs a PTY server inside the VM (which `remote_server` would become) |
| Concurrency | 10,000 sandboxes on Pro (10 on Hobby) |
| Pricing (iad1) | $0.128 per active-CPU-hour, $0.0212 per GB-hour provisioned memory, $0.60 per million creations, $0.15/GB egress including exposed-port traffic, $0.08/GB-month snapshots. An 8 vCPU / 16 GB sandbox for 2 hours at full CPU is about $2.73; at idle it is dominated by memory, about $0.34 per hour. |

Vercel Functions support WebSockets but close them at the function's max duration (300 s Hobby, 800 s Pro, 1800 s beta). So the browser must connect **directly** to the sandbox's public port, not through a Function. That in turn means `remote_server` must authenticate the connection itself, because the `*.vercel.run` URL is public.

Vercel's own products already run interactive sessions this way: v0 (24 h cap, heartbeat extends), Devin Outposts (named persistent sandboxes with auto-extend), Eve (30-minute inactivity timeout, resume on next message).

## Recommended architecture

```
┌──────────────────────────────┐        wss://<id>.vercel.run/rpc?token=…
│  Browser tab                 │ ─────────────────────────────────────────┐
│  gpui_web + Zed workspace    │   (direct; not through a Function)      │
│  Project::remote             │                                          ▼
│  WebSocketRemoteConnection   │                     ┌──────────────────────────────────────┐
└──────────────┬───────────────┘                     │  Vercel Sandbox (Firecracker microVM) │
               │ https (auth, workspace CRUD)        │  custom linux/amd64 image             │
               ▼                                     │                                       │
┌──────────────────────────────┐  @vercel/sandbox    │  zed-remote-server serve              │
│  Control plane (Next.js)     │ ──────────────────► │    --listen 0.0.0.0:8443 --token …    │
│  Sign in with Vercel/GitHub  │  getOrCreate/stop/  │    worktrees · LSP · git · DAP        │
│  workspace table, idle cron  │  extendTimeout      │    tasks · extensions · PTYs (new)    │
│  serves wasm bundle w/ COOP  │                     │  repo checkout · toolchains            │
└──────────────────────────────┘                     └──────────────────────────────────────┘
```

**Client.** Zed's workspace compiled to wasm with `gpui_web`, opened via `Project::remote` against a new `RemoteConnectionOptions::WebSocket { url, token }` whose `start_proxy` opens a `yawc::WebSocket` (already proven in the browser by `cloud_api_client`), maps one binary frame to one `Envelope`, and returns errors from `upload_directory` and `build_command`. Until the wasm port lands, the exact same transport works in the desktop app.

**Server.** A new `serve` subcommand on `remote_server` that listens on a port, accepts one authenticated WebSocket session at a time, and feeds the same `(incoming_rx, outgoing_tx)` pair into `RemoteClient::proto_client_from_channels` that the Unix-socket accept loop uses today. Keep the replay-on-reconnect semantics; drop the pid-file and socket dance. Token in the URL query or the `Sec-WebSocket-Protocol` header, because browsers cannot set arbitrary headers on a WebSocket. TLS terminates at Vercel's edge.

**Control plane.** A Next.js app on Vercel. Route handlers use `@vercel/sandbox` v2 with the automatic OIDC token: `Sandbox.getOrCreate({ name: workspaceId, image, source: { type: 'git', url }, ports: [8443], timeout, onResume })`. `onResume` relaunches `zed-remote-server serve`. The handler returns `{ wsUrl: sandbox.domain(8443), token }`. A Vercel cron stops sandboxes idle past a threshold (auto-snapshot). The wasm bundle is served as static files from the same origin with COOP/COEP headers set in `vercel.ts`, pre-compressed with brotli.

**Image.** Built with `vercel vcr build` from a Dockerfile on `vercel/sandbox/universal`: adds `zed-remote-server` (pinned to the exact client version, since the client rejects mismatches), plus whatever language servers and toolchains you want prebuilt. The user's workspace snapshots carry LSP downloads and Node installs across resumes.

## Work breakdown

Estimates are for one experienced Rust engineer and are rough.

### Phase 0: spike, 1 to 2 weeks

1. Build and run `crates/gpui_web/examples/hello_web` with `trunk` on Chrome, Safari and Firefox. Confirm WebGPU and WebGL2 paths and cross-origin isolation.
2. Add `serve --listen --token` to `remote_server`. Test locally against a patched desktop Zed with `WebSocketRemoteConnection`.
3. Build a sandbox image with the stable `zed-remote-server` binary, create one with `@vercel/sandbox`, expose the port, connect from desktop Zed over `wss://`. Measure connect latency, LSP startup, and file-watch behavior on a mid-size repo.

Exit criteria: desktop Zed edits a repo inside a Vercel Sandbox over WebSocket with LSP and git working.

### Phase 1: Codespaces backend for desktop Zed, 3 to 5 weeks

- Control plane: auth, workspace list, create-from-repo, open (returns connection details or a `zed://` deep link), stop, delete.
- Sandbox lifecycle: idle detection from the WebSocket activity signal `remote_server` already tracks, `extendTimeout` heartbeat while connected, cron stop, `onResume` relaunch, version pinning between client and server.
- Upstream-quality PRs for the WebSocket transport and `serve` subcommand. Zed maintainers have a stated interest in thin clients (iPadOS draft) and this is small.

This is shippable on its own.

### Phase 2: terminal and port-forwarding protocol, 2 to 4 weeks

- Add `SpawnTerminal`, `TerminalInput`, `TerminalOutput`, `ResizeTerminal`, `CloseTerminal` to `zed.proto`; run the PTY inside `HeadlessProject` using the `terminal` crate's alacritty PTY; add a remote-stream `TerminalType` on the client. Preserve scrollback and reattach across reconnects (the fork's `RemotePty` is a reference).
- Port forwarding: either declare extra sandbox ports and rewrite localhost URLs, or add tunnel frames to the protocol. The first is simpler and uses Vercel's public URLs.

Needed for both desktop-over-WebSocket and the browser client.

### Phase 3: browser client, 3 to 5 months, high variance

Make `workspace`, `editor`, `project` and dependencies build for wasm in "remote-only" mode. Concretely:

- Gate `rpc::{conn, message_stream, peer}` (tungstenite, zstd) so only `proto` and `proto_client` build; the `remote` crate's SSH/WSL/Docker transports; `askpass`; `auto_update`; `node_runtime`; `which`; local PTY in `terminal`; extension installation (keep bundled languages and themes, sync extensions server-side).
- Replace `libsqlite3` workspace persistence with IndexedDB or a server-backed store; replace `RealFs` for settings, keymap and snippets with an in-memory or IndexedDB `Fs` (the trait is abstract; `FakeFs` is a model).
- Swap `ReqwestClient` and `gpui_tokio` for `gpui_web::FetchHttpClient` and the wasm executors; audit `std::time::Instant` (the fork's allowlist script is reusable); handle `Send` assumptions and `BackgroundExecutor::scoped` uses.
- Build tree-sitter and grammars for wasm32 with wasi-sdk clang, linked per thread as `language_core::ParseableLanguage` expects. This is the biggest single item and the one the fork skipped.
- rustls with `aws-lc-sys` will not build; use the `ring` backend or rely on the browser for TLS (fetch and WebSocket already do).
- Embed fonts, ship icons and themes as assets, and measure bundle size. Expect tens of megabytes of wasm; plan for brotli, streaming compilation and long-lived caching.

Sequence it by crate depth: `paths`, `task`, `fuzzy`, `lsp` types first, then `fs`, `db`, `rpc`, `client`, then `project`, then `workspace` and `editor`. Keep every change as `cfg(target_family = "wasm")` gates in upstream's crate layout so the diff stays upstreamable and can be swapped for Zed's own port when it appears.

### Phase 4: productization, ongoing

Multi-tenancy (one sandbox per workspace, tokens per session), prebuilds via snapshots, usage metering against Vercel's per-vCPU-hour pricing, GitHub App for repo access, Sign in with Vercel or GitHub OAuth, observability.

## Risks and open questions

1. **Scope of the wasm port.** It is the majority of the cost and Zed may do it first. Mitigation: ship Phases 0 to 2 with the desktop client, keep the port upstream-shaped, and watch `gpui_web` and `crates/zed` for wasm gates landing.
2. **Nightly Rust and shared memory.** The threaded build needs nightly, `build-std`, and cross-origin isolation. Safari's SharedArrayBuffer and WebGPU behavior needs testing early. A single-threaded fallback exists (`gpui_platform::single_threaded_web`) but the fork shows what that costs.
3. **Public sandbox ports.** Anyone with the URL can reach `remote_server`. The token must be per session, rotated, and checked before the upgrade completes; add rate limiting; consider binding to a random high port. Vercel bills exposed-port traffic as egress.
4. **Process death on resume.** `remote_server` keeps buffers, LSP and worktree state in memory. After a sandbox resume the client sees `ServerNotRunning` and reconnects fresh; unsaved buffer contents live in the client, so this is survivable but must be tested. The 24-hour session cap forces at least one resume per day.
5. **Version coupling.** Client and server versions must match exactly. Build both from the same commit and pin the image tag to the client build.
6. **License.** Zed's editor crates are GPL-3.0-or-later; GPUI is Apache-2.0. Serving a modified client to browsers is distribution, so the modified client source must be offered under GPL-3. Server-side changes are not forced open by GPL-3 (it is not AGPL), but an upstream-first approach avoids the question. Check Zed's trademark policy before using the name.
7. **Bundle size and cold start.** Unknown until measured. The fork does not record it. Vercel static asset size limits for a single file should be verified before committing to same-origin hosting; the fallback is Vercel Blob, which then needs CORP headers for COEP.
8. **Undocumented WebSocket support on `*.vercel.run`.** Highly likely to work (v0 HMR), but confirm in Phase 0 with a long-idle connection and large frames.

## Alternatives considered

- **Pixel streaming.** Run native Linux Zed in the sandbox with a virtual display and stream frames over a WebSocket (noVNC-style; WebRTC ingress is not available on sandbox ports). No wasm port needed, so it can demo in days. Rejected as a product: no GPU in the sandbox so GPUI renders through software Vulkan, input latency and IME are poor, bandwidth is billed as egress, and text is blurry under scaling. Useful only as a throwaway demo.
- **Build on the `zed-web` fork.** Fastest path to a working browser tab, but it duplicates `remote_server` with a JSON RPC, has no tree-sitter, runs single-threaded, and carries a rebase burden the maintainer is already two minor versions behind on. Harvest, do not adopt.
- **Route through the collab server.** Collab cannot host a remote project; it only relays a project shared by a connected client. Its "dev server" feature was removed. Not a fit.

## Next steps

1. Run `trunk serve` on `hello_web` and check all three browsers (half a day).
2. Implement `serve` on `remote_server` and `WebSocketRemoteConnection` in `crates/remote` behind a feature flag; test desktop to local (2 to 3 days).
3. Build the sandbox image via `vercel vcr build`, run the stable binary, connect desktop Zed over `wss://` (2 to 3 days).
4. Decide on the browser port only after step 3 works and after checking Zed's `main` for new wasm gates in `project` or `workspace`.

## Appendix: reproduction

Clone used for this study: `/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad/zed` (shallow), fork at `.../scratchpad/zed-web`. Nightly was installed into rustup with `rust-src` and the wasm target.

```sh
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals"
export RUSTC_BOOTSTRAP=1
# Zed's CI check; passes, 363 crates, ~9 min
cargo +nightly -Zbuild-std=std,panic_abort check --target wasm32-unknown-unknown -p gpui_platform -p cloud_api_client
# Blocker enumeration; fails as expected, ~2 min
cargo +nightly -Zbuild-std=std,panic_abort check --target wasm32-unknown-unknown -p editor --keep-going
# Published remote server binary
curl -s "https://cloud.zed.dev/releases/stable/latest/asset?os=linux&arch=x86_64&asset=zed-remote-server"
```

Key files: `crates/remote/src/remote_client.rs` (transport trait, heartbeat, reconnect), `crates/remote/src/protocol.rs` (framing), `crates/remote/src/transport.rs` (stdio multiplexing), `crates/remote_server/src/server.rs` (proxy/run, accept loop), `crates/remote_server/src/headless_project.rs` (what runs remotely), `crates/project/src/terminals.rs` (why terminals are local), `crates/gpui_web/src/platform.rs`, `crates/cloud_api_client/src/websocket/web.rs` (browser WebSocket), `crates/language_core/src/grammar.rs` (tree-sitter on wasm), `crates/gpui_web/examples/hello_web`.

Sources: Zed PRs #46758, #49277, #50228, #62165, #62784, #63484, #63547; zed.dev/blog/introducing-delta; zed.dev/roadmap; zed.dev/docs/remote-development; github.com/zee295/zed/tree/zed-web; vercel.com/docs/sandbox (concepts, persistent-sandboxes, snapshots, images, firewall, pricing, sdk-reference, cli-reference); vercel.com/docs/functions/websockets; vercel.com/changelog/vercel-sandbox-can-now-run-for-up-to-24-hours.
