# Sandbox ↔ control-plane API (shared contract)

The single source of truth for what `zs-agent` (b8) calls on the control plane (b9) and what the
control plane may expect back, per D19. Types and rules are in
`sandbox-manifest.v1.json` (the manifest schema), `fixtures/manifest.example.json` (one example
that satisfies it) and `fixtures/port-token.vector.json` (the pinned HMAC port-token vector).
Wire names follow D21 (port map), D29 (`ZS_CONTROL_URL`, snake_case lifecycle kinds, the
`ActivityDirective` timestamp form) and D13 (`busy`/`phase`/`cpuBusyPct`).

Every call below is `{api} = ZS_CONTROL_URL = https://<control-plane>/api`, path
`/sandboxes/{name}/…`, and carries `Authorization: Bearer <ZS_SANDBOX_TOKEN>`, `X-ZS-Build:
<ZS_BUILD_ID>` and – on preview deployments – `x-vercel-protection-bypass: <ZS_BYPASS_SECRET>`.
Retries: only 5xx / connect / timeout, jittered `250 ms · 2ⁿ⁻¹` (±25 %), 5 tries (2 for logs and
activity); `429` honours `Retry-After` (≤ 30 s). A `401` flips health to `degraded`; a `410`
stops the activity loop; the server keeps running either way. Error bodies are
`{ "error": { "code", "message" } }`; a string-valued `{ "error": "code" }` is accepted too.

## Sandbox-facing routes

| Call | Request | Response | Rate limit |
|---|---|---|---|
| `GET …/manifest` | – | `200` manifest (`sandbox-manifest.v1.json`) | 60/min |
| `POST …/git-token` | `{ "host": "github.com", "protocol": "https", "path": "owner/repo.git" \| null }` | `200 { "username": "x-access-token", "token": "ghs_…", "expiresAt": <unix seconds> }` (an RFC 3339 string is tolerated); `404 host_unsupported`; `403 repo_not_allowed` | 30/min |
| `POST …/ports` | `{ "port", "visibility": "public" \| "private", "label": string \| null }` | `200 { "url": string \| null, "visibility", "slot": number \| null }`; `409 slots_exhausted`; `400` bad port | 30/min |
| `DELETE …/ports/{port}` | – | `204` (frees the slot) | 30/min |
| `POST …/activity` | `ActivityReport` (below) | `200 ActivityDirective` (below) | 10/min |
| `POST …/logs` | `LogBatch { workspaceId, sandboxName, sessionId, build, entries[] }`, ≤ 200 entries / 256 KiB | `204` (any 2xx); `413` → the batch is halved | 120/min |
| `POST …/client-errors` | `{ "build", "kind": "server_crash" \| "boot", "message" (≤ 4 KiB), "stack"? (≤ 64 KiB), "marks"? }` | `202` | 60/min |
| `POST …/extensions` | `{ "installed": [ids] }` (relay of the server's `POST $ZS_SUPERVISOR_URL/extensions`) | `204` | 30/min |
| `GET <manifest.restore.tarballUrl>` | **no** `Authorization`, **no** bypass header (presigned Blob URL) | `200 application/gzip` stream | – |

`ActivityReport` (every `manifest.activity.intervalSecs`, ≥ 10 s, from right after the manifest):
`{ "lastInputAt": unix ms | null, "sessionActive": bool, "sid": string | null, "serverUptimeSecs",
"agentUptimeSecs", "status": "booting" | "ready" | "degraded" | "stopping", "cpuBusyPct"?: 0..100,
"busy": bool, "phase": "manifest" | "restore" | "clone" | "server_starting" | "dotfiles" |
"post_create" | "post_start" | "warm" | "ready", "listening": [{ "port", "pid", "process" }] }`.
`lastInputAt` is `now` while `busy || phase != ready` (the workspace is active while it
bootstraps, D13); otherwise the server's `/health.last_input_at`. `postAttachCommand` runs in its
own task, so pings keep their cadence and report `busy: true` while it runs.

`ActivityDirective` (D29): `{ "idleStopAt": unix ms | null, "sessionCapAt": unix ms | null,
"stop": bool, "forwards"?: ForwardView[], "serverTime"?: unix ms }`. The supervisor derives
`idle_stop_in` (≤ 5 min before `idleStopAt`, once per distinct value) and `session_cap_in` (≤ 30
min before `sessionCapAt`) locally, replaces its forward list when `forwards` is present, uses
`serverTime` as the clock for the countdowns, and runs the SIGTERM stop path once on
`stop: true`.

## Local API (`127.0.0.1:8450`, `ZS_SUPERVISOR_URL`; bearer = the control secret file)

| Route | Caller | Body → Response |
|---|---|---|
| `POST /ports` | server | `{ "port", "visibility", "label" }` → `200 { "url", "visibility" }`; `400 port_not_allowed` (infra set); **every** control-plane 4xx → `409 { "error": <control-plane code> }`; `502 control_plane_unavailable` |
| `DELETE /ports/{port}` | server | → `204`; control-plane 4xx → `409`; `502` |
| `POST /extensions` | server | `{ "installed": [ids] }` → `204` (best-effort relay) |
| `POST /git-token` | `zs-agent credential` | `{ "host", "protocol", "path" }` → the control plane's response verbatim (`expiresAt` normalised to unix seconds); `403`/`404` pass through |
| `POST /lifecycle` | tests / operators | `{ "kind": "idle_stop_in" \| "session_cap_in" \| "stopping" \| "resumed", … }` → forwarded to the server's control listener |
| `GET /health` | anyone on loopback | the full health report (`status`, `phase`, `lastError`, `server.*`, `proxy.*`, `forwards`, `listening`) |

## Health probe under D21 (note for b9)

The public `8448` listener answers only `{ "ok", "phase", "build", "serverUp", "uptimeSec" }`
(200 for `ready | degraded`, 503 for `booting | stopping`). Everything the earlier drafts read
from the public host (`status`, `lastError`, `server.running`, `server.health.build`,
`listening`) now lives on the loopback body only. Consequences for `probeHealth` /
`waitUntilReady`:

- readiness is `ok && serverUp`, with `phase` for progress (`phase == "ready"` once the boot's
  lifecycle commands are done; `ok` turns true as soon as the server answers `/health`);
- a fatal boot failure is signalled by the supervisor command's **exit code** (2 config, 3
  manifest, 4 repository), which is why `waitUntilReady` must watch the command as well as the
  probe; the 60 s grace after a manifest failure only keeps `ok: false, phase: "manifest"`
  observable before the exit;
