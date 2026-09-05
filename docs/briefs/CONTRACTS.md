> **OVERRIDE NOTICE (2026-09-02).** Decisions v2, items D21 to D34 in DECISIONS.md, override any row below that conflicts with them: the port map (8443 rpc, 8444-8447 private slots, 8448 supervisor health, loopback 8450 supervisor API and 8451 serve control listener), heartbeat direction (server to client), the close-code table (4004 retired, 1001 going away), Hello.instance, the connect response shape, ZS_CONTROL_URL, snake_case lifecycle kinds, and ActivityDirective. Read DECISIONS.md first.

> **Round-1 pins (2026-09-03, tech lead).** (a) `HelloAck.session_id` echoes the JWT `sid`. (b) A stale epoch is refused with close code 4001 and reason `CLOSE_REASON_STALE_EPOCH` (shared constant in `remote::websocket_wire`), which the client maps to exit 90 (fresh session); any other 4001 reason maps to exit 91 (superseded). (c) `Hello.identifier` is the plain connection identifier; the per-boot nonce lives only in `Hello.instance` (D25). (d) Server-to-client `Log` control frames for warn/error stay in v1. (e) `PtyManager` is process-level (installed as an App global by `HeadlessProject::new`, read by serve); D24's accessor-method wording is satisfied by that arrangement.

# CONTRACTS.md — shared contracts between workstreams

