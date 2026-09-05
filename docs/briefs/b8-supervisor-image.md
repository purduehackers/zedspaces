# b8-supervisor-image: Sandbox supervisor (`zs-agent`) and image

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` §6.1 (lines 280-292), §6.2 (294-305), §6.3 (307-311), §6.4 (313-315), §5.2 (249-254; amended by D8), §5.5 (264-266), §7.3 (339-350, sandbox-facing routes at 348), §7.4 (356-362), §7.5 (365-371), §7.9 (385-387), §9 (407-420), §4.2 (210-223; amended by D3), §4.3 (225-227), §10 (428-433), §11.1/11.2 (441-459), §12 (469), §13 (477-483), and the binding cross-brief decisions in `/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md` (D1-D20; this brief's reconciliation is §9). Companion briefs read: `docs/briefs/b2-serve-mode.md` (the `serve` CLI, `/health`, log format, close codes, the loopback control listener), `docs/briefs/b4-proto-additions.md` (the `/control/*` channel, `/ports` and `/extensions` supervisor API, `--control-secret-file`, `ZS_SUPERVISOR_URL`), `docs/briefs/b3-terminals.md` (§7.10, the server environment ask), `docs/briefs/b1-ws-transport.md` (§4.2 `Hello`/`HelloAck` and framing, used by the prebuild warm-up client) and `docs/briefs/b9-control-plane.md` (the control plane that actually serves the manifest and the sandbox-facing routes; §3.18, §3.19, §3.25, §4.2, §4.7, §4.8, §7 item 7). **This brief is the authority for the sandbox ↔ control-plane wire contract** (b9 §8 R2-1 adopted it as such; D19 puts the shared fixture under this brief's `docs/contracts/`): where b9's current text and this brief still disagree, §4 and `docs/contracts/` are normative and §7/§9 list the asks. Everything below lives **outside** the Zed workspace: a standalone Cargo workspace at `/Users/ray/Projects/play/wed/sandbox/supervisor`, an image at `/Users/ray/Projects/play/wed/sandbox/image`, and a shared contract directory `/Users/ray/Projects/play/wed/docs/contracts/`. No file under `zed/` or the `zed-web` scratch clone is modified.

## 1. Goal

Deliver `zs-agent`, the single static binary that runs inside every workspace sandbox: it fetches the workspace manifest with the sandbox identity token, clones or restores the repository (rebuild tarball extracted at `/`, D9), launches and supervises `zed-remote-server serve` as early as possible (with the D5/D18 spawn line: `--control-secret-file`, `--control-listen 127.0.0.1:8446`, `--supervisor-url`, `--allowed-origin`), runs dotfiles and `devcontainer.json` lifecycle commands alongside the running server, fronts private ports with a cookie-authenticated reverse proxy on the four D8 proxy slots (bootstrapped by the control plane's HMAC port token), serves health on 8445 and a loopback-only API on 8450, relays listening ports, activity (`lastInputAt`, `busy`, `phase`, `cpuBusyPct`, D13), installed extensions (D18/D19) and logs to the control plane, turns the control plane's activity directive into lifecycle notices for the server, acts as the git credential helper for GitHub, runs the prebuild variant of the same boot including the headless language-server warm-up (`zs-agent prebuild`, D14), and shuts the server down cleanly on `SIGTERM` inside the control plane's exit wait (≤ 25 s, b9 §4.8) while giving b4's 5 s `SaveClientState` flush its full window (D18). Deliver the `linux/amd64` sandbox image (Dockerfile, build scripts, CI workflow) built on a digest-pinned `vercel/sandbox/universal` with toolchains, preinstalled language servers, `zed-remote-server` and `zs-agent`, a Docker-based local test that runs `zs-agent start` against a mock control plane, and the shared manifest/API contract files that b9's and b4's tests consume too.

## 2. Existing code that matters

Verified by reading; paths relative to `/Users/ray/Projects/play/wed` unless absolute.

Plan, decisions and companion briefs

| Anchor | Note |
|---|---|
| `BUILD-SPEC.md:282` | Image base `vercel/sandbox/universal`, pushed with `vercel vcr build docker . zs-workspace:<build> --push`; 500 MB/layer, 15 GB/image limits. |
| `BUILD-SPEC.md:284-290` | Five layers: toolchains (item 1 lists Rust, Go, a Node LTS matrix via corepack, Python via uv, Java, .NET, Ruby, PHP, Docker), language servers (list at 287, incl. jdtls, omnisharp, solargraph, intelephense, eslint, prettier), agents, `zed-remote-server` (static musl, 120 MB) + `zs-agent`, user `ubuntu` uid 1000 with passwordless sudo and "home on the persisted filesystem" (no path named). §3.19 states every cut from that list. |
| `BUILD-SPEC.md:296-305` | Supervisor responsibilities: manifest fetch, first boot (clone/restore, dotfiles, postCreate, "warm LSP caches"), server supervision with backoff, credential helper, `GET :8445/health`, log shipping, `onResume`, `SIGTERM` flush of "client state and buffers" (D6 makes the buffers part of the client-state image; the supervisor only has to leave the flush window open). |
| `BUILD-SPEC.md:309` | Supported `devcontainer.json` keys: `postCreateCommand`, `postStartCommand`, `postAttachCommand`, `remoteEnv`, `forwardPorts`, `portsAttributes`; `customizations.zed`. The builder (§6.3 second paragraph, `buildDevcontainerImage` at 362) is brief **b10** per D14, written after the first implementation round. |
| `BUILD-SPEC.md:313-315` | Prebuild = clone + `postCreateCommand` + LSP warm via a headless client + `snapshot`. D14: `zs-agent prebuild` (headless connect to warm language servers) is owned by this brief (§3.16, §3.16a). |
| `BUILD-SPEC.md:252-253` | Public forward via control plane `POST /api/sandboxes/{name}/ports` → `sandbox.update({ ports })`; pool `3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888`; private forward = proxy validating a signed cookie. **Amended by D8**: four proxy slots declared at create, one slot per private forward, the `zs_port_session` HMAC cookie set through `https://<slot-host>/__zs/auth?zs_port_token=…&next=/` after the control plane's `/open` redirect. |
| `BUILD-SPEC.md:348` | Sandbox-facing routes: `GET /sandboxes/{name}/manifest`, `POST …/git-token`, `POST …/ports`, `POST …/activity`, `POST …/logs`. b9 adds `DELETE …/ports/{port}` and `POST …/client-errors` (b9:1138-1147); the restore tarball is a presigned Blob URL in the manifest (b9 §4.7, b9 §8 R1-M4), no route. |
| `BUILD-SPEC.md:356-358` | `Sandbox.create({ ports: [8443, 8444, …pool], env, timeout, persistent: true, onResume })` → `runCommand(zs-agent start, detached)` → wait for health; stop = `SIGTERM` supervisor → `sandbox.stop()`. b9 §4.8 now waits on the supervisor command's exit (≤ 25 s) instead of a fixed sleep. |
| `BUILD-SPEC.md:367-368` | Idle threshold default 30 min; `IDLE_STOP_IN` 5 min before; `SESSION_CAP_IN` at 23.5 h. b9 hands the supervisor `idleStopAt`/`sessionCapAt` on every activity ping (b9 §3.25) and the supervisor computes the two notices locally (§3.15). |
| `BUILD-SPEC.md:387`, `:431` | Secrets arrive as sandbox environment; manifest carries names only; GitHub tokens "never written to disk"; logs scrubbed for known token shapes. |
| `BUILD-SPEC.md:420` | "the control plane records the list so a rebuild reinstalls them" – extensions; b9 puts `extensions: string[]` in the manifest (b9:1250) and consumes the supervisor's installed-extensions relay (D18/D19); the server takes the install list on `POST /control/extensions` (D5, b4 §4.2). |
| `BUILD-SPEC.md:433` | "Image builds are reproducible from a pinned base digest" – the Dockerfile's base is pinned through `sandbox/image/base.lock` (§3.19, §3.21). |
| `BUILD-SPEC.md:445` | Target layout puts "supervisor sources (Rust)" under `sandbox/image/`; this brief uses a sibling `sandbox/supervisor/` workspace so the image directory holds only image inputs (§7 item 19). |
| `BUILD-SPEC.md:483` | Chaos case "stop with unsaved buffers" – **decided by D6** (client snapshots dirty buffers into the client-state image during the `STOPPING` window); the supervisor's part is the stop budget of §3.9. |
| `DECISIONS.md` D5, D8, D9, D13, D14, D18, D19, D20 | The decisions that touch this brief: control listener `127.0.0.1:8446` with `--control-secret-file` and `--allowed-origin` (D5); four proxy slots and the `zs_port_session`/`zs_port_token` names (D8); rebuild tarball contents and extraction at `/` (D9); activity ping fields (D13); `zs-agent prebuild` with the headless warm-up (D14); the supervisor contract (D18); the control-plane contract incl. the fixture path (D19); serve's `is_input_envelope` exclusions, which define what `/health.last_input_at` means (D20). §9 lists each with what changed. |
| `SCOPE.md:104-121` | Vercel limits table: 24 h sessions, 32 GB disk snapshotted on stop, processes and memory lost on resume, `onResume` hook, ubuntu + sudo, up to 15 public ports, `*.vercel.run` HTTPS only, one hostname per exposed port. Six infra ports (§3.3) + eight pool ports = 14 ≤ 15. |
| `docs/briefs/b2-serve-mode.md:650-680` | `ServeArgs`: `--listen`, `--jwt-public-key` (repeatable), `--workspace-id` (alias `--workspace`), `--audience`, `--issuer` (default `zs`), `--workspace-root`, `--client-build` (alias `--allow-build`), `--allowed-origin` (repeatable; env `ZS_ALLOWED_ORIGINS`), `--control-secret-file` (required), `--control-listen` (default `127.0.0.1:8446`, must be loopback), `--supervisor-url` (env `ZS_SUPERVISOR_URL`), `--port-file`, `--log-file`. The supervisor's spawn line is built from exactly these (§3.9). |
| `docs/briefs/b2-serve-mode.md:578-589, 636` | `HealthResponse { build, version, uptime_secs, workspace_id, session_active, session?, last_input_at?, worktrees?, dirty_buffers?, auth_failures? }`; full body for loopback peers or a valid bearer; never 401. b9 polls the **supervisor's** `/health` on 8445 (b9 §3.18 `probeHealth`, §4.8 `waitUntilReady`), not this one; the supervisor polls this one on loopback and re-exports the fields b9 reads (§3.8, §4.4). |
| `docs/briefs/b2-serve-mode.md:686-695, 700` | `read_control_secret`: `--control-secret-file` read once before any spawn, trailing newline stripped, non-empty, ≤ 4 KiB; a leftover `ZS_CONTROL_SECRET` in the environment is scrubbed and never used. Startup stdout: `ZS_LISTENING=<addr>` and `ZS_CONTROL_LISTENING=127.0.0.1:<port>`. |
| `docs/briefs/b2-serve-mode.md:766-790` | Server stderr is one JSON object per line (`ServeLogRecord { ts_ms, level, module_path, file, line, message, ws, session_id?, epoch?, mode }`); first line is `listening on <addr>`. |
| `docs/briefs/b2-serve-mode.md:912-925` | `is_input_envelope` (D20) is what feeds `/health.last_input_at`; `busy`/`phase`/`cpuBusyPct` are the supervisor's own (D13). Control-listener contract on `127.0.0.1:8446`: `POST /control/lifecycle` (`stopping` returns after the client's `SaveClientState` landed or `STOPPING_FLUSH_TIMEOUT` = 5 s; 204 at once with no session), `POST /control/ports`, `POST /control/extensions`. |
| `docs/briefs/b2-serve-mode.md:869, 1063-1068` | `crates/remote_server/tests/fixtures/control_secret` (32-byte test secret) and `es256_private.pem`/`es256_public.pem`; b2's own integration test spawns `serve … --control-listen 127.0.0.1:0 --control-secret-file …` – this brief's `start_against_fake_server` uses the same fixture when the checkout is present. |
| `docs/briefs/b2-serve-mode.md:1097 (§7.13)` | b2's ask: update `ServerSpec::command()` with `--allowed-origin` (one per `manifest.allowedOrigins` entry), `--control-secret-file`, `--control-listen 127.0.0.1:8446`, `--supervisor-url`; stop exporting `ZS_CONTROL_SECRET`. Done in §3.9. |
| `docs/briefs/b2-serve-mode.md:56` | `cargo tree -p remote_server -i aws-lc-sys`: `aws-lc-sys ← aws-lc-rs ← rustls 0.23 ← http_client_tls ← client ← …`. That is how **remote_server** gets aws-lc; it says nothing about `zs-agent`, whose reqwest selects the `ring` provider (§5). |
| `docs/briefs/b4-proto-additions.md:500-512` | `ControlChannel::handle` (loopback + bearer under `subtle::ConstantTimeEq`, body ≤ 64 KiB); `Resumed` is sent if a session is attached, else held as `pending_resumed` and replayed by `replay_after_attach` – the supervisor no longer needs to hold `RESUMED` itself (§3.15). `Stopping` snapshots the client's save version, sends the notice and waits ≤ 5 s. |
| `docs/briefs/b4-proto-additions.md:516-544` | `PortForwarder`: `POST {base}/ports {port, visibility, label}` → `200 {url}` (`null` → `""`), `DELETE {base}/ports/{port}` → 204, `POST {base}/extensions {installed: [...]}` → 204; `DEFAULT_SUPERVISOR_URL = http://127.0.0.1:8445` overridden by `--supervisor-url`/`ZS_SUPERVISOR_URL` (b4 §7 item 20 asks this brief to move its loopback API off 8446 and export the URL – §3.3 uses `127.0.0.1:8450`). A refused private forward (no free slot, D8) is a non-2xx `{ "error": "…" }`. |
| `docs/briefs/b4-proto-additions.md:665-671, 913` | Serve contract items 1-7 as adopted by D5/D18/D20; item 7: the prebuild warm-up client must not run a `ClientStateStore` (no `SaveClientState`); `POST /control/extensions` during prebuild is desirable. `POST /control/extensions {"install": [ids]}` → 204 supersedes the earlier `remote_extensions/pending.json` hand-off; the server reads no such file. |
| `docs/briefs/b4-proto-additions.md:976, 988` | b4 §7 item 8 (what stays on this brief's side after D18) and item 20 (port map unresolved by D1-D20; b8 must export a loopback API port outside `{8443, 8444-8447}`). Both handled in §3.3/§3.12 and recorded in §7 item 5 / §9. |
| `docs/briefs/b4-proto-additions.md:81, 919` | `data_dir()` = `/vercel/.local/share/zed` (b4 corrected its earlier `/home/ubuntu` claim after this brief's §7 item 1); the whole directory is in the rebuild tarball (D9). |
| `docs/briefs/b3-terminals.md:744 (§7.10)` | b3's ask: set `SHELL` (and `HOME`, `USER`) in the server environment – `get_system_shell()` (`util/src/shell.rs:71`) falls back to `/bin/sh` otherwise – and export no secrets into it. Done in §3.9 (`SHELL=/bin/bash`, `USER=ubuntu`, `HOME` kept). |
| `docs/briefs/b1-ws-transport.md:132-154, 598-651` | `SUBPROTOCOL = "zs.v1"`, `MAX_FRAME_BYTES = 16 MiB`; `ControlFrame::{Hello, HelloAck, Log, Heartbeat}` as JSON text frames (`#[serde(tag = "type", rename_all = "snake_case")]`); `Hello { protocol: 1, build, workspace_id, session_id, identifier, reconnect, takeover, client: desktop\|web, epoch }`; `HelloAck { protocol, build, os, arch, os_version, shell, resumed, session_id, epoch }`; binary frames = `u32 LE len \|\| prost(Envelope)`; token in `Sec-WebSocket-Protocol: zs.v1, <jwt>`. The prebuild warm-up client (§3.16a) speaks exactly this. |
| `docs/briefs/b9-control-plane.md:44-49 (§2)`, `1678 (§8 R2-1)` | b9 rewrote its sandbox contract around this brief's first draft (`ZS_CONTROL_URL` base including `/api`, `zs-agent resume`, HMAC port tokens, `ActivityDirective`, JSON `LogBatch`, `git-token {host, protocol, path}`) and named this brief the authority. §4 adopts that contract (it is what b9 now implements) with the D8/D13/D18 additions listed in §7 items 3-4 and §9. |
| `docs/briefs/b9-control-plane.md:1222-1255 (§4.7)` | `SandboxManifest`: `version, workspaceId, sandboxName, userId, build, region, repo { owner, name, cloneUrl, defaultBranch, revision, depth, ref? }, workspaceDir, restore { tarballUrl, sha256 } \| null, dotfiles \| null, env: Record, secretNames[], jwt { issuer, audience, publicKeys[] }, portSessionSecret, forwards[], portPool[], idle { minutes }, session { id, startedAt, capAt, resumed }, devcontainer { configHash } \| null, settings { settings, keymap } \| null, logs { flushIntervalSecs, maxBatch, maxBatchBytes }, activity { intervalSecs }, allowedOrigins[], extensions[], prebuild?`. §3.4/§4.1 mirror it; `docs/contracts/fixtures/manifest.example.json` (D19) is the shared fixture b9's `tests/manifest.test.ts` must load. |
| `docs/briefs/b9-control-plane.md:1138-1160 (§4.2)` | Sandbox-facing routes: `POST git-token {host, protocol, path}` → `{ username, token, expiresAt: unix seconds }` (404 `host_unsupported`, 403 `repo_not_allowed`); `POST ports {port, visibility, label}` → `{ url, visibility }`; `DELETE ports/{port}` → 204; `POST activity ActivityReport` → `ActivityDirective { idleStopAt, sessionCapAt, stop }`; `POST logs LogBatch` (JSON ≤ 256 KiB / 200 entries, 413 above) → 204; `POST client-errors` → 202. Rate limits: manifest 60/min, git-token 30/min, ports 30/min, activity 10/min, logs 120/min, client-errors 60/min. |
| `docs/briefs/b9-control-plane.md:539-561 (§3.17-3.18)` | `supervisorEnvFor`: `{ ...secrets, ZS_CONTROL_URL: controlApiBase(), ZS_SANDBOX_TOKEN, ZS_SANDBOX_NAME, ZS_WORKSPACE_ID, ZS_BYPASS_SECRET? }` (identity keys spread last; `ZS_`-prefixed secret names are rejected); `startSupervisor(handle, ws, "start" \| "resume")` runs `zs-agent <mode>`; `probeHealth(host8445)` reads `status, phase, build, serverRunning, serverBuild, lastError, listening, sessionActive, lastInputAt` from a **non-loopback** GET – so §4.4's non-loopback body must carry them. |
| `docs/briefs/b9-control-plane.md:1260-1380 (§4.8)` | Create: `ports: [8443, 8444, 8445, ...pool]` (D8 requires the four slots – §7 item 4), env `{ ZS_WORKSPACE_ID, ZS_SANDBOX_NAME, ZS_REGION }`, `waitUntilReady(host8445, 35 min)` accepting `ready\|degraded` with `serverRunning`, fatal on `lastError` while `phase == "manifest"`, `build_mismatch` on an incompatible `serverBuild`. Resume: `onResume` → `zs-agent resume`, 3 min ceiling. Stop: `SIGTERM` → `stepWaitForCommandExit(25 s)` → `stop()`. Rebuild: archive `tar czf … -C / workspaces vercel/.local/share/zed` (exactly D9's two paths, b9 §3.19; `.config/zed` is not archived – `write_settings` re-materialises it from the manifest) → Blob → new generation with a new `port_session_secret` → `manifest.restore.tarballUrl`. Prebuild: `ports: [8443, 8445]`, env `ZS_PREBUILD=1`, `ZS_WORKSPACE_ID = pb.id`, `zs-agent prebuild`, exit 0 within 50 min, then `snapshot({ expiration: 0 })`. |
| `docs/briefs/b9-control-plane.md:735-741 (§3.25)`, `338` | `ActivityDirective`: `idleStopAt = max(lastInputAt, keepaliveAt, sessionStartedAt) + idleMinutes` (unix ms; `null` for prebuilds), `sessionCapAt`, `stop = state === "stopping"` (backstop). The supervisor derives `IDLE_STOP_IN`/`SESSION_CAP_IN`, raises `STOPPING` itself, `RESUMED` on resume. |
| `docs/briefs/b9-control-plane.md:425-431 (§3.12)`, `1119-1120`, `1566` | `signPortSession(secret, { ws, port, sub, iat, exp, jti })` = `"v1." + b64url(JSON) + "." + b64url(HMAC-SHA256(secret, "v1." + b64url(JSON)))`; `PORT_SESSION_TTL_SECS = 3600`; `/open` → 303 to `https://<proxyHost>/__zs/auth?t=…` (D8 renames the parameter to `zs_port_token`; §7 item 4); test `port_session_matches_b8_vector` expects this brief's vector (`docs/contracts/fixtures/port-token.vector.json`, §3.26). |
| `docs/briefs/b9-control-plane.md:1623 (§7 item 7)` | b9's asks of this brief: (a) `manifest.repo.ref`; (b) settings as `Value::String` verbatim; (c) `--allowed-origin` from `manifest.allowedOrigins`; (d) `x-vercel-protection-bypass`; (e) `zs-agent prebuild`; (f) extract the tarball at `/`; (g) `cpuBusyPct`. All done (§9). |
| `docs/briefs/b9-control-plane.md:214, 337-338` | Sandbox token shape `zsb_` + base64url(32 bytes); verified by sha256 hash; rotated at every supervisor start (`runCommand` env), also for `pb-` prebuild principals. |

Zed fork (`/Users/ray/Projects/play/wed/zed`, branch `zs`, upstream `c3cf80c`; a nested repository ignored by `/.gitignore:1-2`, **not** a submodule – no `.gitmodules` exists), read-only evidence

| Anchor | Note |
|---|---|
| `zed/crates/remote_server/Cargo.toml:16-17` | `[[bin]] name = "remote_server"`: the built ELF is `target/<triple>/release/remote_server`; the image renames it to `/usr/local/bin/zed-remote-server`. |
| `zed/crates/remote_server/src/main.rs:6-22, 42-56` | `Cli { command: Option<Commands>, --askpass, --crash-handler, --printenv }`; `serve` (b2) is dispatched through `remote_server::run`. |
| `zed/crates/remote_server/src/server.rs:62-83, 129-140` | `Commands { Run, Proxy, Version }` (+ `Serve` from b2); `VERSION` – what `/health.version` reports and what `zs-agent version` echoes next to `ZS_BUILD_ID`. |
| `zed/crates/remote_server/src/server.rs:542-558, 704-706` | `init_paths()` creates `config_dir`, `extensions_dir`, `languages_dir`, `logs_dir`, `temp_dir`, `hang_traces_dir`, `remote_extensions_dir`, uploads dir – all under the data dir; the supervisor must not pre-create them with root ownership. `LanguageRegistry::set_language_server_download_dir(paths::languages_dir())` – where the warm-up's downloads land (inside the snapshot). |
| `zed/crates/remote_server/src/headless_project.rs:106, 302, 582-610` | `languages::init(..)` runs in `HeadlessProject::new`; `handle_open_buffer_by_path` → `BufferStore::open_buffer` → `BufferStoreEvent::BufferAdded` → `LspStore::register_buffer_with_language_servers` (`crates/project/src/lsp_store.rs:4815-4841`): opening one buffer per language over the wire is what starts (and downloads) its language servers – the mechanism behind §3.16a. |
| `zed/crates/proto/src/proto.rs:17-20` | `include!("zed.messages.rs")`, `REMOTE_SERVER_PEER_ID = PeerId { 0, 0 }`, `REMOTE_SERVER_PROJECT_ID = 0`. `crates/proto/Cargo.toml`: deps `anyhow`, `prost`, `serde`; build deps `prost-build`, `protox`; `build.rs`: `protox::compile(["proto/zed.proto"], ["proto"])` + `prost_build::Config::compile_fds`. |
| `zed/crates/proto/proto/zed.proto:21-31, 45, 55-58, 222-223, 257, 260, 267, 381, 554-562`; `worktree.proto:35-46`; `buffer.proto:30-34`; `lsp.proto:711-727`; `core.proto:4-7` | `Envelope { id = 1, responding_to = 2, original_sender_id = 3, ack_id = 266, oneof payload { Ack = 5, Error = 6, Ping = 7, UpdateWorktree = 45, UpdateLanguageServer = 55, OpenBufferByPath = 57, OpenBufferResponse = 58, AddWorktree = 222, AddWorktreeResponse = 223, ShutdownRemoteServer = 257, LanguageServerLog = 260, FlushBufferedMessages = 267, RemoteStarted = 381 } }`; `AddWorktree { path = 1, project_id = 2, visible = 3 }` → `AddWorktreeResponse { worktree_id = 1, canonicalized_path = 2, .. }`; `OpenBufferByPath { project_id = 1, worktree_id = 2, path = 3 }` → `OpenBufferResponse { buffer_id = 1 }`; `UpdateLanguageServer { project_id = 1, language_server_id = 2, server_name = 8, oneof variant { work_start = 3, work_progress = 4, work_end = 5, status_update = 9, registered_for_buffer = 10, removed = 12, .. } }`; `Error { message = 1, code = 2, tags = 3 }`; `PeerId { owner_id = 1, id = 2 }`. The warm-up client's minimal `.proto` copies exactly these tag numbers (§3.16a) and a test compares them against the checkout. |
| `zed/crates/remote/src/protocol.rs:9-13, 26, 38` | `MessageLen = u32` little-endian length prefix, `read_message`/`write_message` – the stdio framing b1's `encode_envelope_frame` reproduces inside a WebSocket binary frame. |
| `zed/crates/paths/src/paths.rs:144-160` | Linux `data_dir()` = `$XDG_DATA_HOME/zed` or `$HOME/.local/share/zed`. With the universal image's `HOME=/vercel` this is **`/vercel/.local/share/zed`** (b4:81 now agrees). |
| `zed/crates/paths/src/paths.rs:69-73, 240-243` | `.zed_server` relative dir and `server_state` dir; `remote_server_state_dir()/client_state` is where b4 keeps the client-state image – inside the rebuild tarball (D9). |
| `zed/crates/auto_update/src/auto_update.rs:620-622, 664-665, 700` | Release asset lookup: `GET /releases/{channel}/{version}/asset?asset=zed-remote-server&os=linux&arch=x86_64` returns JSON `{ version, url }`; the download is a `.gz` of the raw ELF. |
| `zed/script/install.sh:86`, `zed/script/get-released-version:21` | The `download?asset=…` form streams the file; the `asset?…` form returns JSON. The Dockerfile's release path uses `download`. |
| `zed/script/bundle-linux:86-94, 128-136` | musl recipe: `RUSTFLAGS+=-C target-feature=+crt-static`, `CC_x86_64_unknown_linux_musl=musl-gcc`, `cargo --config .cargo/bundle-config.toml build --release --target x86_64-unknown-linux-musl --package remote_server`; then `llvm-objcopy --strip-debug` on the binary (the release profile has `debug = "limited"`, `zed/Cargo.toml:1083-1086`, and no `strip`); hard fail if `ldd` shows libssl/libcrypto. `build-server.sh` (§3.20) reproduces all four steps. |
| `zed/.cargo/bundle-config.toml` | `RUSTC_BOOTSTRAP=1`, `-Z share-generics=y` – passed with `--config` by `bundle-linux:87,94`. |
| `zed/script/linux:20-52`, `zed/.github/workflows/run_bundling.yml:41-45`, `release.yml:82, 96` | Zed's own Linux bundling jobs run `./script/linux` (gcc/g++, cmake, clang, lld, llvm, musl-tools, musl-dev, libzstd-dev, libssl-dev, libsqlite3-dev, libgit2-dev, …) and `./script/download-wasi-sdk` before `bundle-linux`. The CI `server` job (§3.25) runs the same two scripts rather than a hand-picked package list. |
| `zed/rust-toolchain.toml:2, 8` | Channel `1.97.1`; `x86_64-unknown-linux-musl` target already listed. The supervisor pins the same toolchain. |
| `zed/Cargo.toml:564, 670, 760-763, 768, 795, 804, 812, 1083-1086` | `base64 = "0.22"`, `jsonwebtoken = "10.0"`, `prost = "0.14"`, `prost-build = "0.14"`, `protox = "0.9"`, `rand = "0.9"`, `rustls = { version = "0.23.26" }` (default features → aws-lc-rs, for **Zed's** graph), `serde_json_lenient = "0.2"`, `sha2 = "0.10"`, `[profile.release] debug = "limited", lto = "thin", codegen-units = 1`. The supervisor matches every major it shares. |
| `zed/crates/util/src/shell.rs:71` (via b3 §7.10) | `get_system_shell()` = `$SHELL` else `/bin/sh` – why §3.9 exports `SHELL`. |
| `zed/crates/languages/src/rust.rs:775` | `delegate.which("rust-analyzer")` – PATH lookup honoured. |
| `zed/crates/languages/src/c.rs:18, 61` | `clangd` on PATH honoured. |
| `zed/crates/languages/src/go.rs:51, 113` | `gopls` on PATH honoured. |
| `zed/crates/languages/src/bash.rs:36, 85` | `bash-language-server` on PATH honoured (`start` argument added by Zed). |
| `zed/crates/languages/src/yaml.rs:32-33, 59` | `yaml-language-server` on PATH honoured. |
| `zed/crates/languages/src/json.rs:174`, `css.rs:57` | `vscode-json-language-server`, `vscode-css-language-server` on PATH honoured (both from `vscode-langservers-extracted`, `json.rs:146`, `css.rs:30`). |
| `zed/crates/languages/src/python.rs:780, 2553` | `pyright-langserver` and `ruff` on PATH honoured. |
| `zed/crates/languages/src/vtsls.rs:92, 115` | `vtsls` on PATH honoured. |
| `zed/crates/languages/src/typescript.rs:607, 664`; `zed/crates/languages/src/eslint.rs:35, 81`; `grep -l check_if_user_installed crates/languages/src/*.rs` (bash, css, c, json, go, tailwind, python, rust, yaml, tailwindcss, vtsls only) | `TypeScriptLspAdapter` (struct at 607, `impl LspInstaller` at 664) and `EsLintLspAdapter` (struct at 35, `impl LspInstaller` at 81) have **no** `check_if_user_installed`; Zed installs them itself under `languages_dir()` – which is exactly what the prebuild warm-up (§3.16a) triggers into the snapshot. Preinstalling `typescript-language-server`/`eslint` globally helps tooling but not Zed's adapters (§7 item 7). |
| `zed/crates/languages/src/json.rs:185-215` | `should_install_npm_package(.., VersionStrategy::Latest)` – Zed re-installs node servers when npm has a newer version; image-seeded copies would be churned. |
| `zed/crates/node_runtime/src/node_runtime.rs:134-141` | System Node from PATH is used when `allow_path_lookup` (default); `crates/project/src/project_settings.rs:101-108` `NodeBinarySettings`. The image's Node 24 is picked up without settings. |
| `zed/extensions/html/src/html.rs:5, 70` | Bundled HTML extension does `worktree.which("vscode-html-language-server")`. TOML (`taplo`), Lua (`lua-language-server`) and Dockerfile (`docker-langserver`) extensions live in `zed-industries/extensions` and follow the same `which` convention – not readable here (§7 item 6). |

Community fork (`/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad/zed-web`), evidence only

| Anchor | Note |
|---|---|
| `web/Dockerfile:61-84, 94-106` | Runtime stage: `useradd --uid 1000`, `tini` as `ENTRYPOINT`, `HEALTHCHECK`, `VOLUME`. Vercel does not run `ENTRYPOINT`/`CMD` (docs below), so none of that applies. |
| `web/entrypoint.sh:9-25` | Shell wrapper building the server argv from env – replaced by `zs-agent`'s typed spawn in `server.rs`. |
| `crates/zed_web_server/src/auth.rs:14-16, 18-22, 28-30, 85-90` | `hmac`/`sha2` HMAC-SHA256 cookie signing and a per-IP login limiter. We take the HMAC-cookie idea (same crates) for the proxy's bootstrap token and session cookie, not the axum server or the per-IP limiter. |

Local cargo registry (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f`, read 2026-09-02)

| Anchor | Note |
|---|---|
| `reqwest-0.12.24/Cargo.toml` `[features]`: `rustls-tls-native-roots = ["rustls-tls-native-roots-no-provider", "__rustls-ring"]`, `__rustls-ring = ["hyper-rustls?/ring", "tokio-rustls?/ring", "rustls?/ring", …]`; `[dependencies.rustls] default-features = false` | With `rustls-tls-native-roots`, reqwest builds rustls with the **`ring`** provider; `aws-lc-sys` is never linked into `zs-agent`. |
| `hyper-1.7.0/src/client/conn/http1.rs:127-129, 264`; `server/conn/http1.rs:191, 336-343, 401, 442-448`; `upgrade.rs:105, 165-175` | `handshake`/`serve_connection` require `hyper::rt::Read + Write` (not `tokio::net::TcpStream`); client `Connection::with_upgrades()` exists and is required for `hyper::upgrade::on(response)`; `Upgraded` implements hyper's `Read`/`Write` only. `Builder::header_read_timeout` **panics unless `Builder::timer` is set** (`http1.rs:336-343`); `hyper-util-0.1.17` feature `tokio` provides `rt::TokioIo` and `rt::TokioTimer` (`src/rt/tokio.rs:91`). |
| `hyper-1.7.0/src/proto/h1/role.rs:309-311`; `tungstenite-0.21.0/src/handshake/server.rs:46-51` | hyper's client marks `wants_upgrade` from `Upgrade:` alone; real WebSocket servers require `Connection: upgrade` (`MissingConnectionUpgradeHeader`). The proxy re-inserts it (§3.11). |
| `tokio-tungstenite-0.21.0` (also 0.20.1, 0.24.0, 0.28.0), `tungstenite-0.21.0` | WebSocket **client** for the prebuild warm-up (§3.16a): `client_async(request, TcpStream)` with a hand-built `Request` carrying `Sec-WebSocket-Protocol: zs.v1, <jwt>`; plain `ws://127.0.0.1` so no TLS feature is enabled. b2's own integration test uses the async-std sibling (`async_tungstenite::client_async`) the same way. |
| `prost-0.14.4`, `prost-build-0.14.4`, `protox-0.9.1` | Same majors as Zed (`zed/Cargo.toml:760-763`); `protox` compiles `.proto` without a `protoc` binary. Used by `sandbox/supervisor/build.rs` for the warm-up client's minimal envelope schema (§3.2a, §3.16a). |
| `lock_api-0.4.14/src/rwlock.rs:1221` | `impl<R, T: Default> Default for RwLock<R, T>` – `Instant` has no `Default`, so `AgentState` gets a `new()` (§3.8). |
| `jsonwebtoken-10.3.0/Cargo.toml` `[features]`: `default = ["use_pem"]`, `rust_crypto = [p256 0.13.2, …]`, `aws_lc_rs`; `src/crypto/rust_crypto/mod.rs:30, 71, 93` (`Es256Signer`, `Es256Verifier`) | Pure-Rust ES256 **signing and verification**: the prebuild warm-up mints its own session token with an ephemeral P-256 key (§3.16a); `p256 0.13.2` is not in the local registry (only 0.11.1), so `cargo generate-lockfile` needs network. |
| `secrecy-0.10.3` (`serde` optional feature; `impl Deserialize for SecretBox<T>` at `src/lib.rs:292`) | Present in the registry; used instead of a hand-written newtype (§5). |
| Registry versions present: `tokio 1.52.1/1.52.3/1.53.1`, `tokio-util 0.7.18/0.7.19`, `tracing 0.1.43/0.1.44`, `tracing-subscriber 0.3.22/0.3.23`, `rand 0.8.5/0.8.6/0.8.8/0.9.4/0.9.5`, `hyper 1.7.0/1.10.1/1.11.0`, `hyper-util 0.1.17/0.1.20`, `http-body-util 0.1.3/0.1.5`, `nix 0.29.0/0.30.1`, `hmac 0.12.1`, `sha2 0.10.9`, `subtle 2.6.1`, `serde_json_lenient 0.2.4`, `regex 1.11.1`, `parking_lot 0.12.5`, `tempfile 3.19.1/3.23.0`, `base64 0.22.1`, `hex 0.4.3`, `futures 0.3.32/0.3.34` | §5 pins only versions that exist here (except `jsonwebtoken`'s transitive `p256`). `tokio-util-0.7.18/src/codec/lines_codec.rs:68 new_with_max_length` (feature `codec`). |

Vercel documentation (fetched 2026-09-02)

| Source | Fact used |
|---|---|
| `https://vercel.com/docs/sandbox/concepts/images` | `vercel/sandbox/universal:latest` = `vercel/sandbox/ubuntu` (Ubuntu 26.04) + Node 24, Python 3.14, coding agents, utilities; nightly rebuilds of rolling tags. "Vercel Sandbox does not run Docker `ENTRYPOINT` or `CMD` for custom images." `WORKDIR` becomes the default cwd. VCR serves only prepared `linux/amd64` images; `image_not_ready` → retry. References: `repo:tag`, `repo@sha256:…`, `team/project/repo`, optional `vcr.vercel.com/` prefix. |
| `https://raw.githubusercontent.com/vercel/sandbox/main/images/ubuntu/Dockerfile` | `FROM ubuntu:26.04`; existing `ubuntu` user re-homed to **`/vercel`**; `/etc/sudoers.d/sandbox`: `always_set_home`, `!env_reset`, `!fqdn`, `ubuntu ALL=(ALL) NOPASSWD:ALL`. |
| `https://raw.githubusercontent.com/vercel/sandbox/main/images/universal/Dockerfile` lines 77-86 | `ENV HOME=/vercel`, `USER ubuntu`, `WORKDIR /vercel`, `npm config set prefix ~/.global/npm` (writes `/vercel/.npmrc`), `pnpm config set global-dir ~/.global/pnpm`, `ENV PATH="/vercel/.local/bin:/vercel/.global/pnpm/bin:/vercel/.global/npm/bin:${PATH}"`. Docker's `USER` does **not** change `HOME`, so a derived stage running as root still has `HOME=/vercel` and npm's user config unless it sets `ENV HOME` itself (§3.19). Node 24 at `/usr/local`, pnpm 11, Bun, Python 3.14 + uv, git, git-lfs, gh, curl, jq, tmux, fzf, ripgrep, rsync, sqlite3, netcat, lsof, procps, sudo; agents `@anthropic-ai/claude-code`, `opencode-ai`, `@openai/codex`, `@earendil-works/pi-coding-agent`. |
| `https://vercel.com/docs/sandbox/concepts/persistent-sandboxes` | `onResume` "runs every time a session is resumed, including when an SDK call auto-resumes"; `update({ ports })` replaces the full port list; snapshot expiration default 30 days. |
| `https://vercel.com/docs/sandbox/sdk-reference` | `Sandbox.create({ name, source, resources, image, ports (≤15), env, timeout, region, networkPolicy, persistent, onResume })`; `runCommand({ cmd, args, cwd, env, sudo, detached, stdout, stderr })`; `domain(port)` throws for undeclared ports; undeclared ports are not routable from outside. |
| `https://vercel.com/docs/sandbox/concepts/runtimes` | Firecracker microVM with its own kernel (so `/proc` – including `/proc/stat` for `cpuBusyPct` – is the VM's); Docker under `sudo`; `sudo` sets `HOME=/root` and keeps `PATH`; per-sandbox proxy CA at `/usr/local/share/ca-certificates/vercel-proxy-ca.pem` with `SSL_CERT_FILE` etc. exported – the supervisor's HTTP client must use the **system** trust store. |
| `https://vercel.com/docs/container-registry/public-and-shared-repositories` | "A team with access pulls a shared image with its full repository path **after authenticating as their own team**: `docker pull vcr.vercel.com/team-slug/project-name/my-repository:latest`"; public repositories let "any Vercel team pull". Pulling `vcr.vercel.com/vercel/sandbox/universal` therefore needs `vercel vcr login docker` first, push or not (§3.21). |
| `https://vercel.com/docs/container-registry/cli-reference` | `vercel vcr login docker` mints a 12 h OIDC credential; `vercel vcr build docker [path] [name]` with `--platform` (default `linux/amd64`), `--push`, and "Anything after `--` is forwarded to the container tool unchanged" (e.g. `-- --no-cache --build-arg KEY=value`); `[name]` is `repo[:tag]` without `/`. `vercel vcr image ls <repo> --format json` exists but its JSON shape is **not documented** (§3.21 guards the poll). |
| `https://api.github.com/repos/tamasfe/taplo/releases/tags/0.10.0` | Assets: `taplo-linux-x86_64.gz` (no `taplo-full-*` variant). |

Protocol facts from outside the repo (not file anchors): `git-credential(1)` helper protocol (`get`/`store`/`erase` as argv[1]; stdin `key=value` lines ending at a blank line; stdout `username=`, `password=`, optional `password_expiry_utc=`); `/proc/net/tcp` and `tcp6` column layout (`st == 0A` is LISTEN, IPv4 address as 8 hex chars little-endian, port as 4 hex chars big-endian, IPv6 as four little-endian 32-bit words); `/proc/stat` first line `cpu user nice system idle iowait irq softirq steal …` in jiffies, cumulative since boot (busy % between two samples = 1 − Δ(idle + iowait)/Δtotal); containers.dev `postCreateCommand`/`postStartCommand`/`postAttachCommand` accept a string (shell), an array (argv) or an object (named commands run in parallel); `portsAttributes` keys may be a port, a range (`"3000-3999"`), `host:port` or a regex – only plain ports are honoured here (§3.4); bash `${var:-word}` expands to `word` only when `var` is empty, otherwise to `var`'s **value** (§3.21 fix); `docker exec` connects stdin only with `-i` (§3.24); Linux refuses a second `bind()` on `127.0.0.1:<p>` while a listener holds `0.0.0.0:<p>` – and vice versa – (why the loopback API has its own port and why the D8 slot range must skip 8445 and 8446, §3.3); WebSocket `Sec-WebSocket-Protocol` values are RFC 2616 tokens (b1 `validate_subprotocol_token`); Node.js 25 removed corepack from the distribution (§3.19 does not depend on it).

## 3. Change list

All files are new. Dependency order is bottom-up within the crate, then the image, then scripts, CI and the shared contract files.

### 3.1 `sandbox/supervisor/rust-toolchain.toml` (new)

```toml
[toolchain]
channel = "1.97.1"
profile = "minimal"
components = ["rustfmt", "clippy"]
targets = ["x86_64-unknown-linux-musl"]
```

### 3.2 `sandbox/supervisor/Cargo.toml` (new; its own workspace) – full text in §5.

### 3.2a `sandbox/supervisor/build.rs` and `sandbox/supervisor/proto/zs_warm.proto` (new)

The prebuild warm-up client (§3.16a) needs to encode four request envelopes and decode six response/notification envelopes. Compiling all of `zed.proto` into the supervisor would drag the Zed checkout into the image build context, so the crate carries a **minimal schema with the same tag numbers** (`zed.proto:21-31, 45, 55-58, 222-223, 257, 260, 267, 381`; `worktree.proto:35-46`; `buffer.proto:30-34`; `lsp.proto:711-727`; `core.proto:4-7`). Prost skips unknown fields and unknown oneof variants, so any envelope the server sends decodes (with `payload: None` for variants the subset does not name).

```proto
syntax = "proto3";
package zed.messages;   // same package name so the generated module path matches

message PeerId { uint32 owner_id = 1; uint32 id = 2; }
message Envelope {
  uint32 id = 1;
  optional uint32 responding_to = 2;
  optional PeerId original_sender_id = 3;
  optional uint32 ack_id = 266;
  oneof payload {
    Ack ack = 5;
    Error error = 6;
    Ping ping = 7;
    UpdateWorktree update_worktree = 45;
    UpdateLanguageServer update_language_server = 55;
    OpenBufferByPath open_buffer_by_path = 57;
    OpenBufferResponse open_buffer_response = 58;
    AddWorktree add_worktree = 222;
    AddWorktreeResponse add_worktree_response = 223;
    ShutdownRemoteServer shutdown_remote_server = 257;
    LanguageServerLog language_server_log = 260;
    FlushBufferedMessages flush_buffered_messages = 267;
    RemoteStarted remote_started = 381;
  }
}
message Ack {}
message Ping {}
message Error { string message = 1; int32 code = 2; repeated string tags = 3; }
message UpdateWorktree { uint64 project_id = 1; uint64 worktree_id = 2; }          // only the two fields the client reads
message AddWorktree { string path = 1; uint64 project_id = 2; bool visible = 3; }
message AddWorktreeResponse { uint64 worktree_id = 1; string canonicalized_path = 2; }
message OpenBufferByPath { uint64 project_id = 1; uint64 worktree_id = 2; string path = 3; }
message OpenBufferResponse { uint64 buffer_id = 1; }
message ShutdownRemoteServer {}
message FlushBufferedMessages {}
message RemoteStarted {}
message LanguageServerLog { uint64 project_id = 1; uint64 language_server_id = 2; string message = 3; }
message UpdateLanguageServer {
  uint64 project_id = 1; uint64 language_server_id = 2; optional string server_name = 8;
  oneof variant { LspWorkStart work_start = 3; LspWorkProgress work_progress = 4; LspWorkEnd work_end = 5; StatusUpdate status_update = 9; RegisteredForBuffer registered_for_buffer = 10; ServerRemoved removed = 12; }
}
message LspWorkStart {} message LspWorkProgress {} message LspWorkEnd {} message StatusUpdate {} message RegisteredForBuffer {} message ServerRemoved {}
```

`build.rs`: `println!("cargo:rerun-if-changed=proto"); let fds = protox::compile(["proto/zs_warm.proto"], ["proto"])?; prost_build::Config::new().compile_fds(fds)?;` – the same two calls as `zed/crates/proto/build.rs`, without the serde attribute. `tests/proto_tags.rs` (runs only when `../../zed/crates/proto/proto/zed.proto` exists) parses the checkout's oneof lines with a regex and asserts every `name = N` pair in `zs_warm.proto` matches, so a renumbering upstream fails CI instead of silently mis-decoding.

### 3.3 `sandbox/supervisor/src/config.rs` (new)

Environment and filesystem contract. Reads env once at startup; every other module receives a `&Config`.

**Port map** (the one place it is written down; §7 item 5 and §9 record the D5/D8 collision it resolves):

| Port | Bind | Owner | Declared to Vercel | Purpose |
|---|---|---|---|---|
| 8443 | `0.0.0.0` | `zed-remote-server serve --listen` | yes | RPC, `/files`, `/extensions/*`, public `/health` |
| 8444 | `0.0.0.0` | `zs-agent` proxy slot 0 | yes | private-port proxy (D8) |
| 8445 | `0.0.0.0` | `zs-agent` health listener | yes | `GET /health` only (BUILD-SPEC 6.2; b9 polls it) |
| 8446 | `127.0.0.1` | `zed-remote-server serve --control-listen` | no | `/control/lifecycle`, `/control/ports`, `/control/extensions` (D5/D18) |
| 8447, 8448, 8449 | `0.0.0.0` | `zs-agent` proxy slots 1-3 | yes | private-port proxy (D8) |
| 8450 | `127.0.0.1` | `zs-agent` local API | no | `/ports`, `/extensions`, `/git-token`, `/lifecycle` (`ZS_SUPERVISOR_URL`) |

D8 says "ports 8444 to 8447"; 8445 is the health port every consumer already polls and 8446 is D5's control listener, and Linux will not let a wildcard listener share a port with a loopback listener, so the four slots are `8444, 8447, 8448, 8449`. The slot *count*, the declare-at-create rule, the control-plane allocation and the cookie/parameter names are exactly D8's.

```rust
pub const DEFAULT_WORKSPACES_DIR: &str = "/workspaces";
pub const DEFAULT_SERVER_BIN: &str = "/usr/local/bin/zed-remote-server";
pub const RPC_PORT: u16 = 8443;                       // zed-remote-server serve (declared, public)
pub const PROXY_SLOTS: [u16; 4] = [8444, 8447, 8448, 8449];   // D8 proxy slots (declared, public); one private forward per slot
pub const HEALTH_PORT: u16 = 8445;                    // GET /health only (declared, public)
pub const SERVER_CONTROL_PORT: u16 = 8446;            // serve --control-listen 127.0.0.1:8446 (D5/D18); not ours, never declared
pub const LOCAL_API_PORT: u16 = 8450;                 // /ports, /extensions, /git-token, /lifecycle – bound to 127.0.0.1, never declared
pub const INFRA_PORTS: [u16; 8] = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];
pub const SANDBOX_API_PREFIX: &str = "/sandboxes";    // appended to ZS_CONTROL_URL (which already ends in /api)

#[derive(Clone, Debug)]
pub struct Config {
    pub control_api_base: reqwest::Url,       // ZS_CONTROL_URL – the API base INCLUDING /api, e.g. https://zs.example.com/api (b9 §3.18 supervisorEnvFor, controlApiBase()); trailing slash stripped. Fallback: ZS_CONTROL_PLANE_URL (the bare origin) + "/api" when ZS_CONTROL_URL is absent.
    pub bypass_secret: Option<SecretString>,  // ZS_BYPASS_SECRET → header `x-vercel-protection-bypass` on every control-plane call (D18; b9 §3.18, §7 item 7d)
    pub sandbox_token: SecretString,          // ZS_SANDBOX_TOKEN (`zsb_…`)
    pub sandbox_name: String,                 // ZS_SANDBOX_NAME (`sb-…` workspace, `pb-…` prebuild)
    pub workspace_id: String,                 // ZS_WORKSPACE_ID (b9:1273; cross-checked against manifest.workspaceId; the prebuild id for pb- principals)
    pub region: Option<String>,               // ZS_REGION (b9:1273; informational – logged, echoed in health)
    pub build_id: String,                     // ZS_BUILD_ID (baked into the image)
    pub prebuild: bool,                       // ZS_PREBUILD=1 (b9:1370) – `start` refuses to run when set, `prebuild` requires it
    pub workspaces_dir: PathBuf,              // ZS_WORKSPACES_DIR, default /workspaces
    pub state_dir: PathBuf,                   // ZS_STATE_DIR, default $HOME/.zs
    pub data_dir: PathBuf,                    // ZS_DATA_DIR, default $XDG_DATA_HOME/zed or $HOME/.local/share/zed (mirrors paths.rs:144-160; used for the tarball restore target and for logging only)
    pub server_bin: PathBuf,                  // ZS_SERVER_BIN, default /usr/local/bin/zed-remote-server
    pub health_listen: SocketAddr,            // ZS_HEALTH_LISTEN, default 0.0.0.0:8445
    pub local_api_listen: SocketAddr,         // ZS_LOCAL_API_LISTEN, default 127.0.0.1:8450 (must be loopback; validated)
    pub proxy_bind_ip: IpAddr,                // ZS_PROXY_BIND_IP, default 0.0.0.0; the slot ports are fixed (PROXY_SLOTS)
    pub rpc_listen: SocketAddr,               // ZS_RPC_LISTEN, default 0.0.0.0:8443
    pub server_control_listen: SocketAddr,    // ZS_SERVER_CONTROL_LISTEN, default 127.0.0.1:8446 (passed as `--control-listen`; must be loopback)
    pub insecure_cookies: bool,               // ZS_INSECURE_COOKIES=1 (local docker test over plain http)
    pub home: PathBuf,                        // HOME
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required environment variable {0}")] Missing(&'static str),
    #[error("invalid {0}: {1}")] Invalid(&'static str, String),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError>;
    /// `{control_api_base}/sandboxes/{sandbox_name}/{suffix}`.
    pub fn sandbox_api_url(&self, suffix: &str) -> reqwest::Url;
    pub fn supervisor_url(&self) -> String;      // `http://{local_api_listen}` – exported as ZS_SUPERVISOR_URL and passed as `--supervisor-url`
    /// Sub-paths under `state_dir`, created 0700 on demand.
    pub fn run_dir(&self) -> PathBuf;            // <state>/run     (pid, port file, control.secret) – cleared on every start
    pub fn markers_dir(&self) -> PathBuf;        // <state>/markers (clone.done, post-create.done, dotfiles.done, first-boot.done, settings.sha256, keymap.sha256)
    pub fn jwt_dir(&self) -> PathBuf;            // <state>/jwt     (public key PEMs, 0600)
    pub fn restore_dir(&self) -> PathBuf;        // <state>/restore.partial (tarball staging, §3.14)
    pub fn pid_file(&self) -> PathBuf;           // run/zs-agent.pid
    pub fn server_port_file(&self) -> PathBuf;   // run/server.port
    pub fn control_secret_file(&self) -> PathBuf; // run/control.secret (0600; D18: the secret travels as a file path, never as an environment value)
}
pub type SecretString = secrecy::SecretString;   // re-export; `ExposeSecret` is imported where a value is actually used
```

Variables the supervisor **strips** from every child environment: `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_URL`, `ZS_CONTROL_PLANE_URL`, `ZS_BYPASS_SECRET` (children talk to the supervisor over loopback instead, §3.12), and `ZS_CONTROL_SECRET` if some caller set it (D18: no such variable exists in the server environment; b2 scrubs a leftover one too). Variables the supervisor **adds** to every child environment: `ZS_SUPERVISOR_URL` (`http://127.0.0.1:8450`), `ZS_CONTROL_SECRET_FILE` (the path of `run/control.secret` – a path, not a secret; what the credential helper and lifecycle commands read), `SHELL=/bin/bash` when unset, `USER=ubuntu` when unset, `HOME` as inherited (b3 §7.10). Everything else in the process environment – including the user/org/repo secrets b9 puts in the `runCommand` env (b9 §3.18) – is inherited untouched; `manifest.secretNames` is only used to log which names were expected but absent. `manifest.env` (non-secret literals, b9 §4.7) is merged in after the process environment and before the supervisor's own keys, minus any key that starts with `ZS_` (other than `ZS_WORKSPACE_ID`, `ZS_SANDBOX_NAME`, `ZS_REGION`) or is in b9's `RESERVED_SECRET_NAMES` (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_CONFIG_PARAMETERS`, `HOME`, `PATH`, `USER`, `SHELL`) – dropped with a warning, because `remoteEnv` literals come from the repository's `devcontainer.json`.

### 3.4 `sandbox/supervisor/src/manifest.rs` (new)

Serde types for the `SandboxManifest` this brief defines and b9 §4.7 emits (full JSON in §4.1, JSON Schema in §3.26) and the devcontainer subset.

```rust
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,                        // must be 1
    pub workspace_id: String,                // == ZS_WORKSPACE_ID (the prebuild id for pb- principals)
    pub sandbox_name: String,                // == ZS_SANDBOX_NAME
    pub user_id: String,                     // owner; "system" for prebuilds (logs only)
    pub build: String,                       // workspaces.server_build; != ZS_BUILD_ID → health `degraded`, not fatal
    pub region: String,
    pub repo: RepoSpec,
    pub workspace_dir: PathBuf,              // /workspaces/<repo.name>
    #[serde(default)] pub restore: Option<RestoreSpec>,      // rebuild only (D9)
    #[serde(default)] pub dotfiles: Option<DotfilesSpec>,
    #[serde(default)] pub env: BTreeMap<String, String>,     // NON-secret literals (ZS_WORKSPACE_ID, ZS_REGION, devcontainer remoteEnv); filtered per §3.3
    #[serde(default)] pub secret_names: Vec<String>,         // names only; values arrived in the runCommand env
    pub jwt: JwtSpec,                        // { issuer, audience, publicKeys: [SPKI PEM, …] } → serve --issuer/--audience/--jwt-public-key
    pub port_session_secret: SecretString,   // base64 (standard, padded) of 32 bytes; HMAC key of the port bootstrap token (§3.10); per generation
    #[serde(default)] pub forwards: Vec<Forward>,
    #[serde(default)] pub port_pool: Vec<u16>,
    pub idle: IdleSpec,                      // { minutes }
    pub session: SessionSpec,                // { id, startedAt, capAt, resumed } – `id` is the Vercel sandbox session id (LogBatch.sessionId); `resumed` is the control plane's resume hint
    #[serde(default)] pub devcontainer: Option<DevcontainerHint>,   // { configHash }; informational (§3.14 parses the checkout)
    #[serde(default)] pub settings: Option<SettingsDocs>,           // { settings, keymap }: JSONC TEXT as JSON strings; written verbatim (D18)
    #[serde(default)] pub logs: LogsSpec,                           // { flushIntervalSecs: 5, maxBatch: 200, maxBatchBytes: 262144 }
    #[serde(default)] pub activity: ActivitySpec,                   // { intervalSecs: 30 }
    #[serde(default)] pub allowed_origins: Vec<String>,             // → serve --allowed-origin … (D5; b9 §7 item 7c)
    #[serde(default)] pub extensions: Vec<String>,                  // → POST /control/extensions {"install": …} after the server is up (D5; BUILD-SPEC §9)
    #[serde(default)] pub prebuild: Option<PrebuildSpec>,           // { id, branch, commit } for pb- principals
}

#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct RepoSpec { pub owner: String, pub name: String, pub clone_url: String, pub default_branch: String, pub revision: String /* branch name, or a 40-hex sha when pinned */, #[serde(default)] pub depth: u32 /* 0 = full */, #[serde(default, rename = "ref")] pub git_ref: Option<String> /* "refs/pull/N/head" (D18; b9 §7 item 7a) */ }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct RestoreSpec { pub tarball_url: String /* presigned Blob GET URL, valid 1 h, minted per manifest fetch (b9 §4.7) */, #[serde(default)] pub sha256: Option<String> }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DotfilesSpec { pub repo_url: String, #[serde(default)] pub install_command: Option<String> }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct JwtSpec { pub issuer: String, pub audience: String, pub public_keys: Vec<String> }
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct Forward { pub port: u16, pub visibility: Visibility, #[serde(default)] pub label: Option<String>, #[serde(default)] pub url: Option<String> /* public: slot/pool URL; private: the control plane's /open link (D8) */, #[serde(default)] pub slot: Option<u16> /* private only: the D8 proxy slot the control plane allocated (§7 item 4 asks b9 to emit it; §3.11 binds slots from tokens when absent) */ }
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)] #[serde(rename_all = "lowercase")]
pub enum Visibility { Public, Private }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct IdleSpec { pub minutes: u32 }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SessionSpec { pub id: String, pub started_at: u64 /* unix ms */, pub cap_at: u64 /* unix ms */, #[serde(default)] pub resumed: bool }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DevcontainerHint { pub config_hash: String }   // other keys ignored
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SettingsDocs { pub settings: String /* JSONC, written verbatim */, pub keymap: String }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct LogsSpec { #[serde(default = "d_flush")] pub flush_interval_secs: u64, #[serde(default = "d_batch")] pub max_batch: usize, #[serde(default = "d_batch_bytes")] pub max_batch_bytes: usize }
impl Default for LogsSpec { /* 5, 200, 262_144 – an explicit impl, since `#[serde(default)]` on the field needs `Default` */ }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ActivitySpec { #[serde(default = "d_interval")] pub interval_secs: u64 }
impl Default for ActivitySpec { /* 30 */ }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct PrebuildSpec { pub id: String, pub branch: String, pub commit: String }

impl Manifest {
    pub fn parse(bytes: &[u8]) -> anyhow::Result<Self>;               // serde_json + `validate`
    pub fn validate(&self, config: &Config) -> anyhow::Result<()>;   // version == 1; workspace_id == config.workspace_id; sandbox_name == config.sandbox_name; workspace_dir absolute, lexically normal, under workspaces_dir; ≥1 public key, each a PEM `PUBLIC KEY` block; jwt.audience/issuer non-empty; port_session_secret decodes (base64 standard, padded) to exactly 32 bytes; forwards[].port/port_pool[] in 1..=65535 ∖ INFRA_PORTS; forwards[].slot ∈ PROXY_SLOTS when present, unique per slot, private only; session.cap_at > session.started_at; restore.tarball_url is `https://` (or `http://` when config.insecure_cookies); allowed_origins are `scheme://host[:port]` with no path; activity.interval_secs ≥ 10 (b9 rate-limits activity at 10/min); logs.max_batch ≤ 200 and max_batch_bytes ≤ 262_144 (b9's 413 ceiling)
    pub fn port_session_key(&self) -> [u8; 32];                       // decoded secret (called once by start; never logged)
    pub fn resumed_hint(&self) -> bool { self.session.resumed }      // informational; "resumed" is decided in §3.16 step 1
}

/// The devcontainer.json subset (BUILD-SPEC 6.3), parsed leniently (comments, trailing commas).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerConfig {
    #[serde(default)] pub post_create_command: Option<LifecycleCommand>,
    #[serde(default)] pub post_start_command: Option<LifecycleCommand>,
    #[serde(default)] pub post_attach_command: Option<LifecycleCommand>,
    #[serde(default)] pub remote_env: BTreeMap<String, String>,
    #[serde(default)] pub forward_ports: Vec<u16>,
    #[serde(default)] pub ports_attributes: BTreeMap<String, PortAttributes>,   // keys parsed with `parse_port_key`; ranges/host:port/regex keys are ignored with a warning
    #[serde(default)] pub customizations: Option<Customizations>,
}
#[derive(Clone, Debug, Default, serde::Deserialize)] pub struct Customizations { #[serde(default)] pub zed: Option<ZedCustomizations> }
#[derive(Clone, Debug, Default, serde::Deserialize)] pub struct ZedCustomizations { #[serde(default)] pub extensions: Vec<String> }   // merged into the `POST /control/extensions` install list (§3.14)
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum LifecycleCommand { Shell(String), Argv(Vec<String>), Parallel(BTreeMap<String, LifecycleCommandLeaf>) }
#[derive(Clone, Debug, serde::Deserialize)] #[serde(untagged)]
pub enum LifecycleCommandLeaf { Shell(String), Argv(Vec<String>) }
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct PortAttributes { #[serde(default)] pub label: Option<String>, #[serde(default)] pub visibility: Option<Visibility> }

impl DevcontainerConfig {
    /// `<repo>/.devcontainer/devcontainer.json`, then `<repo>/.devcontainer.json`; `Ok(None)` if neither exists.
    /// Returns the raw bytes too so the caller can hash them (`sha256:<hex>`) for the post-create marker.
    pub fn load(repo_root: &Path) -> anyhow::Result<Option<(Self, Vec<u8>)>>;   // serde_json_lenient::from_slice
    /// `${containerEnv:NAME}` and `${localEnv:NAME}` → env lookup; unknown → empty string (containers.dev semantics).
    pub fn expand_remote_env(&self, base: &BTreeMap<String, String>) -> BTreeMap<String, String>;
}
pub fn parse_port_key(key: &str) -> Option<u16>;   // "3000" → Some(3000); "3000-3999", "localhost:3000", ".+" → None
```

Log-batching and activity intervals come from `manifest.logs`/`manifest.activity` (b9 emits both); the constants in §3.6/§3.15 are the defaults used when the fields are absent and the ceilings the manifest cannot raise.

### 3.5 `sandbox/supervisor/src/control_plane.rs` (new)

The only module that holds `ZS_SANDBOX_TOKEN`. One `reqwest::Client` (rustls with the `ring` provider, **native roots**, 10 s connect / 30 s request timeouts, `User-Agent: zs-agent/<build>`), every call retried with jittered backoff (250 ms · 2ⁿ, max 5 tries, only on 5xx/connect/timeouts; 429 honours `Retry-After`). Every call to the control plane carries `Authorization: Bearer <ZS_SANDBOX_TOKEN>`, `X-ZS-Build: <build>` and, when `bypass_secret` is set, `x-vercel-protection-bypass: <secret>` (D18). A **second, header-less client** (`plain`) fetches the presigned restore tarball: its URL points at Blob storage, and the sandbox bearer or the bypass secret must never be sent to a third-party host.

```rust
#[derive(Clone)]
pub struct ControlPlane { http: reqwest::Client, plain: reqwest::Client, config: Arc<Config> }

#[derive(Debug, thiserror::Error)]
pub enum ControlPlaneError {
    #[error("control plane returned {status}: {body}")] Status { status: u16, code: Option<String> /* JSON `error` field when present */, body: String },
    #[error("sandbox token rejected (401)")] Unauthorized,
    #[error("sandbox retired (410)")] Retired,
    #[error(transparent)] Transport(#[from] reqwest::Error),
    #[error("invalid response: {0}")] Decode(String),
}

#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct GitTokenRequest<'a> { pub host: &'a str, pub protocol: &'a str, pub path: Option<&'a str> }   // b9 §4.2: host must be github.com (404 host_unsupported), path must name the workspace's repo when present (403 repo_not_allowed)
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct GitTokenResponse { pub username: String, pub token: SecretString, pub expires_at: ExpiresAt }
#[derive(serde::Deserialize)] #[serde(untagged)]
pub enum ExpiresAt { UnixSeconds(u64), Iso(String) }   // b9 emits unix SECONDS; an RFC 3339 string is tolerated (parse_rfc3339_utc, §3.13)

#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct ForwardRequest<'a> { pub port: u16, pub visibility: Visibility, pub label: Option<&'a str> }
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ForwardResponse { pub url: Option<String>, pub visibility: Visibility, #[serde(default)] pub slot: Option<u16> }   // `slot` per D8 (§7 item 4)

/// b9 `activityReport` (zod; missing required keys → 400, unknown keys stripped) plus D13's `busy`/`phase`.
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct ActivityReport<'a> {
    pub last_input_at: Option<u64>, pub session_active: bool, #[serde(skip_serializing_if = "Option::is_none")] pub sid: Option<&'a str>,
    pub server_uptime_secs: u64, pub agent_uptime_secs: u64, pub status: HealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")] pub cpu_busy_pct: Option<f32>,   // D13/D18; None on the first ping only
    pub busy: bool, pub phase: Phase,                                                  // D13
    pub listening: Vec<ListeningPortWire>,                                             // extension; b9 keeps keys.listening from the health probe today
}
#[derive(serde::Serialize)] pub struct ListeningPortWire { pub port: u16, pub pid: u32, pub process: String }
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ActivityDirective { pub idle_stop_at: Option<u64> /* unix ms; null for prebuilds */, pub session_cap_at: Option<u64>, #[serde(default)] pub stop: bool, #[serde(default)] pub forwards: Option<Vec<Forward>> /* asked of b9 (§7 item 4); when present it replaces the local list */ }

#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct ClientErrorReport<'a> { pub build: &'a str, pub kind: &'static str /* "server_crash" | "boot" */, pub message: String /* ≤ 4 KiB */, #[serde(skip_serializing_if = "Option::is_none")] pub stack: Option<String> /* ≤ 64 KiB: the crash tail */, #[serde(skip_serializing_if = "Option::is_none")] pub marks: Option<BTreeMap<String, u64>> }
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct InstalledExtensions<'a> { pub installed: &'a [String] }

impl ControlPlane {
    pub fn new(config: Arc<Config>) -> anyhow::Result<Self>;
    pub async fn manifest(&self) -> Result<Manifest, ControlPlaneError>;                                        // GET  {api}/sandboxes/{name}/manifest
    pub async fn git_token(&self, req: GitTokenRequest<'_>) -> Result<GitTokenResponse, ControlPlaneError>;     // POST {api}/sandboxes/{name}/git-token
    pub async fn forward(&self, req: ForwardRequest<'_>) -> Result<ForwardResponse, ControlPlaneError>;         // POST {api}/sandboxes/{name}/ports; a 4xx (no free slot, bad port) surfaces as Status { code } and is relayed to the server as-is (§3.12)
    pub async fn unforward(&self, port: u16) -> Result<(), ControlPlaneError>;                                   // DELETE {api}/sandboxes/{name}/ports/{port} → 204
    pub async fn activity(&self, report: &ActivityReport<'_>) -> Result<ActivityDirective, ControlPlaneError>;  // POST {api}/sandboxes/{name}/activity
    pub async fn logs(&self, batch: &LogBatch<'_>) -> Result<(), ControlPlaneError>;                            // POST {api}/sandboxes/{name}/logs, JSON, any 2xx ok, ≤ 2 tries; 413 → caller halves the batch
    pub async fn client_error(&self, report: &ClientErrorReport<'_>) -> Result<(), ControlPlaneError>;         // POST {api}/sandboxes/{name}/client-errors → 202
    pub async fn report_extensions(&self, ids: &[String]) -> Result<(), ControlPlaneError>;                     // POST {api}/sandboxes/{name}/extensions {"installed": [...]} → 204 (D18/D19 relay; route asked of b9, §7 item 4)
    pub async fn restore_tarball(&self, url: &str) -> Result<impl futures_core::Stream<Item = reqwest::Result<bytes::Bytes>>, ControlPlaneError>; // GET <presigned url> with the `plain` client (no Authorization, no bypass header); via reqwest `bytes_stream()`
}
```

A 401 anywhere flips health to `degraded` with `lastError = "sandbox token rejected"`; a 410 sets `lastError = "sandbox retired"` and stops the activity loop; the agent keeps the server running in both cases (the control plane re-issues a token on the next resume).

### 3.6 `sandbox/supervisor/src/logs.rs` (new)

b9 ingests one JSON `LogBatch` per request: `{ workspaceId, sandboxName, sessionId, build, entries: [{ ts, level, source, msg, fields? }] }`, ≤ 200 entries and ≤ 256 KiB (413 above), answers 204 (b9 §4.2). `sessionId` is `manifest.session.id` (the Vercel sandbox session; D1's per-connect `sid` is informational and travels inside `fields` when a server line carries one).

```rust
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogEntry {
    pub ts: u64,                                        // unix ms
    pub level: &'static str,                            // "error" | "warn" | "info" | "debug" | "trace"
    pub source: String,                                 // "server" | "agent" | "post_create" | "post_start" | "post_attach" | "dotfiles" | "proxy" | "prebuild" | "warm", or "server:<module_path>" when the server line carries one
    pub msg: String,                                    // ≤ MAX_MSG_BYTES after `scrub`
    #[serde(skip_serializing_if = "Option::is_none")] pub fields: Option<serde_json::Map<String, serde_json::Value>>,   // `sid`, `epoch`, `truncated`, `dropped`
}
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct LogBatch<'a> { pub workspace_id: &'a str, pub sandbox_name: &'a str, pub session_id: &'a str, pub build: &'a str, pub entries: &'a [LogEntry] }
#[derive(Clone, Copy, Debug)] pub enum LogSource { Server, Agent, PostCreate, PostStart, PostAttach, Dotfiles, Proxy, Prebuild, Warm }

pub const FLUSH_INTERVAL: Duration = Duration::from_secs(5);   // default; manifest.logs.flushIntervalSecs wins
pub const MAX_BATCH_LINES: usize = 200;          // ceiling; manifest.logs.maxBatch may lower it
pub const MAX_BATCH_BYTES: usize = 256 * 1024;   // ceiling (b9's 413 limit); manifest.logs.maxBatchBytes may lower it
pub const MAX_LINE_BYTES: usize = 64 * 1024;     // `LinesCodec::new_with_max_length` on every pumped stream; longer lines are split and marked `truncated: true` in `fields`
pub const MAX_MSG_BYTES: usize = 8 * 1024;       // `msg` truncated with "…[+N bytes]"
pub const MAX_QUEUE_LINES: usize = 5_000;        // and
pub const MAX_QUEUE_BYTES: usize = 8 * 1024 * 1024;   // oldest dropped beyond either while the control plane is unreachable; drops are counted and reported once per flush as an `agent` entry
pub const PER_SOURCE_RATE: (usize, Duration) = (200, Duration::from_secs(1));   // token bucket per source; excess lines are counted, not shipped (BUILD-SPEC §7.3 ingest protection)

/// Converts one server stderr line: JSON objects following b2's `ServeLogRecord` (`ts_ms`, `level` 1..=5, `message`,
/// `module_path`, `session_id`, `epoch`) are mapped; anything else becomes an `info` entry with the raw text. Always passes through `scrub`.
pub fn entry_from_server(line: &str, now_ms: u64) -> LogEntry;

/// Redacts token shapes in place: `gh[pousr]_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`, `zsb_[A-Za-z0-9_-]{20,}`,
/// `eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, `v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` (port tokens/cookies),
/// `(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}`, `x-access-token:[^@\s]+@`, `zs_port_token=[^&\s]+`, `zs_port_session=[^;\s]+`,
/// `x-vercel-protection-bypass:\s*\S+`, `[?&]token=[^&\s]+` (presigned Blob URLs) → `[redacted]`.
pub fn scrub(message: &str) -> std::borrow::Cow<'_, str>;

#[derive(Clone)]
pub struct LogShipper { tx: tokio::sync::mpsc::Sender<LogEntry> }

pub struct LogShipperConfig { pub flush_interval: Duration, pub max_batch: usize, pub max_batch_bytes: usize, pub workspace_id: String, pub sandbox_name: String, pub session_id: String, pub build: String }   // from Config + Manifest (entries pushed before the manifest is known are held in the queue; the first batch goes out once `configure` runs)

impl LogShipper {
    /// Spawns the batching task: flush on max_batch, max_batch_bytes, or every flush_interval; failed POSTs re-queue (bounded); a 413 halves the batch size for the rest of the boot.
    pub fn start(control: ControlPlane, build: String) -> (Self, LogShipperHandle);
    pub fn configure(&self, config: LogShipperConfig);   // once, after the manifest
    pub fn push(&self, entry: LogEntry);       // try_send; drops with a counter when the channel is full
    /// Installs a `tracing_subscriber` layer so the agent's own `tracing::*` events become `source: "agent"` entries.
    pub fn tracing_layer(&self) -> impl tracing_subscriber::Layer<tracing_subscriber::Registry> + Send + Sync;
    /// Pumps a child's stdout/stderr (`LinesCodec::new_with_max_length(MAX_LINE_BYTES)`) into `push` with the given source.
    pub async fn pump<R: tokio::io::AsyncRead + Unpin>(&self, reader: R, source: LogSource);
}
pub struct LogShipperHandle { /* .. */ }
impl LogShipperHandle {
    /// Final flush with a hard deadline (used on SIGTERM).
    pub async fn flush(self, deadline: Duration);
}
pub fn encode_batch(batch: &LogBatch<'_>) -> bytes::Bytes;   // serde_json; the caller checks max_batch_bytes and splits
```

Agent logs are also written to stderr as JSON lines (`tracing_subscriber::fmt().json()`), so `runCommand({ stderr })` in the control plane sees them.

### 3.7 `sandbox/supervisor/src/ports.rs` (new)

Pure parsing plus the watcher task.

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ListenSocket { pub port: u16, pub v4: bool, pub v6: bool, pub loopback_only: bool, pub uid: u32, pub inode: u64 }

/// Parses the body of `/proc/net/tcp` or `/proc/net/tcp6` (header line skipped); keeps `st == 0A`.
pub fn parse_proc_net_tcp(text: &str, v6: bool) -> Vec<ListenSocket>;
/// `0100007F:0BB8` → (Ipv4 127.0.0.1, 3000); tcp6 `00000000000000000000000001000000:1F90` → (::1, 8080).
pub fn parse_local_address(field: &str, v6: bool) -> Option<(std::net::IpAddr, u16)>;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ListeningPort { pub port: u16, pub pid: u32, pub process_name: String, #[serde(skip)] pub v4: bool, #[serde(skip)] pub v6: bool }

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PortDiff { pub added: Vec<u16>, pub removed: Vec<u16> }
pub fn diff_ports(previous: &BTreeSet<u16>, current: &BTreeSet<u16>) -> PortDiff;
pub fn is_infra_port(port: u16) -> bool;     // config::INFRA_PORTS (8443-8450)

/// Reads both proc files, unions v4/v6 by port (v4/v6 flags kept so the proxy can pick `[::1]` for v6-only listeners), drops INFRA_PORTS and ports owned by `self_pid`.
pub fn scan(self_pid: u32) -> std::io::Result<BTreeMap<u16, ListenSocket>>;
/// Walks `/proc/<pid>/fd/*` for `socket:[<inode>]` links (only for the inodes given), returns pid + `/proc/<pid>/comm`.
pub fn resolve_owners(inodes: &[u64]) -> BTreeMap<u64, (u32, String)>;
/// Owner pid of a listening socket on `port` (any address), if any – used by §3.9 to clear a stale server (8443 and 8446).
pub fn owner_of_port(port: u16) -> std::io::Result<Option<(u32, String)>>;

#[derive(Clone, Default)]
pub struct ListeningState { inner: Arc<std::sync::RwLock<Vec<ListeningPort>>> }
impl ListeningState { pub fn current(&self) -> Vec<ListeningPort>; pub fn address_family(&self, port: u16) -> Option<(bool, bool)>; }

/// Every `interval` (2 s): scan → diff → on change resolve owners for new inodes, cache the rest, update `listening`,
/// then `server.post_ports(ports, forwards.current())`. Also republishes after every server (re)start and after every
/// forwards change (`forwards.changed()` watch). Paused while `state.status() == Stopping` (no republish during teardown).
pub async fn watch(interval: Duration, server: ServerControl, forwards: ForwardsState, listening: ListeningState, state: Arc<AgentState>, shutdown: tokio_util::sync::CancellationToken);
```

`ForwardsState` (in `state.rs`, §3.8) is the in-memory copy of the forward list; the control plane is the persistent store (BUILD-SPEC 7.2 `forwards`). It is seeded from `manifest.forwards`, updated by the local API (`/ports`), and replaced wholesale whenever an `ActivityDirective` carries `forwards` (§7 item 4).

### 3.8 `sandbox/supervisor/src/state.rs` (new)

Shared runtime state read by the health server and the activity relay.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)] #[serde(rename_all = "snake_case")]
pub enum HealthStatus { Booting, Ready, Degraded, Stopping }
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)] #[serde(rename_all = "snake_case")]
pub enum Phase { Manifest, Restore, Clone, ServerStarting, Dotfiles, PostCreate, PostStart, Warm /* prebuild only */, Ready }

pub struct AgentState { inner: parking_lot::RwLock<AgentStateInner> }   // no async held across it
pub struct AgentStateInner {
    pub status: HealthStatus, pub phase: Phase, pub resumed: bool, pub started_at: Instant,
    pub last_error: Option<String>, pub server: ServerStatus, pub proxy_running: bool,
    pub server_health: Option<ServerHealth>,   // last successful GET 127.0.0.1:8443/health
    pub session_seen: bool,                     // first `session_active == true` observed this boot (drives postAttach)
    pub busy: bool,                             // a lifecycle command (dotfiles/postCreate/postStart/postAttach) or the prebuild warm-up is running (D13)
    pub manifest_build: Option<String>,
    pub region: Option<String>,
}
#[derive(Clone, Debug, Default, serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct ServerStatus { pub running: bool, pub pid: Option<u32>, pub restarts: u32, pub last_exit: Option<i32>, pub started_at_ms: Option<u64>, pub crash_loop: bool }
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct ServerHealth { pub build: String, pub version: String, pub uptime_secs: u64, pub session_active: bool, #[serde(default)] pub last_input_at: Option<u64>, #[serde(default)] pub session: Option<serde_json::Value> /* b2 §3.7 SessionMeta; its `session_id` key (the JWT `sid`) is read for the activity ping's `sid` */, #[serde(default)] pub dirty_buffers: Option<u32> }  // b2 §3.8 HealthResponse; `worktrees`/`auth_failures` deliberately not modelled

impl AgentState {
    pub fn new(build: String, region: Option<String>) -> Arc<Self>;   // status Booting, phase Manifest, started_at = Instant::now() (no `Default`: `Instant` has none)
    pub fn set_phase(&self, phase: Phase);
    pub fn set_status(&self, status: HealthStatus);
    pub fn status(&self) -> HealthStatus;
    pub fn set_error(&self, error: impl Into<String>);
    pub fn set_busy(&self, busy: bool);
    pub fn snapshot(&self, full: bool, forwards: &[Forward], listening: &[u16]) -> HealthReport;   // §4.4; `full == false` (non-loopback) omits only `forwards` – b9's probe (b9 §3.18) reads lastError, listening and server.health from the public host
}

/// `GET :8445/health` body (§4.4).
#[derive(Clone, Debug, serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub status: HealthStatus, pub phase: Phase, pub build: String, pub manifest_build: Option<String>, pub region: Option<String>, pub resumed: bool, pub busy: bool, pub uptime_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")] pub last_error: Option<String>,   // scrubbed (§3.6)
    pub server: ServerReport, pub proxy: ProxyReport,
    #[serde(skip_serializing_if = "Option::is_none")] pub forwards: Option<Vec<Forward>>,   // loopback only
    pub listening: Vec<u16>,
}
#[derive(Clone, Debug, serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct ServerReport { #[serde(flatten)] pub status: ServerStatus, #[serde(skip_serializing_if = "Option::is_none")] pub health: Option<ServerHealth> }
#[derive(Clone, Debug, serde::Serialize)] #[serde(rename_all = "camelCase")] pub struct ProxyReport { pub running: bool, pub slots: BTreeMap<u16, Option<u16>> /* slot port → bound target port */ }

#[derive(Clone)]
pub struct ForwardsState { inner: Arc<std::sync::RwLock<ForwardsInner>>, changed: tokio::sync::watch::Sender<u64> }
struct ForwardsInner { forwards: BTreeMap<u16, Forward>, slots: BTreeMap<u16, u16> /* slot → port (D8) */ }
impl ForwardsState {
    pub fn new() -> Self;
    pub fn replace(&self, forwards: Vec<Forward>);   // no-op (no `changed` bump) when equal; re-derives `slots` from `forwards[].slot`, keeps token-learned bindings whose port is still a private forward, drops the rest
    pub fn insert(&self, forward: Forward);          // idempotent per port (b4 §7 item 8: `ForwardPort` may be replayed); binds `slot` when given
    pub fn remove(&self, port: u16);                 // also unbinds any slot pointing at `port`
    pub fn current(&self) -> Vec<Forward>;
    pub fn slot_port(&self, slot: u16) -> Option<u16>;
    pub fn bind_slot(&self, slot: u16, port: u16) -> Result<(), SlotError>;   // token-learned binding (§3.11); refuses when `port` is not a private forward or the slot is bound to another live forward
    pub fn slots(&self) -> BTreeMap<u16, Option<u16>>;
    pub fn changed(&self) -> tokio::sync::watch::Receiver<u64>;
}
```

### 3.9 `sandbox/supervisor/src/server.rs` (new)

Spawns and supervises `zed-remote-server serve`; generates the control secret and writes it to `run/control.secret` (the only place it exists, D18); client for the server's `/control/*` (loopback control listener, `127.0.0.1:8446`, D5) and `/health` (public listener, `127.0.0.1:8443`).

```rust
pub const RESTART_BACKOFF: [u64; 6] = [1, 2, 4, 8, 16, 30];   // seconds; resets after 60 s of stable running
pub const CRASH_LOOP_LIMIT: (u32, Duration) = (6, Duration::from_secs(600));   // 6 exits inside 10 min → stop respawning, `degraded`, lastError "server_crash_loop"
pub const CRASH_TAIL_LINES: usize = 200;
pub const STOPPING_POST_TIMEOUT: Duration = Duration::from_secs(7);   // D18: exceeds b4's STOPPING_FLUSH_TIMEOUT (5 s) so the client's SaveClientState (with D6's unsaved buffers) always gets its full window
pub const TERM_GRACE: Duration = Duration::from_secs(10);              // b9 §4.8 waits ≤ 25 s on the supervisor's exit (≈ 3 + 5 + 10 + 3); the whole stop path fits in ≈ 21 s (§3.16 step 8)
pub const LOG_FLUSH_DEADLINE: Duration = Duration::from_secs(3);

pub struct ServerSpec {
    pub bin: PathBuf,
    pub listen: SocketAddr,                 // 0.0.0.0:8443
    pub jwt_key_files: Vec<PathBuf>,        // manifest.jwt.publicKeys materialised (§3.14), plus the prebuild warm-up key (§3.16a)
    pub workspace_id: String,
    pub audience: String,                   // manifest.jwt.audience (b9 §7 item 4: the control plane owns it; may differ from the sandbox name)
    pub issuer: String,                     // manifest.jwt.issuer
    pub workspace_root: PathBuf,            // manifest.workspaceDir
    pub client_build: String,
    pub allowed_origins: Vec<String>,       // manifest.allowedOrigins → one `--allowed-origin` each (D5; b9 §7 item 7c)
    pub control_secret_file: PathBuf,       // run/control.secret (D5/D18)
    pub control_listen: SocketAddr,         // 127.0.0.1:8446 (D5)
    pub supervisor_url: String,             // http://127.0.0.1:8450 (`--supervisor-url`; also exported as ZS_SUPERVISOR_URL)
    pub port_file: PathBuf,
    pub env: BTreeMap<String, String>,      // process env ∪ manifest.env (filtered) ∪ expanded remoteEnv ∪ { ZS_SUPERVISOR_URL, ZS_CONTROL_SECRET_FILE, SHELL, USER, HOME } minus the stripped variables (§3.3); NO ZS_CONTROL_SECRET (D18)
    pub cwd: PathBuf,                       // workspace_root
}

impl ServerSpec {
    /// Exactly: `<bin> serve --listen <listen> --jwt-public-key <f>… --workspace-id <ws> --audience <aud>
    /// --issuer <iss> --workspace-root <root> --client-build <build> --allowed-origin <o>… --control-secret-file <run/control.secret>
    /// --control-listen 127.0.0.1:8446 --supervisor-url http://127.0.0.1:8450 --port-file <pf>` (b2 §3.9 ServeArgs; D5/D18; b2 §7.13).
    pub fn command(&self) -> tokio::process::Command;   // stdin null, stdout piped (for `ZS_LISTENING=`/`ZS_CONTROL_LISTENING=`), stderr piped, `process_group(0)`, `kill_on_drop(false)`
}

/// Handle used by other tasks; cheap to clone.
#[derive(Clone)]
pub struct ServerControl { http: reqwest::Client /* no proxy, loopback only (b4 §7.9) */, health_base: String /* http://127.0.0.1:8443 */, control_base: String /* http://127.0.0.1:8446 */, secret: SecretString }
impl ServerControl {
    pub async fn health(&self) -> anyhow::Result<ServerHealth>;                                    // GET {health_base}/health (loopback → full body)
    pub async fn post_lifecycle(&self, body: &LifecycleBody) -> anyhow::Result<()>;                 // POST {control_base}/control/lifecycle, expects 204; request timeout STOPPING_POST_TIMEOUT for Stopping, 3 s otherwise
    pub async fn post_ports(&self, ports: &[ListeningPort], forwards: &[Forward]) -> anyhow::Result<()>; // POST {control_base}/control/ports with `PortsBody`, expects 204
    pub async fn post_extensions(&self, install: &[String]) -> anyhow::Result<()>;                  // POST {control_base}/control/extensions {"install": [...]}, expects 204 (D5; b4 §4.2)
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)] #[serde(tag = "kind", rename_all = "snake_case")]
pub enum LifecycleBody { IdleStopIn { seconds: u32 }, SessionCapIn { seconds: u32 }, Stopping, Resumed }   // mirrors b4 §3.10
/// Wire form of b4's `PortsBody` (b4 §4.2): `forwards[].url` is a non-optional string there, so `None` → `""`.
#[derive(serde::Serialize)] pub struct PortsBody<'a> { pub ports: &'a [ListeningPort], pub forwards: Vec<PortForwardWire> }
#[derive(serde::Serialize)] pub struct PortForwardWire { pub port: u16, pub visibility: Visibility, pub label: Option<String>, pub url: String }
impl From<&Forward> for PortForwardWire { /* url.clone().unwrap_or_default() */ }
#[derive(serde::Serialize)] pub struct ExtensionsBody<'a> { pub install: &'a [String] }

pub struct Supervisor { spec: ServerSpec, state: Arc<AgentState>, logs: LogShipper, control: ServerControl, cp: ControlPlane, shutdown: CancellationToken, child_pid: Arc<AtomicU32> }
impl Supervisor {
    pub fn generate_control_secret() -> SecretString;   // 32 random bytes → hex (`rand::rng().fill_bytes`, rand 0.9)
    /// Writes the secret to `run/control.secret` (0600, no trailing newline; created fresh on every boot, never reused from a snapshot). Returns the path.
    pub fn write_control_secret(secret: &SecretString, run_dir: &Path) -> std::io::Result<PathBuf>;
    /// Before the first spawn: `ports::owner_of_port(8443)` and `owner_of_port(8446)`; if another process holds either (a server left
    /// over from a crashed/restarted agent) → `killpg(SIGKILL)` on its process group, log `stale_server_killed {pid, comm, port}`, wait ≤ 2 s for the ports to free.
    pub async fn clear_stale_server(&self) -> anyhow::Result<()>;
    /// Spawn loop: start child, read `ZS_LISTENING=`/`ZS_CONTROL_LISTENING=` from stdout, pump stderr lines into `logs` (and a ring of
    /// CRASH_TAIL_LINES), wait for exit; on exit while not shutting down: `killpg(SIGKILL)` the dead child's group (language servers,
    /// PTYs), ship a `server_crash` entry with the tail and `cp.client_error(kind: "server_crash", stack: tail)`, bump `restarts`,
    /// sleep backoff, respawn – unless CRASH_LOOP_LIMIT is hit. Returns when `shutdown` fires and the child is gone.
    pub async fn run(self) -> anyhow::Result<()>;
    /// Stop sequence (BUILD-SPEC 6.2 stop, b4 §3.10, D18), total ≤ ≈ 18 s:
    ///   1. `post_lifecycle(Stopping)` with STOPPING_POST_TIMEOUT (7 s > the server's 5 s SaveClientState wait; 204 at once when no session is attached);
    ///   2. `kill(pid, SIGTERM)` to the **child pid only** (the server flushes, closes 1001 and exits 0, b2 §3.7);
    ///   3. wait ≤ TERM_GRACE (10 s) for exit; 4. `killpg(pgid, SIGKILL)` (always, even after a clean exit – sweeps orphaned
    ///   LSPs/PTYs); 5. reap. The port watcher is paused during this (status Stopping), so orphans between 2 and 4 are never republished.
    pub async fn stop_child(&self) -> anyhow::Result<()>;
}
/// Poll `GET /health` until 200 or `deadline`; used by start (readiness) and tests.
pub async fn wait_for_server(control: &ServerControl, deadline: Duration) -> anyhow::Result<ServerHealth>;
```

Signals go through `nix::sys::signal::{kill, killpg}`; the child is in its own process group (`process_group(0)`), so the group `SIGKILL` also kills language servers and PTYs it spawned (b3's `PtyManager` SIGTERMs its process groups from `on_app_quit` first, D3; the supervisor's group kill is the backstop). `zs-agent` itself has `panic = "abort"`; `clear_stale_server` is what makes a restarted agent recover from a previous instance's leftovers instead of looping on `EADDRINUSE`. The server's environment carries no secret (D18): the control secret is read by the server from `--control-secret-file` and by the credential helper from `ZS_CONTROL_SECRET_FILE`; every language server, task and PTY inherits the path, and – since everything in the VM runs as uid 1000 – could read the file, which is the same trust level b4 §7.19 states for the loopback listener.

### 3.10 `sandbox/supervisor/src/port_auth.rs` (new; replaces the draft's `cookie.rs` – b9 §6.2 refers to the test vector by the old module name)

Two token kinds, **one format**: `v1.<b64url(json payload)>.<b64url(HMAC-SHA256(key, "v1." + b64url(payload)))>` with unpadded base64url, payload `{"ws","port","sub","iat","exp","jti"}` serialised in that field order (b9 `signPortSession`, byte-for-byte). **Bootstrap token** (`zs_port_token`, D8): minted by the control plane's `/open` route under `manifest.portSessionSecret` (a per-generation secret decrypted from `workspaces.port_session_secret_ciphertext`, rotated on rebuild), TTL 1 h (b9 `PORT_SESSION_TTL_SECS`); verified by the proxy with the same key. An HMAC token rather than an ES256 JWT because b2's `/rpc` verifier validates no `sid` binding, so an ES256 port token would double as a session token (b9 §8 R2-10). **Session cookie** (`zs_port_session`, D8): minted by the proxy itself after a successful bootstrap, same format, HMAC under a per-boot random key that lives only in memory (nothing secret is written to the snapshotted disk, BUILD-SPEC 10.4; the manifest is never persisted either); invalid after every resume, so a private port costs one click per session.

```rust
pub const COOKIE_NAME: &str = "zs_port_session";
pub const BOOTSTRAP_PARAM: &str = "zs_port_token";
pub const TOKEN_PREFIX: &str = "v1";
pub const COOKIE_TTL_SECS: u64 = 8 * 3600;
pub const BOOTSTRAP_MAX_AGE_SECS: u64 = 3600;   // b9 PORT_SESSION_TTL_SECS; a longer-lived token is rejected as `Expired` even if unexpired

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PortSession { pub ws: String, pub port: u16, pub sub: String, pub iat: u64, pub exp: u64, pub jti: String }   // field order is the wire order

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError { #[error("malformed token")] Malformed, #[error("bad signature")] BadSignature, #[error("expired")] Expired, #[error("wrong workspace")] WrongWorkspace, #[error("port not allowed")] BadPort, #[error("token port does not match this slot")] WrongSlot }

pub struct PortTokenCodec { key: [u8; 32] }
impl PortTokenCodec {
    pub fn new(key: [u8; 32]) -> Self;                   // bootstrap: manifest.port_session_key(); cookies: `random()`
    pub fn random() -> Self;                             // rand 0.9 `rng().fill_bytes`; one per proxy start
    /// `v1.<b64url(json payload)>.<b64url(HMAC-SHA256(key, "v1." + b64url(payload)))>`
    pub fn sign(&self, session: &PortSession) -> String;
    /// Splits on '.', requires prefix `v1`, recomputes the MAC and compares with `subtle::ConstantTimeEq`
    /// **before** decoding the payload, then checks `exp > now`, `exp - iat <= max_age`, `ws == workspace_id`, port ∈ 1..=65535 ∖ INFRA_PORTS.
    pub fn verify(&self, token: &str, workspace_id: &str, now: u64, max_age: u64) -> Result<PortSession, AuthError>;
}

/// Finds `zs_port_session` in a `Cookie:` header value (`a=b; c=d`), ignoring others.
pub fn cookie_from_header(header: &str) -> Option<&str>;
/// `Set-Cookie` value: `zs_port_session=<t>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<exp-now>[; Secure]`.
pub fn set_cookie_header(token: &str, max_age: u64, secure: bool) -> String;
pub fn clear_cookie_header(secure: bool) -> String;   // Max-Age=0
/// `next` must start with a single '/' and not '//' or '/\'; anything else → "/".
pub fn safe_next(next: Option<&str>) -> String;
pub fn decode_secret(b64: &str) -> Result<[u8; 32], AuthError>;   // standard base64, padded (b9 `newPortSessionSecret`); exactly 32 bytes
```

### 3.11 `sandbox/supervisor/src/proxy.rs` (new)

**Routing decision: one listener per D8 slot, slot-bound target port, no path prefix, no Host routing.** Each declared sandbox port gets its own fixed `https://<id>.vercel.run` host, so the Host header on a slot is constant and cannot select a target; a path prefix breaks every web app that emits absolute paths (`/static/app.js`, `/api/…`, HMR websockets), so this brief does not implement one. The control plane allocates one of the four slots (`8444, 8447, 8448, 8449`, §3.3) per private forward (D8) and every request on slot `S` is forwarded verbatim to `127.0.0.1:<port bound to S>` (or `[::1]` when the socket table shows a v6-only listener). Entry: the control plane's link `GET {origin}/api/workspaces/{id}/ports/{port}/open` (Clerk-authenticated) → `303` to `https://<slot-host>/__zs/auth?zs_port_token=<token>&next=/` (D8); the proxy on that slot verifies the token under `portSessionSecret`, **binds the slot to the token's port** when the slot is unbound (or learns the binding from `forwards[].slot` when the control plane sent it), mints its cookie for its own host and redirects to `next`. A cross-origin `Set-Cookie` for `*.vercel.run` from our origin is impossible, so BUILD-SPEC 5.2's wording is implemented through this redirect. Because every slot has its own hostname and its own cookie, one browser profile can hold four private ports open at once (the draft's "one private port per browser" limitation is gone with D8).

Slot binding rules (`ForwardsState`, §3.8): a slot follows `forwards[].slot` when present (manifest, `/ports` response, directive); otherwise the first valid bootstrap token seen on a slot binds it to the token's `port`, provided that port is a private forward. `DELETE /ports/{port}` and a forwards refresh that drops the port unbind it, so an unforwarded port stops being reachable through its slot as soon as the supervisor learns of the removal (immediately for server-initiated unforwards; on the next directive for dashboard-initiated ones, §7 item 4). A cookie whose `port` differs from the slot's current binding is answered `401 {"error":"port_session_stale"}` (cookie cleared) – the user re-opens the `/open` link.

```rust
pub const AUTH_PATH: &str = "/__zs/auth";
pub const LOGOUT_PATH: &str = "/__zs/logout";
pub const MAX_INFLIGHT: usize = 256;          // plain requests per slot; the permit is released at 101 hand-off, so long-lived WebSockets never starve requests
pub const MAX_UPGRADED: usize = 1024;         // separate cap for tunnels, per slot
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(30);   // hyper `header_read_timeout` – requires `.timer(TokioTimer::new())` or hyper panics (http1.rs:336-343)

#[derive(Clone)]
pub struct ProxyConfig { pub slot: u16, pub listen: SocketAddr /* proxy_bind_ip:slot */, pub bootstrap: Arc<PortTokenCodec>, pub cookies: Arc<PortTokenCodec>, pub workspace_id: String, pub secure_cookies: bool, pub forwards: ForwardsState, pub listening: ListeningState }

/// One task per slot; `run_all` spawns `PROXY_SLOTS.len()` of them sharing `bootstrap`/`cookies` and reports `proxy.running` once every slot is bound.
pub async fn run_all(configs: Vec<ProxyConfig>, state: Arc<AgentState>, logs: LogShipper, shutdown: CancellationToken) -> anyhow::Result<()>;
pub async fn run(config: ProxyConfig, state: Arc<AgentState>, logs: LogShipper, shutdown: CancellationToken) -> anyhow::Result<()>;
/// One connection: `TcpListener::accept()` → `hyper_util::rt::TokioIo::new(stream)` →
/// `hyper::server::conn::http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(HEADER_TIMEOUT).serve_connection(io, service_fn(..)).with_upgrades()`.
async fn handle(config: Arc<ProxyConfig>, peer: SocketAddr, req: hyper::Request<hyper::body::Incoming>) -> Result<hyper::Response<BoxBody>, std::convert::Infallible>;

/// Request flow:
/// 1. `GET /__zs/auth?zs_port_token=&next=` → `bootstrap.verify(token, ws, now, BOOTSTRAP_MAX_AGE_SECS)` → slot binding (bind if unbound; `WrongSlot`
///    if bound to another port) → mint `PortSession { port, sub, iat = now, exp = now + COOKIE_TTL_SECS, jti }` under `cookies` →
///    303 `Location: safe_next(next)` + Set-Cookie (401 JSON on failure, cookie cleared).
/// 2. `GET /__zs/logout` → clear cookie, 204.
/// 3. Everything else: cookie → `cookies.verify(.., COOKIE_TTL_SECS)` else 401 `{"error":"port_session_required"}` (HTML page when `Accept: text/html`,
///    with no link back – the control plane owns the entry link); cookie.port ≠ slot binding → 401 `port_session_stale`; slot unbound → 404 `{"error":"slot_unbound"}`.
/// 4. Forward: `TcpStream::connect((upstream_ip, port))` → `TokioIo::new` → `hyper::client::conn::http1::handshake(io)`;
///    `tokio::spawn(conn.with_upgrades())` (client-side `with_upgrades` is required for step 5); request URI rewritten to
///    origin-form (path + query only); headers copied except hop-by-hop (`Connection`, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`,
///    `Transfer-Encoding`) – but **keep** `Upgrade` and `Sec-WebSocket-*`, and when `Upgrade` is present **re-insert
///    `Connection: upgrade`** (upstreams such as tungstenite and Node's http parser refuse the handshake without it);
///    `Host: 127.0.0.1:<port>`; add `X-Forwarded-Host`, `X-Forwarded-Proto: https`, `X-Forwarded-Port: <port>`; strip the
///    `zs_port_session` cookie from the forwarded `Cookie` header.
/// 5. If the upstream answers 101: build the 101 for the client (status + `Upgrade`/`Sec-WebSocket-*` headers, plus
///    `Connection: upgrade`), release the inflight permit, take an upgraded permit, then in a spawned task await
///    `hyper::upgrade::on(client_req)` and `hyper::upgrade::on(upstream_resp)`, wrap both in `TokioIo`, and
///    `tokio::io::copy_bidirectional` until either side closes. Bodies otherwise stream both ways.
/// 6. Upstream connect refused → 502 `{"error":"upstream_unavailable","port":N}`; timeout 30 s on headers, none on body.
fn strip_hop_by_hop(headers: &mut hyper::HeaderMap);           // then `ensure_connection_upgrade`
fn ensure_connection_upgrade(headers: &mut hyper::HeaderMap);  // inserts `Connection: upgrade` iff `Upgrade` present
fn strip_port_cookie(cookie_header: &str) -> Option<String>;
fn upstream_ip(listening: &ListeningState, port: u16) -> std::net::IpAddr;   // 127.0.0.1 unless the port is v6-only → ::1
pub type BoxBody = http_body_util::combinators::BoxBody<bytes::Bytes, hyper::Error>;
```

`X-Forwarded-Proto` is `https` unless `secure_cookies == false` (local test), in which case it echoes the incoming scheme. The first navigation from the control plane's redirect carries no cookie simply because none has been set for the slot host yet (`SameSite=Lax` cookies *are* sent on cross-site top-level GET navigations); after `/__zs/auth` sets it, every later navigation and same-site fetch carries it.

### 3.12 `sandbox/supervisor/src/api.rs` (new)

Two listeners, one router. **8445** (`0.0.0.0`, declared to Vercel) serves `GET /health` only; **8450** (`127.0.0.1`, never declared, hence unreachable from outside the VM regardless of what address Vercel's ingress presents) serves the server-facing and helper-facing routes. Linux will not let one process bind `127.0.0.1:8445` beside `0.0.0.0:8445`, which is why the loopback API has its own port, and 8446 belongs to serve's control listener (D5), which is why it is 8450 (b4 §7 item 20). Both listeners come up **before the manifest is fetched** (§3.16 step 1) so b9's `probeHealth` sees `booting`/`manifest` with a `lastError` when the manifest cannot be fetched (b9 §4.8 fails fast on that).

```rust
pub struct ApiDeps { pub state: Arc<AgentState>, pub control: ControlPlane, pub forwards: ForwardsState, pub listening: ListeningState, pub control_secret: SecretString, pub server: OnceLock<ServerControl> /* set once the server spec exists */ }

pub async fn run(health_listen: SocketAddr, local_listen: SocketAddr, deps: Arc<ApiDeps>, shutdown: CancellationToken) -> anyhow::Result<()>;
/// `run` threads the `SocketAddr` from `TcpListener::accept()` into `service_fn` as `peer`; `listener` says which listener the request came in on.
pub async fn route(deps: Arc<ApiDeps>, listener: Listener, peer: SocketAddr, req: hyper::Request<hyper::body::Incoming>) -> Result<hyper::Response<BoxBody>, std::convert::Infallible>;
#[derive(Clone, Copy, PartialEq, Eq)] pub enum Listener { Health, Local }
```

Routes:

- `GET /health` (both listeners) → `HealthReport` (§4.4). HTTP 200 for `ready` **and** `degraded` (the server is usable; `status` says why it is degraded), 503 for `booting`/`stopping` – with the full body either way, since b9's `waitUntilReady` reads `phase`/`lastError` from a 503. `full = peer.ip().is_loopback()`; non-loopback callers get the same body without `forwards`. No auth. `Cache-Control: no-store`. On the `Health` listener every other path is 404.
- `POST /ports` (server → supervisor, b4 §3.11; `Local` only): require `Authorization: Bearer` equal to the control secret (constant-time) else 401. Body `{port, visibility, label}`; `is_infra_port` → 400. Calls `control.forward(..)` → on 200 `forwards.insert` (with `slot` when returned) → `server.post_ports` (so the client sees the new forward) → `200 {"url": <string|null>}`. A control-plane 4xx (no free slot, port refused) → `409 {"error": "<control plane error code>"}` (b4 surfaces it as the `ForwardPort` error); 5xx/transport → `502 {"error":"control_plane_unavailable"}`.
- `DELETE /ports/{port}` → same auth → `control.unforward(port)` → `forwards.remove` (unbinds the slot) → republish → 204.
- `POST /extensions` (server → supervisor, b4 §3.11 `report_installed_extensions`; `Local` only): bearer; body `{"installed": [ids]}` → `control.report_extensions` (D18/D19) → 204 (204 even when the control plane is unreachable: the relay is best-effort and retried on the next report; logged).
- `POST /git-token` (credential helper → supervisor; `Local` only): same bearer (the helper reads the secret from `ZS_CONTROL_SECRET_FILE`, §3.13). Body `{host, protocol, path}` forwarded as `GitTokenRequest`; returns `GitTokenResponse` verbatim (`expiresAt` normalised to unix seconds). Control-plane 404/403 → same status with the body passed through. The token is never logged or written.
- `POST /lifecycle` (tests / operators via `runCommand curl`; `Local` only): bearer; forwards `LifecycleBody` to the server.
- Everything else 404; wrong method 405. Requests for `Local` routes arriving on the `Health` listener are 404, and a non-loopback `peer` on the `Local` listener (cannot happen with the bind address, kept as defence in depth) is 403.

### 3.13 `sandbox/supervisor/src/credential.rs` (new)

```rust
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CredentialRequest { pub protocol: Option<String>, pub host: Option<String>, pub path: Option<String>, pub username: Option<String> }

/// Reads `key=value` lines until EOF or a blank line; unknown keys (`wwwauth[]`, `capability[]`) ignored.
pub fn parse_request<R: std::io::BufRead>(input: R) -> std::io::Result<CredentialRequest>;
/// `username=<u>\npassword=<p>\n[password_expiry_utc=<unix secs>\n]`
pub fn format_response(username: &str, password: &str, expires_at_unix: Option<u64>) -> String;
/// Accepts JS `toISOString()` output only (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) → unix seconds; anything else → None (expiry omitted). Used for the `ExpiresAt::Iso` tolerance path.
pub fn parse_rfc3339_utc(s: &str) -> Option<u64>;
/// Reads the control secret from `ZS_CONTROL_SECRET_FILE` (D18), else `$HOME/.zs/run/control.secret`; `None` when absent/unreadable.
pub fn read_control_secret_file(path: Option<&Path>, home: &Path) -> Option<SecretString>;

/// `zs-agent credential <get|store|erase>`: `store`/`erase` print nothing and exit 0.
/// `get`: parse stdin; if `host != github.com` or `protocol` ∉ {https, None}, or no control secret file is readable,
/// print nothing and exit 0 (git falls through to the next helper / askpass → `AskPassRequest`, BUILD-SPEC 5.7).
/// Otherwise POST http://127.0.0.1:8450/git-token `{host, protocol: "https", path}` with the bearer (5 s timeout) and print `format_response`.
/// 403/404 from the supervisor (repo_not_allowed / host_unsupported) → print nothing, exit 0 (fall through). Network failure → exit 1 with a
/// one-line stderr message. `--supervisor-url` comes from `ZS_SUPERVISOR_URL` (default 8450).
pub async fn main(operation: &str, supervisor_url: &str, control_secret: Option<SecretString>) -> anyhow::Result<i32>;
```

Registered in the image as `git config --system credential.helper '!zs-agent credential'`. `useHttpPath` **is** set (`git config --system credential.useHttpPath true`) so `path` reaches the helper: b9's route scopes the installation token to the workspace's repository and answers 403 `repo_not_allowed` for any other path (b9 §4.2), which the helper turns into a fall-through. Every process that runs git inside the workspace (Zed's PTYs, language servers, agents, lifecycle commands) descends from the server or the supervisor and inherits `ZS_CONTROL_SECRET_FILE`; processes without it fall through to askpass.

### 3.14 `sandbox/supervisor/src/bootstrap.rs` (new)

First-boot and every-boot filesystem work. Runs as the invoking user (`ubuntu`), never `sudo`. Every long step takes the `shutdown` token: a `SIGTERM` during restore/clone/dotfiles/postCreate kills the running child group and returns `Err(Cancelled)` without leaving half-finished state behind.

```rust
pub const POST_CREATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const POST_START_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const POST_ATTACH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const DOTFILES_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const RESTORE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub const DOTFILES_INSTALLERS: [&str; 8] = ["install.sh", "install", "bootstrap.sh", "bootstrap", "script/bootstrap", "setup.sh", "setup", "script/setup"];

pub struct Markers { dir: PathBuf }
impl Markers {
    pub fn new(dir: PathBuf) -> Self;
    pub fn clone_done(&self) -> bool;                              // clone.done – written only after the atomic rename below
    pub fn set_clone_done(&self) -> std::io::Result<()>;
    pub fn post_create_done(&self) -> Option<String>;              // contents = `sha256:<hex>` of the devcontainer file bytes, or "none"
    pub fn set_post_create_done(&self, hash: &str) -> std::io::Result<()>;
    pub fn dotfiles_done(&self) -> Option<String>;                 // contents = dotfiles repo url
    pub fn set_dotfiles_done(&self, repo_url: &str) -> std::io::Result<()>;
    pub fn first_boot_done(&self) -> bool;                         // first-boot.done – exists ⇒ this boot is a resume (drives `resumed` in health and the RESUMED notice, §3.15)
    pub fn set_first_boot_done(&self) -> std::io::Result<()>;
    pub fn needs_post_create(&self, current_hash: &str) -> bool;   // missing or different hash
    pub fn settings_written(&self, kind: &str) -> Option<String>;  // settings.sha256 / keymap.sha256 – sha256 of the text last written by the supervisor
    pub fn set_settings_written(&self, kind: &str, sha256: &str) -> std::io::Result<()>;
}

/// Repository materialisation into `manifest.workspace_dir`. Decision table:
///   * `dir/.git` exists **and** `clone_done` → nothing (snapshot resume, or a completed earlier boot);
///   * `dir` exists without `clone_done` → it is a truncated earlier attempt: remove `dir`, `dir.partial` and `restore_dir`, fall through;
///   * `manifest.restore` is set (rebuild, D9) → `restore_tarball` (below), then `set_clone_done`;
///   * otherwise (fresh, or a snapshot whose disk somehow lacks the repo) → `git init <dir>.partial && git remote add origin <cloneUrl>`
///     then `git fetch [--depth N] origin <refspec>` where refspec = `repo.ref` when set (D18: `refs/pull/<n>/head` for PR workspaces),
///     else the sha when `revision` is 40 hex (a `--depth N` clone cannot reach a non-tip sha, so fetch-by-sha is used instead of clone),
///     else `refs/heads/<revision>` (`revision` is a branch name); `git checkout --detach FETCH_HEAD` (ref/sha) or `-B <revision> FETCH_HEAD` (branch);
///     then `mv <dir>.partial <dir>` and `set_clone_done`.
/// Auth comes from the credential helper (the local api listener must already be up). Cancellation → partial dirs removed.
pub async fn materialize_repo(manifest: &Manifest, config: &Config, control: &ControlPlane, logs: &LogShipper, shutdown: &CancellationToken) -> anyhow::Result<()>;

/// Rebuild restore (D9, b9 §3.19/§4.8 `stepArchiveWorkspaceDir`): the archive was made with `tar czf … -C / workspaces vercel/.local/share/zed`,
/// i.e. it is rooted at `/` and contains exactly `workspaces/…` and `vercel/.local/share/zed/…` (D9's two paths; a `vercel/.config/zed/…`
/// entry appears only in archives made before D9 and is mapped tolerantly below). Stream `control.restore_tarball(url)`
/// (plain client, §3.5) through a sha256 hasher into `tar -xzf - -C <restore_dir>` (RESTORE_TIMEOUT); if `manifest.restore.sha256` is set and differs → remove
/// `restore_dir`, `Err`. Then move into place: every entry of `restore_dir/workspaces/*` → `<workspaces_dir>/` (rename; an existing target is removed first),
/// `restore_dir/vercel/.local/share/zed` → `<data_dir>` and, when present, `restore_dir/vercel/.config/zed` → `<home>/.config/zed` (the archive's `vercel/` is the
/// sandbox `$HOME`; mapping it onto `config.home` makes the local test with a different `HOME` behave the same). Runs before the server starts, so no
/// process holds any of these paths. Absent entries are fine (an archive from an older build may lack `vercel/…`). Finally remove `restore_dir`.
pub async fn restore_tarball(spec: &RestoreSpec, config: &Config, control: &ControlPlane, logs: &LogShipper, shutdown: &CancellationToken) -> anyhow::Result<()>;

/// Clone to `$HOME/dotfiles` if absent; run `install_command` if set, else the first existing DOTFILES_INSTALLERS entry
/// (`bash -lc`, cwd = dotfiles dir, DOTFILES_TIMEOUT); if none, symlink every top-level dotfile (`.bashrc`, `.zshrc`, …,
/// excluding `.git`) into `$HOME` without overwriting existing files. Private dotfiles repos outside the GitHub App
/// installation fail the clone with 401/404 → logged, non-fatal, `lastError = "dotfiles: <reason>"` (§7 item 18).
pub async fn install_dotfiles(spec: &DotfilesSpec, config: &Config, logs: &LogShipper, shutdown: &CancellationToken) -> anyhow::Result<()>;

/// Writes `settings` and `keymap` **verbatim** – they are JSONC TEXT carried as JSON strings (`serde_json::Value::String`, D18; b9 §7 item 7b) – to
/// `~/.config/zed/{settings.json,keymap.json}` (atomic rename) so the server's settings observer sees them before the first client connects.
/// The control plane's copy is authoritative (the shell saves edits there through `saveDocument`, b9 §4.6), so the file is rewritten whenever its
/// sha256 differs from `markers.settings_written(kind)`; a file the supervisor never wrote (first boot after a tarball restore) is replaced too.
/// Runs after `restore_tarball` (which may bring an older `vercel/.config/zed`).
pub fn write_settings(docs: &SettingsDocs, home: &Path, markers: &Markers) -> std::io::Result<()>;

/// Writes each `manifest.jwt.publicKeys[i]` to `<jwt_dir>/key-<i>.pem` (0600), removes stale files, returns the paths in order (active key first, b9 §3.11 rotation).
pub fn write_jwt_keys(pems: &[String], jwt_dir: &Path) -> std::io::Result<Vec<PathBuf>>;

/// Extension install hand-off (BUILD-SPEC §9, D5): `manifest.extensions ∪ devcontainer.customizations.zed.extensions`, deduplicated, ids validated
/// (`^[a-z0-9][a-z0-9_-]{0,63}$`, b9 §4.2), posted to the server with `ServerControl::post_extensions` once the server is healthy (§3.16 step 5); the
/// server skips ids already on disk (b4 §4.2). Replaces the draft's `remote_extensions/pending.json`, which nothing reads.
pub fn extension_install_list(manifest: &Manifest, devcontainer: Option<&DevcontainerConfig>) -> Vec<String>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandSpec { pub argv: Vec<String>, pub shell: bool, pub label: String }
/// string → `["bash","-lc",s]` shell=true; array → argv; object → one spec per entry (run in parallel by `run_lifecycle`).
pub fn lifecycle_specs(command: &LifecycleCommand, label: &str) -> Vec<CommandSpec>;
/// Runs specs (parallel for object form) in their own process group, cwd = workspace dir, env = process env ∪ manifest.env (filtered) ∪ remoteEnv ∪
/// { ZS_SUPERVISOR_URL, ZS_CONTROL_SECRET_FILE, SHELL, USER } minus stripped vars; stdout/stderr lines → `logs` with `source`; sets
/// `state.busy` for the duration; non-zero exit → `Err` with the exit code; timeout or `shutdown` → `killpg(SIGKILL)` and `Err`.
pub async fn run_lifecycle(specs: Vec<CommandSpec>, cwd: &Path, env: &BTreeMap<String, String>, timeout: Duration, source: LogSource, logs: &LogShipper, state: &AgentState, shutdown: &CancellationToken) -> anyhow::Result<()>;
```

### 3.15 `sandbox/supervisor/src/activity.rs` (new)

The control plane decides the deadlines (b9 §3.25: `idleStopAt = max(lastInputAt, keepaliveAt, sessionStartedAt) + idleMinutes`, `sessionCapAt`, `stop`) and hands them to the supervisor on every ping as an `ActivityDirective`; the supervisor turns them into b4's lifecycle notices locally (BUILD-SPEC 5.5: `IDLE_STOP_IN` 5 min before, `SESSION_CAP_IN` 30 min before) and reports what D13 needs (`lastInputAt`, `busy`, `phase`, `cpuBusyPct`). There is no notice queue on the control plane (b9 §3.7).

```rust
pub const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(30);   // manifest.activity.intervalSecs wins (≥ 10 s; b9 rate-limits at 10/min)
pub const IDLE_NOTICE_LEAD: Duration = Duration::from_secs(5 * 60);    // BUILD-SPEC 7.5
pub const CAP_NOTICE_LEAD: Duration = Duration::from_secs(30 * 60);    // BUILD-SPEC 7.5 (23.5 h of 24 h)

pub struct ActivityRelay { control: ControlPlane, server: ServerControl, state: Arc<AgentState>, forwards: ForwardsState, listening: ListeningState, config: Arc<Config>, manifest: Arc<Manifest>, interval: Duration, shutdown: CancellationToken, post_attach: Option<Vec<CommandSpec>>, cpu: CpuSampler }

/// `/proc/stat` sampler for D13/D18 `cpuBusyPct`: keeps the previous `(busy, total)` jiffies; `sample()` returns
/// `100 · (1 − Δ(idle+iowait)/Δtotal)` clamped to 0..=100, `None` on the first call or when `/proc/stat` is unreadable (never fails the ping).
#[derive(Default)] pub struct CpuSampler { prev: Option<(u64, u64)> }
impl CpuSampler { pub fn sample(&mut self) -> Option<f32>; pub fn parse_stat_line(line: &str) -> Option<(u64 /* busy */, u64 /* total */)>; }

/// Pure notice policy, unit-tested:
///   * `IDLE_STOP_IN { seconds }` once per distinct `idle_stop_at` value when `idle_stop_at - now <= IDLE_NOTICE_LEAD` (a later deadline –
///     activity or keepalive – that crosses the lead again produces a new notice); `SESSION_CAP_IN` likewise with CAP_NOTICE_LEAD;
///   * `stop: true` → `stop_requested()` becomes true once (the caller runs the same shutdown path as SIGTERM – b9's backstop when its SIGTERM is lost);
///     the policy never emits a `Stopping` body itself: the supervisor's stop path posts `{"kind":"stopping"}` exactly once (§3.9), so the
///     client flushes once;
///   * `Resumed` is not the policy's job: §3.16 step 5 posts it right after the server is healthy on a resumed boot, and b4's control channel holds
///     it (`pending_resumed`) until a session attaches and replays it once (b4 §3.10), which is why the draft's held-notice logic is gone.
#[derive(Default, Debug)]
pub struct NoticePolicy { idle_notified_for: Option<u64>, cap_notified_for: Option<u64>, stop_seen: bool }
impl NoticePolicy { pub fn accept(&mut self, directive: &ActivityDirective, now_ms: u64) -> Vec<LifecycleBody>; pub fn stop_requested(&self) -> bool; }

impl ActivityRelay {
    /// Started right after the manifest (before restore/clone), so the control plane sees pings during bootstrap. Every `interval`:
    ///   1. if the server is running: `server.health()` → `state.server_health`; on the first `session_active == true` this boot:
    ///      `session_seen = true`, run `postAttachCommand` once (POST_ATTACH_TIMEOUT, non-fatal);
    ///   2. build `ActivityReport { last_input_at: if busy || phase != Ready { Some(now) } else { health.last_input_at }, session_active,
    ///      sid: health.session.session_id (b2 §3.7 `SessionMeta.session_id`, the JWT `sid`), server_uptime_secs, agent_uptime_secs, status, cpu_busy_pct: cpu.sample(), busy, phase, listening }`
    ///      – `busy`/`phase` are what D13 makes the control plane honour ("no idle stop while bootstrapping"); `last_input_at = now` while busy
    ///      stays as belt-and-braces until b9's directive honours them (§7 item 4);
    ///   3. POST; on success: `forwards.replace(d.forwards)` when present, `policy.accept(&d, now)` → `post_lifecycle` each; `policy.stop_requested()`
    ///      → fire `shutdown` (once, logged `stop_directive`); 401 → degraded (once); 410 → stop the loop; other errors → log and keep the interval.
    pub async fn run(self);
}
```

### 3.16 `sandbox/supervisor/src/start.rs` (new)

Orchestration for `start` (create **and** resume – b9 runs `zs-agent start` at create and `zs-agent resume` from `onResume`, b9 §3.18 `startSupervisor(mode)`; `resume` is `start --resumed`) and `prebuild`.

```rust
#[derive(clap::Args, Debug, Clone, Default)]
pub struct StartArgs {
    /// Do not launch the server (image smoke tests).
    #[arg(long, hide = true)] pub no_server: bool,
    /// This boot resumes a stopped sandbox (`zs-agent resume`; b9 onResume). A hint only – the first-boot marker decides.
    #[arg(long)] pub resumed: bool,
}
pub async fn run(args: StartArgs, config: Config) -> anyhow::Result<()>;
pub async fn run_prebuild(config: Config) -> anyhow::Result<()>;
```

`start` sequence (each step sets `Phase`; failures set `last_error` and `degraded` and continue where noted). The server starts as soon as the repository exists – b9 accepts `ready|degraded` with `serverRunning` and waits up to 35 min on create / 3 min on resume (b9 §4.8) – and dotfiles/postCreate/postStart run **beside** the running server, as Codespaces does:

1. Refuse to run if `ZS_PREBUILD=1` (exit 2). Write `pid_file`; clear `run_dir`; `Supervisor::generate_control_secret` → `write_control_secret` (run/control.secret); install `SIGTERM`/`SIGINT` handlers (`tokio::signal::unix`) → `shutdown` token. `resumed = markers.first_boot_done()` (logged against `args.resumed` and, later, `manifest.session.resumed`; the marker wins). Start the `api` listeners (8445 + 8450) and the `LogShipper` **now**, so `GET /health` answers `503 {status: booting, phase: manifest}` from the first second and the credential helper works during clone.
2. `Phase::Manifest`: `ControlPlane::manifest()` (fatal after retries: `lastError = "manifest: <reason>"`, keep the health listener up for 60 s so b9's probe can read it, then exit 3); `validate`; `manifest.build != config.build_id` → log `build_mismatch`, `degraded`. `logs.configure(..)`; `write_jwt_keys`; `forwards.replace(manifest.forwards)`; start the `ActivityRelay`.
3. `Phase::Restore` / `Phase::Clone`: `materialize_repo` (tarball restore for rebuilds, D9; fatal: exit 4; cancelled by SIGTERM → exit 0 after cleanup). `write_settings` (after the restore so the control plane's copy wins). `DevcontainerConfig::load` (also yields the hash).
4. `Phase::ServerStarting`: `Supervisor::clear_stale_server`, `Supervisor::run` (spawned), `wait_for_server(60 s)` (failure → `degraded`, `lastError = "server_not_ready"`, continue: the supervisor keeps retrying with backoff); `proxy::run_all` (four slots; spawned); `ports::watch` (spawned). `status = ready` (or stays `degraded`).
5. Right after the server is healthy: `server.post_extensions(extension_install_list(..))` (D5; non-fatal, retried once after 30 s); if `resumed`: `server.post_lifecycle(Resumed)` (b4 holds it until the client attaches).
6. Lifecycle, in a spawned task with `busy = true`: `Phase::Dotfiles` → `install_dotfiles` when `dotfiles` is set and the marker differs (non-fatal); `Phase::PostCreate` → if `needs_post_create(hash)` run `postCreateCommand` then marker (non-fatal, `degraded` on failure); `Phase::PostStart` → `postStartCommand` every boot (non-fatal); for `devcontainer.forward_ports` not in `forwards`, request forwards from the control plane with `portsAttributes` label/visibility (private default; a refused private forward – no free slot – is logged, not fatal); `set_first_boot_done`; `Phase::Ready`, `busy = false`.
7. `postAttachCommand` runs from the activity relay on first attach (§3.15).
8. Wait for `shutdown` (SIGTERM from b9's `stepSignalSupervisor`, or the directive's `stop: true`): `status = stopping` → cancel the lifecycle task (kills its process group) → `supervisor.stop_child()` (≤ ≈ 18 s: POST stopping ≤ 7 s → SIGTERM → ≤ 10 s → SIGKILL group) → cancel the remaining tasks → `logs.flush(3 s)` → remove pid file and `run/control.secret` → exit 0. Worst case ≈ 21 s, inside b9's `stepWaitForCommandExit(25 s)` (b9 §4.8); the common case (client flushes in < 1 s, server exits on SIGTERM in < 1 s) is ≈ 2 s.

`zs-agent resume` is `start --resumed` (what b9's `onResume` runs); nothing else distinguishes the two.

`prebuild` sequence (b9 §4.8 `prebuild`: sandbox created with `ports: [8443, 8445]`, `ZS_PREBUILD=1`, a `pb-` principal whose manifest carries `prebuild: { id, branch, commit }` and `repo.revision = commit`; b9 waits ≤ 50 min for exit 0, then `snapshot({ expiration: 0 })`): requires `ZS_PREBUILD=1`; steps 1-3 as above (no dotfiles: they are per user, not per branch; no activity relay – `idleStopAt` is null for prebuilds and nothing needs the pings; the log shipper runs); `Phase::ServerStarting`: start the server with the manifest keys **plus** the ephemeral warm-up public key (§3.16a) – `init_paths` creates the data dir tree inside the snapshot; `post_extensions` (b4 §3.15 item 7: the extensions land in the snapshot); `Phase::PostCreate`: `postCreateCommand` with marker; `Phase::Warm` (D14): `warm::run` (§3.16a) with the remaining budget (`WARM_BUDGET = min(15 min, 48 min − elapsed)`), then the optional `ZS_PREBUILD_WARM_CMD` (a shell command from the environment, e.g. `npm ci`/`cargo fetch`; empty by default) with what is left; `stop_child` (the LSP downloads and the extensions are on disk; the warm-up client sent no `SaveClientState`, so `server_state/client_state/` stays empty – b4 §3.15 item 7); `logs.flush`; delete the warm-up key files; exit 0 (non-zero on manifest/clone/postCreate failure; warm-up failures are logged and do not fail the prebuild).

### 3.16a `sandbox/supervisor/src/warm.rs` (new; D14)

The headless language-server warm-up BUILD-SPEC 6.4 asks for, without a Zed client: `zs-agent` speaks b1's wire protocol (§2, b1 §4.2) to the server it just started, adds the workspace as a worktree and opens one buffer per detected language, which makes the headless `LspStore` start – and, for adapters without `check_if_user_installed`, download into `languages_dir()` – every language server (`headless_project.rs:582-610` → `lsp_store.rs:4815-4841`). Everything it fetches lands in the snapshot.

```rust
pub const WARM_BUDGET_MAX: Duration = Duration::from_secs(15 * 60);
pub const WARM_SETTLE: Duration = Duration::from_secs(20);         // no UpdateLanguageServer/LanguageServerLog traffic for this long ⇒ done
pub const WARM_MAX_FILES: usize = 24;                               // one per language, plus a second file for TS/JS (tsserver + eslint)
pub const WARM_HEARTBEAT: Duration = Duration::from_secs(5);        // b1/D3: client → server `{"type":"heartbeat"}` every 5 s

/// Language probe table: extension → priority. Picks the first existing file per language walking the checkout (skipping `.git`, `node_modules`,
/// `target`, `vendor`, `dist`, `build`, depth ≤ 6): `rs, go, py, ts, tsx, js, jsx, json, css, html, yaml, yml, sh, bash, c, cc, cpp, h, toml, lua, Dockerfile, md`.
pub fn pick_probe_files(root: &Path) -> Vec<PathBuf>;   // repo-relative

pub struct WarmKey { pub private_pem: SecretString, pub public_pem: String }
/// Ephemeral P-256 key pair for the prebuild boot: `p256::SecretKey::random` → PKCS#8 / SPKI PEM (`jsonwebtoken` `rust_crypto`, `Es256Signer`).
/// The public PEM is written as `<jwt_dir>/key-warm.pem` and passed as an extra `--jwt-public-key`; the private key never touches disk; both are gone after the prebuild.
pub fn generate_warm_key() -> anyhow::Result<WarmKey>;
/// ES256 JWT with b2's claim set: `iss = manifest.jwt.issuer`, `aud = manifest.jwt.audience`, `sub = "zs-agent-warm"`, `ws = workspace_id`, `sid = "warm-<jti>"`, `iat`, `exp = iat + 900`, `jti`.
pub fn mint_warm_token(key: &WarmKey, manifest: &Manifest, now: u64) -> anyhow::Result<String>;

pub struct WarmOutcome { pub servers_seen: BTreeSet<String>, pub files_opened: usize, pub elapsed: Duration, pub settled: bool }

/// 1. `tokio::net::TcpStream::connect(127.0.0.1:8443)` → `tokio_tungstenite::client_async(request, stream)` with a hand-built
///    `http::Request` for `ws://127.0.0.1:8443/rpc` carrying `Sec-WebSocket-Protocol: zs.v1, <token>` (b1 §4.3; the token is an RFC 2616
///    token, b1 `validate_subprotocol_token`); assert the 101 echoes `zs.v1`.
/// 2. Send text `{"type":"hello","protocol":1,"build":<ZS_BUILD_ID>,"workspace_id":..,"session_id":<sid>,"identifier":"zs-agent-warm/<nonce>",
///    "reconnect":false,"takeover":false,"client":"desktop","epoch":null}`; expect text `{"type":"hello_ack",..,"resumed":false}`; then the first
///    binary envelope must be `RemoteStarted` (b2 §3.7). Spawn the heartbeat task (`{"type":"heartbeat"}` every WARM_HEARTBEAT).
/// 3. Request/response over binary frames (`u32 LE len || prost(Envelope)`, ids from 1, `responding_to` matched): `AddWorktree { path: workspace_dir,
///    project_id: 0, visible: true }` → `AddWorktreeResponse.worktree_id`; then for each probe file `OpenBufferByPath { project_id: 0, worktree_id, path }`
///    → `OpenBufferResponse` (an `Error` response is logged and skipped). `Ping`/`Ack` and unknown envelopes are ignored; `FlushBufferedMessages` is answered with `Ack`.
/// 4. Observe: every `UpdateLanguageServer` (`server_name`, variant) and `LanguageServerLog` resets the settle timer and records the server name;
///    done when WARM_SETTLE passes with no LSP traffic after the last open, or the budget expires (`settled = false`).
/// 5. Close 1000 (the server treats a client close as a detach; the supervisor's `stop_child` follows). Never sends `SaveClientState` or any other
///    persistence message (b4 §3.15 item 7).
pub async fn run(config: &Config, manifest: &Manifest, key: &WarmKey, budget: Duration, logs: &LogShipper, state: &AgentState, shutdown: &CancellationToken) -> anyhow::Result<WarmOutcome>;
```

`zs-agent warm` (hidden subcommand, §3.17) runs the same routine against an already running server for the integration test and for operators; it takes `--private-key`/`--audience`/`--issuer`/`--workspace-id`/`--workspace-root` explicitly and needs no manifest.

### 3.17 `sandbox/supervisor/src/main.rs` (new)

```rust
#[derive(clap::Parser)]
#[command(name = "zs-agent", version = env!("CARGO_PKG_VERSION"), disable_help_subcommand = true)]
struct Cli { #[command(subcommand)] command: Command }

#[derive(clap::Subcommand)]
enum Command {
    /// Boot the workspace and supervise zed-remote-server (create and resume).
    Start(start::StartArgs),
    /// `start --resumed` (what b9's onResume runs).
    Resume,
    /// Prebuild boot: clone, postCreate, LSP warm-up, exit 0 (requires ZS_PREBUILD=1; D14).
    Prebuild,
    /// git credential helper (`credential.helper = !zs-agent credential`).
    Credential { operation: String, #[arg(long, env = "ZS_SUPERVISOR_URL", default_value = "http://127.0.0.1:8450")] supervisor_url: String, #[arg(long, env = "ZS_CONTROL_SECRET_FILE")] control_secret_file: Option<PathBuf> },
    /// Run only the private-port auth proxy slots (tests / manual).
    Proxy(ProxyArgs),
    /// Send SIGTERM to the running agent (pid file) and wait for it to exit.
    Stop { #[arg(long, default_value = "30")] timeout_secs: u64 },
    /// Poll :8445/health until status ready|degraded and phase ready (exit 0) or timeout (exit 1).
    WaitReady { #[arg(long, default_value = "120")] timeout_secs: u64, #[arg(long)] allow_degraded: bool },
    /// Mint a port bootstrap token (HMAC `v1.` format, §3.10) for tests / local runs.
    #[command(hide = true)]
    PortToken { #[arg(long, conflicts_with = "secret_file")] secret_b64: Option<String>, #[arg(long)] secret_file: Option<PathBuf>, #[arg(long)] workspace_id: String, #[arg(long)] port: u16, #[arg(long, default_value = "3600")] ttl_secs: u64, #[arg(long, default_value = "local")] sub: String },
    /// Run the LSP warm-up client against a running server (§3.16a; tests / operators).
    #[command(hide = true)]
    Warm(WarmArgs),
    /// Print build id and the server binary's `version` output.
    Version,
}

#[derive(clap::Args, Debug, Clone)]
pub struct ProxyArgs {
    #[arg(long, default_value = "0.0.0.0")] pub bind_ip: IpAddr,        // slots are fixed: 8444, 8447, 8448, 8449
    #[arg(long)] pub slot: Vec<u16>,                                    // subset of PROXY_SLOTS to run (default: all)
    #[arg(long, required = true)] pub secret_file: PathBuf,             // base64 portSessionSecret (bootstrap key)
    #[arg(long)] pub workspace_id: String,
    #[arg(long)] pub bind: Vec<String>,                                 // "<slot>=<port>" initial bindings (tests)
    #[arg(long)] pub insecure_cookies: bool,
}
#[derive(clap::Args, Debug, Clone)]
pub struct WarmArgs { #[arg(long)] pub private_key: PathBuf, #[arg(long)] pub workspace_id: String, #[arg(long)] pub audience: String, #[arg(long, default_value = "zs")] pub issuer: String, #[arg(long)] pub workspace_root: PathBuf, #[arg(long, default_value = "http://127.0.0.1:8443")] pub server_url: String, #[arg(long, default_value = "300")] pub budget_secs: u64 }

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::process::ExitCode;
```

Exit codes: 0 ok, 1 generic, 2 config error (incl. `start` under `ZS_PREBUILD=1`), 3 manifest unavailable, 4 repo materialisation failed. `Credential`, `PortToken`, `Proxy` and `Warm` do not read `Config` (they must work without `ZS_SANDBOX_TOKEN`).

### 3.18 `sandbox/supervisor/tests/proxy_roundtrip.rs`, `tests/api.rs`, `tests/port_watcher_live.rs`, `tests/start_against_fake_server.rs`, `tests/warm_against_serve.rs`, `tests/proto_tags.rs` (new) – see §6.

### 3.19 `sandbox/image/Dockerfile` (new)

```dockerfile
# syntax=docker/dockerfile:1.7
# BASE_IMAGE is passed by build.sh from sandbox/image/base.lock (a digest-pinned ref, BUILD-SPEC 10 item 6); the default is only for `docker build` by hand.
ARG BASE_IMAGE=vcr.vercel.com/vercel/sandbox/universal:latest
ARG RUST_TOOLCHAIN=1.97.1

# ---- zs-agent (static musl) --------------------------------------------------
FROM rust:${RUST_TOOLCHAIN}-bookworm AS agent-builder
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /src
COPY sandbox/supervisor/ ./
ENV CC_x86_64_unknown_linux_musl=musl-gcc RUSTFLAGS="-C target-feature=+crt-static"
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --target x86_64-unknown-linux-musl \
 && install -m 0755 target/x86_64-unknown-linux-musl/release/zs-agent /out-zs-agent

# ---- zed-remote-server: from build context (default) or the public release ---
FROM ubuntu:26.04 AS server-fetch
ARG ZED_SERVER_SOURCE=context          # context | release
ARG ZED_SERVER_VERSION=1.19.0          # only for release; the release binary lacks `serve` and is for image v0 smoke tests
ARG ZED_RELEASE_CHANNEL=stable
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY sandbox/image/dist/ /dist/
RUN set -eu; \
    if [ "$ZED_SERVER_SOURCE" = "context" ]; then \
      test -f /dist/zed-remote-server || { echo "sandbox/image/dist/zed-remote-server missing (build it with sandbox/image/build-server.sh)"; exit 1; }; \
      install -m 0755 /dist/zed-remote-server /out-zed-remote-server; \
    else \
      curl -fsSL "https://cloud.zed.dev/releases/${ZED_RELEASE_CHANNEL}/${ZED_SERVER_VERSION}/download?asset=zed-remote-server&os=linux&arch=x86_64" \
        | gunzip > /out-zed-remote-server && chmod 0755 /out-zed-remote-server; \
    fi

# ---- workspace image ----------------------------------------------------------
FROM ${BASE_IMAGE}
ARG ZS_BUILD_ID
ARG RUST_TOOLCHAIN
ARG GO_VERSION=1.25.1
ARG GOPLS_VERSION=v0.20.0
ARG TAPLO_VERSION=0.10.0
ARG LUA_LS_VERSION=3.15.0
ARG RUFF_VERSION=0.13.1
ARG NPM_LS_PACKAGES="typescript@5 typescript-language-server@4 @vtsls/language-server@0.2 pyright@1.1 vscode-langservers-extracted@4 bash-language-server@5 yaml-language-server@1 dockerfile-language-server-nodejs@0.14 prettier@3 eslint@9 @google/gemini-cli"
USER root
# The base persists ENV HOME=/vercel and /vercel/.npmrc (prefix ~/.global/npm); Docker's USER does not touch HOME, so pin it for the root steps.
ENV HOME=/root
# Build-only settings as ARGs: visible to RUN in this stage, not persisted into the image config (no need to unset them later).
ARG DEBIAN_FRONTEND=noninteractive
ARG NPM_CONFIG_PREFIX=/usr/local
ARG GOCACHE=/tmp/go-cache
ARG GOPATH=/tmp/go
# 1. toolchains, split by family so no single layer approaches VCR's 500 MB compressed limit (build.sh asserts)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang clangd lld pkg-config cmake gdb shellcheck unzip zstd \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jdk-headless && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends ruby-full php-cli php-xml composer && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends docker.io docker-buildx docker-compose-v2 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:/usr/local/go/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain ${RUST_TOOLCHAIN} \
      --component rust-analyzer,clippy,rustfmt,rust-src \
 && chmod -R a+rwX /usr/local/rustup /usr/local/cargo
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -xz -C /usr/local
# 2. language servers (changes weekly). npm globals go to /usr/local (NPM_CONFIG_PREFIX), not the base's /vercel/.global/npm.
RUN GOBIN=/usr/local/bin GOFLAGS=-mod=mod go install golang.org/x/tools/gopls@${GOPLS_VERSION} && rm -rf /tmp/go /tmp/go-cache
RUN npm install -g --no-fund --no-audit ${NPM_LS_PACKAGES} && npm cache clean --force && rm -rf /root/.npm
RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install ruff==${RUFF_VERSION} && chmod -R a+rX /opt/uv-tools
RUN curl -fsSL "https://github.com/tamasfe/taplo/releases/download/${TAPLO_VERSION}/taplo-linux-x86_64.gz" | gunzip > /usr/local/bin/taplo && chmod 0755 /usr/local/bin/taplo
RUN mkdir -p /opt/lua-language-server \
 && curl -fsSL "https://github.com/LuaLS/lua-language-server/releases/download/${LUA_LS_VERSION}/lua-language-server-${LUA_LS_VERSION}-linux-x64.tar.gz" | tar -xz -C /opt/lua-language-server \
 && printf '#!/bin/sh\nexec /opt/lua-language-server/bin/lua-language-server "$@"\n' > /usr/local/bin/lua-language-server && chmod 0755 /usr/local/bin/lua-language-server
# 3. agents: claude-code, codex, opencode, pi come from the base; gemini-cli added above via NPM_LS_PACKAGES
# 4. zed-remote-server + zs-agent (changes per build)
COPY --from=server-fetch /out-zed-remote-server /usr/local/bin/zed-remote-server
COPY --from=agent-builder /out-zs-agent /usr/local/bin/zs-agent
# 5. users, paths, git. Nothing above wrote under /vercel; assert it and hand the tree back to ubuntu anyway.
RUN mkdir -p /workspaces && chown ubuntu:ubuntu /workspaces \
 && chown -R ubuntu:ubuntu /vercel \
 && git config --system credential.helper '!zs-agent credential' \
 && git config --system credential.useHttpPath true \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main
ENV HOME=/vercel \
    SHELL=/bin/bash \
    ZS_BUILD_ID=${ZS_BUILD_ID} \
    ZS_WORKSPACES_DIR=/workspaces \
    ZS_SERVER_BIN=/usr/local/bin/zed-remote-server \
    ZS_SUPERVISOR_URL=http://127.0.0.1:8450 \
    ZS_CONTROL_SECRET_FILE=/vercel/.zs/run/control.secret
USER ubuntu
WORKDIR /workspaces
# Vercel does not run ENTRYPOINT/CMD; CMD exists only for `docker run` in sandbox/image/test/run-local.sh
CMD ["/usr/local/bin/zs-agent", "start"]
```

Notes on the file: `RUST_TOOLCHAIN` is redeclared before `FROM` use per Docker ARG scoping; `ZS_BUILD_ID` is mandatory (`build.sh` fails without it). `NPM_CONFIG_PREFIX`, `GOCACHE`, `GOPATH` and `DEBIAN_FRONTEND` are stage `ARG`s so they steer only the root build steps and never reach users' environments (`run-local.sh` step (10) asserts `npm i -g` and `go` work as `ubuntu` with the base's own npm prefix). `SHELL=/bin/bash` answers b3 §7.10 for every process in the image; the supervisor additionally exports it (with `USER`) to the server when missing. **No corepack step**: the base already ships pnpm 11 on PATH, corepack is being removed from Node (25+), and a root-run `corepack enable` would shadow the base's pnpm with a second copy. `docker.io` installs `dockerd` but nothing starts it; users run `sudo dockerd &` or the devcontainer feature `docker-in-docker` (builder work, b10). The `agent-builder` stage needs nothing from `zed/` because the warm-up client's schema is vendored (§3.2a).

Cuts from BUILD-SPEC 6.1, each deliberate: **.NET** (no `dotnet-sdk` package verified for Ubuntu 26.04; ~1 GB; follow-up via Microsoft's apt feed); **Node LTS matrix** (one Node, the base's 24; `fnm`/`nvm` can be installed by dotfiles); **jdtls, omnisharp, solargraph, intelephense** (their Zed adapters are extensions that install into the data dir on demand; adding them is a version-pinned follow-up once the extension `which` names are confirmed, §7 item 6). `prettier` and `eslint` **are** installed (npm list) – useful to users' tooling even though Zed's ESLint adapter installs its own copy (§7 item 7; the prebuild warm-up seeds that copy into the snapshot).

### 3.20 `sandbox/image/build-server.sh` (new)

Builds `zed-remote-server` from the fork with Zed's own musl recipe (`zed/script/bundle-linux:86-94, 128`), outputs `sandbox/image/dist/zed-remote-server`.

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
test -d "$root/zed/.git" || { echo "zed/ checkout missing at $root/zed (nested repo today, submodule later – see §3.25)" >&2; exit 1; }
build_id="${ZS_BUILD_ID:?ZS_BUILD_ID required (e.g. $(git -C "$root/zed" rev-parse --short HEAD)-1)}"
export ZED_BUILD_ID="$build_id" ZED_COMMIT_SHA="$(git -C "$root/zed" rev-parse HEAD)"
export ZS_BUILD_ID="$build_id"           # b2 §3.13: remote_server/build.rs turns ZS_BUILD_ID into the serve build id (rerun-if-env-changed)
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+crt-static" CC_x86_64_unknown_linux_musl=musl-gcc
(cd "$root/zed" && cargo --config .cargo/bundle-config.toml build --release --target x86_64-unknown-linux-musl --package remote_server --features serve)
bin="$root/zed/target/x86_64-unknown-linux-musl/release/remote_server"
llvm-objcopy --strip-debug "$bin"          # bundle-linux:128; release profile is debug="limited" without strip
mkdir -p "$here/dist"
install -m 0755 "$bin" "$here/dist/zed-remote-server"
if ldd "$here/dist/zed-remote-server" 2>/dev/null | grep -q 'libcrypto\|libssl'; then echo "remote_server links libssl" >&2; exit 1; fi
"$here/dist/zed-remote-server" version
du -h "$here/dist/zed-remote-server"
```

(`--features serve`: b2 puts the subcommand behind a `serve` cargo feature, b1 §2 row for `server.rs:63-83`; harmless if b2 makes it default.)

### 3.21 `sandbox/image/build.sh` and `sandbox/image/base.lock` (new)

`base.lock` is one line, `vcr.vercel.com/vercel/sandbox/universal@sha256:<digest>`, refreshed by `build.sh --update-base` (`docker buildx imagetools inspect vcr.vercel.com/vercel/sandbox/universal:latest --format '{{json .Manifest.Digest}}'`) and committed, so every image build starts from a pinned base (BUILD-SPEC 10 item 6).

```bash
#!/usr/bin/env bash
# Usage: ZS_BUILD_ID=<zed-commit>-<n> sandbox/image/build.sh [--push] [--source context|release] [--tag zs-workspace:<id>] [--update-base]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
build_id="${ZS_BUILD_ID:?}"; push=""; source="context"; tag="zs-workspace:${build_id}"; update_base=""
while [ $# -gt 0 ]; do case "$1" in --push) push=1;; --source) source="$2"; shift;; --tag) tag="$2"; shift;; --update-base) update_base=1;; esac; shift; done
mkdir -p "$here/dist"   # the Dockerfile COPYs sandbox/image/dist/ even in --source release mode
need_login() { [ -n "$push" ] || grep -q '^vcr.vercel.com/' "$here/base.lock"; }
if need_login; then vercel vcr login docker; fi   # OIDC, 12 h; needed to PULL the universal base too, not only to push (VCR docs: pulls happen "after authenticating as their own team")
if [ -n "$update_base" ]; then
  d="$(docker buildx imagetools inspect vcr.vercel.com/vercel/sandbox/universal:latest --format '{{json .Manifest.Digest}}' | tr -d '"')"
  echo "vcr.vercel.com/vercel/sandbox/universal@${d}" > "$here/base.lock"
fi
base="$(cat "$here/base.lock")"
if [ -n "$push" ]; then
  registry="vcr.vercel.com/${VERCEL_TEAM_SLUG:?}/${VERCEL_PROJECT_SLUG:?}"
  full="${registry}/${tag}"; output=(--push)
else
  full="$tag"; output=(--load)
fi
docker buildx build --platform linux/amd64 -f "$here/Dockerfile" \
  --build-arg BASE_IMAGE="$base" --build-arg ZS_BUILD_ID="$build_id" --build-arg ZED_SERVER_SOURCE="$source" \
  --provenance=false --sbom=false \
  "${output[@]}" -t "$full" "$root"
# layer-size guard (VCR: 500 MB per compressed layer; uncompressed 900 MB is a conservative proxy)
if [ -z "$push" ]; then
  docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' "$full" | awk -F'\t' '{ s=$1; n=s+0; if (s ~ /GB/) n=n*1024; if (s ~ /MB/ && n>900) { print "layer over 900MB: " $0; bad=1 } if (s ~ /GB/) { print "layer over 900MB: " $0; bad=1 } } END { exit bad }'
fi
if [ -n "$push" ]; then
  digest="$(docker buildx imagetools inspect "$full" --format '{{json .Manifest.Digest}}' | tr -d '"')"
  printf '{"tag":"%s","digest":"%s","build":"%s","base":"%s"}\n' "$full" "$digest" "$build_id" "$base" > "$here/dist/image.json"
  # wait for VCR to prepare the linux/amd64 snapshot (Sandbox.create returns image_not_ready until then).
  # `vercel vcr image ls --format json` is documented; its field names are not – the jq below assumes the REST shape
  # (images[].manifestDigest / images[].status ∈ preparing|ready|unoptimized|null). `status` is null for a multi-platform
  # index, which is why --provenance=false --sbom=false --platform linux/amd64 above are load-bearing.
  status=""
  for _ in $(seq 1 120); do
    json="$(vercel vcr image ls "${tag%%:*}" --format json 2>/dev/null || true)"
    status="$(printf '%s' "$json" | jq -r --arg d "$digest" '(.images // .)[]? | select(.manifestDigest==$d or .digest==$d) | .status' | head -1)"
    [ "$status" = "ready" ] && break; sleep 10
  done
  [ "$status" = "ready" ] || { echo "image not ready after 20 min (status='$status'); raw: $(printf '%s' "$json" | head -c 400)" >&2; exit 1; }
fi
```

The build context is the repo root so `sandbox/supervisor` and `sandbox/image/dist` are both reachable; `zed/` must be excluded: add `/Users/ray/Projects/play/wed/.dockerignore` containing `zed/`, `apps/`, `**/target`, `**/node_modules`, `.git`. The `vercel vcr build docker . -- --build-arg …` form (documented pass-through) is an equivalent fallback if plain `docker buildx build` cannot pull the base after login.

### 3.22 `sandbox/image/test/mock-control-plane.mjs` (new; Node ≥ 20, no dependencies)

```js
// Usage: node mock-control-plane.mjs --port 9977 --repo /abs/path/to/fixture.git --workspace-dir /workspaces/fixture --pubkey <spki pem> --port-secret <base64 32 bytes> [--token test-token] [--log-out logs.jsonl] [--restore-tarball path.tgz]
// Routes (all under /api, bearer must equal --token; `x-vercel-protection-bypass` recorded when present):
//   GET  /sandboxes/:name/manifest        → SandboxManifest (§4.1 / docs/contracts fixture) with repo.cloneUrl = "file://<repo>" (or --clone-url), jwt.publicKeys=[pem], portSessionSecret=<--port-secret>, restore = { tarballUrl: "http://host:port/__blob/restore.tgz", sha256 } when --restore-tarball is given (else null)
//   POST /sandboxes/:name/git-token       → { username: "x-access-token", token: "ghs_mock", expiresAt: Math.floor(now/1000)+3600 }; 404 host_unsupported unless host == github.com; 403 repo_not_allowed when path is set and does not name the fixture
//   POST /sandboxes/:name/ports           → { url, visibility, slot? }: private → url "http://localhost:9977/api/workspaces/ws_local/ports/<port>/open" and the lowest free slot of [8444,8447,8448,8449] (409 slots_exhausted when none); public → "http://localhost:<port>"; forwards kept in memory
//   DELETE /sandboxes/:name/ports/:port   → 204
//   POST /sandboxes/:name/activity        → ActivityDirective { idleStopAt: now+30min (or --idle-stop-at override), sessionCapAt: now+24h, stop: <flag>, forwards: [...] }; body recorded
//   POST /sandboxes/:name/logs            → 204; entries appended to --log-out (413 when > 262144 bytes)
//   POST /sandboxes/:name/client-errors   → 202; recorded
//   POST /sandboxes/:name/extensions      → 204; recorded
//   GET  /__blob/restore.tgz              → streams --restore-tarball WITHOUT requiring a bearer (asserts no Authorization/x-vercel-protection-bypass header arrives: 400 if one does)
//   GET  /api/workspaces/:id/ports/:port/open → 303 to http://localhost:<slot>/__zs/auth?zs_port_token=<signPortSession(secret, {ws, port, sub:"user_test", iat, exp:+3600, jti})>&next=/
//   GET  /__test/state                    → { requests: [...method, path, body summaries], forwards, pings: [...], extensions, clientErrors }
//   POST /__test/directive { idleStopAt?, sessionCapAt?, stop? } → overrides for the next activity responses
```

Implemented with `node:http` and `node:crypto` (`signPortSession` is a 6-line port of b9 `lib/port-session.ts`); records every request for `run-local.sh` assertions.

### 3.23 `sandbox/image/test/fake-zed-remote-server.py` (new)

A 90-line stand-in for `zed-remote-server serve` used by the Rust integration test and by `run-local.sh --fake-server`: parses the b2 `ServeArgs` (including `--control-secret-file`, `--control-listen`, `--supervisor-url`, `--allowed-origin`), binds `--listen` **and** `--control-listen`, writes `--port-file`, prints `ZS_LISTENING=` and `ZS_CONTROL_LISTENING=` on stdout, serves `GET /health` on the public listener (b2 `HealthResponse` shape with `session_active` toggling to `true` after `POST /__fake/attach`), `POST /control/lifecycle`, `POST /control/ports` and `POST /control/extensions` on the control listener only (204 when loopback + bearer equal to the secret file's contents, 401 otherwise, recording bodies at `GET /__fake/state`; `stopping` sleeps `--stopping-delay` seconds, default 0.5, before answering, to exercise the 7 s budget), 404 for `/control/*` on the public listener, prints one JSON log line per request on stderr, refuses to start if `ZS_CONTROL_SECRET` is in its environment (asserting D18), and exits 0 on `SIGTERM`. Optional `--linger-child`: spawns a `sleep 3600` in its own process group to simulate an orphaned language server.

### 3.24 `sandbox/image/test/run-local.sh` (new)

```bash
#!/usr/bin/env bash
# Exercises `zs-agent start` inside the image against the mock control plane using docker run.
# Usage: sandbox/image/test/run-local.sh [--fake-server] [--image zs-workspace:dev]
set -euo pipefail
```

Steps: (1) build fixture bare repo `dist/test/fixture.git` with one commit containing `.devcontainer/devcontainer.json` (`postCreateCommand: "echo post-create > /workspaces/fixture/.post-create"`, `forwardPorts: [3000]`, `customizations.zed.extensions: ["toml"]`) and `main.rs`/`index.ts`/`app.py` probe files, and **copy `sandbox/image/test/fake-zed-remote-server.py` into `dist/test/`** (the container mounts `dist/test` as `/fixtures`); (2) generate a P-256 key pair with `openssl` (as in b2 §3.14) and a 32-byte port secret (`openssl rand -base64 32`); (3) start the mock on host port 9977 with `--log-out dist/test/logs.jsonl`; (4) `docker run -d --name zs-local --add-host host.docker.internal:host-gateway -p 8443:8443 -p 8444:8444 -p 8445:8445 -p 8447:8447 -p 8448:8448 -p 8449:8449 -e ZS_CONTROL_URL=http://host.docker.internal:9977/api -e ZS_SANDBOX_TOKEN=test-token -e ZS_SANDBOX_NAME=sb-local -e ZS_WORKSPACE_ID=ws_local -e ZS_REGION=local -e ZS_INSECURE_COOKIES=1 [-e ZS_SERVER_BIN=/fixtures/fake-zed-remote-server.py] -v "$PWD/dist/test:/fixtures:ro" <image> zs-agent start`; (5) `curl --retry 60 --retry-all-errors --retry-delay 2 -fsS localhost:8445/health` and assert `.status == "ready"`, then poll until `.phase == "ready"`; assert the non-loopback body carries `lastError`, `listening`, `server.health.build` and `server.running` (what b9's probe reads) but no `forwards` key, and `docker exec zs-local curl -s 127.0.0.1:8445/health` has `forwards`; assert `docker exec zs-local curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8450/ports` is 401 and `curl localhost:8450/` from the host fails to connect; assert `docker exec zs-local sh -c 'cat /proc/$(cat /vercel/.zs/run/zs-agent.pid)/environ | tr "\0" "\n" | grep -c ^ZS_CONTROL_SECRET='` prints 0 and `ls -l /vercel/.zs/run/control.secret` shows mode 0600 (D18); (6) assert `/workspaces/fixture/.post-create` exists via `docker exec`; assert `docker exec zs-local git -C /workspaces/fixture rev-parse HEAD` equals the fixture sha; assert `docker exec zs-local sh -c 'echo $HOME'` is `/vercel`; assert the server's environment (`/proc/<server pid>/environ`) has `SHELL=/bin/bash`, `ZS_SUPERVISOR_URL=http://127.0.0.1:8450`, `ZS_CONTROL_SECRET_FILE=` and no `ZS_SANDBOX_TOKEN`/`ZS_CONTROL_URL`/`ZS_CONTROL_SECRET`; when not `--fake-server`, the real server received `/control/extensions {"install":["toml"]}`; (7) `docker exec -d zs-local python3 -m http.server 3000 --directory /workspaces/fixture`; within 6 s the mock's `/__test/state.forwards` contains 3000 (from `forwardPorts`, private, slot 8444) and the next ping's `listening` contains 3000; when not `--fake-server`, the real server received `/control/ports` with port 3000; (8) `curl -i -L --max-redirs 0 "localhost:9977/api/workspaces/ws_local/ports/3000/open"` → 303 whose `Location` is `http://localhost:8444/__zs/auth?zs_port_token=…&next=/`; follow it with `curl -i` → 303 + `Set-Cookie: zs_port_session=`; `curl -b "$cookie" localhost:8444/.post-create` → `post-create`; `curl localhost:8444/` without cookie → 401; a token minted for port 3001 (`zs-agent-host port-token --secret-file dist/test/port.secret --workspace-id ws_local --port 3001`, the host-built binary from `cargo build`, or `docker exec` with the secret mounted) presented on slot 8444 → 401 `port_session_stale` (the slot is bound to 3000); forward 3001 through the mock (`POST /__test/forward`, private → slot 8447), present the 3001 token on `localhost:8447/__zs/auth` → 303, and `curl -b <new cookie> localhost:8447/` → 502 `upstream_unavailable` (nothing listens on 3001); (9) `docker exec -i zs-local zs-agent credential get <<< $'protocol=https\nhost=github.com\npath=acme/fixture.git\n'` prints `username=x-access-token`, `password=ghs_mock` and a `password_expiry_utc=` line (`-i` is required: `docker exec` does not connect stdin otherwise; the helper finds the secret through the image's `ZS_CONTROL_SECRET_FILE`); `docker exec -i zs-local git -C /workspaces/fixture credential fill <<< …` works the same way; `path=other/repo.git` prints nothing (403 → fall-through); (10) `docker exec zs-local sh -c 'npm i -g cowsay >/dev/null && cd /tmp && go mod init x >/dev/null 2>&1 && echo ok'` succeeds as ubuntu (root steps left no root-owned files in `/vercel`); (11) `POST /__test/directive {idleStopAt: now+240s}` → within one ping interval the fake/real server recorded `/control/lifecycle {"kind":"idle_stop_in","seconds":≈240}` exactly once (a second ping with the same deadline sends nothing); `{sessionCapAt: now+1200s}` → `session_cap_in`; (12) `docker kill -s TERM zs-local`; container exits 0 within 25 s (and within 5 s when the fake's `--stopping-delay` is 0.5); `logs.jsonl` contains a `source: "server"` entry and a `source: "agent"` entry with `msg == "shutdown complete"`; the fake/real server saw `POST /control/lifecycle {"kind":"stopping"}` before `SIGTERM`; with `--fake-server --linger-child` no `sleep 3600` survives in the container; (13) restart the container with the mock's `--restore-tarball` pointing at an archive built from step (6)'s tree (`tar czf … -C <tmp> workspaces vercel/.local/share/zed vercel/.config/zed` — deliberately the pre-D9 three-path shape, to exercise `restore_tarball`'s tolerant `vercel/.config/zed` mapping; production archives carry D9's two paths, b9 §3.19) and a fresh `ZS_STATE_DIR` → `/workspaces/fixture/.post-create` exists without postCreate having run again (`/__test/state` shows no second `post_create` log entry), `/vercel/.config/zed/settings.json` equals the manifest's text (control plane wins over the archive), and the mock asserted the tarball fetch carried no bearer; (14) `docker exec zs-local zs-agent wait-ready --timeout-secs 5` exits 0. Additional image assertions: `zs-agent version` prints `ZS_BUILD_ID`; `which rust-analyzer gopls clangd vtsls pyright-langserver ruff bash-language-server yaml-language-server vscode-json-language-server vscode-css-language-server vscode-html-language-server taplo lua-language-server docker-langserver typescript-language-server prettier eslint gemini claude codex pnpm` all resolve; `id -u` is 1000 and `sudo -n true` succeeds; `git config --system --get credential.helper` equals `!zs-agent credential` and `credential.useHttpPath` is `true`; `echo $SHELL` is `/bin/bash`.

### 3.25 `.github/workflows/sandbox-image.yml` (new, at `/Users/ray/Projects/play/wed/.github/workflows/`)

Precondition: `zed/` is today a nested repository ignored by git (`/.gitignore:1-2`), not the submodule BUILD-SPEC 11.1 describes; a CI checkout therefore has no `zed/`. Until the fork is pushed and converted, the workflow checks the fork out explicitly from repository variables (`ZED_FORK_REPO`, e.g. `<org>/zed` as configured in the repository's variables – no placeholder is committed anywhere in the tree, D10 – and `ZED_FORK_REF`, default `zs`); once it is a submodule the same step becomes `submodules: recursive` and the `paths` trigger on `zed` starts working.

```yaml
name: sandbox-image
on:
  push: { branches: [main], paths: ["sandbox/**", "docs/contracts/**", "zed", ".github/workflows/sandbox-image.yml"] }
  workflow_dispatch: { inputs: { build_id: { description: "ZS_BUILD_ID", required: false } } }
concurrency: { group: sandbox-image-${{ github.ref }}, cancel-in-progress: false }
jobs:
  server:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4            # the Zed fork (nested repo today; becomes `submodules: recursive` after conversion)
        with: { repository: "${{ vars.ZED_FORK_REPO }}", ref: "${{ vars.ZED_FORK_REF || 'zs' }}", path: zed, fetch-depth: 1 }
      - run: cd zed && ./script/linux && ./script/download-wasi-sdk   # Zed's own Linux bundling prerequisites (run_bundling.yml:41-45)
      - uses: dtolnay/rust-toolchain@stable
        with: { toolchain: 1.97.1, targets: x86_64-unknown-linux-musl }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: zed }
      - id: id
        run: |
          sha="$(git -C zed rev-parse --short HEAD)"
          echo "build_id=${{ inputs.build_id }}" | grep -q 'build_id=.' && echo "build_id=${{ inputs.build_id }}" >> "$GITHUB_OUTPUT" || echo "build_id=${sha}-${{ github.run_number }}" >> "$GITHUB_OUTPUT"
      - run: ZS_BUILD_ID="${{ steps.id.outputs.build_id }}" sandbox/image/build-server.sh
      - uses: actions/upload-artifact@v4
        with: { name: zed-remote-server, path: sandbox/image/dist/zed-remote-server, if-no-files-found: error }
    outputs: { build_id: "${{ steps.id.outputs.build_id }}" }
  agent-tests:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4            # only for tests/proto_tags.rs and tests/warm_against_serve.rs (both skip when zed/ is absent)
        with: { repository: "${{ vars.ZED_FORK_REPO }}", ref: "${{ vars.ZED_FORK_REF || 'zs' }}", path: zed, fetch-depth: 1, sparse-checkout: "crates/proto/proto\ncrates/remote_server/tests/fixtures" }
      - uses: dtolnay/rust-toolchain@stable
        with: { toolchain: 1.97.1 }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: sandbox/supervisor }
      - run: cd sandbox/supervisor && cargo fmt --check && cargo clippy --all-targets -- -D warnings
      - run: cd sandbox/supervisor && ZS_RUN_START_INTEGRATION=1 cargo test   # runs tests/start_against_fake_server.rs too
  image:
    needs: [server, agent-tests]
    runs-on: ubuntu-24.04
    permissions: { contents: read, id-token: write }
    env: { VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}", VERCEL_ORG_ID: "${{ secrets.VERCEL_ORG_ID }}", VERCEL_PROJECT_ID: "${{ secrets.VERCEL_PROJECT_ID }}", VERCEL_TEAM_SLUG: "${{ vars.VERCEL_TEAM_SLUG }}", VERCEL_PROJECT_SLUG: "${{ vars.VERCEL_PROJECT_SLUG }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: zed-remote-server, path: sandbox/image/dist }
      - run: chmod 0755 sandbox/image/dist/zed-remote-server
      - uses: docker/setup-buildx-action@v3
      - run: npm i -g vercel@latest && vercel link --yes --project "$VERCEL_PROJECT_SLUG" --scope "$VERCEL_TEAM_SLUG" --token "$VERCEL_TOKEN"
      - run: vercel vcr login docker            # explicit: needed to pull the base (build.sh) and the pushed image (run-local.sh); 12 h validity
      - run: ZS_BUILD_ID="${{ needs.server.outputs.build_id }}" sandbox/image/build.sh --push
      - run: sandbox/image/test/run-local.sh --image "vcr.vercel.com/$VERCEL_TEAM_SLUG/$VERCEL_PROJECT_SLUG/zs-workspace:${{ needs.server.outputs.build_id }}" --fake-server
      - run: sandbox/image/test/run-local.sh --image "vcr.vercel.com/$VERCEL_TEAM_SLUG/$VERCEL_PROJECT_SLUG/zs-workspace:${{ needs.server.outputs.build_id }}"   # real `serve` binary from the artifact
      - uses: actions/upload-artifact@v4
        with: { name: image-ref, path: sandbox/image/dist/image.json }
```

The web deploy (b9) reads `image.json` (`digest`) and sets `ZS_IMAGE_REF=zs-workspace@sha256:…` so `Sandbox.create` pins by digest (BUILD-SPEC 10.6).

### 3.26 `docs/contracts/sandbox-manifest.v1.json`, `docs/contracts/sandbox-api.md`, `docs/contracts/fixtures/manifest.example.json`, `docs/contracts/fixtures/port-token.vector.json` (new)

The single source of truth for the sandbox ↔ control-plane contract (D19 names the fixture path), consumed by this crate's `example_manifest_parses`/`fixture_validates_against_schema`/`port_token_vector` tests, by b9's `tests/manifest.test.ts` and `port_session_matches_b8_vector` (b9 §6.2, §6.4 – asked to load these files instead of its own copies, §7 item 4) and by b4's `POST /control/extensions` test (b4 §4.2 names the fixture): a JSON Schema (draft 2020-12) for `SandboxManifest` exactly as in §4.1, one example manifest, one port-token vector (`{ "secretB64": …, "payload": { ws, port, sub, iat, exp, jti }, "token": "v1.…" }` generated once with `zs-agent port-token` and pinned), and a short markdown table of the sandbox-facing routes (§4.2) with request/response shapes, status codes, rate limits and the time budgets both sides depend on:

| Budget | Value | Owner |
|---|---|---|
| Create: manifest → supervisor `/health` on 8445 `ready\|degraded` with `serverRunning` | ≤ 35 min (b9 `waitUntilReady`; `postCreateCommand` runs beside the server, so the server is typically up within 60 s of the clone) | b9 waits; b8 starts the server before postCreate |
| Resume: same | ≤ 3 min | idem |
| `postCreateCommand` / `postStartCommand` / `postAttachCommand` / dotfiles / tarball restore | 30 / 10 / 10 / 10 / 20 min, run beside the server | b8 |
| Prebuild `zs-agent prebuild` exit | ≤ 50 min (b9 `stepWaitForCommandExit`) | b8 fits: clone + postCreate 30 min + warm ≤ 15 min − margin; the warm budget shrinks if postCreate used more |
| Stop: `SIGTERM` → agent exit | ≤ ≈ 21 s worst case (POST stopping 7 s > b4's 5 s flush, TERM_GRACE 10 s, log flush 3 s); b9 waits ≤ 25 s | b8 |
| Activity ping interval / unhealthy after | 30 s (`manifest.activity.intervalSecs`) / 5 min without a ping | b9 |
| Port bootstrap token TTL / proxy cookie TTL | 1 h (b9 `PORT_SESSION_TTL_SECS`) / 8 h (per boot) | b9 / b8 |
| Restore tarball URL validity | 1 h from the manifest fetch | b9 |

## 4. New types and messages

### 4.1 Manifest (`GET {ZS_CONTROL_URL}/sandboxes/{name}/manifest`, `Authorization: Bearer <ZS_SANDBOX_TOKEN>`)

This brief's `SandboxManifest`; b9 §4.7 emits it field-for-field (plus `forwards[].slot`, asked in §7 item 4); the schema file in §3.26 is the normative copy.

```json
{
  "version": 1,
  "workspaceId": "ws_01J8X…", "sandboxName": "sb-prod-01j8x…-g1", "userId": "user_2f…",
  "build": "c3cf80c-42", "region": "iad1",
  "repo": { "owner": "acme", "name": "api", "cloneUrl": "https://github.com/acme/api.git", "defaultBranch": "main", "revision": "main", "depth": 0, "ref": null },
  "workspaceDir": "/workspaces/api",
  "restore": null,
  "dotfiles": { "repoUrl": "https://github.com/jane/dotfiles", "installCommand": null },
  "env": { "ZS_WORKSPACE_ID": "ws_01J8X…", "ZS_REGION": "iad1", "NODE_ENV": "development" },
  "secretNames": ["NPM_TOKEN", "DATABASE_URL"],
  "jwt": { "issuer": "zs", "audience": "sb-prod-01j8x…-g1", "publicKeys": ["-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"] },
  "portSessionSecret": "base64-standard-padded-32-bytes==",
  "forwards": [ { "port": 3000, "visibility": "private", "label": "web", "url": "https://zs.example.com/api/workspaces/ws_01J8X…/ports/3000/open", "slot": 8444 } ],
  "portPool": [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888],
  "idle": { "minutes": 30 },
  "session": { "id": "ses_vercel_…", "startedAt": 1756800000000, "capAt": 1756886400000, "resumed": false },
  "devcontainer": { "configHash": "9f…" },
  "settings": { "settings": "// user settings\n{ \"theme\": \"One Dark\" }", "keymap": "[]" },
  "logs": { "flushIntervalSecs": 5, "maxBatch": 200, "maxBatchBytes": 262144 },
  "activity": { "intervalSecs": 30 },
  "allowedOrigins": ["https://zs.example.com"],
  "extensions": ["toml", "dockerfile"],
  "prebuild": null
}
```

A rebuild manifest carries `"restore": { "tarballUrl": "https://<blob-host>/rebuild/ws_01J8X…/1756800000000.tgz?token=…", "sha256": "…" }` (presigned, 1 h); a prebuild manifest carries `"prebuild": { "id": "pb_…", "branch": "main", "commit": "<sha>" }`, `"userId": "system"`, `"dotfiles": null`, `"repo.revision": "<sha>"`.

Schema rules (enforced by `Manifest::validate`): `version == 1`; `workspaceId`/`sandboxName` equal the environment; `workspaceDir` absolute, lexically normal, inside `ZS_WORKSPACES_DIR`; `jwt.publicKeys` non-empty, each a PEM `PUBLIC KEY` block; `jwt.issuer`/`jwt.audience` non-empty; `portSessionSecret` = standard base64 of exactly 32 bytes; every `forwards[].port`/`portPool[]` in `1..=65535` and not in `{8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450}`; `forwards[].slot` ∈ `{8444, 8447, 8448, 8449}`, unique, private only; `session.capAt > session.startedAt`; `restore.tarballUrl` https; `allowedOrigins[]` are origins; `settings.settings`/`keymap` are strings (JSONC, never parsed here); `activity.intervalSecs ≥ 10`; `logs.maxBatch ≤ 200`, `logs.maxBatchBytes ≤ 262144`. Unknown fields are ignored (forward compatibility). Secret **values** never appear here (BUILD-SPEC 7.9); `portSessionSecret` is the one secret the manifest carries – it authorises nothing but private-port cookies, is per generation, and is never written to disk by the supervisor. Private-forward `url` is the control plane's `/open` link (D8).

### 4.2 Control-plane calls made by the supervisor (b9 §4.2)

| Call | Request | Response |
|---|---|---|
| `POST {api}/sandboxes/{name}/git-token` | `{ "host": "github.com", "protocol": "https", "path": "acme/api.git" \| null }` | `200 { "username": "x-access-token", "token": "ghs_…", "expiresAt": 1756803600 }` (unix seconds; an RFC 3339 string is tolerated); `404 host_unsupported`; `403 repo_not_allowed`; `401` bad sandbox token; `410` retired |
| `POST {api}/sandboxes/{name}/ports` | `{ "port": 3000, "visibility": "public" \| "private", "label": "web" \| null }` | `200 { "url": "https://…" \| null, "visibility": "private", "slot": 8444 }` (`slot` for private forwards, D8 – asked of b9); `409 slots_exhausted` when the four slots are taken (D8); `400` bad port. The control plane calls `sandbox.update({ ports })` only for public ports outside the pool. |
| `DELETE {api}/sandboxes/{name}/ports/{port}` | – | `204` |
| `POST {api}/sandboxes/{name}/activity` | `{ "lastInputAt": 1756800123456 \| null, "sessionActive": true, "sid": "ses_…" \| null, "serverUptimeSecs": 120, "agentUptimeSecs": 130, "status": "ready", "cpuBusyPct": 12.5, "busy": false, "phase": "ready", "listening": [{ "port": 3000, "pid": 4242, "process": "node" }] }` (D13: `busy`, `phase`, `cpuBusyPct`; `listening` is an extension b9 may ignore) | `200 { "idleStopAt": 1756801923456 \| null, "sessionCapAt": 1756886400000 \| null, "stop": false, "forwards": [ForwardView…] }` (`forwards` asked of b9; absent today) |
| `POST {api}/sandboxes/{name}/logs` | `{ "workspaceId", "sandboxName", "sessionId", "build", "entries": [{ "ts": 1756800000123, "level": "info", "source": "server", "msg": "listening on 0.0.0.0:8443", "fields": { "epoch": 1 } }] }` ≤ 200 entries / 256 KiB (`manifest.logs`) | `204` (any 2xx accepted); `413` → the batch is halved |
| `POST {api}/sandboxes/{name}/client-errors` | `{ "build", "kind": "server_crash" \| "boot", "message", "stack"?: "<crash tail>", "marks"? }` | `202` |
| `POST {api}/sandboxes/{name}/extensions` | `{ "installed": ["toml", "html"] }` (relay of the server's `POST $ZS_SUPERVISOR_URL/extensions`, D18) | `204` (route asked of b9; D19 says b9 consumes it) |
| `GET <manifest.restore.tarballUrl>` | – (presigned Blob URL; **no** `Authorization`, **no** bypass header) | `200 application/gzip` stream |

All calls to `{api}` carry `Authorization: Bearer <ZS_SANDBOX_TOKEN>`, `X-ZS-Build`, and `x-vercel-protection-bypass` when `ZS_BYPASS_SECRET` is set (D18). `{api}` = `ZS_CONTROL_URL` = `https://<control-plane>/api`.

### 4.3 Supervisor ↔ server (localhost)

Supervisor → server control listener (`http://127.0.0.1:8446`, D5/D18; bearer = the contents of `run/control.secret`, which the server read from `--control-secret-file`; b4 §4.2): `POST /control/lifecycle` `{"kind":"idle_stop_in","seconds":300}` / `{"kind":"session_cap_in","seconds":1800}` / `{"kind":"stopping"}` / `{"kind":"resumed"}`; `POST /control/ports` `{"ports":[{"port":3000,"pid":4242,"process_name":"node"}],"forwards":[{"port":3000,"visibility":"private","label":"web","url":"https://…"}]}` (`url` is `""` when the control plane returned `null`); `POST /control/extensions` `{"install":["toml","dockerfile"]}`. Supervisor → server public listener (`http://127.0.0.1:8443`): `GET /health` (no auth; loopback gets the full b2 body).

Server → supervisor (`$ZS_SUPERVISOR_URL` = `http://127.0.0.1:8450`, same bearer, which the server holds from `--control-secret-file`): `POST /ports` `{"port":3000,"visibility":"public","label":"web"}` → `200 {"url":"https://…"|null}` / `409 {"error":"slots_exhausted"}`; `DELETE /ports/3000` → `204`; `POST /extensions` `{"installed":["toml","html"]}` → `204`.

Credential helper → supervisor (`http://127.0.0.1:8450`, bearer read from `ZS_CONTROL_SECRET_FILE`): `POST /git-token` `{"host":"github.com","protocol":"https","path":"acme/api.git"}` → `GitTokenResponse` verbatim (`expiresAt` in unix seconds).

### 4.4 Health (`GET :8445/health`)

```json
{
  "status": "ready",                     // booting | ready | degraded | stopping  (HTTP 200 for ready and degraded; 503 for booting and stopping, same body)
  "phase": "post_create",                // manifest | restore | clone | server_starting | dotfiles | post_create | post_start | warm | ready
  "build": "c3cf80c-42",
  "manifestBuild": "c3cf80c-42",
  "region": "iad1",
  "resumed": false,
  "busy": true,
  "uptimeSecs": 131,
  "lastError": null,                     // scrubbed; present for every caller (b9's probe fails fast on `manifest:` errors)
  "server": { "running": true, "pid": 214, "restarts": 0, "lastExit": null, "startedAtMs": 1756800001000, "crashLoop": false,
              "health": { "build": "c3cf80c-42", "version": "c3cf80c-42+…", "uptime_secs": 120, "session_active": true, "last_input_at": 1756800123456, "dirty_buffers": 0 } },   // what b9 reads as serverRunning/serverBuild/sessionActive/lastInputAt
  "proxy": { "running": true, "slots": { "8444": 3000, "8447": null, "8448": null, "8449": null } },
  "forwards": [ { "port": 3000, "visibility": "private", "label": "web", "url": "https://…", "slot": 8444 } ],   // loopback only
  "listening": [3000]
}
```

b9 polls **this** endpoint (`probeHealth(host8445)`, b9 §3.18; `waitUntilReady`, §4.8) and reads `status`, `phase`, `build`, `lastError`, `server.running`, `server.health.build`, `server.health.session_active`, `server.health.last_input_at` and `listening` from the public host, which is why those are not loopback-gated; `forwards` (URLs) stays loopback-only. It also serves `zs-agent wait-ready`, `run-local.sh` and operators (`runCommand curl 127.0.0.1:8445/health`).

### 4.5 Port bootstrap token / proxy cookie (D8)

Bootstrap (control plane → proxy, b9 §3.12/§4.2): `v1.<b64url(payload)>.<b64url(sig)>` where `payload = {"ws":"ws_01J8X…","port":3000,"sub":"user_2f…","iat":1756800000,"exp":1756803600,"jti":"9b1c…"}` (this field order, unpadded base64url) and `sig = HMAC-SHA256(portSessionSecret, "v1." + b64url(payload))`; delivered as `GET https://<slot-host>/__zs/auth?zs_port_token=<token>&next=/` after a 303 from `GET {origin}/api/workspaces/{id}/ports/{port}/open`, where `<slot-host>` is `domain(slot)` of the slot the control plane allocated to that forward. Cookie (proxy-minted): the same format under the per-boot key, `payload.port` = the slot's bound port, `exp = iat + 28800`; `Set-Cookie: zs_port_session=<token>; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=<exp-now>`. The pinned vector lives in `docs/contracts/fixtures/port-token.vector.json` (§3.26).

### 4.6 Environment contract

| Variable | Set by | Read by | Meaning |
|---|---|---|---|
| `ZS_CONTROL_URL` | control plane, `runCommand` env of `zs-agent start`/`resume`/`prebuild` (b9 §3.18 `supervisorEnvFor`, `controlApiBase()`) | `zs-agent` only (stripped from children) | API base **including `/api`**, e.g. `https://zs.example.com/api`; the agent appends `/sandboxes/{name}/…`. `ZS_CONTROL_PLANE_URL` (bare origin) is accepted as a fallback and gets `/api` appended. |
| `ZS_BYPASS_SECRET` | control plane, `runCommand` env (preview deployments only, b9 §3.18/§11.2) | `zs-agent` only (stripped) | Sent as `x-vercel-protection-bypass` (D18) |
| `ZS_SANDBOX_TOKEN` | control plane, `runCommand` env (fresh per start, BUILD-SPEC 10.4; b9 §3.12) | `zs-agent` only (stripped) | Bearer `zsb_…` for every control-plane call |
| `ZS_SANDBOX_NAME`, `ZS_WORKSPACE_ID` | control plane, `Sandbox.create({ env })` (b9 §4.8) and the `runCommand` env (b9 §3.18 `supervisorEnvFor`) | `zs-agent` | Identity; cross-checked against the manifest |
| `ZS_REGION` | control plane, `Sandbox.create({ env })` only (b9 §4.8; VM-wide, so every `runCommand` inherits it – `supervisorEnvFor` does not re-emit it) | `zs-agent` | Informational (logged, echoed in health) |
| `ZS_BUILD_ID` | image `ENV` | `zs-agent`, `zed-remote-server` (`option_env!` in b2 §3.13) | Build id; `--client-build` |
| `ZS_PREBUILD` | control plane (`prebuild` workflow only, b9 §4.8) | `zs-agent` | `1` ⇒ only `zs-agent prebuild` may run |
| `ZS_WORKSPACES_DIR` | image `ENV` (`/workspaces`) | `zs-agent` | Parent of workspace dirs |
| `ZS_STATE_DIR`, `ZS_DATA_DIR` | optional | `zs-agent` | Defaults `$HOME/.zs` (`/vercel/.zs`) and `$HOME/.local/share/zed` |
| `ZS_SERVER_BIN` | image `ENV` | `zs-agent` | Server binary path |
| `ZS_SUPERVISOR_URL` | image `ENV` (`http://127.0.0.1:8450`); also exported by `zs-agent` to every child and passed as `--supervisor-url` | `zed-remote-server` (b2 clap `env`), `zs-agent credential` | Supervisor loopback API base |
| `ZS_CONTROL_SECRET_FILE` | image `ENV` (`/vercel/.zs/run/control.secret`); also exported by `zs-agent` to every child | `zs-agent credential`, lifecycle commands (any git under the workspace) | **Path** of the per-boot control secret; the server gets the same path as `--control-secret-file` (D5/D18). No `ZS_CONTROL_SECRET` variable exists anywhere. |
| `SHELL`, `USER`, `HOME` | image `ENV` (`/bin/bash`, `/vercel`); `zs-agent` fills `SHELL`/`USER` when missing | `zed-remote-server` (b3 §7.10 `get_system_shell`) and children | Login shell for terminals |
| `ZS_PREBUILD_WARM_CMD` | optional (prebuild workflow) | `zs-agent prebuild` | Shell command run after the LSP warm-up with the remaining budget |
| `ZS_HEALTH_LISTEN`, `ZS_LOCAL_API_LISTEN`, `ZS_PROXY_BIND_IP`, `ZS_RPC_LISTEN`, `ZS_SERVER_CONTROL_LISTEN` | optional | `zs-agent` | Bind overrides (tests) |
| `ZS_INSECURE_COOKIES` | tests only | `zs-agent` | Omit `Secure` on the cookie; allow `http://` tarball URLs |
| `RUST_LOG` | optional | both | Log filter (default `info`) |
| user/org/repo secrets (`manifest.secretNames`) | control plane, `runCommand` env of `zs-agent start` (b9 §3.18) | inherited by the server and all children | BUILD-SPEC 7.9 |
| `manifest.env` literals | control plane manifest | server and lifecycle commands (filtered, §3.3) | Non-secret env (`ZS_WORKSPACE_ID`, `ZS_REGION`, devcontainer `remoteEnv`) |
| `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, … | Vercel | inherited | Sandbox proxy CA; the agent's reqwest uses native roots so it honours `SSL_CERT_FILE` |

There is no `ZS_JWT_PUBLIC_KEYS` environment fallback: b9 never sets one, and the manifest is authoritative (BUILD-SPEC 4.3's "baked in as an environment variable" is superseded by b9 §3.11 rotation-on-next-start; b2 §7.13 agrees; §7 item 12).

## 5. Cargo/package changes

`sandbox/supervisor/Cargo.toml` (complete; a standalone workspace, so nothing in `zed/Cargo.toml` changes). Every version below exists in the local cargo registry (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f`, §2) except `jsonwebtoken`'s transitive `p256 0.13.2`, so `cargo generate-lockfile` needs network once; majors match Zed's where they overlap (`clap 4`, `nix 0.29`, `rand 0.9`, `sha2 0.10`, `serde_json 1`, `thiserror 2`, `anyhow 1`, `serde_json_lenient 0.2`, `tokio 1`, `hyper 1.7`, `hyper-util 0.1.17`, `http-body-util 0.1.3`, `jsonwebtoken 10`, `base64 0.22`, `prost 0.14`, `prost-build 0.14`, `protox 0.9`).

```toml
[workspace]
members = ["."]
resolver = "2"

[package]
name = "zs-agent"
version = "0.1.0"
edition = "2024"
rust-version = "1.85"
publish = false
description = "In-sandbox supervisor for Zed Codespaces workspaces"
build = "build.rs"

[[bin]]
name = "zs-agent"
path = "src/main.rs"

[dependencies]
anyhow = "1.0.98"
base64 = "0.22.1"
bytes = "1.10"
clap = { version = "4.5", features = ["derive", "env"] }
futures-core = "0.3"
futures-util = { version = "0.3", default-features = false, features = ["sink", "std"] }   # SinkExt/StreamExt for the tokio-tungstenite socket (§3.16a)
hex = "0.4.3"
hmac = "0.12.1"
http = "1.3"
http-body-util = "0.1.3"
hyper = { version = "1.7", features = ["http1", "server", "client"] }
hyper-util = { version = "0.1.17", features = ["tokio"] }
jsonwebtoken = { version = "10.3", default-features = false, features = ["use_pem", "rust_crypto"] }
nix = { version = "0.29", features = ["signal", "process"] }
parking_lot = "0.12"
prost = "0.14"
rand = "0.9"
regex = "1.11"
reqwest = { version = "0.12.24", default-features = false, features = ["rustls-tls-native-roots", "json", "stream"] }
secrecy = { version = "0.10.3", features = ["serde"] }
serde = { version = "1.0.219", features = ["derive"] }
serde_json = "1.0.140"
serde_json_lenient = "0.2.4"
sha2 = "0.10.9"
subtle = "2.6.1"
thiserror = "2.0.12"
tokio = { version = "1.52", features = ["rt-multi-thread", "macros", "net", "process", "signal", "sync", "time", "fs", "io-util"] }
tokio-tungstenite = { version = "0.21", default-features = false, features = ["handshake"] }   # ws:// only, no TLS backend
tokio-util = { version = "0.7.18", features = ["io", "codec"] }
tracing = "0.1.43"
tracing-subscriber = { version = "0.3.22", features = ["json", "env-filter"] }

[build-dependencies]
prost-build = "0.14"
protox = "0.9"

[dev-dependencies]
tempfile = "3.19"

[profile.release]
opt-level = "z"
lto = "thin"
codegen-units = 1
strip = true
panic = "abort"
```

Justifications: **hyper 1.x direct, no axum** – the proxy needs raw upgrade handling (`with_upgrades` on both the server and client connections, `hyper::upgrade::on`) and the API surface is seven routes; `hyper-util`'s `tokio` feature supplies `TokioIo` (the only adapter hyper 1.x accepts for `tokio::net::TcpStream` and for `Upgraded` in `copy_bidirectional`) and `TokioTimer` (required for `header_read_timeout`). **reqwest with `rustls-tls-native-roots`** – the sandbox installs a per-VM proxy CA into the system store and exports `SSL_CERT_FILE`; bundled webpki roots would fail whenever a firewall rule terminates TLS. That feature selects rustls's **`ring`** provider (`reqwest-0.12.24/Cargo.toml` `__rustls-ring`), and reqwest declares rustls with `default-features = false`, so `aws-lc-sys` never enters this graph; `ring` builds under `musl-gcc` (it is already in `remote_server`'s musl graph, b2 §2). **jsonwebtoken 10 with `rust_crypto`** – ES256 signing of the prebuild warm-up token through pure-Rust `p256` (`Es256Signer`, `rust_crypto/mod.rs:71`); the crate has no default backend, and `aws_lc_rs` is avoided for the same static-build reason. The port tokens no longer use it (§3.10). **hmac 0.12 + sha2 0.10** – the port bootstrap token and the proxy's own cookie MAC, byte-compatible with b9's `node:crypto` implementation; same `digest 0.10` generation; `sha2` also verifies the restore tarball. **subtle** – constant-time MAC and secret comparison. **nix 0.29** – `kill`/`killpg`; tokio's `Child::kill` is `SIGKILL` on the pid only. **serde_json_lenient** – JSONC `devcontainer.json` (comments, trailing commas); Zed uses the same crate. **rand 0.9** (`rand::rng().fill_bytes`) – the control secret, the cookie key and `jti`; matches Zed's pin. **secrecy 0.10** with `serde` – `SecretString` deserialises from the git-token response and the manifest's `portSessionSecret` and redacts in `Debug`; the value is only read through `expose_secret()` in `credential.rs`, `control_plane.rs`, `port_auth.rs` and `server.rs` (writing the secret file). **parking_lot** – short critical sections on `AgentState`. **tokio-util `codec`** – `LinesCodec::new_with_max_length` bounds every pumped line. **prost 0.14 + prost-build/protox** – the warm-up client's minimal envelope schema (§3.2a); `protox` needs no `protoc`. **tokio-tungstenite 0.21 (`handshake` only)** – the warm-up's WebSocket client over plain loopback `ws://`; it pulls `tungstenite 0.21`, the same major b2 cites; no TLS feature, so nothing new enters the crypto graph. **futures-util** – `SinkExt`/`StreamExt` for that socket.

No `Cargo.lock` is committed by this brief; the first `cargo build --locked` in CI must run after `cargo generate-lockfile` (commit the lock in the same PR). No changes to `apps/web/package.json`; the mock control plane is dependency-free Node.

## 6. Tests

### 6.1 Unit tests (inline `#[cfg(test)]`)

`credential.rs`
| Test | Asserts |
|---|---|
| `parses_get_request` | `protocol=https\nhost=github.com\npath=acme/api.git\nwwwauth[]=Basic realm=x\n\n` → `{https, github.com, acme/api.git, None}`; unknown keys ignored; stops at blank line. |
| `format_response_shape` | Exactly `username=x-access-token\npassword=ghs_x\npassword_expiry_utc=1756803600\n`; without expiry the third line is absent. |
| `parse_rfc3339_utc` | `2026-09-02T12:00:00.000Z` → `1788350400`; `2026-09-02T12:00:00Z` ok; offsets (`+02:00`) and garbage → `None`. |
| `expires_at_forms` | `ExpiresAt::UnixSeconds(1756803600)` and `ExpiresAt::Iso("2026-09-02T…Z")` both reach `format_response` as unix seconds. |
| `non_github_host_prints_nothing` | `main("get")` with `host=gitlab.com` returns exit 0 and writes nothing (captured writer). |
| `missing_secret_file_prints_nothing` | `control_secret = None` (no `ZS_CONTROL_SECRET_FILE`, no default file) → exit 0, no output, no HTTP call. |
| `secret_file_is_read` | `read_control_secret_file(Some(path))` returns the file's bytes with a trailing newline stripped; a 0644 file is still read (no mode check – uid 1000 owns everything). |
| `repo_not_allowed_falls_through` | Fake supervisor answering 403 → exit 0, no output. |
| `store_and_erase_are_noops` | Both return 0, no output, no HTTP call (fake supervisor URL that would fail). |
| `request_body_shape` | The POST body is `{"host":"github.com","protocol":"https","path":"acme/api.git"}`; `path` null when git sent none. |

`port_auth.rs`
| Test | Asserts |
|---|---|
| `port_token_vector` | `PortTokenCodec::new(decode_secret(vector.secretB64)).sign(&vector.payload) == vector.token` (`docs/contracts/fixtures/port-token.vector.json`; the vector b9's `port_session_matches_b8_vector` pins too); `verify` round-trips it. |
| `payload_field_order_and_padding` | `sign` serialises `ws, port, sub, iat, exp, jti` in that order and uses unpadded base64url (byte-for-byte b9 `signPortSession`). |
| `bootstrap_rejects` | wrong `ws` → `WrongWorkspace`; port 8443/8446/8450/0 → `BadPort`; `exp - iat = 7200` with `max_age = 3600` → `Expired`; expired → `Expired`; other key → `BadSignature`; `v0` prefix / missing dots / non-base64 → `Malformed`; a payload of invalid JSON with a valid MAC → `Malformed`. |
| `cookie_sign_verify_roundtrip` | `verify(sign(s), ws, now, COOKIE_TTL_SECS)` == `s`. |
| `cookie_tampered_payload_rejected` | Flip one payload byte → `BadSignature`. |
| `cookie_other_key_rejected` | A second `PortTokenCodec::random()` → `BadSignature` (what a resume does to old cookies). |
| `decode_secret_shapes` | 32 bytes standard-padded → ok; 31 bytes, unpadded, base64url → `Malformed`. |
| `cookie_header_parsing` | `a=1; zs_port_session=T; b=2` → `T`; absent → `None`; `zs_port_session_x=..` not matched. |
| `safe_next` | `/x?y=1` ok; `//evil.com`, `/\evil`, `https://evil`, `` → `/`. |
| `set_cookie_flags` | Contains `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=`, and `Secure` iff requested. |

`ports.rs`
| Test | Asserts |
|---|---|
| `parses_ipv4_listen_line` | Fixture `  0: 0100007F:0BB8 00000000:0000 0A … 1000 0 12345` → `{port 3000, loopback_only true, uid 1000, inode 12345, v4}`; `01` (ESTABLISHED) lines skipped. |
| `parses_ipv6_listen_line` | `00000000000000000000000000000000:1F90` → port 8080, not loopback; `…01000000:1F90` → loopback. |
| `unions_v4_and_v6_by_port` | Same port in both files → one entry, `loopback_only` is the AND, `v4 && v6`. |
| `v6_only_flagged` | Only in tcp6 → `v4 == false`, `v6 == true` (proxy picks `::1`). |
| `excludes_infra_ports_and_self` | 8443-8450 and sockets owned by `self_pid` removed. |
| `diff_ports` | `{3000}` → `{3000, 5173}`: added `[5173]`, removed `[]`; reverse gives removed. |
| `parse_local_address_bad_input` | Odd lengths, non-hex → `None`. |

`manifest.rs` / `bootstrap.rs` / `state.rs`
| Test | Asserts |
|---|---|
| `example_manifest_parses` | `docs/contracts/fixtures/manifest.example.json` parses; `restore` is `None`; `forwards[0].url` is `Some`, `forwards[0].slot == Some(8444)`; `settings.settings` is the raw JSONC string; `logs`/`activity` defaults apply when the keys are removed. |
| `fixture_validates_against_schema` | The fixture satisfies `docs/contracts/sandbox-manifest.v1.json` (a 60-line in-test validator covering `type`, `required`, `enum`, `properties`; no jsonschema crate). |
| `validate_rejects` | version 2; `workspaceDir` `/etc`; `../` component; empty keys; forward on 8450; `slot: 8445`; two forwards on slot 8444; a 31-byte `portSessionSecret`; `session.capAt <= startedAt`; `restore.tarballUrl` `http://` without insecure mode; `allowedOrigins: ["https://x/path"]`; `workspaceId` mismatch; `activity.intervalSecs: 5`. |
| `prebuild_manifest_parses` | The `pb-` variant (`prebuild` set, `userId: "system"`, `dotfiles: null`) parses. |
| `parse_port_key` | `"3000"` → 3000; `"3000-3999"`, `"localhost:3000"`, `".+"` → `None`. |
| `lifecycle_specs_forms` | String → `["bash","-lc",s]`; array → argv verbatim; object `{a: "x", b: ["y"]}` → two specs labelled `post_create:a`, `post_create:b`. |
| `devcontainer_jsonc_loads` | File with `// comment`, `/* block */` and trailing comma parses; returned bytes hash to the file's sha256; missing file → `Ok(None)`. |
| `remote_env_expansion` | `${containerEnv:HOME}` → base `HOME`; unknown → `""`; literal text preserved. |
| `env_denylist` | `manifest.env`/`remoteEnv` keys `LD_PRELOAD`, `ZS_SUPERVISOR_URL`, `ZS_CONTROL_SECRET_FILE`, `PATH` are dropped; `ZS_REGION`, `NODE_ENV` kept; supervisor keys win over both. |
| `markers_roundtrip` | `needs_post_create("h1")` true on empty; after `set_post_create_done("h1")` false; `"h2"` true; `first_boot_done` false → true; `settings_written` round-trips. |
| `write_jwt_keys_replaces_stale` | Three PEMs then two → only `key-0.pem`, `key-1.pem` remain, mode 0600; order preserved (active first). |
| `write_settings_verbatim` | JSONC input (with comments) lands byte-for-byte in `settings.json`; the same text again → no rewrite (mtime unchanged); different text → rewritten; a pre-existing file the supervisor never wrote → replaced. |
| `extension_install_list` | manifest `[toml, lua]` ∪ devcontainer `[lua, html, "Bad Id"]` → `[toml, lua, html]` (dedupe, invalid id dropped with a warning). |
| `control_secret_file_written` | `write_control_secret` → 0600, no trailing newline, contents == the hex secret; `command_line_matches_serve_args` (below) passes its path. |
| `dotfiles_installer_pick` (tempdir) | Creates `bootstrap.sh` only → chosen; none → symlink mode links `.zshrc` and skips existing `.bashrc`. |
| `refspec_selection` | `ref = refs/pull/12/head` → that ref (D18); revision `abc123…` (40 hex) → the sha; revision `dev` → `refs/heads/dev` with `-B dev`; `depth 0` → no `--depth`. |
| `restore_layout_mapping` (tempdir) | A tarball with `workspaces/api/x`, `vercel/.local/share/zed/y`, `vercel/.config/zed/settings.json` extracted at a fake root lands at `<workspaces_dir>/api/x`, `<data_dir>/y`, `<home>/.config/zed/settings.json`; a wrong `sha256` → `Err` and no files moved; an archive without `vercel/` entries succeeds. |
| `forwards_slot_binding` | `insert(Forward{port 3000, private, slot 8444})` → `slot_port(8444) == Some(3000)`; `bind_slot(8447, 3001)` refused while 3001 is not a forward, accepted after `insert`; `remove(3000)` unbinds 8444; `replace([...])` without `slot` keeps a token-learned binding whose port survives and drops the rest; `insert` twice is idempotent (b4 §7 item 8). |

`logs.rs`
| Test | Asserts |
|---|---|
| `server_json_line_mapped` | b2 line `{"ts_ms":1,"level":3,"message":"listening on 0.0.0.0:8443","ws":"w","mode":"serve","module_path":"remote_server::serve","session_id":"ses_1","epoch":7}` → `source "server:remote_server::serve"`, `level "info"`, message kept, `fields.sid == "ses_1"`, `fields.epoch == 7`. |
| `plain_line_wrapped` | Non-JSON → `info` entry with raw text. |
| `scrub_redacts_tokens` | Each regex family redacts (incl. `zsb_…`, `zs_port_token=…`, a `v1.<b64>.<b64>` port token, `?token=` in a Blob URL, `x-vercel-protection-bypass: …`); ordinary text untouched; `x-access-token:abc@github.com` → `[redacted]github.com`. |
| `long_lines_bounded` | A 300 KiB line → split at 64 KiB with `fields.truncated`; a 20 KiB `msg` → 8 KiB + `…[+N bytes]`. |
| `batch_encoding` | Two entries → one JSON object with `workspaceId`, `sandboxName`, `sessionId`, `build`, `entries[2]`; no NDJSON. |
| `batch_flushes_on_count_and_bytes` (tokio, in-process hyper) | 200 pushes → one POST with 200 entries; 5 × 60 KiB → POST before the count threshold; timer flush after `flush_interval`; 204 and 202 both count as success; a 413 halves the batch and the next POST carries ≤ 100 entries. |
| `manifest_limits_applied` | `configure({ max_batch: 50, max_batch_bytes: 65536, flush_interval: 2 s })` → batches obey the lower limits; a manifest asking for 500 is clamped to 200. |
| `queue_bounded_when_unreachable` | With the endpoint returning 503, pushing 6 000 entries keeps at most `MAX_QUEUE_LINES` and ≤ `MAX_QUEUE_BYTES`; the drop counter entry is emitted once per flush. |
| `per_source_rate_limit` | 1 000 `server` entries in 100 ms → 200 shipped + one counter entry. |

`activity.rs`
| Test | Asserts |
|---|---|
| `idle_notice_once_per_deadline` | `idleStopAt = now + 240 s` → `[IdleStopIn{240}]`; the same deadline again → `[]`; `idleStopAt = now + 600 s` (keepalive) → `[]`; later, that deadline within lead → one more `IdleStopIn`. |
| `cap_notice_lead` | `sessionCapAt = now + 31 min` → `[]`; `now + 29 min` → `[SessionCapIn{1740}]`; again → `[]`; `null` → `[]`. |
| `stop_directive_once` | `stop: true` → `stop_requested()` true; a second directive does not re-trigger; no `Stopping` body is ever emitted by the policy. |
| `ping_marks_busy_active` | `busy = true` or `phase != Ready` → `last_input_at == Some(now)`; ready and idle → the server's value; `busy`/`phase`/`cpu_busy_pct` present in the serialised JSON (D13). |
| `cpu_sampler` | `parse_stat_line("cpu  100 0 100 700 100 0 0 0 0 0")` → busy 200, total 1000; two samples `(200,1000)` → `(300,1200)` give `50.0`; the first `sample()` is `None`; a garbage line → `None`. |

`config.rs`: `missing_required_is_error` (each of `ZS_CONTROL_URL`-or-`ZS_CONTROL_PLANE_URL`, `ZS_SANDBOX_TOKEN`, `ZS_SANDBOX_NAME`, `ZS_WORKSPACE_ID`, `ZS_BUILD_ID`), `control_url_forms` (`ZS_CONTROL_URL=https://x/api/` → `https://x/api`; only `ZS_CONTROL_PLANE_URL=https://x` → `https://x/api`; both set → `ZS_CONTROL_URL` wins), `defaults_applied` (8445, 8450, slots `[8444, 8447, 8448, 8449]`, `INFRA_PORTS` has 8 entries incl. 8446), `local_api_must_be_loopback`, `server_control_must_be_loopback`, `secret_debug_is_redacted`, `sandbox_api_url_joins`.

`server.rs`: `command_line_matches_serve_args` – `ServerSpec::command()` argv equals the b2 §3.9 flags in order including `--allowed-origin https://zs.example.com`, `--control-secret-file <run>/control.secret`, `--control-listen 127.0.0.1:8446`, `--supervisor-url http://127.0.0.1:8450`; the env lacks `ZS_SANDBOX_TOKEN`/`ZS_CONTROL_URL`/`ZS_CONTROL_PLANE_URL`/`ZS_BYPASS_SECRET`/`ZS_CONTROL_SECRET` and contains `ZS_SUPERVISOR_URL=http://127.0.0.1:8450`, `ZS_CONTROL_SECRET_FILE`, `SHELL`, `USER` (D18, b3 §7.10); `ports_body_maps_null_url` – `Forward { url: None }` → `"url": ""`; `extensions_body_shape` – `{"install":["toml"]}`; `control_targets` – lifecycle/ports/extensions go to `127.0.0.1:8446`, health to `127.0.0.1:8443`.

`proxy.rs`: `strip_hop_by_hop_keeps_upgrade_and_readds_connection` (`Connection: keep-alive`, `Transfer-Encoding` removed; `Upgrade`, `Sec-WebSocket-Key` kept; result contains `Connection: upgrade`); `no_upgrade_no_connection_header`; `strip_port_cookie` (`a=1; zs_port_session=T; b=2` → `a=1; b=2`; only ours → `None`); `upstream_ip_prefers_v4` (`(true,true)` → 127.0.0.1; `(false,true)` → ::1).

`warm.rs`: `probe_file_selection` (tempdir with `src/main.rs`, `node_modules/x.ts`, `web/app.ts`, `README.md` → `src/main.rs`, `web/app.ts`, `README.md`; `node_modules` skipped; ≤ WARM_MAX_FILES); `hello_frame_shape` (serialises to `{"type":"hello","protocol":1,…,"client":"desktop","epoch":null}` – b1 §4.2 field names); `envelope_framing_roundtrip` (`AddWorktree` → `u32 LE len || prost` → decode → same; an envelope whose oneof tag is unknown decodes with `payload == None`); `warm_token_claims` (decodes with `jsonwebtoken` under the generated public key: `iss`, `aud`, `sub`, `ws`, `sid`, `jti`, `exp - iat == 900`; the token is an RFC 2616 token string).

### 6.2 Integration tests (`sandbox/supervisor/tests/`, `#[tokio::test(flavor = "multi_thread")]`, loopback only)

`proxy_roundtrip.rs`: in-process upstream on `127.0.0.1:0` that echoes `method path query` and, for `Upgrade: websocket`, performs a **strict** handshake (requires `Connection: upgrade` and `Sec-WebSocket-Key`, answers 4xx otherwise – what tungstenite/Node do) then echoes frames; plus a second upstream bound to `[::1]:0` only. Two slots are run on ephemeral ports (`ProxyConfig.listen` overridden) sharing one `bootstrap` codec keyed by a test secret. Cases: no cookie → 401 JSON; `/__zs/auth?zs_port_token=<valid for port P>&next=/a?b=1` on an unbound slot → binds the slot, 303 `Location: /a?b=1` and `Set-Cookie`; with cookie → 200 body equals `GET /a?b=1`, upstream saw `Host: 127.0.0.1:<port>`, `X-Forwarded-Port`, and no `zs_port_session` in `Cookie`; websocket upgrade with cookie → 101 and a 3-frame echo through `copy_bidirectional` (fails if `Connection: upgrade` is not re-added); 300 concurrent idle WebSockets do not block a plain request (permit released at 101); v6-only upstream → 200; expired bootstrap → 401 with `Max-Age=0` cookie; a token for another port on the bound slot → 401 `port_session_stale`; the same token on the second (unbound) slot → 303 and the second slot binds; cookie for a closed port → 502 `upstream_unavailable`; `next=//evil` → 303 to `/`; `forwards.remove(P)` → the slot unbinds and the old cookie gets 404 `slot_unbound`; an ES256 JWT in `zs_port_token` → 401 `Malformed`.

`api.rs`: run `api::run` with a fake `ControlPlane` (in-process hyper serving §4.2 routes, incl. a `null` url, a `409 slots_exhausted`, a 403 on git-token for a foreign path, and recording `/extensions`) and a fake server (`ServerControl` pointed at an in-process recorder). Cases: `/health` 503 while `booting` **with** `phase`/`lastError` in the body, 200 with `status == "ready"` after `set_status(Ready)`, 200 with `status == "degraded"` after `Degraded`; `route(Listener::Health, peer = 10.0.0.1:1, GET /health)` includes `lastError`, `listening`, `server.health` and omits `forwards`; `route(Listener::Health, 127.0.0.1, …)` includes `forwards`; `route(Listener::Health, …, POST /ports)` → 404; `POST /ports` on `Local` without bearer → 401, valid → 200 `{url}` and the recorder received `/control/ports` containing the new forward with its slot bound; `null` url → `{"url":null}` and the recorder saw `"url":""`; the fake's 409 → 409 `{"error":"slots_exhausted"}`; `DELETE /ports/3000` → 204 and forwards empty; `POST /extensions {"installed":[...]}` → 204 and the fake control plane received the relay; `POST /git-token` with bearer → creds from the fake (`expiresAt` as seconds), foreign path → 403, without bearer → 401.

`port_watcher_live.rs` (`#[cfg(target_os = "linux")]`): bind `TcpListener` on `127.0.0.1:0`; `ports::scan(0)` contains the port with `loopback_only == true`; `resolve_owners([inode])` returns the test process's pid and `comm`; `owner_of_port(port)` returns the same pid.

`start_against_fake_server.rs` (runs when `ZS_RUN_START_INTEGRATION=1`, which CI sets): spawns `env!("CARGO_BIN_EXE_zs-agent") start` with `ZS_SERVER_BIN=sandbox/image/test/fake-zed-remote-server.py`, `ZS_CONTROL_URL` pointing at an in-process mock (same routes as §3.22), a temp `ZS_WORKSPACES_DIR`/`ZS_STATE_DIR`/`ZS_DATA_DIR`/`HOME`, ephemeral `ZS_HEALTH_LISTEN`/`ZS_LOCAL_API_LISTEN`/`ZS_RPC_LISTEN`/`ZS_SERVER_CONTROL_LISTEN` and `ZS_PROXY_BIND_IP=127.0.0.1`, and a fixture bare repo (`file://`). Cases: (a) happy path – `/health` answers 503 `phase: manifest` **before** the mock has served the manifest (listeners first); pings arrive **before** the clone finishes (`phase != ready`, `busy`, `lastInputAt == now`, `cpuBusyPct` present from the second ping); the fake server's `/health` answers within 5 s of the clone while `postCreateCommand` (a 3 s sleep) is still running; the fake received `/control/extensions {"install":["toml"]}` and, because the state dir has `first-boot.done` pre-seeded in a second run, `/control/lifecycle {"kind":"resumed"}` right after health (not in the first run); health reaches `phase ready` within 30 s; the repo is at `workspaceDir` with `clone.done`; `.post-create` exists and `post-create.done` holds `sha256:` of the file; the fake's environment (`/__fake/state.env`) has no `ZS_CONTROL_SECRET`, has `ZS_CONTROL_SECRET_FILE` pointing at a 0600 file whose contents equal the bearer the agent used, `SHELL`, `USER`; the fake's argv contains `--control-secret-file`, `--control-listen`, `--supervisor-url`, `--allowed-origin`; a directive with `idleStopAt = now + 200 s` → `{"kind":"idle_stop_in"}` exactly once over three pings; `SIGTERM` → fake receives `{"kind":"stopping"}` (answered after its 0.5 s delay) then `SIGTERM`; agent exits 0 within 10 s; mock received a final `/logs` batch containing `shutdown complete`. (b) `SIGTERM` during clone (mock serves a `cloneUrl` whose `git fetch` blocks on a never-answering local TCP listener): agent exits 0 within 10 s, `workspaceDir` does not exist, `.partial` is gone; a second `start` clones cleanly. (c) restart recovery: start the fake server by hand on the RPC and control ports with `--linger-child`, then `zs-agent start` → `stale_server_killed` logged for both ports, the lingering `sleep` is gone, the agent's own server comes up. (d) crash handling: `POST /__fake/crash` makes the fake exit 1 with a lingering child → the child is killed before respawn, `restarts == 1`, the mock received a `client-errors` report with `kind: "server_crash"`; six crashes in a row → `crashLoop == true`, `status == "degraded"`. (e) `stop: true` directive → the agent runs the stop sequence and exits 0 without any signal. (f) rebuild restore: mock serves `restore.tarballUrl` (its own `/__blob/` route, asserting no bearer) with a sha256 → the tree is in place, postCreate is skipped (marker from the archive is **not** trusted: markers live in `ZS_STATE_DIR`, which a rebuild starts fresh, so postCreate **does** run once – asserted), settings from the manifest overwrite the archive's; a wrong sha256 → exit 4. (g) `ZS_PREBUILD=1 zs-agent prebuild` with the fake server (which accepts the warm-up's `/rpc` upgrade and answers `hello_ack` + `RemoteStarted` + `AddWorktreeResponse` + `OpenBufferResponse` and emits two `UpdateLanguageServer`) → exit 0 within the budget, no activity pings, `post-create.done` written, `/__fake/state.warm` lists the opened files, no `SaveClientState` seen, `key-warm.pem` removed afterwards; `ZS_PREBUILD=1 zs-agent start` → exit 2.

`warm_against_serve.rs` (runs when `ZS_RUN_WARM_INTEGRATION=1` **and** `../../zed/target/…/remote_server` exists; CI's `agent-tests` job skips it, the `image` job's real-server `run-local.sh` covers the same path): spawns the real `remote_server serve` with b2's fixture keys and `tests/fixtures/control_secret`, then `zs-agent warm --private-key <fixture private> …` on a tempdir with `main.rs` and `app.py` → exit 0, `servers_seen` non-empty within 60 s (`rust-analyzer` from PATH), and the server log shows no `SaveClientState`.

`proto_tags.rs`: see §3.2a.

### 6.3 Image tests

`sandbox/image/test/run-local.sh` (§3.24) is the acceptance test; CI runs it in `--fake-server` mode **and** against the real `serve` binary from the `server` job's artifact (§3.25), so the real `/health`, `/control/*` (on 8446), `--control-secret-file` and `POST /control/extensions` paths are exercised on every push.

## 7. Risks and open questions

1. **`HOME=/vercel`, not `/home/ubuntu`** – resolved. The universal image re-homes `ubuntu` to `/vercel`, so Zed's data dir is `/vercel/.local/share/zed` and the state dir `/vercel/.zs`; b4:81 now says the same. Both are on the snapshotted root filesystem, and D9 puts the data dir into the rebuild tarball. `run-local.sh` step (6) asserts it.
2. **Two cloners** – resolved by D19/b9 §4.8: `Sandbox.create` never passes a git `source`; the supervisor is the only cloner (`materialize_repo`, credential helper).
3. **Manifest and route contract drift** – resolved in the other direction. b9 rewrote its sandbox contract around this brief's first draft while this brief had adopted b9's first draft; §4 now adopts what b9 implements (`ZS_CONTROL_URL`, HMAC port tokens, `ActivityDirective`, JSON `LogBatch`, `git-token {host, protocol, path}`, `restore.tarballUrl`, `allowedOrigins`, `session`, `portSessionSecret`) and `docs/contracts/` (§3.26) is the shared source both test suites load. The remaining asks of b9 are item 4.
4. **Asks of b9 (all consequences of D8/D13/D18/D19, none blocking a first boot):** (a) declare the four proxy slots `8444, 8447, 8448, 8449` at create (`ports: [8443, 8444, 8445, 8447, 8448, 8449, ...pool]`, 14 ≤ 15) and allocate one per private forward, refusing with `409 slots_exhausted` (D8); (b) emit `slot` on `ForwardView` (manifest, `POST /ports` response) – until then the proxy binds slots from the first token it sees (§3.11); (c) redirect `/open` to `https://<slot-host>/__zs/auth?zs_port_token=…&next=/` (D8 parameter name; b9:1120 has `?t=`) with the slot host of the forward's slot; (d) exclude the whole infra set `{8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450}` in `verifyPortSession` and the ports routes (b9 excludes three); (e) accept `busy`, `phase`, `cpuBusyPct` in `activityReport` and honour `busy`/non-ready `phase` as activity in `idleStopAt` (D13; zod strips unknown keys today, so nothing breaks meanwhile – the `lastInputAt = now` while busy workaround stays until then); (f) add `forwards: ForwardView[]` to `ActivityDirective` so dashboard-initiated forwards/unforwards reach the sandbox (without it a dashboard unforward leaves the slot bound until the next boot); (g) add `POST /api/sandboxes/{name}/extensions { installed }` → 204 feeding `workspaces.installed_extensions` (D19 "consume the installed-extensions relay"); (h) load `docs/contracts/fixtures/manifest.example.json` and `port-token.vector.json` in `tests/manifest.test.ts`/`tests/port-session.test.ts` instead of private copies (D19); (i) `stepArchiveWorkspaceDir` is fine as is (D9) – note that a rebuild tarball restored into a **fresh** state dir makes `postCreateCommand` run again (markers are not archived), which is the intended "rebuild" semantics.
5. **Port map** (D5 vs D8; b4 §7 item 20). D8's "8444 to 8447" cannot hold beside D5's `127.0.0.1:8446` control listener and the 8445 health listener on Linux (§3.3). This brief's map – slots `8444, 8447, 8448, 8449`, health 8445, control 8446, supervisor API `127.0.0.1:8450` – honours D5/D18 literally, D8's slot count/allocation/naming, BUILD-SPEC 6.2's health port and b4's request to move the loopback API off 8446 and export it as `ZS_SUPERVISOR_URL`. It needs the tech lead's confirmation (or a different map – every port is one constant in §3.3 and one entry in b9's create call). Listed as unresolved in §9.
6. **Language-server versions and extension binary names are unverified offline**: `GOPLS_VERSION`, `LUA_LS_VERSION`, `RUFF_VERSION`, the npm majors, and the `which` names used by the TOML/Lua/Dockerfile extensions come from memory of `zed-industries/extensions` (`TAPLO_VERSION` 0.10.0 and its asset name are verified). The image build fails loudly on a bad version; a Renovate rule for the `ARG` lines is recommended.
7. **TypeScript and ESLint are not PATH-resolved by Zed** (`typescript.rs:664`, `eslint.rs:81` have no `check_if_user_installed`), and node servers Zed installs are re-checked against npm's latest (`json.rs:185-215`), so image preinstalls of those only serve users' tooling; first-open latency for TS/ESLint is now the prebuild warm-up's job (§3.16a seeds `languages_dir()` into the snapshot). Workspaces created without a prebuild still download on first open.
8. **Static musl build not executed here** (no cargo build permitted). The graph is `ring` (via reqwest) + pure-Rust `p256` (via jsonwebtoken `rust_crypto`) + `tungstenite` without TLS; no `aws-lc-sys`, no C++ beyond `ring`'s C, which `bundle-linux` already builds under `musl-gcc`. If `agent-builder` still fails, the fallback is `reqwest` `rustls-tls-native-roots-no-provider` plus an explicit provider install – confined to `Cargo.toml` and `control_plane.rs`.
9. **Idle policy during bootstrap.** D13 makes the control plane honour `busy`/`phase`; until b9 implements it (item 4e) the relay also reports `lastInputAt = now` while `busy || phase != ready` so b9's current `idleStopAt` formula cannot stop a 30-minute `postCreateCommand`. Remove the workaround once b9 lands D13.
10. **Stop budget** – resolved by D18 and b9 §4.8: b9 waits on the supervisor command's exit (≤ 25 s); this brief's worst case is ≈ 21 s with the 7 s stopping request (> b4's 5 s flush) and 10 s `TERM_GRACE`. D13's "never on fixed sleeps" is satisfied on both sides.
11. **Health polling target** – resolved: b9 polls 8445 (`probeHealth`), so the non-loopback body now carries everything `HealthProbe` reads (§4.4); only forward URLs stay loopback-gated. The earlier "minimal public body" is superseded (§8 R2-10).
12. **JWT public keys** come only from the manifest (b9 §3.11 rotation-on-next-start; b2 §7.13 agrees); BUILD-SPEC 4.3's env-variable wording should be updated. No env fallback exists.
13. **`runCommand({ detached: true })` process lifetime.** Not documented whether dropping the SDK `Command` handle kills the detached process. The agent does not depend on the handle; if Vercel does kill it, the fallback is `runCommand('sh', ['-c', 'setsid -f zs-agent start'])`. Measure in month one (BUILD-SPEC 15.3 window).
14. **Prebuild LSP warm-up** – owned here per D14 (§3.16a). Risks: the warm-up client speaks b1's wire format and b2's Hello/HelloAck; a change to either breaks `warm_against_serve.rs` (skipped when the checkout is absent – CI's `image` job runs the real-server `run-local.sh`, which should gain a `prebuild` pass once b2's `serve` builds); the minimal `.proto` copies tag numbers (`proto_tags.rs` guards drift); which servers actually start depends on the probe-file table and on Zed's adapters being able to download inside the sandbox's network policy (b4 §7.11: `api.zed.dev` / GitHub releases must be reachable during prebuild). The warm-up never sends `SaveClientState` (b4 §3.15 item 7).
15. **Extension reinstall hand-off** – resolved by D5/b4 §4.2: `POST /control/extensions {"install": […]}` after the server is healthy; `pending.json` is gone.
16. **Rebuild loses the data dir** – resolved by D9: the tarball carries exactly `/workspaces` and `$HOME/.local/share/zed`, extracted at `/` (§3.14 `restore_tarball`; b9 §3.19 archives exactly those two paths, `archive_paths_are_exactly_d9`). `$HOME/.config/zed` is not archived – `write_settings` (§3.14) re-materialises it from the manifest; `restore_tarball` still maps a `vercel/.config/zed` entry when a pre-D9 archive carries one.
17. **Unsaved buffers on stop** – resolved by D6 on the client side (dirty buffers go into the client-state image during the `STOPPING` window); this brief's part is the 7 s stopping request that outlasts b4's 5 s flush wait.
18. **Private dotfiles repositories.** The credential helper mints GitHub App installation tokens scoped to the workspace repository (b9 §4.2), which cannot read a personal dotfiles repo; `install_dotfiles` fails non-fatally with `lastError`. Either b9 mints a user OAuth token for `dotfiles.repoUrl` or the dashboard requires a public repo.
19. **Repository layout.** BUILD-SPEC 11.1 puts supervisor sources under `sandbox/image/`; this brief uses `sandbox/supervisor/` beside it (the image directory then holds only image inputs). Update the spec or move the crate – mechanical either way.
20. **Devcontainer image builder** – assigned to brief b10 by D14; repos with `build.dockerfile` are not accepted until it exists.
21. **Registry pull auth.** Pulling `vcr.vercel.com/vercel/sandbox/universal` requires `vercel vcr login docker` even without pushing (VCR docs); `build.sh` logs in whenever `base.lock` points at VCR, and CI logs in explicitly. If the login token is unavailable on a developer machine, `--source release` still needs the base, so there is no fully offline build.
22. **`vercel vcr image ls --format json` shape is undocumented**; the readiness poll assumes the REST field names and prints the raw payload on failure (§3.21). Verify on the first CI run.
23. **Loopback-only routes.** They live on an undeclared port (8450), so Vercel's ingress cannot reach them whatever peer address it presents, and every route requires the control secret. The secret is a 0600 file readable by uid 1000 (`ZS_CONTROL_SECRET_FILE`), which every process in the VM is – no privilege boundary is claimed inside the VM (b4 §7.19, W6 review); what D18 buys is that no environment dump (crash reports, `printenv` in a terminal, a child's `/proc/*/environ` in logs) contains the secret.
24. **Docker inside the sandbox** is installed but not started; whether `dockerd` should be a manifest-driven optional service is open. Running it costs memory in every workspace.
25. **Log volume**: bounded by entry/message/queue caps and a 200 entries/s per-source bucket (§3.6); b9's ingest limit is 120 requests/min, which 5 s batches respect (12/min). If a workspace exceeds the bucket persistently, only counters reach the control plane.
26. **`RESUMED` delivery** – resolved by b4 §3.10: the supervisor posts `{"kind":"resumed"}` once the server is healthy and the server holds it (`pending_resumed`) until a session attaches, replaying it once (`replay_after_attach`), so the draft's held-notice logic is gone. Whether the client shows it depends on b2's fresh-vs-reconnect semantics (D3) only insofar as the notice is delivered to whichever session attaches first.
27. **`zed/` is not yet a submodule**; the CI checkout of the fork depends on `vars.ZED_FORK_REPO`. Until the fork is pushed, the `server` and `image` jobs cannot run at all, and the `paths: ["zed"]` trigger is inert.
28. **`ZS_CONTROL_URL` vs `ZS_CONTROL_PLANE_URL`.** b9 sets `ZS_CONTROL_URL` (origin + `/api`); the previous revision of this brief read `ZS_CONTROL_PLANE_URL` (origin). Both are accepted (§3.3) so either side can land first; the contract file names `ZS_CONTROL_URL` as canonical. No decision covers the name – flagged in §9.
29. **In-place server upgrade on resume** (b9 §7 item 9): a future `manifest.build != ZS_BUILD_ID` step that downloads the matching `zed-remote-server` from the control plane before spawning. Not designed here; `Config.server_bin` and `ServerSpec.bin` are the seams.

## 8. Review log

Two adversarial reviews (R1 "major", R2 "blocking") on the first draft, then the cross-brief reconciliation of §9. Each finding was checked against the code, registry and documents before acting; "accepted" means the brief changed as the reviewer proposed (possibly with a different mechanism), "rejected" means the claim was found wrong or the proposal not taken. Where §9 later changed a disposition, the entry says so.

R1 wrong claims

1. reqwest `rustls-tls-native-roots` → aws-lc-rs: **accepted**. `reqwest-0.12.24/Cargo.toml` maps the feature to `__rustls-ring` and declares rustls without default features, so `zs-agent` builds `ring`, never `aws-lc-sys`. §5 justification and risk 8 rewritten; the old "fallback" was a no-op.
2. Registry versions (tokio 1.45, tokio-util 0.7.15, tracing 0.1.41, tracing-subscriber 0.3.19 absent): **accepted**. Registry holds tokio 1.52/1.53, tokio-util 0.7.18/19, tracing 0.1.43/44, tracing-subscriber 0.3.22/23; §5 now pins those and §2 lists what is present. (R1's aside that `secrecy` is absent is wrong: `secrecy-0.10.3` is in the registry; used in §5.)
3. taplo asset `taplo-full-linux-x86_64.gz`: **accepted**. GitHub release 0.10.0 has `taplo-linux-x86_64.gz` only; Dockerfile fixed.
4. `USER root` keeps `HOME=/vercel`: **accepted**. Universal Dockerfile line 77 persists `ENV HOME=/vercel` and 82 writes `/vercel/.npmrc`; the final stage now sets `HOME=/root`, `NPM_CONFIG_PREFIX=/usr/local`, `GOCACHE`/`GOPATH` under `/tmp`, restores `HOME=/vercel`, `chown -R ubuntu /vercel`, and `run-local.sh` step (10) asserts `npm i -g`/`go` work as ubuntu.
5. `${push:---load}` expands to `1`: **accepted** (bash `${var:-word}` semantics). `build.sh` uses an `output=(--push|--load)` array.
6. VCR pull needs login even without `--push`: **accepted**. Docs say pulls happen "after authenticating as their own team"; `build.sh` logs in whenever `base.lock` is a VCR ref, CI has an explicit login step, risk 21 records it.
7. `typescript.rs:612-660` / `EsLintLspAdapter` location: **accepted**. Anchors corrected to `typescript.rs:607, 664` and `eslint.rs:35, 81`.
8. BUILD-SPEC 6.1 item 5 never says `/home/ubuntu`: **accepted**. Only b4:67 did (since corrected by b4); §2 and risk 1 re-attributed.
9. `SameSite=Lax` explanation: **accepted**. Lax cookies are sent on cross-site top-level GETs; the first navigation has no cookie because none was set for the host yet. §3.11 text fixed.
10. hyper `TokioIo` / client `with_upgrades`: **accepted** (`hyper-1.7.0` `client/conn/http1.rs:264`, `upgrade.rs:165-175`, `hyper-util` `rt/tokio.rs`). §3.11 steps 4-5 spell out `TokioIo` on the accepted stream, the upstream stream and both `Upgraded` halves, and `tokio::spawn(conn.with_upgrades())` on the client connection. (§9 adds `TokioTimer` for `header_read_timeout`, `http1.rs:336-343`.)
11. `#[derive(Default)]` on `AgentState` with `Instant`: **accepted** (`lock_api` requires `T: Default`; `Instant` has none). `AgentState::new()`.
12. `#[serde(default)]` on `LogSpec`/`ActivitySpec` without `Default`: **accepted** – those fields are back (b9's manifest carries `logs`/`activity`) with explicit `impl Default` (§3.4).
13. `docker exec` without `-i`: **accepted**. Step (9) uses `docker exec -i` for both the helper and `git credential fill`.
14. `zed/` is not a submodule: **accepted**. `/.gitignore:1-2`, no `.gitmodules`; §3.25 states the precondition and checks the fork out explicitly from repository variables; `build-server.sh` fails early when `zed/` is missing; risk 27.
15. CI `server` job package list unverified: **accepted**. The job now runs `./script/linux` and `./script/download-wasi-sdk` exactly as `run_bundling.yml:41-45` does.
16. `vercel vcr image ls` JSON shape unverified: **accepted**. §3.21 says so, keeps `--provenance=false --sbom=false --platform linux/amd64` as load-bearing, tolerates `.images[]` or a bare array, and prints the raw payload on failure; risk 22.
17. `vercel vcr build docker` supports `-- --build-arg`: **accepted**. Documented pass-through; old risk 5 replaced, §3.21 names it as the fallback.
18. `secrecy::SecretString` referenced but not a dependency: **accepted**. `secrecy 0.10.3` (with `serde`) added; the newtype plan dropped.

R1 missing items

- `HealthReport` undefined: **accepted** – defined in §3.8 (the loopback/non-loopback split was later narrowed to `forwards` only, §9).
- `PortsBody` wire struct / `Forward.url` nullability: **accepted** – `PortsBody`/`PortForwardWire` in §3.9 (`None` → `""` for b4).
- `SecretString` Deserialize: **accepted** via `secrecy`'s `serde` feature; `Serialize` is not needed (the helper formats the exposed value).
- `Connection: upgrade` must be re-added: **accepted** – `ensure_connection_upgrade`, unit test and strict-handshake integration upstream.
- `stop_child` pid-vs-group sequencing: **accepted** – SIGTERM to the pid, SIGKILL to the group after grace (always), watcher paused while `stopping`.
- `degraded` returning 503: **accepted** – 200 for ready|degraded, 503 for booting|stopping.
- Fake server not copied into `dist/test`: **accepted** – step (1) copies it.
- corepack duplication / Node 25 removal: **accepted** – corepack step removed; base's pnpm kept; yarn not preinstalled (stated cut).
- Rolling `:latest` base vs pinned digest: **accepted** – `base.lock` + `--update-base`.
- `rand 0.8` vs Zed's `0.9`: **accepted** – rand 0.9.
- `build-server.sh` strip and `--config`: **accepted** – both added.
- `ZS_JWT_PUBLIC_KEYS` fallback had nowhere to live: **accepted** – removed; manifest authoritative (b9 never sets the env).
- `route()` peer address plumbing: **accepted** – `TcpListener::accept()` addr threaded into `service_fn`; listeners distinguished by `Listener`.
- CI `image` job login dependency: **accepted** – explicit `vercel vcr login docker` step.

R2 wrong claims

1. Manifest contract differs from b9 §4.7: **accepted at the time; superseded by §9**. The draft adopted b9's then-manifest; b9 meanwhile adopted this brief's first draft and named it the authority, so §3.4/§4.1 now carry the shape b9 emits (`build: string`, `jwt { issuer, audience, publicKeys }`, `portSessionSecret`, `session`, `restore.tarballUrl`, `env` map, `secretNames`, `logs`, `activity`, `allowedOrigins`, `extensions`, `prebuild`) and §3.26 holds the shared schema + fixtures.
2. `ZS_CONTROL_PLANE_URL` origin + bypass header: **accepted for the header (D18)**; the variable is now `ZS_CONTROL_URL` = origin + `/api` (b9 §3.18) with `ZS_CONTROL_PLANE_URL` accepted as a fallback (§3.3, risk 28).
3. Ports route shape: **accepted, then superseded** – b9 implements `POST { port, visibility, label }` → `{ url, visibility }` and `DELETE …/ports/{port}`; `Forward.url: Option<String>`; `slot` added for D8.
4. Activity ping/response: **accepted, then superseded** – the wire is b9's `ActivityReport` → `ActivityDirective { idleStopAt, sessionCapAt, stop }` plus D13's `busy`/`phase`/`cpuBusyPct`; notices are computed locally (`NoticePolicy`, §3.15). (The reviewer's "b5" attribution in old risk 16 was this brief's error; b9 owns the route.)
5. Logs NDJSON / 202: **accepted, then superseded** – b9 ingests a JSON `LogBatch` (≤ 200 entries / 256 KiB → 204); §3.6 follows it.
6. Git token `expiresAt` ISO / `useHttpPath` pointless: **accepted for the parser; reversed for `useHttpPath`** – b9 now scopes the token to the repository and answers 403 for other paths, so `useHttpPath` is set and the helper sends `{host, protocol, path}`; `expiresAt` is unix seconds with the ISO form tolerated.
7. Private-port bootstrap = ES256 JWT, no HMAC secret in the manifest: **accepted at the time; reversed by §9**. b9 §8 R2-10 showed an ES256 port token is a valid RPC token for b2's verifier, so the bootstrap token is an HMAC `v1.` token under `manifest.portSessionSecret` (§3.10); the proxy cookie stays under a per-boot in-memory key; `zs-agent port-token` mints HMAC tokens. The `/p/<port>/` prefix is still not adopted (D8 uses per-slot hosts).
8. One cookie-bound port per host: **resolved by D8** – four slots, each with its own hostname and cookie (§3.11).
9. `Connection: upgrade`: **accepted** (same as R1).
10. Health on 8445 and loopback routes: **accepted, refined by §9** – b9 polls **8445** (not 8443), so the non-loopback body carries what `HealthProbe` reads; `/ports`, `/extensions`, `/git-token`, `/lifecycle` live on `127.0.0.1:8450` (`ZS_SUPERVISOR_URL`; 8446 is D5's control listener). The optional "full body with a control-plane JWT" was not added.
11. Boot order vs the create health wait: **accepted** – server starts right after the repo exists; dotfiles/postCreate/postStart run beside it with `phase`/`busy` reported (§3.16); b9's 35 min ceiling makes the order a latency matter, not a correctness one.
12. `RESUMED` origin: **accepted with a refinement, then simplified by §9** – `resumed` comes from the `first-boot.done` marker (with `--resumed`/`manifest.session.resumed` as hints); the supervisor posts `Resumed` once after the server is healthy and b4's control channel holds it until a session attaches (b4 §3.10), so no supervisor-side hold exists.
13. Stop budget vs b9's 8 s sleep: **accepted, then re-budgeted by D18** – b9 now waits on the command exit (≤ 25 s); `STOPPING_POST_TIMEOUT` 7 s (> 5 s flush), `TERM_GRACE` 10 s, flush 3 s.
14. Devcontainer hash from the control plane: **accepted** – the supervisor parses the checked-out file and marks with `sha256(file bytes)`; `manifest.devcontainer.configHash` is informational.
15. Env delivery table: **accepted** – §4.6 rewritten per b9 §3.18; `ZS_JWT_PUBLIC_KEYS` removed.
16. `build-server.sh` strip/config: **accepted** (same as R1).
17. `/health` 503 for degraded: **accepted** (same as R1).
18. `materialize_repo`: **accepted** – fetch-by-ref/sha instead of clone+checkout (`repo.ref`, D18); tarball via a presigned URL fetched without credentials; SDK `source` conflict resolved by D19.
19. Single apt layer over 500 MB; corepack/npm as root: **accepted** – four apt layers by family, `docker history` size guard in `build.sh`, npm prefix `/usr/local`, no corepack, `chown` at the end. (The reviewer's "pnpm shadowing at `/vercel/.global/pnpm/bin`" is moot once corepack is gone.)
20. `scrub` misses `zsb_` and `zs_port_token=`: **accepted** – both added, plus the bypass header, `v1.` port tokens and presigned `?token=`.

R2 missing items

- Idle/unhealthy during bootstrap: **accepted** – relay starts after the manifest, reports `busy`/`phase` (now D13), and marks itself active while busy (risk 9).
- SIGTERM during bootstrap: **accepted** – `.partial` + atomic rename, `clone.done` marker, cancellation kills the child group; integration case (b).
- Stale/crashed server cleanup and restart cap: **accepted** – `clear_stale_server` (8443 and 8446), `killpg` before respawn, `CRASH_LOOP_LIMIT`, crash reports to `client-errors`; integration cases (c)/(d).
- `zs-agent prebuild`: **accepted** – subcommand with `ZS_PREBUILD` gating, 50 min budget; the LSP warm-up is now owned here per D14 (§3.16a).
- Extension reinstall: **accepted, mechanism replaced by D5** – `POST /control/extensions` (risk 15).
- `STOPPING` notice double flush: **accepted** – the policy never emits `Stopping`; the stop path posts it once.
- Unsaved buffers on stop: **resolved by D6** (risk 17).
- Rebuild loses `data_dir`: **resolved by D9** (risk 16).
- Log line/entry bounds: **accepted** – `MAX_LINE_BYTES`, `MAX_MSG_BYTES`, `MAX_QUEUE_BYTES`, `LinesCodec::new_with_max_length` (tokio-util `codec`).
- Loopback-only guard: **accepted** – undeclared 8450 listener; every route requires the control secret, which the helper reads from `ZS_CONTROL_SECRET_FILE` (D18: a file, never an environment value).
- `portsAttributes` ranges/regex: **accepted** – `parse_port_key` honours plain ports only, documented.
- IPv6-only upstreams: **accepted** – `upstream_ip` uses the socket table's family flags.
- `MAX_INFLIGHT` starved by WebSockets: **accepted** – permit released at 101, separate `MAX_UPGRADED`, per slot.
- CI never runs the real binary / `ZS_RUN_START_INTEGRATION`: **accepted** – env set in `agent-tests`, `run-local.sh` runs twice in `image` (fake and real).
- Test gaps (strict upgrade upstream, SIGTERM mid-clone, crash with children, second private port, public health body, pings before ready): **accepted** – all in §6 (the "second private port" case now exercises the second slot).
- Budgets not aligned: **accepted** – table in §3.26 (re-aligned to b9 §4.8 and D18 in §9).
- Private dotfiles: **accepted as risk 18**.
- Layout / unowned builder: **accepted as risks 19-20** (the builder is b10 by D14).
- Unstated cuts (.NET, Node matrix, prettier, eslint): **accepted** – §3.19 states each; prettier and eslint are now installed.
- wasm/native regression exposure: **agreed, nothing to do** – no crate under `zed/` changes.

## 9. Reconciliation log

Amended 2026-09-02 against `docs/briefs/DECISIONS.md` (D1-D20) and every sibling brief's sections 7 and 8 (each of b1-b9 was grepped for `b8`; b5, b6 and b7 address nothing to this brief – b5 §9 notes that this brief's earlier "b5" attribution was retracted in §8 R2-4). Every change was checked against the code under `zed/` and the local registry (§2). Line numbers of sibling briefs are as they stand now.

| Item | Impact on this brief | What changed |
|---|---|---|
| D1 identity | `session_id` is per-connect and informational; `workspace_id` is the identity. | `LogBatch.sessionId` is the sandbox session id from `manifest.session.id`, never a client `sid`; the server's `sid` (from `/health.session`) travels only as `ActivityReport.sid` / a log field (§3.6, §3.15). The warm-up client mints its own `sid = "warm-<jti>"` (§3.16a). |
| D2 reconnect budget | None (client). | – |
| D3 session semantics | Fresh sessions reset the project; PTYs survive; 4001/4005/1001; `Heartbeat` every 5 s from the client; 16 MiB. | Stop sequence relies on the server's own SIGTERM flush + 1001 (§3.9); `killpg` stays as the backstop for PTY/LSP orphans. The warm-up client sends `Heartbeat` every 5 s and frames ≤ 16 MiB (§3.16a). `RESUMED` no longer held by the supervisor (b4 holds it), §3.15. |
| D4 terminal restore | None. | – |
| D5 control listener | `serve --control-secret-file`, `--control-listen 127.0.0.1:8446`, routes `/control/{lifecycle,ports,extensions}`, `--allowed-origin` from `manifest.allowedOrigins`. | `ServerSpec` gains `control_secret_file`, `control_listen`, `supervisor_url`, `allowed_origins`; `command()` line rewritten (§3.9); `ServerControl` splits `health_base` (8443) from `control_base` (8446); `post_extensions` added; `clear_stale_server` also frees 8446; `extension_install_list` → `POST /control/extensions` replaces `write_pending_extensions`/`pending.json` (§3.14, §3.16 step 5); §4.3 rewritten; fake server and tests updated (§3.23, §6). |
| D6 unsaved buffers | Client-side; the supervisor's stopping request must outlast the flush. | `STOPPING_POST_TIMEOUT` 2.5 s → 7 s (§3.9); risk 17 closed. |
| D7 client-state store | None directly. | Noted that `server_state/client_state` is inside the D9 tarball (§2). |
| D8 private ports | Four proxy slots declared at create, one per private forward, `zs_port_session` HMAC cookie, `/open` → `https://<slot-host>/__zs/auth?zs_port_token=…&next=/`. | `PROXY_SLOTS = [8444, 8447, 8448, 8449]` (§3.3; see the port-map row below); proxy rewritten per slot with slot binding from `forwards[].slot` or the first valid token (§3.11, `ForwardsState` §3.8); `Forward.slot` and `ForwardResponse.slot` (§3.4, §3.5); `409 slots_exhausted` relay (§3.12); the "one private port per browser" limitation and old §7 item 5 removed; `ProxyArgs` per slot (§3.17); mock allocates slots (§3.22); `run-local.sh` maps the slot ports and tests two slots (§3.24); tests §6.1/§6.2; asks to b9 in §7 item 4 (a)-(d). |
| D9 rebuild tarball | `/workspaces` + `$HOME/.local/share/zed` (+ b9 adds `$HOME/.config/zed`), extracted at `/`. | `restore_tarball` stages the archive and maps `workspaces/`, `vercel/.local/share/zed`, `vercel/.config/zed` into place before the server starts (§3.14); `RestoreSpec { tarballUrl, sha256 }` presigned, fetched with a header-less client (§3.5); `write_settings` runs after the restore (§3.16 step 3); tests `restore_layout_mapping`, integration (f), `run-local.sh` step (13); risk 16 closed. |
| D10 vendored deps | No `<org>` placeholder anywhere. | §3.25 wording: the fork repository comes from `vars.ZED_FORK_REPO`; no placeholder committed. |
| D11 wasm home | None. | – |
| D12 web keymap | None. | – |
| D13 activity ping | `lastInputAt`, `busy`, `phase`, `cpuBusyPct`; control plane honours busy/phase and waits on health. | `ActivityReport` = b9's zod fields + `busy`, `phase`, `cpuBusyPct` (§3.5); `CpuSampler` over `/proc/stat` (§3.15, test `cpu_sampler`); the `lastInputAt = now` while busy workaround kept until b9 lands D13 (risk 9, §7 item 4e). |
| D14 prebuild and devcontainer | `zs-agent prebuild` with a headless LSP warm-up is this brief's; the image builder is b10. | New §3.16a `warm.rs` (wire client per b1 §4.2/b2 §3.7, ephemeral ES256 key, minimal prost schema §3.2a, `proto_tags.rs` drift guard), `Phase::Warm`, `WARM_BUDGET`, hidden `zs-agent warm` (§3.17), deps `prost`/`prost-build`/`protox`/`tokio-tungstenite`/`futures-util` (§5), tests §6.1 `warm.rs`, §6.2 (g) and `warm_against_serve.rs`; b4 §3.15 item 7 honoured (no `SaveClientState`; `POST /control/extensions` during prebuild); risks 14/20 rewritten; the builder references now say b10. |
| D15 AI proxy | None. | – |
| D16 shell entry point | None. | – |
| D17 terminal ownership | None. | – |
| D18 supervisor contract | No `ZS_CONTROL_SECRET` (file), control calls to `127.0.0.1:8446`, `POST /extensions` relay, `repo.ref`, settings `Value::String` verbatim, bypass header, stopping budget > 5 s, `cpuBusyPct`. | `write_control_secret` → `run/control.secret` 0600 + `--control-secret-file`; `ZS_CONTROL_SECRET` removed from every env table, spawn line and test (`ZS_CONTROL_SECRET_FILE` path exported instead; helper reads the file, §3.13); `ServerControl.control_base = 127.0.0.1:8446`; local API `POST /extensions` → `ControlPlane::report_extensions` (§3.12, §3.5); `RepoSpec.git_ref` honoured first in `materialize_repo` (§3.14, test `refspec_selection`); `write_settings` verbatim with a content-hash marker (no `version` field in b9's manifest); bypass header unchanged; `STOPPING_POST_TIMEOUT` 7 s, `TERM_GRACE` 10 s, flush 3 s (§3.9, §3.16 step 8, §3.26 budgets); `cpuBusyPct` as under D13. Image `ENV` gains `ZS_CONTROL_SECRET_FILE`, `SHELL`; `run-local.sh` asserts the absence of `ZS_CONTROL_SECRET` and the 0600 file. |
| D19 control-plane contract | No git source; tarball per D9; consume the extensions relay; fixture at `docs/contracts/fixtures/manifest.example.json`; honour D13. | Risk 2 closed; fixture path unchanged and now also `port-token.vector.json` (§3.26); the relay route `POST /api/sandboxes/{name}/extensions` defined in §4.2 and asked of b9 (§7 item 4g). |
| D20 serve contract | `is_input_envelope` exclusions define `last_input_at`; `Heartbeat` is not input. | §2 row; `ActivityReport.last_input_at` documented as b2's `/health.last_input_at` (§3.15); the warm-up's heartbeats do not count as input (§3.16a). |
| b2 §7.13 / §2 row 86 / §3.9 | Spawn line: `--allowed-origin`, `--control-secret-file`, `--control-listen`, `--supervisor-url`; stop exporting `ZS_CONTROL_SECRET`; serve scrubs a leftover; `ZS_LISTENING=`/`ZS_CONTROL_LISTENING=` on stdout; `HealthResponse` gained `dirty_buffers`/`auth_failures`; `ServeLogRecord` has `session_id`/`epoch`. | `ServerSpec::command()` (§3.9); stdout piped and parsed; `ServerHealth.dirty_buffers`; `entry_from_server` maps `session_id`/`epoch` into `fields` (§3.6, test `server_json_line_mapped`); `build-server.sh` exports `ZS_BUILD_ID` for b2 §3.13 and passes `--features serve` (§3.20); the fake server refuses to start with `ZS_CONTROL_SECRET` set (§3.23); b2's `tests/fixtures/control_secret` reused when present (§6.2). |
| b4 §7 item 8 | `POST /control/extensions` at startup; `forwards.insert` idempotent; loopback API port ≠ 8446 exported as `ZS_SUPERVISOR_URL`; prebuild client must not `SaveClientState`; risk 17 answered by D6. | All applied: §3.14/§3.16 step 5; `ForwardsState::insert` idempotent (test `forwards_slot_binding`); `LOCAL_API_PORT = 8450`, `--supervisor-url` passed explicitly and `ZS_SUPERVISOR_URL` exported (§3.3, §3.9, §3.19); §3.16a never persists. |
| b4 §7 item 20 (port map) | 8446 collision; slots overlap 8445/8446. | Port map table in §3.3; the collision and the chosen map recorded in §7 item 5 and in "Unresolved" below. |
| b4 §3.11/§4.2 | `POST $SUPERVISOR_URL/extensions {installed}` → 204; refused private forward is a non-2xx `{error}`; `null` url → `""`. | `POST /extensions` route (§3.12); 409 relay of control-plane 4xx; `PortForwardWire` unchanged. |
| b3 §7.10 | Export `SHELL` (and `HOME`, `USER`); no secrets in the server env. | `SHELL=/bin/bash` in the image `ENV` and filled by the supervisor when missing, `USER=ubuntu` likewise, `HOME` inherited (§3.3, §3.9, §3.19); asserted by `command_line_matches_serve_args` and `run-local.sh` step (6). |
| b9 §2 rows 44-49, §8 R2-1 | b9 adopted this brief's first draft (`ZS_CONTROL_URL` incl. `/api`; `zs-agent resume`; old manifest; `ActivityDirective`; `LogBatch`; git-token body; HMAC port tokens; 8445 health polling; `TERM_GRACE` 10 s) and made this brief the authority. | §3.3 reads `ZS_CONTROL_URL` (fallback `ZS_CONTROL_PLANE_URL`); `zs-agent resume` = `start --resumed` (§3.16, §3.17); §3.4/§4.1 manifest = b9 §4.7 + `slot`; `ActivityDirective` + `NoticePolicy` replace the notices relay (§3.5, §3.15); JSON `LogBatch` replaces NDJSON (§3.6); `GitTokenRequest {host, protocol, path}` + `useHttpPath` (§3.5, §3.13, §3.19); HMAC `PortTokenCodec` replaces `BootstrapVerifier`/ES256 (§3.10); health body widened for `probeHealth` (§3.8, §4.4); `TERM_GRACE` 10 s; §4.2/§4.6 rewritten; §8 entries R2-1..7, 10, 12, 13 annotated. |
| b9 §7 item 7 (a)-(g) | `repo.ref`; settings verbatim; `--allowed-origin`; bypass header; `zs-agent prebuild`; extract at `/`; `cpuBusyPct`. | (a) §3.14; (b) §3.14 `write_settings`; (c) §3.9; (d) §3.5 (already); (e) §3.16 + §3.16a; (f) §3.14 `restore_tarball`; (g) §3.15 `CpuSampler`. |
| b9 §7 item 4 (audience) | `serve --audience` from `manifest.jwt.audience`. | `ServerSpec.audience = manifest.jwt.audience`, `issuer = manifest.jwt.issuer` (§3.9). |
| b9 §7 item 9 (in-place upgrade) | Deferred. | Recorded as risk 29 with the seams named. |
| b9 §3.18/§4.8 (health probe on 8445, `waitUntilReady`, stop wait 25 s, prebuild `pb-` principal, create env `ZS_REGION`) | Non-loopback health must carry `lastError`/`listening`/`server.health`; listeners must be up before the manifest; budgets. | Listeners started in step 1, 60 s grace on manifest failure (§3.12, §3.16); `HealthReport` non-loopback = full minus `forwards` (§3.8, §4.4); `Config.region`; prebuild manifest variant (§3.4, §4.1, test `prebuild_manifest_parses`); budgets table (§3.26). |
| b9 §3.12/§6.2 (`port_session_matches_b8_vector`) | b9 pins a vector from this brief's tests. | `docs/contracts/fixtures/port-token.vector.json` + test `port_token_vector` (§3.26, §6.1); §3.10 states the byte-for-byte rules (field order, unpadded base64url, standard-padded secret). |
| b1 §4.2/§4.3, b2 §3.7/§6.4 | Wire format for the warm-up client. | §2 rows; §3.16a mirrors `Hello`/`HelloAck`, the subprotocol token placement, `RemoteStarted` first, `u32 LE len || prost` framing. |
| b5, b6, b7 | Nothing addressed to b8. | – |

Unresolved (needs the tech lead):

1. **Port map (D5 × D8).** D8's literal "8444 to 8447" and D5's `127.0.0.1:8446` control listener (plus the 8445 health port) cannot coexist on Linux; this brief uses slots `8444, 8447, 8448, 8449`, health 8445, control 8446, supervisor API `127.0.0.1:8450`. Confirm, or issue a map; b9's create call and b4's `DEFAULT_SUPERVISOR_URL` comment follow whatever is decided.
2. **`ZS_CONTROL_URL` (b9, origin + `/api`) vs `ZS_CONTROL_PLANE_URL` (this brief's previous revision).** Both accepted here; the contract file declares `ZS_CONTROL_URL` canonical. A one-line decision would let the fallback go.
3. **b9 deltas listed in §7 item 4** (slot declaration/allocation, `slot` on `ForwardView`, `zs_port_token` parameter, full infra-port exclusion, D13 fields honoured, `forwards` in the directive, the `/extensions` relay route, loading the shared fixtures). Each is a consequence of D8/D13/D19; none blocks a first boot, but the private-port and extensions paths are incomplete until b9 lands them.

### Contract pass (2026-09-02)

Cross-brief mismatches found by the CONTRACTS.md audit and fixed here:

- Activity ping `sid`: b2 §3.7 `SessionMeta` has `session_id` (the JWT `sid`), not `sid`; §3.8 `ServerHealth.session` comment and §3.15 step 2 now read `health.session.session_id` (previously the report would always have carried `sid: null`).
- Rebuild tarball: D9 and b9 §3.19 archive exactly `workspaces vercel/.local/share/zed`; §2 (b9 row), §3.14 `restore_tarball` and §7 item 16 no longer describe a third `vercel/.config/zed` path. The tolerant mapping of that entry stays for pre-D9 archives (§6.2 `restore_layout_mapping` and `run-local.sh` step 13 feed a three-path archive on purpose, annotated as such); `write_settings` re-materialises `~/.config/zed` from the manifest either way.
- `ZS_REGION` reaches `zs-agent` from `Sandbox.create({ env })` only (b9 §4.8) — `supervisorEnvFor` (b9 §3.18) re-emits `ZS_SANDBOX_NAME`/`ZS_WORKSPACE_ID` but not `ZS_REGION`; §4.6 splits the row accordingly (no behaviour change: the create env is VM-wide).