- `lastError` (incl. `build_mismatch`) and `server.*` detail are reachable through
  `runCommand curl -s 127.0.0.1:8450/health` when a failure needs diagnosing.

## Time budgets both sides depend on

| Budget | Value | Owner |
|---|---|---|
| Create: manifest → `8448/health` `ok && serverUp` | ≤ 35 min (b9 `waitUntilReady`; the server is typically up within 60 s of the clone because `postCreateCommand` runs beside it) | b9 waits; b8 starts the server before postCreate |
| Resume: same | ≤ 3 min | idem |
| `postCreateCommand` / `postStartCommand` / `postAttachCommand` / dotfiles / tarball restore | 30 / 10 / 10 / 10 / 20 min, beside the server | b8 |
| Prebuild `zs-agent prebuild` exit | ≤ 50 min (b9 `stepWaitForCommandExit`); warm-up `min(15 min, 48 min − elapsed)` | b8 |
| Stop: `SIGTERM` → agent exit | ≤ ≈ 21 s worst case (`POST /control/lifecycle {stopping}` 7 s > b4's 5 s flush, `TERM_GRACE` 10 s, log flush 3 s); b9 waits ≤ 25 s | b8 |
| Activity ping interval / unhealthy after | 30 s (`manifest.activity.intervalSecs`, ≥ 10) / 5 min without a ping | b9 |
| Port bootstrap token TTL / proxy cookie TTL | 1 h (`PORT_SESSION_TTL_SECS`) / 8 h (per boot) | b9 / b8 |
| Restore tarball URL validity | 1 h from the manifest fetch | b9 |
| Server crash → respawn | `1, 2, 4, 8, 16, 30 s` backoff (the `client-errors` report is posted in the background and never delays it); 6 exits in 10 min → `crashLoop`, `degraded` | b8 |

## Port map (D21)

`8443` serve (`/rpc`, `/files`, `/extensions`, `/health`); `8444-8447` private proxy slots
(cookie `zs_port_session`, entry `/__zs/auth?zs_port_token=…&next=/`); `8448` supervisor health;
forward pool `3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888`; loopback only `127.0.0.1:8450`
(supervisor API) and `127.0.0.1:8451` (serve control listener). The infrastructure set
`8443-8451` is refused as a forward everywhere.

## Image builder principal (`ib-…`, b10 §3.10, §4.6)

A devcontainer image build runs the driver `zs-build-devcontainer` on an `ib-<env>-<img id body>`
sandbox with its own `zsb_…` bearer (rotated per start, retired once the row is `ready`, `failed`
or `superseded` → `410 sandbox_retired`). It may call exactly three routes; every other
`/sandboxes/{name}/…` route answers `404 not_found` to it (the default `kinds` of
`requireSandbox`).

| Call | Request | Response | Rate limit |
|---|---|---|---|
| `GET …/image-build` | – | `200 ImageBuildSpec` (`docs/contracts/devcontainer-normalized.v1.json` under `devcontainer.normalized`; `image.{repository,tag,ref,fullRef}`; `layer.{serverBuild,version,startDockerd,envLines,repoLabel}`; `limits`; `cache.{from,to}`; `logUploadUrl` – a presigned Blob PUT scoped to `image-builds/<id>/build.log`) | 60/min |
| `POST …/image-build` | `{ "phase": "boot" \| "dockerd" \| "clone" \| "devcontainer_build" \| "layer_build" \| "size_check" \| "push" \| "pushed" \| "done" \| "failed", "message"?, "errorCode"?, "result"?: { "digest": "sha256:…", "sizeBytes", "manifest"?, "lockfile"? } }` — **no** `imageRef` on the wire: it is recomputed server-side from the row (§3.10) | `204`; `409 build_not_active` once the row left `building`/`pushing` | 60/min |
| `POST …/git-token` | as above; `path` must be the build's own repository | `200 { … }` with an installation token scoped to `contents: read` | 30/min |
| `POST …/logs` | `LogBatch` with `workspaceId = repoId`, `sessionId = buildId`, `build = ZS_SERVER_BUILD_ID`; `source` must be `builder` | `204` | 120/min |

`LogBatch.entries[].source` for a workspace or prebuild supervisor gains `services` (the `dockerd`
service started from `manifest.devcontainer.services`, b10 §3.16); a builder may only send
`builder`. Because `docker build` output exceeds the 200 lines/s per-source cap by an order of
magnitude, the driver's flusher counts drops and sets `fields.dropped`/`truncated`; the full
transcript is the uploaded `build.log`.

`manifest.devcontainer` is the `DevcontainerSpec` block (`manifest-devcontainer.v1.json`, D38):
authoritative when `source` is `manifest` (the supervisor does not read the checkout's file),
a hint when `checkout`. `ActivityReport.phase` gains `services`.