> **Round-5 override (2026-09-05, later D43–D45 and owner confirmation).** The
> control plane uses **Drizzle ORM / sqlite-core / libSQL**, deployed on Turso
> (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`); local development uses a SQLite
> file (`ZS_DB_URL`), tests an isolated in-memory libSQL database. Migrations
> are `apps/web/drizzle-sqlite`; old Postgres migrations/dependencies are removed.
> KV, locks and rate limits share this database (`kv`), not Redis.
> User-facing routes resolve the same `user_public` without login.
> The home page manages all workspaces; `GET /new/owner/repo[?branch=…]` creates
> and returns 303 to `/w/id`. HEAD and prefetch do not create. Only public
> GitHub repositories are supported, with no GitHub credentials. The internal
> git-token response has empty `username` and `token`; the supervisor emits no
> credential. Internal sandbox JWTs, signed cookies and cron authentication
> remain. Older Clerk/App/Redis/Postgres wording below is superseded.
> Default shared active/admitted-workspace cap: 5. The subsequent owner-requested
> cleanup removed AI/key storage, billing, admin and custom-image/prebuild code.
> Every repo clones on the base image; the manifest has `devcontainer: null` and
> no injected user secrets. Historical database migrations remain for existing
> data, but obsolete tables are unused. See [deployment setup](../deploy-vercel.md).

Single reference for every value two or more briefs depend on. Sources of truth: `docs/briefs/DECISIONS.md` (D1-D20) and the nine briefs `b1`..`b9` (cited as `b<n> §<section>`; b5 uses numbered change items, cited as `b5 item <n>`). Where two briefs disagree the table shows the value from the brief that owns the item under D20/D18/D19 and marks the row `⚠ M<n>`; every `M<n>` is listed with both positions in §14. Nothing here is invented: every cell cites the section it was read from.

Ownership under the decisions: b1 owns `wire.rs` (constants, control frames, close codes) and the client transport; b2 owns `serve` (CLI, routes, arbitration implementation); b3 owns `terminal.proto` and PTYs; b4 owns `remote_session.proto`, the control channel bodies and client-state; b8 owns the sandbox ↔ control-plane wire (manifest, activity, logs, git-token, ports) and the port map inside the VM; b9 owns the user-facing API and the shell; b7 owns the loader/host contract (`ZsBootConfig`/`ZsHost`); b5/b6/b7 own the wasm build.

---

## 1. Wire protocol (`GET /rpc`)

### 1.1 Constants (`crates/remote/src/transport/websocket/wire.rs`, re-exported as `remote::websocket_wire`)

| Name | Value | Defined | Consumed |
|---|---|---|---|
| `SUBPROTOCOL` | `"zs.v1"` | b1 §3.2 | b2 §3.5 `token_from_subprotocol`, b8 §3.16a |
| `PROTOCOL_VERSION` | `1` (u32) | b1 §3.2 | b2 §3.7 (`protocol != 1` → 4006) |
| `MAX_FRAME_BYTES` | `16 * 1024 * 1024` (16 MiB), inbound ceiling on **both** sides | D3; b1 §3.2, §4.2 | b2 §3.8 `with_max_payload_read(MAX_FRAME_BYTES)`, read buffer `2 * MAX_FRAME_BYTES`; b3 §7.1(c); b4 §3.7 |
| `HEARTBEAT_INTERVAL_SECS` | `5` | D3; b1 §3.2 | b2 §3.7 ⚠ M1; b8 §3.16a `WARM_HEARTBEAT` |
| `ZS_BUILD_ID` | `option_env!("ZS_BUILD_ID")`, kept fresh by `crates/remote/build.rs` (`rerun-if-env-changed`) | b1 §3.2, §3.19; b2 §3.13 | b1 `client_build_id(cx)`, b2 `ServeState.build` |
| `builds_compatible(client, server)` | exact string match unless either side is a dev build (`"dev"` prefix or no `ZS_BUILD_ID`) | b1 §3.2 | b2 §3.7 (`--client-build`), b9 §4.8 `waitUntilReady` |

### 1.2 Token placement and pre-upgrade decisions

| Item | Value | Source |
|---|---|---|
| Native client | header `Sec-WebSocket-Protocol: zs.v1, <jwt>` via yawc `with_request` | b1 §4.3 |
| Browser client | `new WebSocket(url, ["zs.v1", "<jwt>"])` via vendored yawc `connect_with_protocols` (no query string) | b1 §3.18, §4.3; b9 §7.5 |
| JWT charset | RFC 2616 token (`A-Za-z0-9-_.`), else `InvalidToken` before dialing | b1 §3.2 `validate_subprotocol_token` |
| Server token extraction order | 1. `Sec-WebSocket-Protocol` item, 2. `Authorization: Bearer`, 3. `?zs_token=` (`?zs_proto=zs.v1` counts as "offered"). Placements 2-3 on `/rpc` are a documented, unused server-side superset: both client targets send only the subprotocol list, and `?zs_token=` is sent only on `/files` downloads | b2 §3.5 `extract_token`, §4; b1 §3.2, §4.3 |
| Server echo | 101 carries `Sec-WebSocket-Protocol: zs.v1` **only** when offered in the header | b2 §3.8 (d); b1 §4.3 |
| Pre-upgrade rejections | 401 (missing/malformed/expired/bad signature/wrong alg), 403 (aud/iss/ws, disallowed `Origin`), 426 (`zs.v1` not offered). No 409, no 429. | b2 §3.5, §3.8, §4; b1 §7.12(b) |
| `Origin` check | only when `--allowed-origin` non-empty; present-and-not-allowed → 403 `{"error":"origin_not_allowed"}`; absent `Origin` (native/curl) unaffected | b2 §3.8; D5 |
| Auth throttling | `VERIFY_CONCURRENCY = 4`, `AUTH_FAILURE_DELAY = 250 ms` held under the permit; a valid token is never refused | b2 §3.8 |

### 1.3 Framing

| Item | Value | Source |
|---|---|---|
| Binary frame | `u32 LE length || prost(Envelope)` — byte-identical to stdio `write_message`; one envelope per frame | b1 §3.1 `encode_envelope_frame`/`decode_envelope_frame`; b2 §2, §4; BUILD-SPEC §4.4 |
| Text frame | JSON `ControlFrame` (`#[serde(tag = "type", rename_all = "snake_case")]`); first frame in each direction after the upgrade is a control frame | b1 §4.2 |
| Fragmentation / compression | none; `permessage-deflate` never offered by the server | b1 §4.2; b2 §3.8 (d) `without_compression()` |
| Oversize outbound (client) | request envelope > 16 MiB → not sent; local `Error { code: Internal }` response injected with `responding_to = envelope.id` | b1 §3.3 step 4 |
| Oversize outbound (server) | envelope > 16 MiB → `Close(1009)`, session detached | b2 §3.7 step 5 |
| Oversize inbound | native client: yawc ends the stream (peer gets 1009) → reconnect; server: `ReadError` → `FrameTooLarge`, `Close(1009)` | b1 §6.2 test 8; b2 §3.7 |
| Close reason length | ≤ 123 bytes (`MAX_CLOSE_REASON_BYTES`) | b2 §3.7 |
| Client wasm decode offload | `decode_envelope_frame` on `background_spawn` for frames ≥ 64 KiB | b1 §3.3 step 4 |
| Native client yawc options | `max_payload_read` 16 MiB, `max_read_buffer` 32 MiB, `with_backpressure_boundary(1 MiB)`, `with_no_delay()` | b1 §3.3 step 3 |
| Server yawc options | `max_payload_read` 16 MiB, `max_read_buffer` 32 MiB, `without_compression()`, `with_utf8()`, `with_backpressure_boundary(256 KiB)` | b2 §3.8 (d) |

### 1.4 Control frames

`ControlFrame` (b1 §4.2): `Hello`, `HelloAck`, `Log`, `Heartbeat`.

**`Hello`** — client → server, first frame (b1 §4.2; b2 §4 example; b8 §3.16a warm-up client):

| Field | Type | Value / meaning | Source |
|---|---|---|---|
| `protocol` | u32 | `1` | b1 §4.2 |
| `build` | String | `client_build_id()` = `ZS_BUILD_ID` else `AppVersion` | b1 §3.3 |
| `workspace_id` | String | D1 stable identity; == JWT `ws` | b1 §4.2 ⚠ M8 (b2's Hello example omits it) |
| `session_id` | String | per-connect id from the same `/connect` as the token; == JWT `sid` | b1 §4.2; D1 |
| `identifier` | String | `"<RemoteClient unique_identifier>/<instance nonce>"`; nonce `format!("{:x}-{:x}", unix_ms, counter)`; b7 uses `ConnectionIdentifier::setup()` (`setup-N`); warm-up uses `"zs-agent-warm/<nonce>"` | b1 §3.3 step 2, §4.1; b7 §3.28; b8 §3.16a ⚠ M5 |
| `reconnect` | bool | `start_proxy`'s `reconnect` | b1 §4.2 |
| `takeover` | bool | per-attempt, never persisted | b1 §4.1 |
| `client` | `ClientKind` | `"desktop"` \| `"web"` (snake_case) | b1 §4.2 |
| `epoch` | Option<u64> | last `HelloAck.epoch` when `reconnect`, else `null` | b1 §4.2; b2 §4 |

**`HelloAck`** — server → client, first frame (b1 §4.2; b2 §3.7 step 4, §3.9):

| Field | Type | Value | Source |
|---|---|---|---|
| `protocol` | u32 | `1` | b2 §3.7 |
| `build` | String | `ZS_BUILD_ID` else `VERSION` | b2 §3.8 `ServeState.build` |
| `os` | String | `std::env::consts::OS` (`"linux"`) | b2 §3.7 |
| `arch` | String | `consts::ARCH` (`"x86_64"` \| `"aarch64"`) | b2 §3.7 |
| `os_version` | Option<String> | `util::parse_os_release("/etc/os-release")`, `None` on error | b2 §3.9 |
| `shell` | String | `$SHELL` of the server process else `/bin/sh` (`%COMSPEC%` on Windows) | b2 §3.9 |
| `resumed` | bool | `true` iff D3 *reconnect* (warm attach + replay) | b1 §4.2; b2 §3.7 |
| `session_id` | String | JWT `sid` (b2) / echo of `Hello.session_id` (b1) — equal when the client is honest | b2 §3.9; b1 §4.2 ⚠ M4 |
| `epoch` | u64 | incremented on every fresh session, unchanged on reconnect; b2 value `(process start unix ms << 16) \| attach counter` (`EPOCH_SEQ_BITS = 16`) | b1 §4.2; b2 §3.7, §4 |

**`Heartbeat`** — `{"type":"heartbeat"}`. Direction per D3/b1: **client → server every 5 s** from a gpui timer; not an envelope, never counts as input; the server must tolerate gaps ≥ 90 s (hidden tabs) (b1 §3.3 step 4, §7.8, §7.12(f)). b2 §3.7 additionally emits a **server → client** heartbeat every 5 s (`HEARTBEAT_INTERVAL`) and accepts the client's silently (liveness only, never `touch_input`) ⚠ M1. b2 never times out a socket on missing client `Heartbeat` frames — liveness is the TCP/WebSocket close only (b2 §3.7 `run_session` doc; b1 §7.12(f)).

**`Log`** — server → client `{type:"log", level: usize, module_path: Option<String>, file: Option<String>, line: Option<u32>, message: String}` (same fields as `json_log::LogRecord`). b1 §4.2: reserved, not emitted in v1; b2 §3.9: emitted for records with `level <= LOG_FRAME_MAX_LEVEL` (warn, error) via `try_send` on the session queue ⚠ M7. The client logs it and treats it as activity (b1 §3.3 step 4).

### 1.5 Epoch semantics and session arbitration at `Hello` (D3; b1 §4.4; b2 §3.7)

| Step | Rule | Source |
|---|---|---|
| 0. Pre-upgrade | JWT verified; nothing about the session is decided before the upgrade (no 409) | b2 §3.8; b1 §7.12(b) |
| 1. Arbitration first | another client attached and `Hello.takeover = true` → attached socket closed **4001**, newcomer proceeds; `takeover = false` and a *different* instance → newcomer closed **4005** (terminal; take-over UI); a *same-instance* redial is never refused: b1 keys it on equal `Hello.identifier` and closes the old socket 4001; b2 keys it on `reconnect:true` + matching epoch and closes the old socket **1001** "superseded by reconnect" (identifier is logs-only) ⚠ M5 | b1 §4.4 item 1; b2 §3.7 step 2 |
| 2. Reconnect | `Hello.reconnect = true` **and** `Hello.epoch == current_epoch` **and** the server still holds the `ChannelClient` state → warm attach: rebind the existing channel pair, keep replay buffer / `max_received`, no new `RemoteStarted`, replay via `FlushBufferedMessages` → `Ack`; `HelloAck { resumed: true, epoch: unchanged }` | b1 §4.4 item 2; b2 §3.7 steps 1, 3-4 |
| 3. Fresh | `Hello.reconnect = false`, or nothing to resume (`reconnect = true` with `Hello.epoch = None`, or the server holds no epoch after a restart) → `HeadlessProject::reset_for_new_client` (worktrees → language servers, git, local settings; user settings reset to `{}`), `ServerChannel::begin_fresh_session` (new channel pair, replay buffer cleared, `max_received = 0`), `RemoteStarted` first, `HelloAck { resumed: false, epoch: incremented }` | D3; b1 §4.4 item 3; b2 §3.2, §3.7, §3.10 |
| 3a. Stale epoch | `reconnect = true`, `epoch != current_epoch`: b1 → treated as fresh (`resumed = false`); b2 → newcomer closed **4001** "stale epoch" and must re-open with `reconnect:false` ⚠ M3 | b1 §4.2 doc, §4.4 item 3; b2 §3.7 step 1, §7.19 |
| 3b. `reconnect && !resumed` | client discards `ChannelClient` state, returns exit 90 (`ServerNotRunning`); the shell's host `reconnect()` (D2) opens a fresh session | b1 §3.3 step 3; b2 §4 |
| 4. PTYs | survive fresh sessions in the server-level `PtyManager` (`App` global); `detach_all` on every session detach; `kill_all` only on process quit or `CloseTerminal` | D3, D20; b3 §3.8, §3.9; b2 §3.7 step 7, §3.9 |
| 5. `Hello.session_id != JWT sid` | b1 wire doc: server closes **4003**; b2 §3.7: logged at warn, not fatal (D1: informational) ⚠ M4 | b1 §3.2, §4.2; b2 §3.7 |
| 6. Stale responses | after a fresh attach the broker drops outgoing envelopes with `responding_to >= incoming_watermark`; watermark carries over on reconnect | b2 §3.7 step 5 |
| 7. Activity | replayed envelopes (ids below the watermark at attach) do not reset `last_input_at` | b2 §3.7 step 6 |
| 8. `session_attached` hook | b2 calls `HeadlessProject::on_session_attached` after a **Fresh** attach only (replays last `PortsChanged`, pending `Resumed`, `ExtensionsChanged`); b4 §3.14 says "after every attach, fresh or reconnect; idempotent" ⚠ M15 | b2 §3.7 step 4, §3.9; b4 §3.14 |

### 1.6 Close codes

| Code | `wire.rs` constant (b1 §3.2) | Meaning | Client mapping (b1 §3.3 step 5) | Server usage (b2 §3.7, §4) |
|---|---|---|---|---|
| 1000 | — | client-requested shutdown (after `ShutdownRemoteServer`'s `Ack`) | `Err` → reconnect | `CloseSession { code: 1000 }` |
| 1001 | `CLOSE_GOING_AWAY` | D3/b1: server going away — SIGTERM / lifecycle `STOPPING`; terminal, `refresh` never called | `Ok(90)` terminal | b2: **superseded by a same-epoch reconnect** (`CLOSE_SUPERSEDED`), reconnectable; SIGTERM uses 4004 ⚠ M2 |
| 1008 | — | slow consumer: no frame accepted within `WRITE_TIMEOUT` 30 s | `Err` → reconnect | b2 §3.7 (c) |
| 1009 | — | frame over 16 MiB (either direction) | `Err` → reconnect | b2 §3.7 |
| 4001 | `CLOSE_TAKEN_OVER` | superseded: takeover (b1: also same-instance redial; b2: also stale epoch) | `Ok(91)` terminal, no refresh | b2 §3.7 steps 1-2 |
| 4002 | `CLOSE_BUILD_MISMATCH` | `Hello.build` not `builds_compatible` with `--client-build` (also `HelloAck.build` on the client) | `Ok(92)` terminal | b2 §3.7 per-connection task |
| 4003 | `CLOSE_UNAUTHORIZED` | b1: `Hello.session_id ≠ sid`; b2: **not emitted** (D1). Also synthesized client-side on `RefreshError::Unauthorized` | `Err` → refresh + redial | ⚠ M4 |
| 4004 | — (retired by D3) | b2 still uses `CLOSE_SERVER_STOPPING = 4004` for SIGTERM and imports it from `wire.rs`, where b1 removed it | unknown 4xxx → `Err` → refresh → `RefreshError::Stopped` | ⚠ M2 |
| 4005 | `CLOSE_SESSION_ACTIVE` (b1) / imported as `CLOSE_SESSION_BUSY` (b2) | attach refused: another instance attached, `takeover = false` | `Ok(91)` terminal; `last_close()` distinguishes it from 4001 | b2 §3.7 step 2 ⚠ M6 |
| 4006 | `CLOSE_BAD_HELLO` | no/invalid `Hello` within `HELLO_TIMEOUT` 5 s, or `protocol != 1` | `Ok(92)` terminal (b1); b2 believes b1 treats it as reconnectable | b2 §3.7 ⚠ M6 |

Client `ProxyLaunchError` exit codes (b1 §3.4): `90 ServerNotRunning`, `91 SessionTakenOver`, `92 IncompatibleServer`. All three map to `State::ServerNotRunning` → `RemoteClientEvent::Disconnected { server_not_running: true }`; `ReconnectExhausted` emits `Disconnected { server_not_running: false }` (b4 §2).

### 1.7 Timers and budgets

| Item | Value | Source |
|---|---|---|
| Client dial timeout (TCP/TLS + upgrade) | `CONNECT_TIMEOUT = 30 s` | b1 §3.3 step 3 |
| Client wait for `HelloAck` | 15 s | b1 §3.3 step 3 |
| Reconnect budget | `WS_MAX_RECONNECT_ATTEMPTS = 20`, backoff `min(2^(attempt-1), 8)` s, then `ReconnectExhausted` with `last_close()`; `RefreshError::Stopped` / `Unauthorized` terminal at once (`max_reconnect_attempts() == 0`) | D2; b1 §3.3 step 2, §3.5 |
| `RemoteClient` proto heartbeat | `Ping` every 5 s, 5 s timeout, 5 misses → reconnect (unchanged upstream); resync window 5 s | b1 §2 |
| Server `HELLO_TIMEOUT` | 5 s | b2 §3.7 |
| Server `UPGRADE_TIMEOUT` | 10 s | b2 §3.7 |
| Server `WRITE_TIMEOUT` | 30 s (→ 1008) | b2 §3.7 |
| Server `DETACH_TIMEOUT` | 1 s | b2 §3.7 |
| Server `SHUTDOWN_FLUSH_TIMEOUT` / `CLOSE_GRACE` | 2 s / 100 ms | b2 §3.7 |
| Server `SESSION_QUEUE_FRAMES` | 64 | b2 §3.7 |
| Client bridge channel | bounded 64 frames | b1 §3.3 |
| Server heartbeat-gap tolerance | unbounded — the server never times out a socket on missing client heartbeats (b1 requires ≥ 90 s for hidden tabs) | b1 §7.8, §7.12(f); b2 §3.7 |

### 1.8 Handshake sequence

```
client                                         server (serve)
  |-- HTTP upgrade (Sec-WebSocket-Protocol: zs.v1, <jwt>) -->|  verify JWT: 401/403/426 only pre-upgrade
  |<-- 101 (Sec-WebSocket-Protocol: zs.v1) --|
  |-- Text Hello ------------------------->|  protocol/build check (4006/4002); arbitration (§1.5)
  |<-- Text HelloAck ----------------------|  or Close 4001/4005/4002/4006
  |   (resumed=false) <- Binary RemoteStarted (id 0)
  |-- Binary RemoteStarted (id 0) -------->|  server answers Ack{responding_to:0}
  |<-> envelopes (Ping/Ack; FlushBufferedMessages/Ack on reconnect)
  |-- Text Heartbeat every 5 s ----------->|  (b2 also sends one the other way, M1)
  |<-- Close 1001 (D3) / 4004 (b2, M2) ----|  on SIGTERM, after the STOPPING flush window
```
(b1 §4.4; b2 §4)

---

## 2. `zed-remote-server serve` CLI

`Commands::Serve(ServeArgs)` behind cargo feature `serve` (default-on in the fork; `cargo build -p remote_server --features serve`) (b2 §3.4, §3.11, §5; b8 §3.20).

| Flag | Type | Default | Required | Env | Alias | Source |
|---|---|---|---|---|---|---|
| `--listen` | `SocketAddr` | — (port 0 allowed in tests) | yes | | | b2 §3.9 |
| `--jwt-public-key` | `Vec<PathBuf>` (repeatable; each file may hold several PEM blocks) | — | yes (≥ 1) | | | b2 §3.9; b8 §3.14 |
| `--workspace-id` | String (expected `ws` claim) | — | yes | | `--workspace` | b2 §3.9; BUILD-SPEC §4.2 |
| `--audience` | String (expected `aud`) | — | yes | | | b2 §3.9 |
| `--issuer` | String (expected `iss`) | `"zs"` | | | | b2 §3.9 |
| `--workspace-root` | PathBuf (bounds `/files`; must exist) | — | yes | | | b2 §3.9 |
| `--client-build` | Option<String> (4002 when `Hello.build` incompatible) | none | | | `--allow-build` | b2 §3.9 |
| `--allowed-origin` | `Vec<String>` (repeatable or comma-separated) | empty → no CORS, no Origin check | | `ZS_ALLOWED_ORIGINS` | | D5; b2 §3.9 |
| `--control-secret-file` | PathBuf (non-empty, ≤ 4096 bytes, trailing `\r?\n` stripped; read before any spawn) | — | **yes** | | | D5/D18; b2 §3.9; b4 §3.15 item 1 |
| `--control-listen` | `SocketAddr` (must be loopback; port 0 allowed) | `127.0.0.1:8446` | | | | D5; b2 §3.9 |
| `--supervisor-url` | String | `crate::ports::DEFAULT_SUPERVISOR_URL` = `http://127.0.0.1:8445` (b4 §3.11 `ports.rs`; b2 §3.9, §4) | | `ZS_SUPERVISOR_URL` | | b2 §3.9 ⚠ M13 (b8 passes `http://127.0.0.1:8450`) |
| `--port-file` | Option<PathBuf> (`<ip>:<port>\n` of the public listener) | none | | | | b2 §3.9 |
| `--log-file` | Option<PathBuf> (rotating JSON tee) | none | | | | b2 §3.9 |

Supervisor spawn line (b8 §3.9 `ServerSpec::command()`): `zed-remote-server serve --listen 0.0.0.0:8443 --jwt-public-key <state>/jwt/key-<i>.pem… --workspace-id <ws> --audience <manifest.jwt.audience> --issuer <manifest.jwt.issuer> --workspace-root <manifest.workspaceDir> --client-build <ZS_BUILD_ID> --allowed-origin <manifest.allowedOrigins[i]>… --control-secret-file <state>/run/control.secret --control-listen 127.0.0.1:8446 --supervisor-url http://127.0.0.1:8450 --port-file <state>/run/server.port`; stdin null, stdout/stderr piped, own process group, cwd = workspace root.

Startup outputs: `--port-file` written once bound; stdout `ZS_LISTENING=<ip>:<port>` and `ZS_CONTROL_LISTENING=127.0.0.1:<port>` (b2 §3.9; parsed by b8 §3.9) ⚠ M9 (b1 §2/§6.3 states there is no stdout line). First stderr log line `listening on <addr>`.

Environment handling: a leftover `ZS_CONTROL_SECRET` is scrubbed with `remove_var` and never used (b2 §3.9 `read_control_secret`); no secret-bearing variable exists in the server environment (D18). Server reads `ZS_SUPERVISOR_URL` (clap env) and `ZS_ALLOWED_ORIGINS`.

Logs: one JSON object per stderr line — `ServeLogRecord { ts_ms: u64, level: usize (Info = 3), module_path?, file?, line?, message, ws: &str, session_id?: String, epoch?: u64, mode: "serve" }` (b2 §3.9; consumed by b8 §3.6 `entry_from_server`).

Shutdown: SIGTERM/SIGINT → `flush_then_close` → Close (1001 per D3 / 4004 per b2, M2) → `Quit` → `PtyManager::kill_all` → `cx.shutdown(); cx.quit()` → exit 0; exits promptly with no session (b2 §3.7 step 9, §3.9). `ShutdownRemoteServer` from a client closes the session (Close 1000 after the `Ack`), never the process (b2 §3.10).

---

## 3. Public HTTP routes on the `serve` listener (`0.0.0.0:8443`)

Common (b2 §3.8): plain HTTP/1.1 (TLS at Vercel's edge); every response `Cache-Control: no-store`; error bodies `{"error":"<snake_case>"}`; unknown path 404, wrong method 405; `/control/*` **always 404** here (D5). CORS only when `allowed_origins` is non-empty: allowed `Origin` on `/files`, `/extensions/*`, `/health` → `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, `Access-Control-Expose-Headers: content-disposition, content-length`, `Cross-Origin-Resource-Policy: cross-origin`; `OPTIONS` on those → 204 with `Access-Control-Allow-Methods: GET, POST`, `Access-Control-Allow-Headers: authorization, content-type`, `Access-Control-Max-Age: 600` (no auth on preflight); `OPTIONS` elsewhere → 405. Request logs use `redact_query` (`zs_token=***`).

| Route | Auth | Request | Response | Errors | Source |
|---|---|---|---|---|---|
| `GET /health` | none; **full** body when `peer.ip().is_loopback()` or a valid bearer verifies | — | 200 `HealthResponse` (below) | never 401 | b2 §3.8 |
| `GET /rpc` | JWT from the subprotocol list (§1.2) | `Upgrade: websocket`, `Sec-WebSocket-Protocol: zs.v1, <jwt>` | 101 (+ `Sec-WebSocket-Protocol: zs.v1` iff offered in header), then §1.8 | 401 / 403 / 426 | b2 §3.8, §4 |
| `POST /files?path=<rel>` | `Authorization: Bearer <jwt>` or `?zs_token=<jwt>` (verified per request) | `multipart/form-data` (each part's `filename`, nested `a/b.txt` allowed, joined under `<dir>`) or `application/octet-stream` (body = file at `<path>`) | 201 `{"written":["<rel>", …]}` (`/`-separated, relative to root); then `GpuiCommand::FilesUploaded` → `proto::FilesUploaded` | 400 `Traversal` (`..`, symlink escape: `path is outside the workspace root`) / 400 `InvalidPath` (empty, NUL, absolute, `Prefix` component, invalid UTF-8 after percent-decoding: `path contains an invalid component`); 413 `> MAX_UPLOAD_BYTES` (512 MiB, checked on `Content-Length` and while streaming) or `> MAX_FILES_PER_UPLOAD` (512); 415 unsupported content type; 500 io | b2 §3.6, §3.8; b4 §3.15 item 5 |
| `GET /files?path=<rel>` | same | — | file: 200 `application/octet-stream`, `Content-Length`, `Content-Disposition: attachment; filename="<name>"`, 64 KiB streamed reads; directory: 200 `application/x-tar`, `Content-Disposition: attachment; filename="<name>.tar"`, symlinks **not** followed, aborts past `MAX_DOWNLOAD_ENTRIES` 100 000 | 400 / 404 | b2 §3.6, §3.8; b9 §7.5 (`?zs_token=` is the `<a download>` form) |
| `GET /extensions/{id}/assets/{rel}` | same as `/files` | `id`, `rel` percent-decoded; `rel` may contain `/` | 200 streamed file, `Content-Type` from extension (`.css .json .png .svg .ttf .woff2 .wasm` table, else `application/octet-stream`), no `Content-Disposition` | 400 (`..`, NUL, absolute in `id`/`rel`, before any gpui round trip); 404 unknown id / uninstalled / traversal (`HeadlessExtensionStore::asset_path` → `None`) / directory | b2 §3.6, §3.8; b4 §3.13, §3.15 item 4; BUILD-SPEC §9 |
| `OPTIONS /files` \| `/extensions/*` \| `/health` | none | — | 204 CORS preflight | 405 elsewhere | b2 §3.8 |

`HealthResponse` (b2 §3.8; consumed by b8 §3.8 `ServerHealth`):

| Field | Type | Present | Source |
|---|---|---|---|
| `build` | String (`ZS_BUILD_ID` else `VERSION`) | always | b2 §3.8 |
| `version` | String (`VERSION`) | always | |
| `uptime_secs` | u64 | always | |
| `workspace_id` | String | always | |
| `session_active` | bool | always | |
| `session` | `SessionMeta { session_id (JWT sid), sub, jti, identifier, kind: "fresh"\|"reconnect", epoch: u64, client_build, client: "desktop"\|"web", attached_at_ms }` | full body only | b2 §3.7, §3.8 |
| `last_input_at` | unix ms | full body only; source of b8's `lastInputAt` (D13, D20) | b2 §3.8, §4 |
| `worktrees` | `[abs root paths]` | full body only | |
| `dirty_buffers` | u32 | full body only | |
| `auth_failures` | u64 | full body only | |

Other public-listener constants: `HEADER_READ_TIMEOUT` 10 s, `MAX_HEADER_BUF` 64 KiB, `TEMP_SUFFIX` `.zs-upload-` (swept at startup) (b2 §3.6, §3.8).

---

## 4. Loopback control listener (`--control-listen`, default `127.0.0.1:8446`)

| Item | Value | Source |
|---|---|---|
| Bind | `--control-listen`, loopback IP enforced at startup (`execute_serve` errors otherwise); a non-loopback peer is answered 401 regardless of bearer | D5; b2 §3.8 `serve_control` |
| Secret | contents of `--control-secret-file`; generated by `zs-agent` per boot (32 random bytes → hex), written to `<state>/run/control.secret` mode 0600, no trailing newline, never reused from a snapshot, deleted at exit; travels as a **path** (`--control-secret-file`, `ZS_CONTROL_SECRET_FILE`), never as an env value | D18; b8 §3.9, §3.3; b2 §3.9 |
| Auth | `Authorization: Bearer <secret>` compared with `subtle::ConstantTimeEq`; `peer_is_loopback` must be true | b4 §3.10; b2 §3.8 `route_control` |
| Body cap | `MAX_CONTROL_BODY_BYTES = 1 MiB` (413 above) | b2 §3.8; b4 §3.10 (adopted b2's cap) |
| Responses | `NoContent` → 204; `BadRequest(msg)` → 400 `{"error":"bad_request","message":"<msg>"}`; `Unauthorized` → 401; `NotFound` → 404; other path 404; other method 405; `Cache-Control: no-store`; bearer never logged | b2 §3.8 (owns the adapter under D20); b4 §3.10 (same shape) |
| Rust seam | `control::ControlChannel::handle(ControlRequest { method, path, bearer, peer_is_loopback, session_attached, body }) -> ControlResponse`; mounted through b2's `ControlRoutes::handle<'a>(&'a self, ControlRequest<'a>) -> BoxFuture<'a, ControlResponse>` adapter (a one-line impl for `ControlChannel`) | b4 §3.10; b2 §3.8 |

Routes (paths are b4 §3.10 `LIFECYCLE_PATH`, `PORTS_PATH`, `EXTENSIONS_PATH`; bodies b4 §4.2; caller b8 §3.9 `ServerControl`):

| Route | Body | Behaviour | Response |
|---|---|---|---|
| `POST /control/lifecycle` | `{"kind":"idle_stop_in","seconds":u32}` \| `{"kind":"session_cap_in","seconds":u32}` \| `{"kind":"stopping"}` \| `{"kind":"resumed"}` (serde `tag = "kind", rename_all = "snake_case"`) | `idle_stop_in`/`session_cap_in` → `LifecycleNotice` sent; `resumed` → sent if a session is attached, else held (`pending_resumed`) and replayed once on the next attach; `stopping` → 204 immediately when no session, else sends `LifecycleNotice{Stopping}` and waits for the next accepted `SaveClientState` or `STOPPING_FLUSH_TIMEOUT = 5 s` | 204 |
| `POST /control/ports` | `{"ports":[{"port":u16,"pid":u32,"process_name":string}],"forwards":[{"port":u16,"visibility":"public"\|"private","label":string\|null,"url":string}]}` (`forwards` defaults empty; `url` is `""` when the control plane returned `null`) | stored as `last_ports` (only writer); `PortsChanged` with the full picture sent to the client | 204 |
| `POST /control/extensions` | `{"install":["<id>", …]}`; ids `^[a-z0-9][a-z0-9_-]{0,63}$` | `ControlEvent::InstallExtensions` → `install_from_registry` per id not already on disk; results as `ExtensionsChanged` | 204 (400 on invalid id) |

Supervisor request budgets: `stopping` POST timeout 7 s (`STOPPING_POST_TIMEOUT`, > the 5 s flush, D18), others 3 s (b8 §3.9).

---

## 5. New proto messages

Files: `crates/proto/proto/terminal.proto` (b3 §3.1, §4; oneof tags **488-499**) and `crates/proto/proto/remote_session.proto` (b4 §3.1, §4.1; tags **500-514**); both imported from `zed.proto`. `project_id` is always `REMOTE_SERVER_PROJECT_ID = 0` (b3 §2). No other brief changes `.proto`.

### 5.1 `terminal.proto` (b3 §4; all `Background`)

| Tag | Message | Fields | Direction | Kind | Client side | Server side |
|---|---|---|---|---|---|---|
| 488 → 489 | `SpawnTerminal` → `SpawnTerminalResponse` | `{ project_id u64; working_directory optional string; shell Shell (task.proto; System ⇒ `$SHELL -l`); env map<string,string>; cols u32; rows u32; task_id optional string; title optional string }` → `{ terminal_id u64 }` (random 64-bit, unique across restarts; starts **detached**) | C→S | request (entity) | `Project::spawn_remote_terminal` (b3 §3.6) | `HeadlessProject::handle_spawn_terminal` → `PtyManager::spawn` (b3 §3.8-3.9) |
| 490 | `TerminalInput` | `{ project_id; terminal_id; data bytes }` ≤ 64 KiB (`INPUT_CHUNK`) | C→S | message (entity) | `ProtoPtyTransport::input` (b3 §3.6) | `handle_terminal_input` → `PtyManager::write` |
| 491 | `TerminalOutput` | `{ project_id; terminal_id; offset u64; data bytes (≤ 64 KiB `OUTPUT_CHUNK`); reset bool }` | S→C | message (entity) | `Project::handle_terminal_output` → `RemotePtyHandle::push_output` (b3 §3.5-3.6) | reader thread → drain task (b3 §3.8) |
| 492 | `AckTerminalOutput` | `{ project_id; terminal_id; offset u64 }` (ack ≥ 64 KiB `REMOTE_ACK_THRESHOLD` or batch end) | C→S | message (entity) | `flush_remote_ack` (b3 §3.5g) | `PtyManager::ack` (window `OUTPUT_WINDOW` 512 KiB) |
| 493 | `ResizeTerminal` | `{ project_id; terminal_id; cols u32; rows u32 }` | C→S | message (entity) | `InternalEvent::Resize` (b3 §3.5i) | `PtyManager::resize` |
| 494 | `CloseTerminal` | `{ project_id; terminal_id }` — SIGTERM pgrp, SIGKILL after 100 ms; entry removed after `TerminalExited` | C→S | message (entity) | `release_pty_resources` / `kill_active_task` (b3 §3.5n-o) | `PtyManager::close` |
| 495 | `TerminalExited` | `{ project_id; terminal_id; exit TerminalExit { code optional int32; signal optional int32 } (exactly one set); end_offset u64 }`; re-sent after every replay of an exited terminal | S→C | message (entity) | `handle_terminal_exited` → `push_exit` (dedup) | wait thread |
| 496 → 497 | `ListTerminals` → `ListTerminalsResponse` | `{ project_id }` → `{ terminals: [TerminalInfo { terminal_id; title; cwd optional (Linux `/proc/<pgrp>/cwd`); task_id optional; end_offset; scrollback_start; exit optional TerminalExit; cols; rows }] }` | C→S | request (entity) | `Project::fetch_remote_terminal_inventory` (D4, b3 §3.6, §3.6a) | `handle_list_terminals` → `PtyManager::list` |
| 498 → 499 | `AttachTerminal` → `AttachTerminalResponse` | `{ project_id; terminal_id; from_offset u64; cols u32; rows u32 }` → `{ replayed_from u64; end_offset u64; exit optional TerminalExit }` (replays `[max(from_offset, scrollback_start), end)`, `reset=true` on the first chunk if evicted; unknown id → error response → client marks lost) | C→S | request (entity) | `restore_remote_terminal` (`from_offset: 0`), `reattach_remote_terminals` (b3 §3.6) | `handle_attach_terminal` → `PtyManager::attach` |

`entity_messages!({project_id, ShareProject}, …)` gains `SpawnTerminal, TerminalInput, TerminalOutput, AckTerminalOutput, ResizeTerminal, CloseTerminal, TerminalExited, ListTerminals, AttachTerminal` (b3 §3.3). Server constants: `SCROLLBACK_CAPACITY` 2 MiB, `OUTPUT_WINDOW` 512 KiB, `OUTPUT_CHUNK` 64 KiB, `EXIT_DRAIN_TIMEOUT` 500 ms, `KILL_ESCALATION_DELAY` 100 ms, `MAX_TERMINALS` 64 (b3 §3.8). Client: `REMOTE_ACK_THRESHOLD` 64 KiB, `REMOTE_PARSE_BUDGET` 256 KiB, `INPUT_CHUNK` 64 KiB (b3 §3.5c, §3.6).

### 5.2 `remote_session.proto` (b4 §4.1)

| Tag | Message | Fields | Direction | Priority | Kind | Client side | Server side |
|---|---|---|---|---|---|---|---|
| 500 → 501 | `SaveClientState` → `SaveClientStateResponse` | `{ project_id u64; sqlite bytes; version u64; gzip bool; client_build optional string }` → `{ accepted bool; version u64 }` (`accepted=false` when `version <= current`; not an error) | C→S | Background | request | `workspace::client_state::RemoteClientStateSink` / `db::client_state::ClientStateStore` (b4 §3.7-3.8) | `remote_server::client_state::ClientStateStore::handle_save_client_state` (b4 §3.9) |
| 502 → 503 | `LoadClientState` → `LoadClientStateResponse` | `{ project_id; metadata_only bool }` → `{ sqlite bytes (empty if none/metadata_only); version u64 (0 if none); gzip bool; client_build optional string }` | C→S | Background | request | `load_client_state(&AnyProtoClient)` (b4 §3.8), `ClientStateSink::current_version` | `handle_load_client_state` (b4 §3.9) |
| 504 | `LifecycleNotice` | `{ project_id; kind LifecycleKind { IdleStopIn = 0, SessionCapIn = 1, Stopping = 2, Resumed = 3 }; seconds u32 (countdown; 0 otherwise) }` | S→C | **Foreground** | message (entity) | `Project::handle_lifecycle_notice` → `Event::LifecycleNotice { kind, seconds }`; b7 forwards `LifecycleKind::as_str()` to `ZsHost.onLifecycle` (b4 §3.16; b7 §3.21) | `ControlChannel` (b4 §3.10) |
| 505 | `PortsChanged` | `{ project_id; ports: [ListeningPort { port u32; pid u32; process_name string }]; forwards: [PortForward { port u32; visibility PortVisibility { PortPrivate = 0, PortPublic = 1 }; label optional string; url string }] }` (full picture every time) | S→C | Background | message (entity) | `PortStore::handle_ports_changed` (b4 §3.16) | `ControlChannel` on `POST /control/ports`; replayed by `on_session_attached` |
| 506 → 507 | `ForwardPort` → `ForwardPortResponse` | `{ project_id; port u32 (1..=65535); visibility; label optional }` → `{ url string }` (opaque; public slot URL or `/open` link; `""` when supervisor returned `null`) | C→S | Background | request | `PortStore::forward_port` | `PortForwarder::handle_forward_port` → `POST $SUPERVISOR_URL/ports` (b4 §3.11) |
| 508 | `UnforwardPort` → `Ack` | `{ project_id; port u32 }` | C→S | Background | request | `PortStore::unforward_port` | `handle_unforward_port` → `DELETE $SUPERVISOR_URL/ports/{port}` |
| 509 | `FilesUploaded` | `{ project_id; paths: [ProjectPath] }` | S→C | **Foreground** | message (entity) | `Project::handle_files_uploaded` → `Event::FilesUploaded(Vec<ProjectPath>)` | `HeadlessProject::notify_files_uploaded` (b4 §3.14) via b2 `GpuiCommand::FilesUploaded` |
| 510 → 511 | `ListExtensions` → `ListExtensionsResponse` | `{ project_id; search optional string; include_available bool }` → `{ installed: [InstalledExtension { id; version; name; description optional; provides repeated string; dev bool }]; available: [AvailableExtension { id; version; name; description optional; authors repeated; repository; provides repeated; download_count u64 }] }` | C→S | Background | request | `RemoteExtensionStore::{refresh, search}` (b4 §3.16) | `HeadlessExtensionStore::handle_list_extensions` (b4 §3.13) |
| 512 | `InstallRegistryExtension` → `Ack` | `{ project_id; id string (validated `^[a-z0-9][a-z0-9_-]{0,63}$`); version optional string }` | C→S | Background | request | `RemoteExtensionStore::install` | `handle_install_registry_extension` → `install_from_registry` |
| 513 | `UninstallExtension` → `Ack` | `{ project_id; id string }` | C→S | Background | request | `RemoteExtensionStore::uninstall` | `handle_uninstall_extension` → `uninstall_by_id` |
| 514 | `ExtensionsChanged` | `{ project_id; installed: [InstalledExtension] }` | S→C | Background | message (entity) | `RemoteExtensionStore::handle_extensions_changed` | `enable_sandbox` subscription on `ExtensionsInstalledChanged`; also `POST $SUPERVISOR_URL/extensions {installed}` (b4 §3.14) |

`entity_messages!` gains `LifecycleNotice, PortsChanged, FilesUploaded, ExtensionsChanged` (b4 §3.3). The server registers the seven request handlers only inside `HeadlessProject::enable_sandbox` (serve mode); in `run` mode they answer "no handler registered" (b4 §3.14).

### 5.3 Idle-clock exclusions (`is_input_envelope`, b2 §3.7; D20)

Not input: any response (`responding_to` set), `Ping`, `Ack`, `RemoteStarted`, `FlushBufferedMessages`, `SaveClientState`, `LoadClientState`, `ListExtensions` (b4 §3.15 item 6), `AckTerminalOutput`, `ResizeTerminal`, `ListTerminals`, `AttachTerminal` (b3 §3.8), replayed envelopes after a resume, and `Heartbeat` text frames. Input: everything else, including `SpawnTerminal`, `TerminalInput`, `CloseTerminal`, `AddWorktree`, plus `/files` uploads. `/health.last_input_at` is what the supervisor reports as `lastInputAt` (D13; b2 §4).

### 5.4 Cross-brief Rust API additions (not proto)

| Item | Signature / value | Defined | Consumed |
|---|---|---|---|
| `RemoteConnection::max_reconnect_attempts()` | defaulted `MAX_RECONNECT_ATTEMPTS` (3); WebSocket returns 20 (0 once terminal) | b1 §3.5 | `RemoteClient::reconnect` |
| `RemoteConnection::supports_remote_pty()` | defaulted `false`; WebSocket `true` | b3 §3.4; b1 §3.3 | b3 §3.6 `create_terminal_task` |
| `RemoteConnection::supports_extension_upload()` | defaulted `true`; WebSocket `false`; gate in `extension_host.rs:2285` | b1 §3.20; b4 §7.3 | desktop only |
| `workspace::open_remote_project_in_new_window_with_client(remote: Entity<RemoteClient>, app_state, paths, window_options, cx) -> Task<Result<OpenedRemoteProject { window, workspace, items }>>` | D16 | b1 §3.12 | b7 §3.28 |
| `remote::{ServerChannel, ChannelEnds}`; `RemoteClient::server_channel_from_channels(..)`; `ServerChannel::begin_fresh_session(cx) -> ChannelEnds` | fresh-session channel swap | b2 §3.2 | b2 §3.9; b3 §3.10 |
| `HeadlessProject::{set_shutdown_request_handler, reset_for_new_client, enable_sandbox(SandboxConfig), on_session_attached, notify_files_uploaded}`; `HeadlessProject.pty_manager: Arc<PtyManager>` | | b2 §3.10; b4 §3.14; b3 §3.9 | b2 §3.9 |
| `PtyManager::{new, global, install, spawn, write, resize, ack, attach, detach, detach_all, list, close, kill_all}` (App global `GlobalPtyManager`) | | b3 §3.8 | b2 §3.9 (`detach_all` on detach, `kill_all` on `Quit`) ⚠ M16 |
| `db::AppDatabase::open_with_image(Option<Vec<u8>>) -> (Self, RestoreOutcome)`; `db::registered_migration_count()`; `db::kvp::GlobalKeyValueStore::{from_app_db, init(&AppDatabase)}` | D7 | b4 §3.6, §3.6a; b6 §3.4 | b7 §3.27 ⚠ M17 |
| `fs::WasmFs::{new(BackgroundExecutor), insert_file, insert_dir, take_dirty}` | **landed** (round 3: `crates/fs/src/wasm_fs.rs`, 15 tests) | b6 §3.2 | b7 §3.24, §3.27 |
| `client::Client::sign_in_supported()` | `cfg!(not(wasm))` — **landed** (round 3: `crates/client/src/client.rs`) | b6 §3.8 | b7 §3.11 |
| `settings::{KeymapOs, default_keymap_path_for, specific_overrides_keymap_path_for, WEB_KEYMAP_PATH = "keymaps/web.json", BaseKeymap::asset_path_for}`; `ui::PlatformStyle::set_platform_style` | D12 — **landed** (round 3: `crates/settings/src/settings.rs`, `crates/settings/src/base_keymap_setting.rs`, `crates/ui/src/styles/platform.rs`, `assets/keymaps/web.json`) | b7 §3.2, §3.2a | b7 §3.23, §3.26 |
| `smol::runtime::{Runtime, Runnable, install_runtime, runtime_installed}` (wasm) | | b5 §4 | b7 §3.27 step 2 (`GpuiSmolRuntime`) |
| `zed_web_core::web_defaults_for_origin(origin, base_json) -> Result<&'static str>` (cached per origin); `zed_web::web_settings::{web_default_settings(origin) -> &'static str, init(fs, settings_json, origin, cx)}`; `zed_web::init::{init_before_connect(fs, assets, host_os, settings_json, origin, build, cx), init_after_db(client, fs, assets, extension_host_proxy, session, origin, cx)}` | `origin` = the control-plane origin the `/api/ai/*` `api_url`s hang off — **landed** (round 4: `crates/zed_web_core/src/web_settings.rs`, `crates/zed_web/src/{web_settings,init,boot}.rs`) | b11 §3.18 (changes b7 §3.24, §3.26) | b7 `boot.rs` |
| `zed_web_core::ai_proxy::{PLACEHOLDER_KEY = "zs-proxy-v1", PROXY_PREFIX, KEYS_PATH, PROXIED_LANGUAGE_MODEL_PROVIDERS, PROXIED_EDIT_PREDICTION_PROVIDERS, LOCAL_ONLY_LANGUAGE_MODEL_PROVIDERS, normalize_origin, proxy_api_url, keys_url, manage_keys_url, provider_for_url, ai_proxy_settings_overrides, merge_ai_proxy_defaults, KeysOutcome::{Known, Disabled, Unknown, is_session_expired}, parse_keys_outcome, credential_for, ensure_not_placeholder, write_key_payload, parse_proxy_error, describe_proxy_error, notice_for, SESSION_EXPIRED_MESSAGE, KeysCache}` | host-tested rules behind the browser credentials provider — **landed** (round 4: `crates/zed_web_core/src/ai_proxy.rs`, `ai_proxy/keys_cache.rs`) | b11 §3.16 | `zed_web::ai`, `zed_web::web_edit_prediction` |
| `zed_web::ai::{ProxyCredentialsProvider, install(origin, cx) -> Arc<ProxyCredentialsProvider>, watch_default_model(origin, cx), page_origin(), ManageAiKeys}`; `zed_web::web_edit_prediction::init(client, user_store, origin, cx)` | the `zed_credentials_provider` global and notice-raising HTTP client on wasm (step 8a, before `Client::production`); the OpenCode custom-URL notice (step 22a); the browser edit-prediction registry (step 30a, after `edit_prediction::init`) — **landed** (round 4) | b11 §3.17, §3.19, §7 item 4b | b7 §3.26 |
| `language_models::register_language_model_providers` skips Ollama, LM Studio, llama.cpp (`localhost`, unreachable under the editor CSP), Bedrock and `openai_subscribed` under `cfg(target_family = "wasm")`; `AllLanguageModelSettings.bedrock` is `not(wasm)` | **landed** (`crates/language_models/src/{language_models,settings}.rs`; tests `cargo test -p language_models proxy`) | b11 §3.18; b7 §3.5 | `zed_web` step 22 |

---

## 6. JWT claims and verification

### 6.1 Session token (b2 §3.5, §4; b9 §3.11; BUILD-SPEC §4.3)

Header `{ "alg": "ES256", "typ": "JWT", "kid"?: string }` — `kid` is ignored by the verifier (all loaded keys tried) (b2 §4).

| Claim | Type | Value | Verification (b2 §3.5) | Minted by (b9 §3.11) |
|---|---|---|---|---|
| `iss` | string | `--issuer` = `manifest.jwt.issuer` = `ZS_JWT_ISSUER` (default `"zs"`) | required; mismatch → `WrongIssuer` 403 | `setIssuer(issuer)` |
| `sub` | string | user id (Clerk); `"zs-agent-warm"` for the prebuild warm-up | required | `setSubject(userId)` |
| `ws` | string | workspace id `ws_…` (D1 identity) = `--workspace-id` | constant-time compare (`subtle`) → `WrongWorkspace` 403 | `{ ws: workspaceId }` |
| `sid` | string | per-connect id `con_…` (D1), informational; `"warm-<jti>"` for the warm-up | must be present (`Claims.sid: String`; missing → `Malformed` 401, b2 §6.1 `missing_claim_rejected`); value not validated; carried into `SessionMeta.session_id`, `HelloAck.session_id`, logs, `/health` | `{ sid: sessionId }` |
| `aud` | string | `workspaces.audience` (defaults to the sandbox name; rotatable) = `manifest.jwt.audience` = `--audience` | required; mismatch → `WrongAudience` 403 | `setAudience(audience)` |
| `iat` | u64 | now | required (deserialization: `Claims.iat: u64`); `iat > now + 30 s` → `Malformed` 401 (manual check) | `setIssuedAt()` |
| `exp` | u64 | `iat + 3600` (ttl default and max 3600) | required; leeway `LEEWAY_SECS = 30`; expired → 401 | `setExpirationTime(now + ttl)` |
| `jti` | string | unique | required (deserialization: `Claims.jti: String`; missing → `Malformed` 401); value not validated by b2 | `setJti()` |

Other rules: `alg ∈ [ES256]` only (HS256 confusion closed by the algorithm allowlist) → `WrongAlgorithm` 401; `nbf` not validated; with several keys the first `Ok` wins and the reported error is the first non-`BadSignature` (b2 §3.5). Errors: `Missing`/`Malformed`/`BadSignature`/`Expired`/`WrongAlgorithm` → 401; `WrongAudience`/`WrongIssuer`/`WrongWorkspace` → 403; `MissingSubprotocol` → 426. The token is verified at upgrade time only (a session outlives `exp`); `/files`, `/extensions/*` and the full `/health` body verify per request, so the client refreshes 60 s before `sessionExpiresAt` (b2 §4; b7 §3.21 `ensure_fresh_token`; b9 §3.18). jsonwebtoken backend `aws_lc_rs`; no workspace crate may enable `rust_crypto` (b2 §3.5).

Key distribution: control plane `ZS_JWT_PRIVATE_KEY` (PKCS#8 P-256) + `ZS_JWT_KID`, optional `ZS_JWT_PREVIOUS_PUBLIC_KEY`/`_KID` during rotation → `manifest.jwt.publicKeys` (SPKI PEM strings, active first) → supervisor writes `<state>/jwt/key-<i>.pem` (0600, stale files removed) → one `--jwt-public-key` per file; no environment fallback (b9 §3.11; b8 §3.14, §4.6). Test fixtures: `crates/remote_server/tests/fixtures/es256_private.pem`, `es256_public.pem`, `es256_other_public.pem` (b2 §3.14; b1 §6.3; b9 §6).

### 6.2 Other tokens

| Token | Format | Source |
|---|---|---|
| Sandbox identity (`ZS_SANDBOX_TOKEN`) | `"zsb_" + base64url(32 random bytes)`; control plane stores `sha256` hex (`workspaces.sandbox_token_hash` / `prebuilds.sandbox_token_hash`), constant-time compare; rotated at every supervisor start; 401 `sandbox_unauthorized`, 410 `sandbox_retired` | b9 §3.3, §3.12; b8 §3.5 |
| Editor cookie `zs_editor` | HS256 (`ZS_EDITOR_COOKIE_SECRET`, base64 32 bytes); claims `{ sub, ws, aud: "zs-editor", iat, exp: +12 h, jti }`; `HttpOnly; Secure; SameSite=Strict; Path=/api/workspaces/<id>`; minted by `proxy.ts` on `/w/:id` document requests and by `POST /api/workspaces/{id}/session` | b9 §3.8 |
| Prebuild warm-up token | ES256 with an ephemeral P-256 key whose public PEM is passed as an extra `--jwt-public-key key-warm.pem`; claims `iss/aud` from the manifest, `sub = "zs-agent-warm"`, `ws`, `sid = "warm-<jti>"`, `exp = iat + 900` | b8 §3.16a |
| Private-port bootstrap token (`zs_port_token`) | ⚠ **M12** — b8 §3.10: HMAC `v1.<b64url(payload)>.<b64url(sig)>` under `manifest.portSessionSecret`, max age 3600 s; b9 §3.12: ES256 JWT `{ iss, sub: userId, ws, sid: "port:<port>", aud: "<audience>/ports", iat, exp: iat + 600, jti }` verified with `manifest.jwt.publicKeys` | see §9.3 |
| Cron | `Authorization: Bearer ${CRON_SECRET}` | b9 §4.2 |
| AI cookie `zs_ai` | HS256 (`ZS_EDITOR_COOKIE_SECRET`); claims `{ sub, aud: "zs-ai", ep, iat, oat, exp: +12 h, jti }` — no `ws` claim (the mint site cannot check workspace access); refresh by `POST /api/workspaces/{id}/session` refused past `oat + 24 h`; `ep` checked against `zs:ai:epoch:<sub>` (bumped on key delete, account flag, sign-out); `HttpOnly; Secure; SameSite=Strict; Path=/api/ai`; minted beside `zs_editor` on `/w/:id` document requests (`apps/web/lib/ai/cookie.ts`) | b11 §3.8, §4.7 |

---

## 7. `zs-agent` (supervisor) contract

### 7.1 CLI and exit codes (b8 §3.16, §3.17)

| Subcommand | Args | Behaviour |
|---|---|---|
| `start` | `[--no-server]` (hidden) `[--resumed]` | full boot (§7.7); refuses (exit 2) when `ZS_PREBUILD=1` |
| `resume` | — | `start --resumed`; what b9's `onResume` runs (b9 §3.18) |
| `prebuild` | — | requires `ZS_PREBUILD=1`; clone + postCreate + LSP warm-up (D14) + `ZS_PREBUILD_WARM_CMD`; exit 0 |
| `credential <get\|store\|erase>` | `--supervisor-url` (env `ZS_SUPERVISOR_URL`, default `http://127.0.0.1:8450`), `--control-secret-file` (env `ZS_CONTROL_SECRET_FILE`) | git credential helper; registered as `credential.helper = !zs-agent credential`, `credential.useHttpPath = true` (b8 §3.13, §3.19) |
| `proxy` | `--bind-ip`, `--slot…`, `--secret-file`, `--workspace-id`, `--bind <slot>=<port>…`, `--insecure-cookies` | private-port proxy only |
| `stop` | `--timeout-secs 30` | SIGTERM the pid-file process and wait |
| `wait-ready` | `--timeout-secs 120`, `--allow-degraded` | poll `:8445/health` |
| `port-token` (hidden) | `--secret-b64\|--secret-file`, `--workspace-id`, `--port`, `--ttl-secs 3600`, `--sub local` | mint an HMAC bootstrap token |
| `warm` (hidden) | `--private-key`, `--workspace-id`, `--audience`, `--issuer zs`, `--workspace-root`, `--server-url http://127.0.0.1:8443`, `--budget-secs 300` | LSP warm-up against a running server |
| `version` | — | prints `ZS_BUILD_ID` and the server's `version` |

Exit codes: 0 ok, 1 generic, 2 config error, 3 manifest unavailable, 4 repo materialisation failed (b8 §3.17; b9 §4.8 fails fast on any non-null exit during `waitUntilReady`).

### 7.2 Environment read by `zs-agent` (b8 §3.3, §4.6; b9 §3.18, §4.8)

| Variable | Set by | Value |
|---|---|---|
| `ZS_CONTROL_URL` | control plane `runCommand` env (b8 canonical) | API base **including** `/api`, e.g. `https://zs.example.com/api`; trailing slash stripped ⚠ M11 |
| `ZS_CONTROL_PLANE_URL` | control plane `runCommand` env (b9 §3.18 emits this one) | bare origin; b8 appends `/api` as a fallback when `ZS_CONTROL_URL` is absent ⚠ M11 |
| `ZS_BYPASS_SECRET` | control plane (preview deployments; from `VERCEL_AUTOMATION_BYPASS_SECRET`) | sent as `x-vercel-protection-bypass` on every control-plane call (D18) |
| `ZS_SANDBOX_TOKEN` | control plane `runCommand` env, fresh per start | bearer `zsb_…` |
| `ZS_SANDBOX_NAME`, `ZS_WORKSPACE_ID` | `Sandbox.create({ env })` (b9 §4.8) **and** `runCommand` env (b9 §3.18 `supervisorEnvFor`) | identity; cross-checked against the manifest; `ZS_WORKSPACE_ID` = prebuild id for `pb-` principals |
| `ZS_REGION` | `Sandbox.create({ env })` only (b9 §4.8; VM-wide, so `runCommand` inherits it — `supervisorEnvFor` does not re-emit it) | informational (b8 §3.3, §4.6) |
| `ZS_BUILD_ID` | image `ENV` | build id; `--client-build` |
| `ZS_PREBUILD` | control plane (prebuild workflow) | `"1"` ⇒ only `zs-agent prebuild` may run |
| `ZS_PREBUILD_WARM_CMD` | control plane (from `repos.prebuild_warm_command`) | shell command after the LSP warm-up |
| `ZS_WORKSPACES_DIR` | image `ENV` | `/workspaces` |
| `ZS_STATE_DIR`, `ZS_DATA_DIR` | optional | defaults `$HOME/.zs`, `$XDG_DATA_HOME/zed` or `$HOME/.local/share/zed` |
| `ZS_SERVER_BIN` | image `ENV` | `/usr/local/bin/zed-remote-server` |
| `ZS_SUPERVISOR_URL` | image `ENV`; re-exported to every child; passed as `--supervisor-url` | `http://127.0.0.1:8450` |
| `ZS_CONTROL_SECRET_FILE` | image `ENV`; re-exported to every child | `/vercel/.zs/run/control.secret` (a path) |
| `ZS_HEALTH_LISTEN`, `ZS_LOCAL_API_LISTEN`, `ZS_PROXY_BIND_IP`, `ZS_RPC_LISTEN`, `ZS_SERVER_CONTROL_LISTEN`, `ZS_INSECURE_COOKIES` | tests | bind overrides (`0.0.0.0:8445`, `127.0.0.1:8450`, `0.0.0.0`, `0.0.0.0:8443`, `127.0.0.1:8446`); insecure cookies |
| `SHELL`, `USER`, `HOME` | image `ENV` (`/bin/bash`, `/vercel`); `zs-agent` fills `SHELL` when missing and `USER` from the uid-1000 passwd entry, then `/etc/zs/user` (written by a repo image's layer fixup), then `ubuntu` (b10 §3.16) | inherited by the server (b3 §7.10) |
| `ZS_IMAGE_BUILD_ID`, `ZS_VCR_USERNAME`, `ZS_VCR_PASSWORD`, `ZS_VCR_REGISTRY` | control plane `runCommand` env of the **builder** driver `zs-build-devcontainer` only (b10 §3.8) — never `Sandbox.create({ env })`, never a workspace | image build id; registry credential (`docker login vcr.vercel.com`), consumed into `DOCKER_CONFIG=/var/lib/zs-builder/docker-push` and unset; `vcr.vercel.com/<team>/<project>` |
| `RUST_LOG` | optional | default `info` |
| user/org/repo secrets | control plane `runCommand` env | inherited untouched by the server and children; `manifest.secretNames` lists names only |

Stripped from every child: `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_URL`, `ZS_CONTROL_PLANE_URL`, `ZS_BYPASS_SECRET`, `ZS_CONTROL_SECRET`. `manifest.env` literals are merged minus `ZS_*` keys (other than the three identity keys) and b9's `RESERVED_SECRET_NAMES` (`LD_PRELOAD, LD_LIBRARY_PATH, BASH_ENV, ENV, PROMPT_COMMAND, GIT_ASKPASS, SSH_ASKPASS, GIT_CONFIG_PARAMETERS, HOME, PATH, USER, SHELL`) (b8 §3.3; b9 §3.17). b10 §3.1 rule 7 applies the **same filter plus `LD_*`/`GIT_*`/`PERL5*`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PYTHONPATH`** to a repository's `containerEnv` (before it becomes image `ENV`) and `remoteEnv` (in the control plane and again in `Config::child_env`); a repo image reproduces the §11 image `ENV` line verbatim.

### 7.3 Manifest (`GET {api}/sandboxes/{name}/manifest`; b8 §3.4, §4.1; b9 §4.7; schema `docs/contracts/sandbox-manifest.v1.json`, fixture `docs/contracts/fixtures/manifest.example.json` per D19)

camelCase; unknown fields ignored by b8; `Manifest::validate` rules listed under "Rule".

| Field | Type | b8 §4.1 | b9 §4.7 | Rule / note |
|---|---|---|---|---|
| `version` | 1 | ✓ | ✓ | must be 1 |
| `workspaceId` | string | ✓ | ✓ | == `ZS_WORKSPACE_ID` |
| `sandboxName` | string | ✓ | ✓ | == `ZS_SANDBOX_NAME` |
| `sandboxGeneration` | number | — (ignored) | ✓ | |
| `userId` | string | ✓ | ✓ | `"system"` for prebuilds |
| `build` | string | ✓ | ✓ | `workspaces.server_build`; ≠ `ZS_BUILD_ID` → health `degraded` |
| `region` | string | ✓ | ✓ | |
| `repo` | `{ owner, name, cloneUrl, defaultBranch, revision (branch or 40-hex sha), depth (0 = full), ref? ("refs/pull/N/head") }` | ✓ | ✓ | D18: `ref` fetched first |
| `workspaceDir` | string | ✓ | ✓ | absolute, normal, under `ZS_WORKSPACES_DIR`; `/workspaces/<repo.name>` |
| `restore` | `{ tarballUrl (presigned https, 1 h), sha256: string \| null } \| null` | ✓ | ✓ | rebuild only; fetched with a header-less client |
| `dotfiles` | `{ repoUrl, installCommand: string \| null } \| null` | ✓ | ✓ | |
| `env` | `Record<string,string>` | ✓ | ✓ | non-secret literals, filtered (§7.2) |
| `secretNames` | string[] | ✓ | ✓ | names only |
| `jwt` | `{ issuer, audience, publicKeys: string[] }` | ✓ | ✓ + `portAudience: "<audience>/ports"` | ≥ 1 PEM `PUBLIC KEY`; issuer/audience non-empty ⚠ M12 |
| `portSessionSecret` | string (standard base64, padded, exactly 32 bytes) | ✓ **required** | **absent** | ⚠ M12 — b8 deserialization/validation fails without it |
| `forwards[]` | `{ port, visibility: "public"\|"private", label: string \| null, url: string \| null, slot: number \| null }` (b8 `Option<String>`; b9 §4.7 = `ForwardView`; null while stopped or for a public forward outside the pool before `stepUpdatePorts`) | ✓ | ✓ | ports ∉ infra set; private `url` = `/open` link (D8); `slot` ∈ proxy slots, unique, private only |
| `proxySlots` | number[] (4) | — (ignored; b8 uses `PROXY_SLOTS`) | ✓ | ⚠ M10 |
| `portPool` | number[] | ✓ | ✓ | default `3000,3001,4000,5000,5173,8000,8080,8888` (b9 `ZS_PORT_POOL`) |
| `idle` | `{ minutes }` | ✓ | ✓ | |
| `session` | `{ id (Vercel session id), startedAt (unix ms), capAt (unix ms), resumed }` | ✓ | ✓ | `capAt > startedAt`; `resumed` informational (first-boot marker wins) |
| `devcontainer` | `DevcontainerSpec \| null` (`docs/contracts/manifest-devcontainer.v1.json`, b10 §4.4): `{ configHash (bare hex contentHash), imageBuildId?, source: "manifest" \| "checkout", lifecycle{onCreate,updateContent,postCreate,postStart,postAttach}, remoteEnv, forwardPorts, portsAttributes, otherPortsAttributes?, zed{extensions,settings,prebuild,services}, services, features }`; every field but `configHash` defaults | ✓ | ✓ | **authoritative when `source: "manifest"`** (D38); `{ configHash }` alone parses as `checkout` and the supervisor reads the file |
| `settings` | `{ settings: string (JSONC text), keymap: string } \| null` | ✓ | ✓ | written verbatim to `~/.config/zed/{settings,keymap}.json` (D18) |
| `logs` | `{ flushIntervalSecs: 5, maxBatch: 200, maxBatchBytes: 262144 }` | ✓ (defaults) | ✓ | `maxBatch ≤ 200`, `maxBatchBytes ≤ 262144` |
| `activity` | `{ intervalSecs: 30 }` | ✓ | ✓ | `≥ 10` |
| `allowedOrigins` | string[] (`scheme://host[:port]`) | ✓ | ✓ (`[controlPlaneUrl()]`) | → `--allowed-origin` each (D5) |
| `extensions` | string[] | ✓ | ✓ (`workspaces.installed_extensions`) | → `POST /control/extensions {install}` (D5) |
| `prebuild` | `{ id, branch, commit } \| null` | ✓ | optional | `pb-` principals |

### 7.4 Sandbox → control plane calls (b8 §3.5, §4.2; b9 §4.2)

All carry `Authorization: Bearer <ZS_SANDBOX_TOKEN>`, `X-ZS-Build: <build>`, `x-vercel-protection-bypass` when `ZS_BYPASS_SECRET` is set; retried on 5xx/connect/timeout with jittered backoff (250 ms · 2ⁿ, 5 tries), 429 honours `Retry-After`; 401 → health `degraded`, 410 → activity loop stops (b8 §3.5). Rate limits per sandbox (b9 §3.7 `LimitName`/`LIMITS`; the extensions limit is also on the b9 §4.2 route line): manifest 60/min, git-token 30/min, ports 30/min, activity 10/min, logs 120/min, client-errors 60/min, extensions 30/min, image-build 60/min (b10). Principals: `sb-` workspaces, `pb-` prebuild builders and, since b10, `ib-` image builders; an `ib-` principal may call only `git-token` (read-only, its own repository), `logs` and `image-build/*` — every other route answers `404 not_found` to it.

| Call | Request | Response | Notes |
|---|---|---|---|
| `GET …/manifest` | — | 200 manifest (§7.3) | |
| `POST …/git-token` | `{ "host": "github.com", "protocol": "https", "path": "owner/repo.git" \| null }` (b9 also accepts `{}`) | 200 `{ "username": "x-access-token", "token": "ghs_…", "expiresAt": <unix seconds (b8) \| RFC 3339 (b9)> }` ⚠ M18 (b8 tolerates the ISO form); 404 `host_unsupported`; 403 `repo_not_allowed` | token scoped to the workspace repo; dotfiles repo → owner's OAuth token (b9 §4.2) |
| `POST …/ports` | `{ "port", "visibility": "public"\|"private", "label": string \| null }` (b9 also accepts `action`) | 200 `{ "url": string \| null, "visibility", "slot": number \| null }`; 409 `slots_exhausted` (b8) / `no_free_slot` (b9) ⚠ M19; 400 bad port | public outside the pool → `sandbox.update({ ports })` |
| `DELETE …/ports/{port}` | — | 204 | frees the slot |
| `POST …/activity` | `ActivityReport` (§7.5) | 200 `ActivityDirective` (§7.5) | |
| `POST …/logs` | `LogBatch` JSON (§7.6) ≤ 200 entries / 256 KiB (b9 also accepts NDJSON `LogLine { ts, level, target, msg, sid?, fields? }`) | 204 (any 2xx); 413 → batch halved | |
| `POST …/client-errors` | `{ "build", "kind": "server_crash"\|"boot", "message" (≤ 4 KiB), "stack"? (≤ 64 KiB), "marks"? }` | 202 | |
| `POST …/extensions` | `{ "installed": [ids] }` (≤ 200) | 204 | relay of the server's `POST $SUPERVISOR_URL/extensions` (D18) → `workspaces.installed_extensions` (D19) |
| `GET …/image-build` (b10) | — | 200 `ImageBuildSpec` (b10 §4.6: sanitised `devcontainer.effective`, `normalized`, hashes, `image.{repository,tag,ref,fullRef}`, `layer`, `limits`, `cache`, `logUploadUrl`) | `ib-` principals only |
| `POST …/image-build` (b10) | `ImageBuildStatusReport { phase, message?, errorCode?, result?: { digest, sizeBytes, manifest?, lockfile? } }` — no `imageRef` on the wire | 204; 409 `build_not_active` | `pushed` stores the digest only; the ref is recomputed server-side |
| `GET <restore.tarballUrl>` | no `Authorization`, no bypass header | 200 `application/gzip` | presigned Blob URL |

Error body: b9 emits `{ error: { code, message, details? } }`; b8 parses `code` from a string-valued `error` field ⚠ M19.

### 7.5 Activity ping and directive (D13; b8 §3.5, §3.15; b9 §3.25, §4.2)

`ActivityReport` (every `manifest.activity.intervalSecs` = 30 s, started right after the manifest):

| Field | Type | Meaning |
|---|---|---|
| `lastInputAt` | unix ms \| null | `/health.last_input_at`; `now` while `busy \|\| phase != ready` (b8 workaround until b9 honours D13) |
| `sessionActive` | bool | from `/health.session_active` |
| `sid` | string \| null | `/health.session.session_id` (b2 §3.7 `SessionMeta.session_id` = JWT `sid`; b8 §3.8 `ServerHealth.session`, §3.15 step 2 read that key) |
| `serverUptimeSecs`, `agentUptimeSecs` | u64 | |
| `status` | `"booting"\|"ready"\|"degraded"\|"stopping"` | |
| `cpuBusyPct` | 0..100 \| absent on first ping | `/proc/stat` delta (D18) |
| `busy` | bool | lifecycle command or warm-up running (D13) |
| `phase` | `"manifest"\|"restore"\|"clone"\|"server_starting"\|"dotfiles"\|"post_create"\|"post_start"\|"warm"\|"ready"` | b8 §3.8 `Phase`; b9 §4.2 zod enum and §3.18 `HealthProbe.phase` carry `warm` too |
| `listening` | `[{ port, pid, process }]` (≤ 256) | feeds `keys.listening` |

`ActivityDirective`: `{ idleStopAt: unix ms \| null (null for prebuilds), sessionCapAt: unix ms \| null, stop: bool, forwards: ForwardView[], serverTime: unix ms }` (b9); b8 reads `idleStopAt`, `sessionCapAt`, `stop`, `forwards?` and ignores `serverTime` (b8 §3.5) ⚠ M20. `idleStopAt = max(lastInputAt, keepaliveAt, sessionStartedAt, busy ? now : 0) + idleMinutes·60 000`; `sessionCapAt = sessionStartedAt + ZS_SESSION_CAP_MS` (24 h); `stop = state === "stopping"`. Supervisor policy (b8 §3.15): `IDLE_STOP_IN { seconds }` once per distinct `idleStopAt` when `idleStopAt − now ≤ 5 min` (`IDLE_NOTICE_LEAD`); `SESSION_CAP_IN` at ≤ 30 min (`CAP_NOTICE_LEAD`); `stop: true` → same shutdown path as SIGTERM; `RESUMED` posted once after the server is healthy on a resumed boot (first-boot marker); `STOPPING` posted exactly once by the stop path.

### 7.6 Logs (b8 §3.6; b9 §4.2)

`LogBatch { workspaceId, sandboxName, sessionId (= manifest.session.id), build, entries: [LogEntry { ts: unix ms, level: "error"\|"warn"\|"info"\|"debug"\|"trace", source: "server"\|"agent"\|"post_create"\|"post_start"\|"post_attach"\|"dotfiles"\|"proxy"\|"prebuild"\|"warm"\|"services"\|"builder"\|"server:<module_path>", msg (≤ 8 KiB), fields?: { sid, epoch, truncated, dropped } }] }`. b10: `services` is the supervisor's `dockerd` service, `builder` the image builder's driver (the only source an `ib-` principal may send); for an `ib-` principal `workspaceId = repoId`, `sessionId = buildId`, `build = ZS_SERVER_BUILD_ID`, and the driver counts drops above 200 lines/s into `fields.dropped`/`truncated` — the full transcript is the uploaded `build.log`. Defaults/ceilings: flush 5 s, ≤ 200 entries, ≤ 256 KiB, line ≤ 64 KiB, queue ≤ 5 000 lines / 8 MiB, per-source 200 lines/s. `scrub` redacts `gh[pousr]_…`, `github_pat_…`, `zsb_…`, JWT shapes, `v1.<b64>.<b64>` port tokens, `bearer …`, `x-access-token:…@`, `zs_port_token=`, `zs_port_session=`, `x-vercel-protection-bypass:`, `?token=`.

### 7.7 Boot, health and local API (b8 §3.8, §3.12, §3.16, §4.4)

Boot order: pid/run dir + control secret → SIGTERM handlers → **listeners 8445 + 8450 and log shipper up first** → manifest (fatal exit 3 after 60 s grace) → JWT keys, forwards, activity relay → restore/clone (exit 4 on failure) → `write_settings` → devcontainer parse → `clear_stale_server` (8443, 8446) → spawn server, `wait_for_server(60 s)` → proxies (4 slots) + port watcher → `ready` → `POST /control/extensions`, `POST /control/lifecycle {resumed}` if resumed → dotfiles / postCreate (30 min) / postStart (10 min) beside the server with `busy = true` → `forwardPorts` requested → `first-boot.done` → `phase = ready`. `postAttachCommand` (10 min) on first `session_active`. Stop: `status = stopping` → cancel lifecycle task → `POST /control/lifecycle {stopping}` (7 s) → SIGTERM child pid → `TERM_GRACE` 10 s → SIGKILL process group → `logs.flush(3 s)` → remove pid file and secret → exit 0; worst case ≈ 21 s (b9 waits ≤ 25 s on the command's exit).

`GET :8445/health` (`0.0.0.0`; no auth; 200 for `ready|degraded`, 503 for `booting|stopping`, same body; non-loopback callers get everything except `forwards`):

```json
{ "status": "ready", "phase": "post_create", "build": "<ZS_BUILD_ID>", "manifestBuild": "…", "region": "iad1", "resumed": false, "busy": true, "uptimeSecs": 131,
  "lastError": null, "server": { "running": true, "pid": 214, "restarts": 0, "lastExit": null, "startedAtMs": 1756800001000, "crashLoop": false,
  "health": { "build", "version", "uptime_secs", "session_active", "last_input_at", "dirty_buffers" } },
  "proxy": { "running": true, "slots": { "8444": 3000, "8447": null, "8448": null, "8449": null } },
  "forwards": [ … ],  "listening": [3000] }
```
b9 `probeHealth` reads `status, phase, build, manifestBuild, resumed, busy, server.running, server.crashLoop, server.restarts, uptimeSecs` (`HealthProbe.phase` includes `warm`, b9 §3.18) and computes `ready = status ∈ {ready, degraded} && server.running`; `waitUntilReady` also uses the supervisor command's exit code (b9 §3.18, §4.8).

Local API (`127.0.0.1:8450`, never declared to Vercel; bearer = control secret; `ZS_SUPERVISOR_URL`):

| Route | Caller | Body → Response |
|---|---|---|
| `POST /ports` | server (b4 §3.11 `PortForwarder::forward`) | `{ "port", "visibility", "label" }` → 200 `{ "url": string \| null }`; 400 infra port; 409 `{ "error": "<control-plane code>" }`; 502 `control_plane_unavailable` |
| `DELETE /ports/{port}` | server | → 204 |
| `POST /extensions` | server (`report_installed_extensions`) | `{ "installed": [ids] }` → 204 (best-effort relay) |
| `POST /git-token` | `zs-agent credential` | `{ "host", "protocol", "path" }` → `GitTokenResponse` verbatim (`expiresAt` unix seconds); 403/404 passed through |
| `POST /lifecycle` | tests/operators | `LifecycleBody` → forwarded to the server |
| `GET /health` | anyone | same as 8445 |

Budgets (b8 §3.26): create → `ready|degraded` with `serverRunning` ≤ 35 min (b9 `waitUntilReady`); resume ≤ 3 min; postCreate/postStart/postAttach/dotfiles/restore 30/10/10/10/20 min; prebuild exit ≤ 50 min (warm budget `min(15 min, 48 min − elapsed)`); stop ≤ ≈ 21 s vs b9's 25 s; ping 30 s, unhealthy after 5 min without a ping; bootstrap token TTL 1 h (b8) / 10 min (b9, M12); proxy cookie 8 h; restore URL 1 h.

---

## 8. Control-plane routes (b9 §4.2) and the shell contract (b7 §4.2)

### 8.1 Conventions

Path aliases: `{api}` = `https://<control-plane>/api`. User routes: Clerk session (`requireViewer()`); workspace-scoped routes also accept the `zs_editor` cookie (`allowEditorCookie: true`). Errors `{ error: { code, message, details? } }`: 401 `unauthenticated`, 404 `not_found` (also foreign workspaces), 400 `invalid_body`, 409 `conflict`, 402 `plan_limit`, 423 `locked`, 429 `rate_limited` (+ `Retry-After`), 413 `payload_too_large`, 500 `internal`. Ids `^(ws|repo|img)_[0-9A-HJKMNP-TV-Z]{20}$`; sandbox names `^(sb|pb|ib)-[a-z0-9-]{1,60}$` (`img_`/`ib-` are b10's image builds and builders); `Idempotency-Key` honoured on `POST /api/workspaces` (24 h). `proxy.ts` (Next 16 middleware) protects dashboard pages and `/api/{repos,me,secrets,admin}`; excludes `/editor/`, `sw.js`, `manifest.webmanifest`, `.well-known/workflow/`, `api/sandboxes/`, `api/webhooks/`, `api/cron/` (b9 §3.21).

### 8.2 User-facing routes

| Route | Auth | Request | Response / errors | Source |
|---|---|---|---|---|
| `POST /api/workspaces` | Clerk; rate `user.workspaces.create` 10/600 s | `{ repo: {repoId} \| {installationId, owner, name}, ref?: {branch}\|{pullRequest}\|{revision}, machine?: vcpu2\|vcpu4\|vcpu8\|vcpu32, region?: iad1\|sfo1\|cle1\|cdg1, idleMinutes? (5..240), name?, orgId? }` | 202 `{ workspace: WorkspaceView, runId }`; 402 `plan_limit`, 403 `installation_not_allowed` / `account_flagged`, 404 `repo_not_found`, 409 `image_building { imageBuildId, runId, phase }` / `image_failed { imageBuildId, error }` / `devcontainer_invalid { error, warnings }` (b10 §3.10; the body gains `allowBase?: boolean` to create on the base image instead when `repos.allow_base_fallback` permits) | b9 §4.2; b10 |
| `GET /api/workspaces` | Clerk | — | 200 `{ workspaces: WorkspaceView[] }` | |
| `GET /api/workspaces/{id}` | Clerk or editor cookie | — | 200 `{ workspace }` (`state`, `stateReason` `boot:<phase>`, `workflowRunId`, …) | |
| `PATCH /api/workspaces/{id}` | Clerk | `{ name?, idleMinutes? }` | 200 `{ workspace }` | |
| `DELETE /api/workspaces/{id}` | Clerk | — | 202 `{ runId }`; 409 `workspace_busy` while a run is pending/running | |
| `POST /api/workspaces/{id}/connect` | Clerk or editor cookie; rate `user.connect` 60/min; `maxDuration = 60` | `{ takeover: bool = false, clientBuild?: string, reason: "open"\|"reconnect"\|"resume" = "open", tabId: string (8..64) }` | 200 `ConnectInfo`; 202 `{ status: "resuming", runId }`; 409 `workspace_stopped` (reason `reconnect` on stopped/stopping — never resumes), 409 `session_active` `{ holder: { startedAt } }`, 409 `client_build_mismatch { serverBuild, clientBuild }`; 423 `workspace_busy`; 410 `workspace_deleted`; 500 `sandbox_unhealthy` | b9 §3.18, §4.2 |
| `POST /api/workspaces/{id}/session` | Clerk or still-valid editor cookie | — | 204 + `Set-Cookie: zs_editor` | b9 §3.8 |
| `POST /api/workspaces/{id}/stop` | Clerk or cookie | — | 202 `{ runId }` \| 200 `{ state: "stopped" }` | |
| `POST /api/workspaces/{id}/rebuild` | Clerk | `{ fromImage?: bool }` | 202 `{ runId }`; 409 while a run is in flight | |
| `POST /api/workspaces/{id}/keepalive` | Clerk or cookie; rate 30/min | — | 200 `{ keptAliveUntil }` | |
| `GET /api/workspaces/{id}/ports` | Clerk or cookie | — | 200 `{ ports: ForwardView[], listening: number[], slotsFree: number }` | |
| `POST /api/workspaces/{id}/ports` | Clerk or cookie | `{ port (1..65535 ∉ infraPorts()), visibility, label? }` | 200 `{ forward: ForwardView }`; 409 `no_free_slot`; 409 `workspace_not_running` | D8 |
| `DELETE /api/workspaces/{id}/ports?port=N` | Clerk or cookie | — | 204 (frees the slot) | |
| `GET /api/workspaces/{id}/ports/{port}/open` | Clerk (browser navigation) | — | 303 `https://<slot-host>/__zs/auth?zs_port_token=<token>&next=/`; 404 no/public forward; 409 `workspace_not_running` | D8; b9 §3.12 |
| `POST /api/workspaces/{id}/client-errors` | Clerk or cookie; rate 60/min | `{ build, kind: "panic"\|"boot"\|"error"\|"perf"\|"close", message (≤ 4 KiB), stack? (≤ 64 KiB), marks? }` | 202 | |
| `GET\|POST /api/workspaces/{id}/test-local` (test only) | Clerk or cookie; exists only with `ZS_TEST_ROUTES=1` **and** `ZS_SANDBOX_BACKEND=local`, refused in a production build (`lib/test-routes.ts`) | POST `{ op: "drop_socket" \| "kill_sandbox" \| "read_file", path? }` | GET 200 `TestLocalInfo { workspace, sandbox: { dir, status, portMap, internal, rpcProxy, alive }, workspaceDir, supervisor }`; POST 200 `{ dropped }` (needs `ZS_LOCAL_RPC_PROXY=1`, 409 `rpc_proxy_off`) / `{ killed: pid[] }` / `{ path, content }`; 404 otherwise | round 4 `tests/e2e-browser` |
| `GET /api/repos`, `POST /api/repos` | Clerk | `{ installationId, owner, name }` | `{ installations: [...] }` / `{ repo }` | |
| `GET\|POST /api/repos/{id}/prebuilds` | Clerk | `{ branch }` | `{ prebuilds }` / 202 `{ runId }` | |
| `GET\|POST /api/repos/{id}/image-builds` (b10) | Clerk (`maintain` for POST); rate `user.image-builds` 5/600 s | `{ ref?: {branch}\|{revision}, force?: bool }` | `{ builds: ImageBuildView[] }` / 202 `{ build, runId }`, 200 `{ build }` when a live build exists; 400 `no_devcontainer` / `devcontainer_invalid` | b10 §3.10 |
| `GET /api/repos/{id}/image-builds/{buildId}/log` (b10) | Clerk | — | 303 presigned GET of the build log (1 h); 404 `log_unavailable` | b10 §3.10 |
| `GET\|PUT /api/me/settings`, `/api/me/keymap` | Clerk or cookie | PUT `{ content (≤ 512 KiB JSONC), version? }` | `{ content, version }`; 409 `version_conflict` | b7 `saveDocument` target |
| `GET\|PUT /api/me/dotfiles` | Clerk | `{ repoUrl, installCommand }` | same | |
| `GET\|PUT\|DELETE /api/secrets` | Clerk; rate 60/min | `?scope=user\|org\|repo&scopeId=`; PUT `{ scope, scopeId, name (`^[A-Z_][A-Z0-9_]{0,127}$`, not `ZS_*`, not reserved), value (≤ 64 KiB) }` | names only; 204; 400 `invalid_name`/`reserved_name` | |
| `POST\|DELETE /api/admin/workspaces/{id}` | org owner/admin | `{ action: "stop" }` | 202 `{ runId }` | |
| `POST /api/webhooks/{github,clerk,stripe}` | signatures | | 200 | |
| `GET /api/cron/{sweep,gc,snapshot-usage,invoice}` | `Bearer ${CRON_SECRET}` | | 200 `{ ran, … }` | schedules `* * * * *`, `17 3 * * *`, `47 0 * * *`, `23 2 1 * *` (b9 §3.23) |
| `ANY /api/ai/{provider}/{...path}` (b11; `compat/<name>` = two segments) | `zs_ai` cookie via `requireAiViewer` (outside the Clerk matcher; `Sec-Fetch-Site` cross-site or absent → 403 `cross_site`; flagged account → 403); rate `user.ai.requests` 120/min; `maxDuration = 300`, upstream timeout `ZS_AI_UPSTREAM_TIMEOUT_MS ≤ 290 000`; `apps/web/vercel.ts` declares `supportsCancellation: true` for `app/api/ai/**` | the provider-dialect request the Zed crate sends, credential header/query carrying the placeholder `zs-proxy-v1` (stripped; the user's key from `ai_keys` injected per provider kind); body ≤ `ZS_AI_MAX_BODY_BYTES` (4 MiB) | upstream status and headers (allowlisted) with the body streamed unbuffered; proxy-originated errors are **dialect-shaped** with `x-zs-ai-error: <code>`: 401 `unauthenticated` \| `ai_key_missing`, 403 `cross_site` \| `account_flagged`, 404 `ai_disabled` \| `unknown_provider` \| `path_not_allowed`, 400 `too_many_headers`, 405 `method_not_allowed`, 413, 415, 429 `rate_limited` \| `ai_daily_limit` \| `too_many_streams`, 402 `ai_spend_cap`, 502 `upstream_unreachable` \| `upstream_redirect`, 503 `ai_unavailable`, 504 `upstream_timeout` | b11 §3.10, §3.11, §4.4-4.6 |
| `GET /api/ai/keys` | `zs_ai` or Clerk (`requireAiViewer`); rate `user.ai.keys` 30/min | — | 200 `{ providers: [{ id, configured, envName, … }] }` (never values; unknown fields ignored by the bundle); 404 `ai_disabled` when `ZS_AI_PROXY=off` (§8.1 envelope) | b11 §3.4, §4.4 |
| `PUT\|DELETE /api/ai/keys/{provider}` (`compat/<name>` allowed) | same | PUT `{ key (1..8192 printable ASCII, never the placeholder), kind?: "openai"\|"anthropic", upstream?, exportEnv?, routeAgents? }` | 204; 400 `invalid_body` \| `invalid_provider` \| `invalid_upstream` \| `invalid_key` \| `export_not_supported`, 403 `plan_required`, 409 `compat_limit`, 429 `rate_limited`; DELETE 204 (bumps `zs:ai:epoch:<sub>`) / 404 `not_found`; audit `ai_key.put`/`ai_key.delete` `{ provider }` | b11 §3.4, §4.4 |
| `GET /api/ai/usage?period=YYYY-MM` | `zs_ai` or Clerk | — | 200 `AiUsageSummary { period, totals, byProvider, caps }` | b11 §3.5, §4.4 |

`ConnectInfo` (b9 §3.18): `{ wsUrl: "wss://<host8443>/rpc", token, sessionId: "con_…" (fresh per call, = JWT sid), serverBuild, clientBuild, sessionExpiresAt (ISO = token exp), sessionCapAt (ISO), audience }` → b7 `ConnectInfo { ws_url, token, session_id, takeover, server_build, session_expires_at }` (extra fields ignored) → `WebSocketConnectionOptions::new(ws_url, workspace.id, session_id, token).with_takeover(takeover)` (b1 §4.6; b7 §3.28).

`ForwardView`: `{ port, visibility: "private"\|"public", label: string \| null, url: string \| null, slot: number \| null }` (b9 §4.2).

### 8.3 Sandbox-facing routes — see §7.4 (all under `{api}/sandboxes/{name}/…`, bearer `zsb_…`).

### 8.4 Shell ↔ wasm loader contract (b7 §3.20, §3.30, §4.1, §4.2; b9 §3.26, §4.6 adopt it verbatim)

Exports of `/editor/<build>/zed_web.js`: `start(configJson: string, assets: Uint8Array, host: ZsHost): Promise<void>` (single-shot; rejects `{ code, message }`), `flush_client_state(): Promise<void>`, `set_hidden(hidden: boolean)`, `has_unsaved_changes(): boolean`, `build_id(): string`.

`ZsBootConfig`: `{ buildId, connect: { wsUrl, token, sessionId, takeover?, serverBuild?, sessionExpiresAt? }, workspace: { id (D1 identity), paths: ["/workspaces/<repo>"] }, settingsJson?, keymapJson?, backend?: "auto"\|"webgpu"\|"webgl", hostOs?: "mac"\|"windows"\|"linux", origin? }`. `origin` (b11 §3.18) is the control-plane origin the `/api/ai/*` `api_url`s and the keys page hang off; the shell omits it and the bundle uses `window.location.origin` — in a browser no other value can work (the `zs_ai` cookie is same-origin and the editor CSP allows `connect-src 'self'`), so the field is for native and unit harnesses only. `app/api/ai/**` must keep `supportsCancellation: true` in `apps/web/vercel.ts` (b11 §3.9a): without it a closed tab never aborts the upstream stream.

`ZsHost`: `bootProgress(stage, detail)`; `refreshConnectInfo(): Promise<connect>` — rejects `{ code: "unauthorized" }` (→ `RefreshError::Unauthorized`, terminal), `{ code: "stopped" }` on 409 `workspace_stopped` (→ `RefreshError::Stopped`, terminal), anything else `{ code: "unavailable" }` (→ `RefreshError::Other`, retried ≤ 20); polls `202`/`423` up to 5 min inside one attempt (b9 §3.26); `saveDocument(kind: "settings"\|"keymap", json): Promise<void>`; `reportError(kind: "panic"\|"boot", message, stack)`; `onLifecycle(kind: "idle_stop_in"\|"session_cap_in"\|"stopping"\|"resumed", seconds)`; optional `onClosed({ code, reason })`.

Stages: `booting|assets|settings|connecting|database|languages|window|ready|reconnecting|stopped|failed`. `stopped`/`start()` rejection codes: `bad_config, bad_host, bad_assets, runtime_missing, ctors_missing, settings, connect_failed, session_busy (4005), taken_over (4001), incompatible_server (4002/4006), server_stopping (1001), unauthorized, workspace_stopped, reconnect_exhausted, database, window, boot_timeout (90 s), cancelled, quit` (b7 §3.28 `close_code_detail`, §4.1). Shell mapping: `session_busy` → takeover dialog → reload with `takeover: true`; `taken_over` → "Take back"; `incompatible_server` → reload; `unauthorized` → `POST /session` then sign-in; `workspace_stopped`/`server_stopping` → stopped; `reconnect_exhausted` → retryable error (b9 §3.26). D2's host `reconnect()` = shell re-`POST /connect` + `location.reload()` via `sessionStorage.zsNext` (b7 §3.28; b9 §3.26 bullet 10).

Loader requirements: COOP `same-origin`, COEP `require-corp`, CORP `same-origin` on `/w/:id` and `/editor/:build/*`; `crossOriginIsolated` checked before `init()`; `globalThis.__zsBindgenShimUrl = "/editor/<build>/zed_web.js"` before `start`; `globalThis.__zsCallCtors?.() ?? wasm.__wasm_call_ctors?.()` once; `visibilitychange` → `set_hidden(document.hidden)` (+ `flush_client_state()` when hidden); `pagehide` → best-effort flush; `beforeunload` → `has_unsaved_changes()`; `fullscreenchange` → `navigator.keyboard.lock(["KeyW","KeyT","KeyN","KeyQ","Tab"])`. Editor CSP (b7 §3.30; b9 §4.9): `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic' 'wasm-unsafe-eval' ['unsafe-eval' while ZS_CSP_UNSAFE_EVAL=1]; connect-src 'self' wss://*.vercel.run https://*.vercel.run; worker-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'nonce-<n>'; font-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; upgrade-insecure-requests`. Bundle layout: b7 §3.31 emits `<out_dir>/<build>/{zed_web.js, zed_web_bg.wasm, zed-assets.tar, build.json, loader.js, index.html}`; b7 §6's nightly `web_bundle` job packs that directory as `editor/<build>.tar` and lists the id in `editor/manifest.json` at `ZS_EDITOR_BUNDLE_SOURCE`; b9 §3.30 unpacks it into `public/editor/<build>/` and serves `{zed_web.js, zed_web_bg.wasm, zed-assets.tar, build.json}` (`build.json.build_id` is the build identity — no `BUILD_ID` file; `loader.js`/`index.html` are b7's dev harness and are not served), `Cache-Control: public, max-age=31536000, immutable` (b7 §3.31, §6; b9 §3.22, §3.30). Service worker `/sw.js`, scope `/w/`, precaches the build's three runtime files (b9 §3.31).

Test-hooks bundle (round 4, `apps/web/tests/e2e-browser`): `script/build-web --test-hooks` builds `zed_web` with the `test-hooks` cargo feature, which installs `window.__zs_test` (`crates/zed_web/src/test_hooks.rs`: async hooks over the real workspace, editor, terminal and client-state entities plus event logs of connection transitions, saves and `set_hidden` calls) at the top of `start()`. Its id is `<build>-test` (`<build>-test-names` with `--names`), its `build.json` carries `test_hooks: true`, and it is never a production bundle: `scripts/fetch-editor-bundle.ts` refuses to deliver such an id or `build.json`, `lib/env.ts` refuses a `-test` `ZS_CLIENT_BUILD_ID` in a production build/deployment (`ZS_ALLOW_TEST_BUNDLE=1` overrides both for a test deployment), and only `scripts/dev-local.sh browser` (local backend, `ZS_TEST_ROUTES=1`, `ZS_LOCAL_RPC_PROXY=1`, port 3110) stamps one into new workspaces. The hook names are the `test_hooks.rs` header's list; `hooks.ts` mirrors it.

---

## 9. Sandbox port layout and private-port cookie

### 9.1 Ports ⚠ M10 (no two briefs agree on the full map)

| Port | Bind | Owner | Declared to Vercel | Purpose | b8 §3.3 | b9 §3.2 defaults | D5/D8 / BUILD-SPEC |
|---|---|---|---|---|---|---|---|
| 8443 | `0.0.0.0` | `serve --listen` | yes | `/rpc`, `/files`, `/extensions/*`, public `/health` | ✓ | `ZS_RPC_PORT` 8443 | BUILD-SPEC §4.2 |
| 8444 | `0.0.0.0` | `zs-agent` proxy slot 0 | yes | private-port proxy | ✓ | slot | D8 |
| 8445 | `0.0.0.0` | `zs-agent` health | yes | `GET /health` polled by b9 | ✓ | `ZS_HEALTH_PORT` 8445 **and** a D8 slot | BUILD-SPEC §6.2 |
| 8446 | `127.0.0.1` | `serve --control-listen` | no | `/control/*` | ✓ | a D8 slot (declared) | D5 |
| 8447 | `0.0.0.0` | proxy slot 1 | yes | | ✓ | slot | D8 |
| 8448, 8449 | `0.0.0.0` | proxy slots 2, 3 | yes | | ✓ | not declared | — |
| 8450 | `127.0.0.1` | `zs-agent` local API | no | `/ports`, `/extensions`, `/git-token`, `/lifecycle` (`ZS_SUPERVISOR_URL`) | ✓ | (b9 §2 cites 8446, stale) | b4 default 8445 (M13) |
| pool | — | user processes | yes | `3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888` | ✓ | `ZS_PORT_POOL` | BUILD-SPEC §5.2 |

b8 `PROXY_SLOTS = [8444, 8447, 8448, 8449]`, `INFRA_PORTS = [8443..8450]` (8 ports); b9 `ZS_PROXY_SLOTS = "8444,8445,8446,8447"`, `infraPorts() = [8443, ...slots, 8445]`; create declares `dedupe([8443, ...slots, 8445, ...pool])` (b9 §4.8); prebuild declares `[8443, 8445]` (both). Forward/pool ports must avoid the infra set on both sides.

### 9.2 Proxy behaviour (b8 §3.11; D8)

One listener per slot, slot-bound target port, no path prefix, no Host routing. Entry `GET {origin}/api/workspaces/{id}/ports/{port}/open` → 303 → `https://<slot-host>/__zs/auth?zs_port_token=<token>&next=/` (`AUTH_PATH = "/__zs/auth"`, `LOGOUT_PATH = "/__zs/logout"`, `BOOTSTRAP_PARAM = "zs_port_token"`). Slot binding: from `forwards[].slot` when present, else the first valid bootstrap token binds the slot to its port (private forwards only). Responses: 303 + `Set-Cookie` on success; 401 `{"error":"port_session_required"}` (HTML when `Accept: text/html`), 401 `port_session_stale` (cookie cleared), 404 `slot_unbound`, 502 `{"error":"upstream_unavailable","port":N}`. Forwarding: origin-form URI, hop-by-hop headers stripped but `Upgrade`/`Sec-WebSocket-*` kept and `Connection: upgrade` re-inserted, `Host: 127.0.0.1:<port>`, `X-Forwarded-Host`, `X-Forwarded-Proto: https`, `X-Forwarded-Port: <port>`, `zs_port_session` stripped from the forwarded `Cookie`; WebSocket 101 tunnelled with `copy_bidirectional`; `MAX_INFLIGHT` 256, `MAX_UPGRADED` 1024 per slot, `HEADER_TIMEOUT` 30 s.

### 9.3 Cookie and bootstrap token format (b8 §3.10, §4.5; b9 §3.12)

| Item | Value |
|---|---|
| Cookie name | `zs_port_session` (D8) |
| Cookie value | `v1.<b64url(payload)>.<b64url(HMAC-SHA256(key, "v1." + b64url(payload)))>`, unpadded base64url; payload JSON in field order `{"ws","port","sub","iat","exp","jti"}`; key = per-boot random 32 bytes in memory (invalid after every resume) |
| Cookie attributes | `Path=/; HttpOnly; SameSite=Lax; Max-Age=<exp−now>; Secure` (omitted under `ZS_INSECURE_COOKIES=1`); `exp = iat + 28800` (8 h `COOKIE_TTL_SECS`) |
| Verify | MAC compared with `subtle::ConstantTimeEq` before decoding; `exp > now`; `exp − iat ≤ max_age`; `ws == workspace_id`; port ∈ 1..=65535 ∖ infra; cookie `port` must equal the slot binding |
| `next` | must start with a single `/` (not `//`, `/\`), else `/` |
| Bootstrap token (`zs_port_token`) | ⚠ M12: b8 — same `v1.` HMAC format under `manifest.portSessionSecret` (standard base64, padded, 32 bytes; per generation), max age 3600 s, `sub` = user id; b9 — ES256 JWT `{ iss, sub: userId, ws, sid: "port:<port>", aud: "<audience>/ports", iat, exp: iat + 600, jti }` signed with the session key, verified with `manifest.jwt.publicKeys` |
| Test vector | `docs/contracts/fixtures/port-token.vector.json` `{ secretB64, payload, token }` (b8 §3.26) — b9 §6.2 expects to pin an ES256 shape instead |

---

## 10. Client-state image (D7; b4 §3.4-3.9; b6 §3.3-3.4; b7 §3.27)

| Item | Value | Source |
|---|---|---|
| What | one whole-database image of the `AppDatabase` (`sqlite3_serialize` of `main`), with `GlobalKeyValueStore` folded into the same database (D7) | b4 §3.4, §3.6a |
| Restore | `Connection::open_scratch_from_image` (rejects < 100 bytes / bad magic; header bytes 18-19 set to 1 because native images come from WAL files) → migration dry-run on the scratch → `restore_main_from` (`backup_main`) into the empty main before `journal_mode` is set; any failure → `RestoreOutcome::Skipped(reason)` + empty DB, store read-only until `allow_overwrite()` | b4 §3.4, §3.5; b7 §3.27 step 3d |
| Outcomes | `RestoreOutcome::{NoImage, Restored, Skipped(String)}`; `AppDatabase::open_with_image(Option<Vec<u8>>) -> (Self, RestoreOutcome)` awaited on `background_spawn` | b4 §3.6; D7 |
| Wire | `SaveClientState { sqlite: gzip level 3 (async-compression) of the image, version, gzip: true, client_build }`; `MAX_IMAGE_BYTES = 12 MiB` uncompressed (client) and on the wire (server) | b4 §3.7-3.9 |
| Versioning | `version` strictly increasing per workspace; server keeps the max; `accepted: false` → client adopts `max(version, server)` and retries `+1`; `LoadClientState { metadata_only: true }` after reconnect (`resync`) | b4 §3.7, §3.9 |
| Flush triggers (exhaustive) | 1. `SAVE_INTERVAL = 15 s` ticker when dirty (`write_generation` changed) and nothing in flight; 2. `visibilitychange` → hidden (`set_hidden(true)` also `set_interval(5 s)`); 3. `LifecycleNotice STOPPING` — `flush_pending_saves` → `snapshot_unsaved_buffers` (D6) → `flush_now` inside the 5 s window. `pagehide` best-effort only; `on_app_quit` never runs in the browser | D7; b4 §3.7-3.8; b7 §3.27; b9 §3.26 bullet 6 |
| Stop rule | `ClientStateStore::stop()` on every `RemoteClientEvent::Disconnected`; `flush_now` then returns `Err`; no flush after 4001/4005 | b4 §3.7; b7 §7.20 |
| `unsaved_buffers` (D6) | `CREATE TABLE unsaved_buffers(workspace_id INTEGER NOT NULL, abs_path TEXT NOT NULL, text TEXT NOT NULL, mtime_seconds INTEGER, mtime_nanos INTEGER, snapshot_at_unix_ms INTEGER NOT NULL, PRIMARY KEY(workspace_id, abs_path), FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT`; domain `UnsavedBuffersDb` (deps `[WorkspaceDb]`); `UNSAVED_SNAPSHOT_LIMIT_BYTES = 8 MiB`; dirty path-backed buffers only; restored after `open_remote_project_in_new_window_with_client` with `did_reload` + `set_text` + `forget_transaction`, then cleared | b4 §3.8; b7 §3.27 step 3f |
| Terminal rows (D4) | `terminals` gains `remote_terminal_id INTEGER`, `remote_title TEXT` | b3 §3.6a |
| Global KVP fold | b4 §3.6a (and b7 §2.5, §9 D7, which cite the same table): `scoped_kv_store` rows under namespace `"global"` (`GLOBAL_KVP_NAMESPACE`); b6 §3.4: `GlobalKeyValueStore::from_app_db` shares the app connection and keeps its `kv_store` queries (keys must not collide with `KeyValueStore`) ⚠ M17 | b4 §3.6a; b6 §3.4, §7.12 |
| wasm write queue | b6 `wasm_lock_queue()` (reentrant spin lock, also the FFI lock); b4's text still names `locking_queue` ⚠ M17 | b6 §3.3; b4 §3.6 |
| Server storage | `paths::remote_server_state_dir()/client_state/` = `$DATA/server_state/client_state/{db.sqlite, db.sqlite.prev, meta.json}`; `meta.json = {"version","saved_at_unix_ms","bytes","gzip","client_build"}`; bytes stored verbatim | b4 §3.9, §4.3 |
| Portability | not importable into desktop Zed's shared database; layout follows the workspace across resumes and rebuilds (D9 tarball carries the data dir) | D7, D9 |
| Prebuild | the warm-up client never sends `SaveClientState`, so the snapshot's `client_state/` stays empty | b4 §3.15 item 7; b8 §3.16a |

---

## 11. File paths and env vars on the sandbox

| Path / var | Value | Source |
|---|---|---|
| `HOME` | `/vercel` (universal image re-homes `ubuntu`, uid 1000) | b8 §2, §7.1; b4 §2 |
| Zed data dir (`paths::data_dir()`) | `/vercel/.local/share/zed` (`$XDG_DATA_HOME/zed` else `$HOME/.local/share/zed`); in the rebuild tarball (D9) | b4 §2, §4.3; b8 §3.3 |
| Client-state store | `/vercel/.local/share/zed/server_state/client_state/{db.sqlite, db.sqlite.prev, meta.json}` | b4 §3.9, §4.3 |
| Extensions | `/vercel/.local/share/zed/remote_extensions/<id>/` (+ `staging/`, `work/`); no index file | b4 §4.3 |
| Language-server downloads | `paths::languages_dir()` under the data dir (warm-up seeds it into the snapshot) | b8 §2, §3.16a |
| Server settings/keymap | `/vercel/.config/zed/{settings.json, keymap.json}`, written verbatim from `manifest.settings` after any restore, content-hash markers | b8 §3.14; D18 |
| Workspaces | `/workspaces` (`ZS_WORKSPACES_DIR`); repo at `manifest.workspaceDir = /workspaces/<repo.name>`; clone staged at `<dir>.partial` | b8 §3.3, §3.14 |
| Supervisor state dir | `/vercel/.zs` (`ZS_STATE_DIR`): `run/{zs-agent.pid, server.port, control.secret}` (cleared each boot), `markers/{clone.done, post-create.done, dotfiles.done, first-boot.done, settings.sha256, keymap.sha256}`, `jwt/key-<i>.pem` (+ `key-warm.pem` during prebuild), `restore.partial/` | b8 §3.3, §3.14 |
| Control secret file | `/vercel/.zs/run/control.secret` (0600; `ZS_CONTROL_SECRET_FILE`; `--control-secret-file`) | D18; b8 §3.9 |
| Public key files | `/vercel/.zs/jwt/key-0.pem …` (0600; `--jwt-public-key` each) | b8 §3.14 |
| Binaries | `/usr/local/bin/zed-remote-server` (`ZS_SERVER_BIN`), `/usr/local/bin/zs-agent` | b8 §3.19 |
| Dotfiles | `$HOME/dotfiles`; installers `install.sh, install, bootstrap.sh, bootstrap, script/bootstrap, setup.sh, setup, script/setup` | b8 §3.14 |
| Rebuild tarball | `tar czf … -C / workspaces vercel/.local/share/zed` — exactly D9's two paths (b9 §3.19, §6.6 `archive_paths_are_exactly_d9`; b8 §2, §3.14, §7.16 describe the same two) → Blob `rebuild/<ws>/<ts>.tgz`; restored by extracting at `/` (b8 `restore_tarball` tolerates and maps a `vercel/.config/zed` entry from a pre-D9 archive; `~/.config/zed` is re-materialised by `write_settings` regardless) | D9; b8 §3.14; b9 §3.19, §4.8 |
| Image `ENV` | `HOME=/vercel SHELL=/bin/bash ZS_BUILD_ID=<id> ZS_WORKSPACES_DIR=/workspaces ZS_SERVER_BIN=/usr/local/bin/zed-remote-server ZS_SUPERVISOR_URL=http://127.0.0.1:8450 ZS_CONTROL_SECRET_FILE=/vercel/.zs/run/control.secret`; `RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo` | b8 §3.19 |
| Git config | `credential.helper='!zs-agent credential'`, `credential.useHttpPath=true`, `safe.directory='*'`, `init.defaultBranch=main` | b8 §3.19 |
| Server environment | process env ∪ filtered `manifest.env` ∪ **filtered** `remoteEnv` (b10 §3.1 rule 7: the §7.2 filter is applied in the control plane and again by `Config::child_env`) ∪ `{ ZS_SUPERVISOR_URL, ZS_CONTROL_SECRET_FILE, SHELL, USER, HOME }` minus stripped vars; **no** `ZS_CONTROL_SECRET` (D18) | b8 §3.3, §3.9; b10 |
| Browser (wasm) home | `/home/web` (D11); `config_dir` `/home/web/.config/zed`; `settings_file`/`keymap_file` `/home/web/.config/zed/{settings,keymap}.json` in `WasmFs`; empty `snippets/`, `prompts/`, `tasks/` dirs seeded | b7 §3.1, §3.24; b6 §2 |
| AI provider table `docs/contracts/ai-providers.v1.json` | `{ version: 1, placeholderKey: "zs-proxy-v1", proxyPrefix: "/api/ai/", providers: [{ id, kind, upstream, envName, settingsPath }] }`, shared by `apps/web/lib/ai/providers.ts` and byte-identical to `zed/crates/zed_web_core/tests/fixtures/ai-providers.v1.json` (`tests/ai/providers.test.ts`). **Append-only**: rows are added, never renamed or removed; a bundle ignores ids it does not know and `PROXIED_* ⊆ fixture` is pinned by `cargo test -p zed_web_core` | b11 §3.15, §6.4, §6.5 |

---

## 12. Build ids and version coupling

| Item | Value | Source |
|---|---|---|
| `ZS_BUILD_ID` format | `<zed-commit>-<patch>`: CI `<short sha>-<github run number>` (b8 §3.25), `cargo xtask web-bundle` default `<short sha>-0` (b7 §3.31), BUILD-SPEC §11.2 `<zed-commit>-<patch>` | |
| Where it is baked | `crates/remote` `wire::ZS_BUILD_ID` (`build.rs` rerun-if-env-changed, b1 §3.19); `crates/remote_server/build.rs` (b2 §3.13); `zed_web::build_id()` (`"dev"` fallback, b7 §3.20); image `ENV ZS_BUILD_ID` (b8 §3.19); `sandbox/image/build-server.sh` exports it and builds with `--features serve` (b8 §3.20) | |
| Control plane | `ZS_CLIENT_BUILD_ID` (bundle for new workspaces), `ZS_SERVER_BUILD_ID`, `ZS_IMAGE_REF` (`zs-workspace:<build>` or `@sha256:…` from `image.json`); `workspaces.server_build`, `workspaces.client_build` stamped at create/rebuild; `manifest.build = server_build`; the page loads `/editor/<workspace.client_build>/`; `ZS_EDITOR_BUNDLES_KEEP = 5` older bundles retained | b9 §3.2, §3.26, §3.30, §4.1; b8 §3.25 |
| Compatibility rule | `builds_compatible`: exact match unless either side is dev | b1 §3.2 |
| Repo images (b10) | A repo image (`zs-workspace-<slug>@sha256:…`) embeds the builder's `zed-remote-server`/`zs-agent`; the driver verifies `/opt/zs/layer/BUILD_ID == spec.layer.serverBuild` and `/opt/zs/layer/LAYER_VERSION == spec.layer.version` before building (exit 2 on drift) and the layer bakes `ENV ZS_BUILD_ID` from that file; `image_builds.server_build`/`layer_version` record them, and `workspaces.server_build`/`client_build` are stamped from the build the image was made for (a stale-but-served image keeps its own bundle) | b10 §3.13, §4.5 |
| Check points | `serve --client-build` vs `Hello.build` → Close 4002 (b2 §3.7); client `HelloAck.build` → exit 92 (b1 §3.3); `/connect` `clientBuild` vs `workspaces.client_build` → 409 `client_build_mismatch` (b9 §4.2); `waitUntilReady` health `build` vs `server_build` → `FatalError build_mismatch` (b9 §4.8); `manifest.build ≠ ZS_BUILD_ID` → supervisor health `degraded` (b8 §3.4). `serve --client-build` is fed from the image's `ZS_BUILD_ID` (b8 §4.6), not from `manifest.build` (b9 §4.7 comment amended): equal at create, and a swapped image is only reported as `degraded` | |
| Zed version | `ZED_PKG_VERSION` derived from `crates/zed/Cargo.toml` by `remote_server/build.rs` and `zed_web/build.rs`; `release_channel::init(AppVersion::load(ZED_PKG_VERSION, Some(ZS_BUILD_ID), sha))` | b7 §3.20, §3.26 step 3 |
| Toolchains | Rust `1.97.1` (`rust-toolchain.toml`; supervisor pins the same); `wasm-bindgen-cli` exactly `0.2.120`; wasi-sdk 25; `wasm-opt` (binaryen ≥ 116); Node 24 / pnpm 11 in the image | b5 §2, item 1; b7 §3.31; b8 §3.1, §3.19 |
| Upstream pins | Zed fork branch `zs` on `c3cf80c`; community fork evidence `zee295/zed` `88db2d1` | all briefs |

---

## 13. wasm build flags and vendored crates

### 13.1 `.cargo/config.toml` (b5 item 2; b7 §3.16)

```toml
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
    "-C", "link-arg=--export=__wasm_call_ctors",   # b7 §3.16 (b7-owned line)
    "-C", "link-arg=--export=__heap_base",         # carried (round 3b): wasm-bindgen 0.2.120's threads transform reads it to place the thread id/stack; rustc 1.97 no longer exports it (b7 §3.16 step 4b)
]

[env]
MACOSX_DEPLOYMENT_TARGET = "10.15.7"
CC_wasm32_unknown_unknown = { value = "script/wasm-cc", relative = true }
AR_wasm32_unknown_unknown = { value = "script/wasm-ar", relative = true }   # wrapper resolving the same SDK as script/wasm-cc
```

| Item | Value | Source |
|---|---|---|
| `script/wasm-cc` | wasi-sdk 25 clang: `--target=wasm32-unknown-unknown -matomics -mbulk-memory -mmutable-globals -isystem <sdk>/share/wasi-sysroot/include/wasm32-wasi`; `WASI_SDK_PATH` override; SDK at `target/wasi-sdk` (`script/download-wasi-sdk`) | b5 item 1 |
| `script/check-wasm` | `[-p <crate>]… [passthrough]`; env `ZS_WASM_MODE=check\|build`, `ZS_WASM_TOOLCHAIN`; exit 2 if any `RUSTFLAGS`/`CARGO_ENCODED_RUSTFLAGS`/`CARGO_BUILD_RUSTFLAGS`/`CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS` is set or on a Windows shell; passes `-Zbuild-std=std,panic_abort` with `RUSTC_BOOTSTRAP=1`; `default_packages` (day one `gpui_platform cloud_api_client smol`) is the CI layer list, appended **in the script** by b6 (`sqlez db prompt_store clock fs terminal acp_thread client`) and b7 (`util paths settings ui …`, `zed_web` last); the xtask `cargo_check_wasm()` calls the script with no arguments (b6 §6 amended to append there, not in the generator) | b5 items 3, 16; b6 §6; b7 §3.32 |
| Bundle build | `ZS_WASM_MODE=build ZS_BUILD_ID=<id> script/check-wasm -p zed_web --profile web-release` (+ `--features util/debug-embed` for `dev`); `wasm-bindgen --target web --no-typescript`; `script/patch-wasm-bindgen-memory.sh`; `wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue --enable-simd` (`--enable-simd` added in round 3b: the linked module carries v128 instructions); asset pack `tar -C assets -cf zed-assets.tar fonts icons images themes sounds`; never emit `.br` files | b7 §3.31 |
| Profile | `[profile.web-release] inherits = "release", debug = false, strip = "symbols", opt-level = "z", lto = "thin", codegen-units = 1` | b7 §5 |
| getrandom | the `wasm_js` **feature** selects the backend (gpui, `sqlez`, `zed_web` declare it); the cfg is parity only | b5 §2; b6 §5; b7 §5 |
| `time` | `wasm-bindgen` feature via `crates/time_format` and `zed_web`; `sys-locale` `js` | b5 item 15; b7 §5 |
| tree-sitter | `wasm` feature dropped on wasm in `language`, `multi_buffer`, `migrator`, `edit_prediction_context`, `language_tools`, `languages`, `settings_json`; `zed_web` enables no `test-support` reaching `grammars`; `languages` with `load-grammars` | b5 item 12; b7 §5 |
| Forbidden crates in the wasm closure | `wasmtime, cranelift-codegen, livekit, webrtc-sys, aws-config, aws-sdk-bedrockruntime, aws-lc-sys, rustls-platform-verifier, tiny_http, tokio, tokio-rustls, tokio-native-tls, gpui_tokio, extension_host, call, dev_container, auto_update, http_client_tls, bedrock, reqwest, audio, cpal, rodio, miniprofiler_ui` (`cargo xtask web-bundle --check-only`) | b7 §6 |
| SQLite on wasm | `libsqlite3-sys = { package = "sqlite-wasm-rs", version = "0.5.5" }` in `sqlez`'s wasm table; `SQLITE_THREADSAFE=0`, `OMIT_SHARED_CACHE`, memory VFS; one connection per `ThreadSafeConnection`, all FFI under `sqlez::wasm_lock`; wasm `DB_INITIALIZE_QUERY` = `journal_mode=MEMORY; case_sensitive_like=TRUE; synchronous=OFF` (no `busy_timeout`) | b6 §3.3, §3.4, §5 |
| `-D warnings` | reaches path-sourced crates uncapped (shim and every `vendor/<name>`) once b5 item 16 lands | b5 §7.14 |

### 13.2 Patched / vendored crates (D10: `zed/vendor/<name>`, path `[patch]`, non-members listed in `[workspace] exclude`, one section each in `zed/vendor/README.md` with a `- Upstream:` line carrying the 40-hex rev or crates-io version)

| Crate | Location | Upstream / rev | Patch entry | Change | Owner |
|---|---|---|---|---|---|
| `smol` (shim, **workspace member**, package name `smol` 2.0.2) | `crates/zs_smol_shim` | smol 2.0.2 facade | `[patch.crates-io] smol = { path = "crates/zs_smol_shim" }` | native = smol's surface; wasm exports `Task, Executor, LocalExecutor, future, io, pin, prelude, ready, stream, channel, lock, spawn, fs, net, process, runtime`; `fs`/`net`/`process` return `io::ErrorKind::Unsupported` immediately; no `Timer`/`block_on`/`unblock`/`Unblock`/`Async` on wasm | b5 items 4-6, §4 |
| `yawc` | `vendor/yawc` | `https://github.com/zed-industries/yawc` @ `71a452f551cac178367eaac5d7418a09afa1f3a2` (version `0.3.3`) | `[patch."https://github.com/zed-industries/yawc"] yawc = { path = "vendor/yawc" }` | wasm `WebSocket::connect_with_protocols(url, &[&str])`; `impl Drop for WebSocket` closes the socket | b1 §3.18 |
| `lsp-types` | `vendor/lsp-types` | `https://github.com/zed-industries/lsp-types` @ `f1783e63a7f4eb4397bf51d4148b4895a1f7ab16` (0.95.1) | `[patch."https://github.com/zed-industries/lsp-types"] lsp-types = { path = "vendor/lsp-types" }` | `percent-encoding = "2.3"`; wasm `Uri::from_file_path`/`to_file_path` (Unix rules, `..` → `Err`, no scheme check) | b5 item 7 |
| `agent-client-protocol` | `vendor/agent-client-protocol` | crates.io 2.0.0 = `agentclientprotocol/rust-sdk` @ `ce023279824149008659dd8f4b8b70266a7e8210` (tag `v2.0.0`, `src/agent-client-protocol`) | `[patch.crates-io] agent-client-protocol = { path = "vendor/agent-client-protocol" }` | `async-io`, `async-process`, `blocking` moved to `cfg(not(wasm))` tables; `acp_agent`/`stdio` modules and re-exports gated; `[lints]` tables removed (not part of the upstream PR) | b5 item 11 |
| `alacritty_terminal` | `vendor/alacritty_terminal` (+ `vendor/alacritty_terminal.patch`) | `https://github.com/zed-industries/alacritty` @ `4c129667ce56611becdc82de6e28218c80e2e88f` (0.26.1-dev) | `[patch."https://github.com/zed-industries/alacritty"] alacritty_terminal = { path = "vendor/alacritty_terminal" }` | `event_loop`, `thread`, `tty` modules and `home`/`libc`/`polling` deps gated `cfg(not(wasm))`; `edition = "2024"`, `rust-version = "1.85.0"` literals; `readme` dropped | b6 §3.1 |
| `wasm_thread` | `vendor/wasm_thread` | `https://github.com/zed-industries/wasm_thread` @ `0cf96c7708dfb97ccf3da50347e25edcf75d6937` | `[patch."https://github.com/zed-industries/wasm_thread"] wasm_thread = { path = "vendor/wasm_thread" }` | all five `js_sys::eval` sites replaced by `js_sys::global()`/`web_sys` lookups; shim URL from `globalThis.__zsBindgenShimUrl` (fallback: stack trace). Not in D10's list of four — added by b7 for the CSP decision | b7 §3.33 |
| `async-tar` | `vendor/async-tar` | `https://github.com/zed-industries/async-tar` @ `bd3ad6f89df9a9da7a8535958756d6bf465936a0` (0.6.1) | `[patch."https://github.com/zed-industries/async-tar"] async-tar = { path = "vendor/async-tar" }` | local-filesystem surface (`Archive::unpack`, `Entry::unpack*`, `Builder::append_path*`/`append_dir*`/`append_file`, `Header::set_metadata*`, the `Drop` that blocks on `finish`) gated `cfg(not(wasm))` under the existing `runtime-…` feature gates (`async_std::fs` does not exist on wasm32); wasm keeps the reader (`Archive`, `Entries`, `Entry`, `Header`, `PaxExtensions`) and the in-memory `Builder` | wasm closure loop (round 3) |
| `pet`, `pet-fs`, `pet-conda`, `pet-hatch`, `pet-uv`, `pet-env-var-path`, `pet-pyenv`, `pet-virtualenvwrapper`, `pet-venv` | `vendor/<name>` (nine directories) | `https://github.com/microsoft/python-environment-tools` @ `bb8e04607b96a3865d6aa4bb2a5a5a82ce05b5f0` (0.1.0; the rev on Zed's `pet*` lines) | `[patch."https://github.com/microsoft/python-environment-tools.git"] <name> = { path = "vendor/<name>" }`, one line each; `pet-{hatch,uv,env-var-path,pyenv,virtualenvwrapper,venv}` gain `[workspace.dependencies]` git lines at that rev so the patch has a target; `vendor/<name>/Cargo.toml` keeps `version = "0.1.0"` | non-test `#[cfg(unix)]` gates become `#[cfg(any(unix, target_family = "wasm"))]`; `pet_python_utils::executable::find_executable{,_or_broken}` imports gated `cfg(not(wasm))` with a private wasm twin carrying the Unix arm's body; `impl Default for {Hatch, Uv}` and `pet`'s `&EnvironmentApi` → `&dyn Environment` coercions gated (pet-core's `EnvironmentApi` is `unix`/`windows` only); standalone-manifest lines (`version`/`edition`/`license` literals, in-repo path deps → git at the same rev). Native source is byte-for-byte the same | wasm closure loop (round 3) |
| `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-bash` | `vendor/tree-sitter-{python,rust,bash}` | crates.io 0.25.0 = `tree-sitter/tree-sitter-python` @ `293fdc02038ee2bf0e2e206711b69c90ac0d413f`; 0.24.2 = `tree-sitter/tree-sitter-rust` @ `e2bee853694a1d3e0f6ef308fe3674542fec95d7`; 0.25.1 = `tree-sitter/tree-sitter-bash` @ `a06c2e4415e9bc0346c6b86d401879ffb44058f7` | `[patch.crates-io] tree-sitter-<x> = { path = "vendor/tree-sitter-<x>" }` (the vendored `version` must equal the dependency line's, or cargo reports the patch unused) | `bindings/rust/build.rs` only: the tree-sitter CLI template's wasm32-unknown-unknown block (tree-sitter 43623ec `crates/cli/src/templates/build.rs:10-16`: `DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS` on the include path, so `scanner.c` stops reaching wasi-sdk 25's `stdio.h` → `wasi/api.h` `#error`); bash additionally `-Disdigit=iswdigit` on that target. Everything else byte-identical to the registry package | wasm closure loop (round 3) |
| `tree-sitter-cpp`, `tree-sitter-yaml`, `tree-sitter-md` | `vendor/tree-sitter-{cpp,yaml,md}` | `tree-sitter/tree-sitter-cpp` @ `5cb9b693cfd7bfacab1d9ff4acac1a4150700609` (0.23.4); `zed-industries/tree-sitter-yaml` @ `baff0b51c64ef6a1fb1f8390f3ad6015b83ec13a` (0.6.1); `zed-industries/tree-sitter-markdown` @ `b596e737286780d7bfa9fcddceaeeb754574b352` (0.3.2) | `[patch."<upstream git url>"] tree-sitter-<x> = { path = "vendor/tree-sitter-<x>" }` (git deps carry no version requirement); `tree-sitter-md` is also on `script/check-wasm`'s default list | the same `build.rs` block; md adds `-Disdigit=iswdigit`; cpp adds `-include wchar.h` and a `static_assert` define (the shim headers lack `wchar_t`/`static_assert`). Everything else byte-identical to the checkout. Known noise on wasm: cc-rs `-Wunused-parameter` on the shim's `__assert_fail` (`cargo:warning`, not rustc, so `-D warnings` does not see it) | wasm closure loop (round 3) |
| `sqlite-wasm-rs` — **not vendored** (provenance record only) | registry package, `Cargo.lock` checksum `dc3efc0d…` | crates.io 0.5.5 = `Spxg/sqlite-wasm-rs`; bundles SQLite 3.53.0 (native stays `libsqlite3-sys` 0.30.1 / SQLite 3.46.0; images are portable) | none: no `[patch]`, not in `exclude`; reached as `libsqlite3-sys = { package = "sqlite-wasm-rs", version = "0.5.5" }` from `sqlez`'s wasm table | unmodified. **Provenance rule**: `vendor/README.md` carries a `## sqlite-wasm-rs (not vendored; provenance record)` section whose `- Upstream:` line names the crates-io version and which records that the package's `sqlite3.c`/`sqlite3.h` are byte-identical to sqlite.org's `sqlite-amalgamation-3530000.zip` (`sqlite3.c` SHA-256 `c94657c2…`, `sqlite3.h` SHA-256 `8e43a799…`), plus its compile flags; the comparison is re-run on every version bump (release checklist). `script/check-vendor-pins` skips `## <crate> (not vendored; …)` sections | b6 §3.3, §5 |

`[workspace] exclude = ["vendor/yawc", "vendor/lsp-types", "vendor/agent-client-protocol", "vendor/alacritty_terminal", "vendor/wasm_thread", "vendor/pet-fs", "vendor/tree-sitter-python", "vendor/tree-sitter-rust", "vendor/tree-sitter-bash", "vendor/tree-sitter-cpp", "vendor/tree-sitter-yaml", "vendor/tree-sitter-md", "vendor/async-tar", "vendor/pet-conda", "vendor/pet-hatch", "vendor/pet-uv", "vendor/pet-env-var-path", "vendor/pet-pyenv", "vendor/pet-virtualenvwrapper", "vendor/pet-venv", "vendor/pet"]` (21 entries, the order of `zed/Cargo.toml:272`; b5 item 4/§9 defines the array; `vendor/yawc` appended by b1 §3.18/§7.1; `vendor/alacritty_terminal` by b6 §3.1; `vendor/wasm_thread` by b7 §5; the `pet*`, `tree-sitter-*` and `async-tar` entries by the round-3 wasm closure loop, `docs/status/round3.md` §1). `script/check-vendor-pins` (round 3) checks every `vendor/<name>` against its `[patch]` line, its `Cargo.toml` rev/version and its README section. Other cross-brief Cargo additions: workspace deps `http-body-util 0.1.3`, `hyper 1.7`, `hyper-util 0.1.17`, `multer 3.1`, `subtle 2.6` (b2 §3.1), `async-executor 1.13`, `async-net 2.0`, `blocking 1.6` (b5 item 4), `tar 0.4` (no default features), `zed_web_core` (b7 §3.15); `remote_server` feature `serve` with `jsonwebtoken` `aws_lc_rs` (b2 §5), `libc`, `parking_lot`, `portable-pty` (b3 §5), `serde` (b4 §5); `crates/remote` gains `url`, `web-time`, `yawc`, native `gpui_tokio` (b1 §5). Supervisor: standalone workspace `sandbox/supervisor` (`zs-agent`, edition 2024, musl static, `reqwest` `rustls-tls-native-roots` → `ring`, `jsonwebtoken` `rust_crypto`) (b8 §5).

---

## 14. Open mismatches

Each entry gives both positions verbatim in substance; none is resolved here.

| # | Topic | Position A | Position B | Blocking? |
|---|---|---|---|---|
| **M1** | Heartbeat direction | D3, b1 §3.2/§3.3 step 4/§7.12(f): `Heartbeat` is a **client → server** text frame every 5 s; a server → client heartbeat is tolerated but not part of the contract; server must tolerate ≥ 90 s gaps. b7 §7.25 and b8 §3.16a follow this. | b2 §3.7 (`HEARTBEAT_INTERVAL`), §4, §7.18: the server **also sends** `{"type":"heartbeat"}` every 5 s to keep hidden tabs' activity channel fed, and accepts the client's silently; "flagged for confirmation". | No (both sides tolerate the other's frames), but the wire has two heartbeats until decided. |
| **M2** | Close code for SIGTERM / `STOPPING` and the meaning of 1001 | D3, b1 §3.2/§3.3 step 5/§7.17: 4004 is retired; the stopping server closes **1001** (`CLOSE_GOING_AWAY`, terminal, no refresh); b1 removed `CLOSE_SERVER_STOPPING` from `wire.rs`. b7 §3.28/§4.1 (`server_stopping` ← 1001) and b9 §3.26 follow D3. b8 §3.9 expects "closes 1001". | b2 §3.7 steps 2/9, §4, §7.19: **1001** = `CLOSE_SUPERSEDED` (a same-epoch reconnect replaced a half-open socket; reconnectable); SIGTERM closes **4004** (`CLOSE_SERVER_STOPPING`, imported from `wire.rs`); b2 §6.4 step 12 asserts Close 4004 on SIGTERM. | Yes for code: b2 imports a constant b1 deleted. Runtime: a b2 4004 would reach b1's `Err → refresh → RefreshError::Stopped` path (one extra round trip); a b2 1001 supersede would be read by b1 as terminal 90. |
| **M3** | Stale epoch on `reconnect:true` | b1 §4.2 (`Hello.epoch` doc), §4.4 item 3, §6.3 test 8: a stale epoch is a **fresh session** (`HelloAck.resumed = false`) once arbitration has passed (4005 if another instance is attached); the client maps it to exit 90. D3 says the same ("or stale epoch"). | b2 §3.7 step 1, §4, §6.3 `stale_epoch_closes_4001`, §7.19: a stale epoch is closed with **4001 "stale epoch"** and the client must re-open with `reconnect:false`. | Behavioural only (both end in a fresh open); test suites disagree (b1 §6.3 test 8 vs b2 §6.3). |
| **M4** | `Hello.session_id ≠ JWT sid` and `HelloAck.session_id` | b1 §3.2 (`CLOSE_UNAUTHORIZED` comment), §4.2, §4.4 item 5, §7.12(d): server closes **4003**; `HelloAck.session_id` is an echo of `Hello.session_id`. | b2 §3.7 (per-connection task), §4, §6.3 `hello_session_id_mismatch_is_logged`, §9.1 D1: mismatch is **logged at warn**, never fatal; `HelloAck.session_id` is the JWT `sid`. | No (honest clients send equal values). |
| **M5** | Same-instance redial rule | b1 §4.4 item 1, §7.16: a `takeover:false` Hello whose `identifier` equals the attached socket's is a same-instance redial → old socket closed 4001, newcomer proceeds; `Hello.identifier` carries a per-tab nonce for this. | b2 §3.7 step 2, §4: `identifier` is logs-only; the supersede is keyed on `reconnect:true` + matching epoch and closes the old socket with 1001; a `reconnect:false` newcomer without takeover always gets 4005 even from the same instance. | No in practice (b1 always sends `reconnect:true` on a redial), but a same-instance fresh open (reload) gets 4005 under b2 and 4001-supersede under b1. |
| **M6** | `wire.rs` constant names and 4006 handling | b1 §3.2: `CLOSE_SESSION_ACTIVE = 4005`, `CLOSE_BAD_HELLO = 4006` (client maps 4006 to `Ok(92)` terminal), `CLOSE_GOING_AWAY = 1001`. | b2 §3.3, §3.7: imports `CLOSE_SESSION_BUSY` and `CLOSE_SERVER_STOPPING` from `wire.rs`, defines its own `CLOSE_SUPERSEDED = 1001` and `CLOSE_BAD_HELLO = 4006`, and states b1 treats 4006 as reconnectable. | Compile-level for the names; b2's `Hello`/`HelloAck` copy in §2 also lacks `workspace_id` (M8). |
| **M7** | `Log` control frames | b1 §4.2, §3.3 step 4, §9 (b2 §7.4(d)): reserved; "b2 does not emit it in v1". | b2 §3.9 `init_logging_serve`, §6.3 `log_frames_mirror_warnings`: warn/error records **are** mirrored to the attached session as `Log` frames. | No (client logs and ignores). |
| **M8** | `Hello` field set | b1 §4.2: `Hello` has `workspace_id`; `Hello` without it fails to deserialize (b1 §6.1). b8 §3.16a sends it. | b2 §2 row for `wire.rs` and §4 example list `Hello { protocol, build, session_id, identifier, reconnect, takeover, client, epoch }` without `workspace_id`; b2's §6.4 step 4 hello body omits it. | b2's test client would fail against b1's `Hello` type; production uses b1's type, so implementation is unaffected. |
| **M9** | Startup stdout lines | b1 §2 (`ServeArgs` row), §6.3 preconditions, §9 "Removed": **no** `ZS_LISTENING=` stdout line; the bound address is only in `--port-file`. | b2 §3.9 `start_serve`, §4, §6.4 step 1: prints `ZS_LISTENING=<addr>` and `ZS_CONTROL_LISTENING=<addr>` **and** writes `--port-file`. b8 §3.9 parses both stdout lines. | No (b1 only reads the port file). |
| **M10** | Port map inside the VM (D5 × D8 × BUILD-SPEC §6.2) | b8 §3.3, §7.5, §9: slots **`8444, 8447, 8448, 8449`**, health `8445`, control `8446`, supervisor API `127.0.0.1:8450`; `INFRA_PORTS` = 8443-8450; asks b9 to declare `[8443, 8444, 8445, 8447, 8448, 8449, …pool]`. | D8 literally: slots 8444-8447. b9 §3.2 `ZS_PROXY_SLOTS = "8444,8445,8446,8447"` (logs the overlap), `infraPorts() = [8443, 8444, 8445, 8446, 8447]`, create declares `[8443, 8444, 8445, 8446, 8447, …pool]`, manifest `proxySlots` (which b8 ignores); b9 §2 still cites b8's loopback API on 8446; b4 §3.11 `DEFAULT_SUPERVISOR_URL = http://127.0.0.1:8445`; b2 §7.16 and b4 §7.20 list it as unresolved. | **Yes**: with b9's defaults, b8's slots 8448/8449 are undeclared (`domain()` throws, unreachable) and 8445/8446 are declared as slots. Needs a tech-lead port map. |
| **M11** | Control-plane URL env var | b8 §3.3, §4.6, §7.28, §9: `ZS_CONTROL_URL` = API base **including `/api`** is canonical (contract file); `ZS_CONTROL_PLANE_URL` (bare origin, `/api` appended) accepted as fallback. | b9 §2 (b8 row), §3.2 `controlPlaneUrl()`, §3.18 `supervisorEnvFor`, §9.3: emits **`ZS_CONTROL_PLANE_URL`** (origin, no `/api`); "there is no `ZS_CONTROL_URL`". | No at runtime (b8's fallback); canonical name undecided. |
| **M12** | Private-port bootstrap token and the manifest secret | b8 §3.10, §3.4, §4.1, §4.5, §3.26: `zs_port_token` is an **HMAC `v1.` token** under `manifest.portSessionSecret` (required, base64 32 bytes, per generation), max age 3600 s; an ES256 JWT in `zs_port_token` → 401 `Malformed`; pinned vector `port-token.vector.json`. | b9 §3.12, §4.2 `/open`, §4.7, §6.2, §7.4: `zs_port_token` is an **ES256 JWT** `{ iss, sub, ws, sid: "port:<port>", aud: "<audience>/ports", exp: iat + 600, jti }` verified with `manifest.jwt.publicKeys`; the manifest has **no `portSessionSecret`** and carries `jwt.portAudience`; b9 §2 says b8's verifier is a `BootstrapVerifier` on `manifest.audience` (stale). | **Yes**: b8's `Manifest` deserialization requires `portSessionSecret` (b9's manifest fails `validate`), and private ports cannot open with either token against the other side. |
| **M13** | `--supervisor-url` default | b4 §3.11, §3.15 item 1, §4.2: `DEFAULT_SUPERVISOR_URL = "http://127.0.0.1:8445"` (BUILD-SPEC §6.2 port), overridable. | b8 §3.3, §3.9, §3.19: the local API is `127.0.0.1:8450`; `ZS_SUPERVISOR_URL=http://127.0.0.1:8450` in the image and `--supervisor-url http://127.0.0.1:8450` on the spawn line; b4 §7.20 asks b8 to export a port ≠ 8446. | No at runtime (explicit flag wins); the compiled default is wrong (8445 is the health listener, which 404s `/ports`). |
| **M15** | When `on_session_attached` runs | b4 §3.14, §3.15 item 5: called by serve **after every attach, fresh or reconnect**; idempotent. | b2 §3.7 step 4, §3.9 `spawn_gpui_command_loop`: `SessionAttached { kind: Fresh }` → `on_session_attached`; `Reconnect` → nothing. | No (b4 documents the reconnect replay as redundant). |
| **M16** | Who constructs the server-level `PtyManager` | b3 §3.8, §3.9: `HeadlessProject::new` does `PtyManager::global(cx).unwrap_or_else(\|\| PtyManager::install(REMOTE_SERVER_PROJECT_ID, sink, cx))` and stores `Arc<PtyManager>`. | b2 §3.9 step 2, §7.17: serve constructs `Arc::new(pty::PtyManager::new(..))` **after** `build_headless_project` and hands the handle to the project through an accessor b3 defines. | No (both yield one manager per process); the construction site must be picked at implementation time. |
| **M17** | `GlobalKeyValueStore` fold table and the wasm write queue | b4 §3.6a: `GlobalKeyValueStore::from_app_db` dispatches `read_kvp/write_kvp/delete_kvp` to **`scoped_kv_store` under namespace `"global"`** (`GLOBAL_KVP_NAMESPACE`); b7 §2.5 ("the table the folded global store reuses under namespace `"global"` (D7)") and b7 §9 D7 ("2.5 (`scoped_kv_store` reuse)") assert the same table, so Position A is b4 + b7 and whichever table is chosen must be fixed in all three briefs; b4 §3.6 and §7.5 name b6's wasm queue `locking_queue`. | b6 §3.4, §4.7, §7.12(c), §9: `from_app_db` = `Self(db.0.clone())` with the queries **unchanged (`kv_store`)**, sharing the table with `KeyValueStore` (keys must not collide); the wasm default queue is `wasm_lock_queue()` (spin lock), and b6 §9 lists b4's `locking_queue` wording as unresolved. | No for the queue (naming); yes for the table if both land as written (a global key written through b4's path is read through b6's from a different table). |
| **M18** | `git-token.expiresAt` | b8 §3.5, §4.2, §3.13: **unix seconds** canonical; an RFC 3339 string is tolerated (`ExpiresAt::Iso`). | b9 §4.2, §6.5: **RFC 3339** string (`Date.toISOString()`), citing b8's earlier `parse_rfc3339_utc`. | No (b8 tolerates). |
| **M19** | Sandbox-facing error body and slot-exhaustion code | b8 §3.5 `ControlPlaneError::Status { code: JSON "error" field }`, §4.2, §3.22 mock: `409 slots_exhausted`, error body `{ "error": "<code>" }` (string). | b9 §4.2 conventions: `{ error: { code, message, details? } }` (object); private forward with no slot → `409 { error: { code: "no_free_slot", message } }`. | No for the flow (any non-2xx is relayed), but b8 will not extract the code from b9's object-valued `error`. |
| **M20** | Activity directive details | b8 §3.5, §3.8: `ActivityDirective` read as `{ idleStopAt, sessionCapAt, stop, forwards? }`; countdowns computed against the local clock. | b9 §3.25, §4.2: directive adds `serverTime` "so the supervisor can convert timestamps without trusting its own clock"; b9 §2 still describes b8's health body as reduced (no `lastError`/`listening`/`server.health`) and `TERM_GRACE = 3 s` (b8: 10 s, full body minus `forwards`). (The `phase` enum gap — `warm` missing from b9's zod enum and `HealthProbe.phase` — was closed in the 2026-09-02 pass, §15.) | No (b8 ignores `serverTime`); b9's descriptions of b8 are stale. |
| **M21** | D10 vendored-crate list | D10: `yawc`, `alacritty_terminal`, `lsp-types`, `agent-client-protocol`. | b7 §3.33 adds `vendor/wasm_thread` under the same rule for the CSP decision (b7 §3.30). | No (extension, not contradiction); listed so D10 can be amended. |
| **M22** | Cosmetic stale references | b7 §3.28 names close 1001 `server_stopping`; b9 §3.26 bullet 1 says b7 picks `web.json`/`web-macos.json` (D12 has one file); b9 §4.8 says the LSP warm-up "stays b8 §7.14's open item" (b8 §3.16a implements it) and `ZS_PREBUILD_WARM_CMD ≤ 20 min` (b8: remaining budget); b4 §7.21 and b7 §7.27 still list the `onLifecycle` spelling as open (b9 §4.6 now uses snake_case). | — | No. |
| **M23** | Sandbox `timeout` at create (brief vs BUILD-SPEC) | BUILD-SPEC §7.5: "Timeouts at create are 24 hours". | b9 §4.8, §4.10, §7.11: `ZS_SESSION_TIMEOUT_MS` = **4 h rolling**, extended by the sweep; cap 24 h. No decision covers it. | No. |
| **M24** | Repository layout for supervisor sources | BUILD-SPEC §11.1: supervisor sources under `sandbox/image/`. | b8 §2, §7.19: standalone workspace at `sandbox/supervisor/` beside `sandbox/image/`. | No. |

---

## 15. Resolved in the 2026-09-02 contract pass

Mismatches found while auditing §1-§13 against the briefs and fixed in the briefs named (each brief's §9 records the change). None remains open.

| # | Item | Resolution | Briefs edited |
|---|---|---|---|
| R1 | `DEFAULT_SUPERVISOR_URL` module path | b4 §3.11 defines it in `ports.rs`; b2 §3.9/§4 read `crate::ports::DEFAULT_SUPERVISOR_URL` (§2 row updated) | b2 |
| R2 | Activity ping `sid` source | b2 `SessionMeta.session_id` (no `sid` key); b8 §3.8/§3.15 read `health.session.session_id` (§7.5) | b8 |
| R3 | `?zs_proto=`/`?zs_token=` on `/rpc` | Accepted by b2 as a documented, unused superset; both client targets use the subprotocol list; the query form is for `/files` downloads only (§1.2) | b2 |
| R4 | Control-listener `400` body | `{"error":"bad_request","message":"<msg>"}` everywhere (b2 owns the adapter, D20) (§4) | b4 |
| R5 | b1 §6.3 `serve` spawn line | adds `--control-listen 127.0.0.1:0`; b2 §7.21 updated | b1, b2 |
| R6 | JWT claim presence | `sid`, `jti`, `iat` are required by deserialization (`Malformed` 401 when missing); only `sid`/`jti` values are unchecked (§6.1) | — |
| R7 | `HelloAck.version` | no such field; b2 §2 says `/health.version` and `HelloAck.build` | b2 |
| R8 | `mod pty` visibility | `pub mod pty;` (b3 §3.9) in b2 §2/§3.11 | b2 |
| R9 | `--audience` doc comment | `manifest.jwt.audience` (control-plane owned, defaults to the sandbox name, rotatable) | b2 |
| R10 | `ControlRoutes` citation in b4 §3.10 | current `handle<'a>(&'a self, ControlRequest<'a>) -> BoxFuture<'a, ControlResponse>` shape; body cap 1 MiB adopted (closes **M14**) (§4) | b4 |
| R11 | Rebuild tarball paths | exactly D9's two (`workspaces vercel/.local/share/zed`, b9 §3.19); b8 §2/§3.14/§7.16 amended, tolerant `vercel/.config/zed` mapping kept (§11) | b8 |
| R12 | `POST /files` 400 classification | `Traversal` (`..`, symlink escape) vs `InvalidPath` (empty, NUL, absolute, prefix) per b2 §3.6 (§3) | — |
| R13 | `Hello { reconnect: true, epoch: None }` | b2 §3.7 step 1 rules now treat it as `Fresh`, matching the parenthetical and §1.5 step 3 | b2 |
| R14 | Missing client `Heartbeat` frames | b2 §3.7 states the server never times out a socket on them (b1 §7.12(f)); §1.4/§1.7 cite it | b2 |
| R15 | Editor bundle metadata / producer | `build.json` (b7 §3.31) is the identity; b7 §6's `web_bundle` job produces `editor/<build>.tar` + `editor/manifest.json`; `loader.js`/`index.html` are the dev harness (§8.4) | b7, b9 |
| R16 | `serve --client-build` source | image `ZS_BUILD_ID` (b8 §4.6); b9 §4.7 comment amended (§12) | b9 |
| R17 | `sandbox.extensions` rate limit | added to b9 §3.7 `LimitName`/`LIMITS` (30/60) (§7.4) | b9 |
| R18 | `ZS_REGION` delivery | `Sandbox.create({ env })` only; `ZS_SANDBOX_NAME`/`ZS_WORKSPACE_ID` also via `supervisorEnvFor` (§7.2; b8 §4.6 split) | b8 |
| R19 | `check_wasm` layer-list location | `script/check-wasm` `default_packages` (b5 item 3/16); b6 §6 amended (§13.1) | b6 |
| R20 | Editor CSP transcription | `; upgrade-insecure-requests` restored (§8.4) | — |
| R21 | M17 participants | b7 §2.5/§9 D7 added to Position A (§10, §14 M17 — still open) | — |
| R22 | `vendor/yawc` in `[workspace] exclude` | b1 §3.18/§7.1 append it per b5 item 4 (§13.2) | b1 |
| R23 | `forwards[].url` nullability | `string \| null` on both sides; b9 §4.7 matches `ForwardView` (§7.3) | b9 |
| R24 | `HealthProbe.phase` / zod `phase` lack `warm` | both gain `"warm"` in b9 §3.18/§4.2; M20 narrowed to the directive/description items (§7.5, §7.7) | b9 |
