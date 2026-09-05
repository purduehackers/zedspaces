# b9-control-plane: Control plane (Next.js on Vercel)

Plan of record: `/Users/ray/Projects/play/wed/BUILD-SPEC.md` §2 principle 1 (line 68), §3.4 boot (155-164), §3.5 service worker (172), §3.6 PWA (185), §4.3 tokens (225-227), §5.2 ports (249-254), §5.4 client persistence (262), §5.5 lifecycle notices (264-266), §6.2 supervisor (294-305; `:8445/health` at 302), §6.4 prebuilds (313-316), §7 control plane (319-395; §7.3 admin at 350, §7.5 lifecycle at 364-372, §7.6 CSP at 375, §7.7 dashboard at 379, §7.10 billing at 389-391, §7.11 abuse at 393-395), §8 AI proxy (402), §10 security (424-437; XSS/"no inline script" at 430), §11.1-11.2 layout and builds (441-461), §12 client errors (470), §13 tests (478-483), Appendix B (580-592; idle stop at 588). Workstream target: `/Users/ray/Projects/play/wed/apps/web` (a bare `create-next-app` scaffold today). **Binding cross-brief decisions: `/Users/ray/Projects/play/wed/docs/briefs/DECISIONS.md` (D1-D20, 2026-09-02), cited inline as `D<n>`; §9 records what each one changed here.** BUILD-SPEC §4.2, §5.2 and §5.4 are amended by D3, D8 and D7 respectively; where this brief cites those sections it means the amended text. Sibling briefs this one must agree with: `docs/briefs/b8-supervisor-image.md` (the **consumer** of every sandbox-facing route, the manifest and the `runCommand` env — b8's own header says "the sandbox-facing wire contract in this brief is b9's", and D18/D19 fix that contract on this brief's §4.2/§4.7 field names; b8 as it stands on disk (revision of 19:22, no §9 yet) still carries shapes derived from this brief's *previous* revision and predates D5/D8/D13/D18 — §2 lists every such row and §9 the deltas it must pick up), `docs/briefs/b1-ws-transport.md` (client transport, token placement, refresh callback; identity is `workspace_id`, `session_id` is per connect — D1), `docs/briefs/b2-serve-mode.md` (server-side JWT verification, `/health`, `/rpc`, `/files` CORS, the D5 control listener), `docs/briefs/b7-edge-gates-entry.md` (`crates/zed_web` loader contract: `ZsBootConfig`/`ZsHost`/`start(configJson, assets, host)` — its §4.2 is authoritative for the shell) and `docs/briefs/b4-proto-additions.md` (lifecycle notices, `/control/*`, client state, the installed-extensions relay). The shared manifest fixture both b8 and this brief test against is `docs/contracts/fixtures/manifest.example.json` (D19; created by b8 §3.26, generated from §4.7 here). All paths below are relative to `apps/web` unless absolute or prefixed with `zed/` or `docs/`.

Every external API cited here was fetched on 2026-09-02 (Vercel Sandbox SDK reference, Sandbox concepts/persistence/images/snapshots/tags/pricing, Workflow DevKit Next.js guide and errors/retries/start/local-world pages, Clerk Next.js quickstart, "How Clerk works" (session token lifetime), `clerkMiddleware` / `auth()` / webhooks pages, `@vercel/config` `vercel.ts` page, Cron Jobs and Managing Cron Jobs, Vercel Blob and Vercel Signed URLs, `@vercel/functions`, jose `SignJWT`/`jwtVerify`, Drizzle Postgres getting-started and PGlite pages, `@octokit/auth-app` and `@octokit/webhooks-methods` READMEs). Package versions were read with `npm view <pkg> version` the same day, and the pinned versions were installed into a scratch project (`@vercel/sandbox 3.2.1`, `@clerk/nextjs 7.8.4`, `workflow 4.8.5`, `@workflow/vitest 4.0.21`, `drizzle-orm 0.45.2`, `@vercel/blob 2.8.0`) so every SDK shape quoted below was type-checked against `dist/*.d.ts` (§8).

## 1. Goal

Turn `apps/web` into the Zed Codespaces control plane: Clerk-authenticated dashboard and API, a Drizzle/Postgres data model for every table in BUILD-SPEC §7.2, Workflow DevKit workflows that create, connect, stop, restart, rebuild, delete, prebuild and garbage-collect Vercel Sandboxes through `@vercel/sandbox`, ES256 session-token minting that `zed-remote-server serve` (b2) verifies, AES-256-GCM secrets, a per-minute cron sweep for idle stop, session-cap restart, dead-run reconciliation and abuse detection, GitHub App tokens and webhooks, usage metering and monthly Stripe invoicing, and the `/w/[id]` editor shell that loads the wasm bundle under COOP/COEP and a nonce CSP, implements b7's `ZsHost` contract and drives boot, reconnect, takeover and lifecycle UI. The control plane never carries editor traffic (§2 principle 1, line 68); it hands the browser `{ wsUrl, token, sessionId }` — `sessionId` minted per connect and informational, the stable identity being the workspace id (D1) — and gets out of the way. It also allocates the four private-port proxy slots per workspace (D8), consumes the supervisor's installed-extensions relay (D18/D19), honours the supervisor's `busy`/`phase` in idle policy (D13) and never waits on a fixed sleep where the supervisor's health can be polled (D13). The supervisor (b8) is the consumer of every sandbox-facing route; this brief defines the JSON b8 deserialises (§4.2, §4.7) and both test suites read the same fixture (D19).

## 2. Existing code that matters

Every anchor below was read in this session; sibling-brief line numbers are those of the files as they stand today (they moved since the first draft of this brief).

### `apps/web` (scaffold to modify)

| Anchor | Note |
|---|---|
| `package.json:1-27` | `next 16.3.4`, `react 19.2.8`, `react-dom 19.2.8`, dev: tailwind 4, eslint 9, typescript 5; `packageManager: pnpm@11.20.0`; scripts `dev/build/start/lint` only. Everything else in §5 is new. |
| `next.config.ts:1-7` | Empty `NextConfig`. Gains `headers()` (COOP/COEP, immutable cache) and the `withWorkflow` wrapper. |
| `tsconfig.json:21-23` | Path alias `@/*` → `./*`; vitest must mirror it (`vite-tsconfig-paths`). `include` at `:25-32` already covers `**/*.ts`. |
| `app/layout.tsx:1-29` | **Root layout for every route**, including `/w/[id]`: imports `next/font/google` (`Geist`, `Geist_Mono`, `:2, 5-13`) and `./globals.css` (Tailwind 4, `:3`), sets `<html className="… h-full antialiased">` (`:22-25`) and `<body className="min-h-full flex flex-col">` (`:26`). A nested `w/[id]/layout.tsx` cannot opt out of any of that (Next's `layout.md:26, 114, 140-145`: the root layout wraps all routes; multiple root layouts require omitting `app/layout.tsx` and giving each route group its own `<html>/<body>`). **This file is deleted** and replaced by two root layouts (§3.26-3.28). |
| `app/page.tsx:3-69` | Template landing page; moves to `app/(site)/page.tsx` as a redirect to `/workspaces` (a page cannot live above the root layouts once `app/layout.tsx` is gone). |
| `app/globals.css`, `postcss.config.mjs:1-7` | Tailwind 4 stays for the `(site)` tree; the editor root layout imports neither. |
| `eslint.config.mjs:5-16` | `defineConfig([...nextVitals, ...nextTs, globalIgnores([...])])`; add `drizzle/**`, `public/editor/**`, `.workflow-data/**`, `public/sw.js` to the ignores. |
| `.gitignore:25` `*.pem`, `:34` `.env*` | Key material and env files already ignored; `.env.example` must be force-added (`!.env.example`). |
| `pnpm-workspace.yaml:1-3` | `allowBuilds: sharp:false, unrs-resolver:false`; `@electric-sql/pglite` and `pg` need no build scripts, nothing to add. |
| `AGENTS.md:1-9` | Next 16 rules: read `node_modules/next/dist/docs/` before writing Next code. Followed below. |

### Next.js 16 bundled docs (`node_modules/next/dist/docs/01-app/…`)

| Anchor | Note |
|---|---|
| `03-api-reference/03-file-conventions/proxy.md:23` | "Create a `proxy.ts` … at the same level as `pages` or `app`"; `:27-38` `export function proxy(request: NextRequest)` + `export const config = { matcher }`. Next 16 renamed `middleware.ts` → `proxy.ts`; Clerk's own docs say the same. **The task's `middleware.ts` becomes `proxy.ts`.** |
| `02-guides/content-security-policy.md:38-60` | Canonical nonce pattern: nonce generated in `proxy`, `script-src 'self' 'nonce-…' 'strict-dynamic'` (`'unsafe-eval'` only in dev, `:43`), `style-src 'self' 'nonce-…'`; `:176-193` Next applies the nonce to its own inline scripts and styles automatically. A nonce does not cover `style="…"` **attributes**, so the shell renders no `style` props (§3.26). This is how "no inline script" (§10 line 430) is achieved without breaking React hydration. |
| `03-api-reference/03-file-conventions/layout.md:26, 112-146` | Root-layout rules quoted above; `:142-145` multiple root layouts via route groups, cross-group navigation is a full page load (fine: the editor opens the dashboard in a new tab). |
| `03-api-reference/03-file-conventions/route.md:106-115` | `RouteContext<'/users/[id]'>` global helper; `params` is a `Promise`. Used by every dynamic route handler below. |
| `03-api-reference/03-file-conventions/page.md:124-131` | `PageProps<'/blog/[slug]'>` global helper; `await props.params`. Used by `app/(editor)/w/[id]/page.tsx`. |

### Sibling briefs (contracts this brief must satisfy)

| Anchor | Note |
|---|---|
| `docs/briefs/b8-supervisor-image.md:141-169, 179-180, 191` (§3.3 `config.rs`) | `Config` read from env: **`ZS_CONTROL_PLANE_URL` – the origin** (e.g. `https://zs.example.com`, trailing slash stripped; the agent appends `/api/sandboxes/{name}/{suffix}` itself, `sandbox_api_url` at `:179-180`), `ZS_BYPASS_SECRET` (→ `x-vercel-protection-bypass`, D18), `ZS_SANDBOX_TOKEN`, `ZS_SANDBOX_NAME`, `ZS_WORKSPACE_ID`, `ZS_BUILD_ID` (baked into the image), `ZS_PREBUILD`, `ZS_WORKSPACES_DIR` (`/workspaces`), `ZS_STATE_DIR` (`$HOME/.zs`), `ZS_DATA_DIR`, `ZS_SERVER_BIN`, listen overrides; `RPC_PORT 8443`, `PROXY_PORT 8444`, `HEALTH_PORT 8445`, `LOCAL_API_PORT 8446`, `INFRA_PORTS = [8443, 8444, 8445, 8446]`. `:191`: the agent strips `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_PLANE_URL`, `ZS_BYPASS_SECRET` from every child environment and inherits everything else (the decrypted secrets). **The env names in §3.18 are these: `ZS_CONTROL_PLANE_URL` carries the origin; there is no `ZS_CONTROL_URL`** (an earlier revision of this brief cited one against a b8 revision that is not on disk; corrected in §9). `:1243-1258` is the full environment table. |
| `b8:193-251` (§3.4 `manifest.rs`), `:1166-1191` (§4.1), `:1150-1162` (§3.26) | b8's `Manifest` serde struct (`rename_all = "camelCase"`, unknown fields ignored) **as it stands on disk** was derived from this brief's previous revision: `version, workspaceId, sandboxName, sandboxGeneration, audience, issuer, build: { server, client }, jwtPublicKeys: [{ kid, spkiPem }], repo: { cloneUrl, owner, name, defaultBranch, branch?, revision?, pullRequest?, path, depth }, restore: { kind, tarballPath? }, env: { names }, dotfiles, forwards[] (url nullable), portPool[], rpcPort/proxyPort/healthPort, settings: { settings, keymap, version } (JSONC **strings**, written verbatim by `write_settings`, `:750-753`), idle: { idleMinutes, pingIntervalSeconds, activityPath }, devcontainer: { hash }, extensions[], controlPlaneUrl` — no `session`, `portSessionSecret`, `logs`, `activity`, `allowedOrigins`, `repo.ref`. `Manifest::validate` (`:249`): `version == 1`, `workspaceId`/`sandboxName` equal the environment, repo dir absolute and under `ZS_WORKSPACES_DIR`, ≥ 1 PEM `PUBLIC KEY` block, forward/pool ports ∉ `INFRA_PORTS`. D18 ("honour `manifest.repo.ref`; write settings `Value::String` verbatim") and D19 (fixture `docs/contracts/fixtures/manifest.example.json`, generated from §4.7) fix the contract on **this brief's §4.7 field names**; b8 §3.26 owns the JSON Schema + fixture files and re-derives its struct from them (§9). §4.7 keeps every b8 validation rule that survives (version, identity cross-check, repo dir, ≥ 1 PEM, ports ∉ infra set) so b8's `validate` needs no semantic change. |
| `b8:287-338` (§3.5 `control_plane.rs`), `:340-394` (§3.6 `logs.rs`), `:1193-1203` (§4.2) | What b8's client sends and expects **today**: every call carries `Authorization: Bearer <ZS_SANDBOX_TOKEN>`, `X-ZS-Build: <build>` and, when set, `x-vercel-protection-bypass` (`:289`, D18); 401 → health `degraded`, 410 → activity loop stops (`:338`). `git_token()` POSTs `{}` and reads `GitTokenResponse { username, token, expiresAt: String /* RFC 3339 from toISOString() */ }` (`:305`, parsed by `parse_rfc3339_utc`, `:693`); `port_action` POSTs `{ action: "forward" \| "unforward", port, visibility, label? }` and reads `{ url: string \| null }` (`:308-310`); `ActivityPing { lastInputAt?, sessionActive, serverBuild, supervisorBuild, uptimeSeconds, listening: [{ port, pid, process }], cpuBusyPct?, phase, busy }` (`:313-318`; `phase`/`busy` are D13's fields, `cpuBusyPct` D18's) and expects `ActivityResponse { notices[], idleMinutes, sessionCapAt, serverTime, forwards[] }` (`:321`) with a `NoticeRelay` (`:782-790`); logs are NDJSON `LogLine { ts, level, target, msg, sid?, fields? }`, `Content-Type: application/x-ndjson`, ≤ 200 lines / 256 KiB per POST, any 2xx accepted (`:342, 356-358, 391`); `restore_tarball(path)` GETs `{origin}{path}` with the bearer (`:334`). §4.2 is written so that b8's on-disk request bodies parse unchanged (optional `action`, empty git-token body, NDJSON **or** JSON logs, `listening[]` accepted) while the **responses** are this brief's: `GitTokenResponse.expiresAt` is the RFC 3339 string b8 parses; the ports response is `{ url, visibility, slot? }`; the activity response is `ActivityDirective { idleStopAt, sessionCapAt, stop, forwards, serverTime }` — the supervisor derives `IDLE_STOP_IN`/`SESSION_CAP_IN` from the two timestamps and there is no `notices[]` queue (the reason is R2-17 in §8: a queued `STOPPING` is never delivered in time; §9 lists this as the delta b8 picks up); the rebuild tarball is a presigned Blob URL in the manifest (§4.7 `restore.tarballUrl`), not a bearer route. |
| `b8:500-504, 552-557` (§3.9), `:441-444, 470-481` (§3.8), `:711` (§3.14), `:820-829` (§3.16), `:1213-1233` (§4.4) | `TERM_GRACE = 3 s` and `STOPPING_POST_TIMEOUT = 2.5 s` (`:503-504`); `stop_child` = `POST /control/lifecycle {"kind":"stopping"}` → SIGTERM to the child pid → `TERM_GRACE` → SIGKILL of the process group (`:552-557`), whole stop path ≈ 6.5 s today. **D18 requires the stopping request budget to exceed b4's 5 s `STOPPING_FLUSH_TIMEOUT`**, so b8's POST timeout grows to > 5 s and the exit wait in §4.8 is sized for that (25 s cap, never a fixed sleep — D13). Boot phases `Phase { Manifest, Restore, Clone, ServerStarting, Dotfiles, PostCreate, PostStart, Ready }` (`:444`): **the server starts as soon as the repository exists** (`:820`, step 5) and dotfiles/`postCreateCommand` (`POST_CREATE_TIMEOUT` 30 min, `:711`)/`postStartCommand` run *beside* it with `busy = true` and `phase` reported (`:827`, D13); `status = ready` is set before the lifecycle task (`:826`), so `/connect` may succeed while `postCreateCommand` is still running (Codespaces behaviour) and the overlay keeps showing `boot:<phase>` from the activity pings (§3.25). `GET :8445/health` (`:1215-1231`): `{ status: booting\|ready\|degraded\|stopping, phase, build, manifestBuild, resumed, busy, uptimeSecs, server: { running, pid, restarts, lastExit, startedAtMs, crashLoop }, proxy: { running } }` for a **non-loopback** caller — `lastError`, `server.health`, `forwards`, `listening` are loopback-only (`:676`); HTTP 200 for `ready` **and** `degraded`, 503 for `booting`/`stopping`. §3.18's `HealthProbe` models the reduced body only; `listening` comes from the activity ping instead. |
| `b8:565-612` (§3.10 `port_auth.rs`), `:614-618` (§3.11 `proxy.rs`), `:1235-1237` (§4.5), §7 items 4-5 | Private ports use **two token kinds**: the **bootstrap token** the control plane mints — an ES256 JWT verified with the manifest's public keys, header `{ alg: "ES256", typ: "JWT", kid }`, claims `{ iss, aud, sub: <userId>, ws: <workspaceId>, sid: "port:<port>", iat, exp: iat + 600, jti }`, `BOOTSTRAP_MAX_AGE_SECS = 600` (`:574`), delivered as `GET https://<proxy-host>/__zs/auth?zs_port_token=<jwt>&next=/` (`BOOTSTRAP_PARAM = "zs_port_token"`, `:571`) after the redirect from `GET {origin}/api/workspaces/{id}/ports/{port}/open` — and the **session cookie** the proxy mints itself after a successful bootstrap: `zs_port_session` (`COOKIE_NAME`, `:570`), `v1.<b64url(payload)>.<b64url(HMAC-SHA256(per-boot key, …))>`, 8 h, never minted by the control plane. Cookie-bound target port, **no path prefix** (`:616`). **D8 fixes exactly this** (`zs_port_session` HMAC cookie; `/open` link → `/__zs/auth?zs_port_token=...&next=/`) and adds four proxy slots (8444-8447) allocated by the control plane, one per private forward; b8 §3.11 is already written for `ProxyConfig { bound_port }` per slot (`:618, 627`) and asks b9 for the slot allocation in §7 item 5. §4.2 ports, `lib/port-token.ts` and `lib/ports.ts` implement this. The RPC-reuse hazard that made the previous revision of this brief choose an HMAC token (b2 verifies `aud`/`ws`/`iss` and treats `sid` as informational, so a bootstrap token with `aud = <audience>` would open `/rpc` for 10 minutes) is closed by minting the bootstrap token with **`aud = "<audience>/ports"`** — b2's verifier rejects it on `aud`; b8's `BootstrapVerifier::new(pems, issuer, audience, workspace_id)` is handed `"<manifest.jwt.audience>/ports"` (§7 item 7h; the manifest also states it as `jwt.portAudience`). |
| `b8:806-833` (§3.16 `start.rs`), `:842-863` (§3.17), `:726, 822` (markers), §7 items 2, 3, 4, 5, 9, 10, 11, 12, 16, 17, 18, 20 | `zs-agent resume` is an **alias of `start`** (`:831, 846-847`); the `--resumed` flag is gone — `resumed` is derived from the `first-boot.done` marker (`:726, 822`), so `manifest.session.resumed` is informational. `prebuild` (`:833`; D14: owned by b8): requires `ZS_PREBUILD=1`, sandbox created with `ports: [8443, 8445]`, clone + `postCreateCommand` + optional `ZS_PREBUILD_WARM_CMD` (≤ 20 min), exit 0 within ≤ 50 min, then the control plane snapshots. Deltas b8 addresses to b9 and their status: item 2 (drop `source: { type: "git" }`) — done, D19; item 3 (shared fixture; private `ForwardView.url` = `/open` link; accept `phase`/`busy`) — done, D13/D19; item 4 (303 target `/__zs/auth?zs_port_token=<jwt>&next=/`, ES256, 10 min, `sid = "port:<port>"`) — adopted with the `aud` refinement above, D8; item 5 (proxy slots) — implemented per D8 (§3.12 `ports.ts`, §4.2); item 9 (honour `busy`/non-ready `phase`) — D13, §3.25/§4.10; item 10 (wait on the command's exit instead of sleeping) — §4.8 already waits on `getCommand(cmdId).wait()` and now never sleeps (D13); item 11 (poll 8445 first for `phase`) — §3.18 polls 8445 only; item 12 (no `ZS_JWT_PUBLIC_KEYS` env fallback) — none is set; item 16 (tarball must carry the data dir) — D9; item 17 (unsaved buffers) — D6 (client side); item 18 (private dotfiles need a user token) — §4.2 git-token mints the owner's GitHub OAuth token for `dotfiles.repoUrl`; item 20 (devcontainer image builder unowned) — D14: brief b10. |
| `docs/briefs/b1-ws-transport.md` §3.2 (`wire.rs`), §3.3 step 5 (`:281-283`), §3.18, §4.3 | Wire constants `CLOSE_TAKEN_OVER 4001`, `CLOSE_BUILD_MISMATCH 4002`, `CLOSE_UNAUTHORIZED 4003`, `CLOSE_SESSION_BUSY 4005`; **4004 no longer exists** — D3 makes `1001` "server going away" (SIGTERM / lifecycle `STOPPING`; b1 `:281` "replaces the former 4004"), terminal, `refresh` never called; 4001 also covers a stale epoch (b1 §4.4, b2 §7.19). `builds_compatible` is exact match unless a dev build. §3.18/§4.3: **there is no query-string token placement**; native sends `Sec-WebSocket-Protocol: zs.v1, <jwt>`, wasm offers `["zs.v1", "<jwt>"]` through the vendored yawc (`zed/vendor/yawc`, D10). `?zs_token=` survives only in b2's `/files` download form (b2 §4 `:912`). b1 `:282-283`: `reconnect && !HelloAck.resumed` and 1001 end in `ServerNotRunning`; other closes/errors go through `refresh` with backoff, ≤ 20 attempts (D2). |
| `b1:426-530` (§4.1, as amended by D1) | `WebSocketConnectionOptions { url, workspace_id, session_id (serde skip), token (skip), takeover (skip), refresh: Option<Arc<dyn WebSocketSessionRefresh>> (skip), pub(crate) state }`; `new(url, workspace_id, session_id, token)`, `with_takeover`, `with_refresh`, `last_close()`, `server_info()`. **Identity (`PartialEq`/`Hash`, the `ConnectionPool` key, workspace persistence `name = workspace_id`, `host = None`, `user = None`) is `workspace_id` only (D1)**; `session_id` is minted per connect by this brief, rotated by `refresh`, and never part of identity or persistence. |
| `b1:531-560` (§4.1), `:244-245` (§3.3 steps 1-2) | `WebSocketSession { url, token, session_id }` (the per-connect id must equal the new token's `sid`, D1); `RefreshReason::Reconnect { attempt, last_close }`; **`RefreshError { Unauthorized, Stopped, Other }`** — `Unauthorized` (control-plane session gone; synthesised `CloseInfo{4003}`) and `Stopped` (this brief answered `409 workspace_stopped`; synthesised `CloseInfo{1001, "workspace stopped"}`) are terminal and short-circuit the 20-attempt budget at once (D2); `Other` is retried with backoff capped at 8 s; `trait WebSocketSessionRefresh { fn refresh(&self, workspace_id: &str, reason: RefreshReason, cx: &mut AsyncApp) -> Task<Result<WebSocketSession, RefreshError>> }` – implemented in `zed_web` (b7 §3.21 `JsSessionRefresh`) by calling `ZsHost.refreshConnectInfo()`, i.e. `POST /api/workspaces/{id}/connect`; a rejection `{ code: "unauthorized" }` → `Unauthorized`, `{ code: "stopped" }` → `Stopped`, anything else → `Other`. `:245`: the shell's from-scratch `reconnect()` (D2) builds *new* options and is not a redial. |
| `b1` §7 items 3, 5, 9, 14 | Item 3 (`session_id` stability) is **decided by D1**: the client keys persistence and the pool on `workspace_id` = `ZsBootConfig.workspace.id`; `sessionId` in `ConnectInfo` is a fresh per-connect id (`con_…`) equal to the JWT `sid` (§3.18) — the previous "`sessionId === sid === workspaceId`" resolution is withdrawn (§9). Item 5 (decided, D2): refresh, backoff and dial run inside `connect` with no timeout, 20 attempts, backoff capped at 8 s; `/connect` is expected to block until the sandbox is healthy — §3.26 makes `refreshConnectInfo` poll through `202`/`423` for up to 5 min so one attempt spans a restart, and `409 workspace_stopped` is surfaced as `{ code: "stopped" }` so the transport stops immediately (`RefreshError::Stopped`). Item 9: dirty buffers on terminal outcomes — D6 covers the `STOPPING` path (client-state image), so §4.8 `stopWorkspace` gives b4 its full 5 s flush window; for 4001/4005/exhaustion the shell's `beforeunload` guard uses b7's `has_unsaved_changes()` (§3.26). Item 14: on wasm a 401 and a transient failure look alike, so `RefreshError::Unauthorized` from `refreshConnectInfo()` is the sign-in signal (§3.26). |
| `docs/briefs/b2-serve-mode.md` §3.5, §4 (`:928`) | `Claims { iss, sub, ws, sid, aud, iat, exp, jti }`, header `{ alg: "ES256", typ: "JWT", kid?: string }`, `AuthConfig::load(pem_files, issuer, audience, workspace_id)`; validation requires `exp, aud, iss, sub`, `iat` not in the future (b2 R1-5), `aud` == `--audience`, `iss` == `--issuer`, `ws` == `--workspace-id` compared constant-time. **`sid` is the per-connect session id, informational (D1)**: it appears in `SessionMeta`, `HelloAck.session_id`, logs and `/health`; a `Hello.session_id` that differs is logged, not rejected; resume is keyed on the server's epoch (D3), never on `sid`. Because `sid` is not validated, a port bootstrap token is kept out of `/rpc` by its **audience** (`<audience>/ports`, §3.12), not by `sid`. |
| `b2:635-641` (§3.8 router) | **CORS is implemented** when `--allowed-origin` is non-empty: `/files`, `/extensions/*` and `/health` responses carry `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, `Access-Control-Expose-Headers: content-disposition, content-length` and — because the shell runs under COEP (§4.9) — `Cross-Origin-Resource-Policy: cross-origin`; `OPTIONS /files\|/extensions/*\|/health` → 204 with methods/headers/`Max-Age: 600`; an `Origin` present and not allowed → 403 on `/files`, `/extensions/*` and `/rpc` upgrades. The control plane therefore delivers its origin to the supervisor (`manifest.allowedOrigins`, §4.7) and b8 passes one `--allowed-origin` per entry (D5, b2 §7.13, b2 §9.2 b9 row). `GET /health` never 401s; `GET /rpc` verifies the token from the subprotocol list before the upgrade; `GET /extensions/{id}/assets/{rel}` (b4 §3.15 item 4, D20) uses the `/files` auth and the same CORS. |
| `b2` §3.9 `ServeArgs`, §4 control-listener contract (`:915-925`), §7.13 | `ServeArgs { listen, jwt_public_keys: Vec<PathBuf> (repeatable), workspace_id (alias --workspace), audience, issuer = "zs", workspace_root, client_build (alias --allow-build), allowed_origins (--allowed-origin, ZS_ALLOWED_ORIGINS), control_secret_file (--control-secret-file, required, D5/D18), control_listen (--control-listen, default 127.0.0.1:8446, D5), supervisor_url (--supervisor-url / ZS_SUPERVISOR_URL), port_file, log_file }` – the supervisor materialises PEM files from `manifest.jwt.publicKeys`, passes `--audience manifest.jwt.audience` (the control plane owns the audience string) and `--allowed-origin` per `manifest.allowedOrigins` entry; **no `ZS_CONTROL_SECRET` exists in the server environment** (D18). The control listener (`127.0.0.1:8446`) serves `POST /control/{lifecycle,ports,extensions}` (D5); `stopping` returns only after the client's `SaveClientState` landed or `STOPPING_FLUSH_TIMEOUT = 5 s` elapsed. Startup prints `ZS_LISTENING=` and `ZS_CONTROL_LISTENING=` on stdout. None of this is called by the control plane directly; it sizes §4.8's stop wait. |
| `b2` §4 (`:905-913, 928`), §7.3, §7.12, §9.2 (b9 rows) | Wire contract for `GET /rpc`; `kid` ignored (all loaded keys tried), so rotation = ship both public keys. `sid` is per connect and informational; `identifier` (Hello) is logged only; resume is by epoch (D1/D3) — b2 §9.2 says of this brief's earlier `sid === workspaceId` rule: "superseded by D1/D3; b9's claim minting must follow D1 (its change)" — done in §3.11/§3.18. `:906` and §7.12: "The control plane polls the supervisor (`:8445`), not this listener" — unchanged. `:911`: the JWT is verified at upgrade time only; `/files`, `/extensions/*` and the full `/health` body verify per request, so b7 refreshes the token 60 s before `sessionExpiresAt` (§3.18 sets that field to the token's `exp`). |
| `docs/briefs/b7-edge-gates-entry.md:885-897` (§3.30 loader contract), §7 item 2 (`:1417`) | Loader requirements the shell must meet (b7's `crates/zed_web/web/loader.js` is the *reference* loader for the dev harness; `apps/web` implements the same contract in `zs-host.ts`): COOP/COEP on the document and every subresource, `Cross-Origin-Resource-Policy: same-origin` on bundle files, **`crossOriginIsolated === true` checked before `init()`**, `import init, { start, flush_client_state, set_hidden, has_unsaved_changes, build_id } from "/editor/<build>/zed_web.js"` (a real same-origin URL — `wasm_thread` derives the worker import URL from a stack trace), `const wasm = await init({ module_or_path })`, then `globalThis.__zsCallCtors?.()` (added by b7's memory patch) or `wasm.__wasm_call_ctors?.()`, then **`await start(JSON.stringify(config), assets, host)`** (three arguments; `assets` is the `Uint8Array` of `zed-assets.tar`, fetched in parallel with `init()`); `start` rejects with `{ code, message }`; `visibilitychange` → `set_hidden(document.hidden)` (+ `flush_client_state()` when hidden), `pagehide` → best-effort `flush_client_state()`, `beforeunload` → `if (has_unsaved_changes()) event.preventDefault()` (D7 triggers); `worker-src 'self' blob:`; `globalThis.__zsBindgenShimUrl` set before `start` once the patched `wasm_thread` lands, and **`'unsafe-eval'` on the editor route only until then** (b7 §7.2, owned by b7; `ZS_CSP_UNSAFE_EVAL`, §4.9). |
| `b7:945-978` (§4.2, authoritative), `:622-628` (§3.21), `:806-815, 826-846` (§3.28) | `ZsBootConfig { buildId, connect: { wsUrl, token, sessionId, takeover?, serverBuild?, sessionExpiresAt? }, workspace: { id, paths }, settingsJson?, keymapJson?, backend?, hostOs? }` (no `assets` field — it is `start`'s second argument); `ZsHost { bootProgress(stage, detail), refreshConnectInfo(): Promise<ZsBootConfig["connect"]>, saveDocument(kind, json), reportError(kind: "panic" \| "boot", message, stack), onLifecycle(kind: "idle_stop_in" \| "session_cap_in" \| "stopping" \| "resumed", seconds) }` plus the **optional `onClosed({ code, reason })`** b7 accepted from this brief's §4.6 (`:622, :627`); exports `start(configJson, assets, host)`, `flush_client_state()`, `set_hidden(hidden)`, `has_unsaved_changes()`, `build_id()`. Stages `booting \| assets \| settings \| connecting \| database \| languages \| window \| ready \| reconnecting \| stopped \| failed`; **`bootProgress("stopped", detail)` carries a `BootError` code as `detail`** (`session_busy` 4005, `taken_over` 4001, `incompatible_server` 4002, `unauthorized` 4003, `server_stopping`, `reconnect_exhausted`, `workspace_stopped` from `RefreshError::Stopped`, …; b7 §3.28 `close_code_detail`). `start()` is single-shot: on `session_busy` the shell reloads with `connect.takeover = true` (`:812`); the "Reconnect" affordance is the shell's from-scratch `reconnect()` (D2), which in v0 reloads the page. b7 declined `keepAlive`, `stop`, `setDirty` (→ `has_unsaved_changes()`), `onExtensionsChanged` (→ supervisor relay, D18/D19) and `openExternal` (`gpui_web` already `window.open`s) — `:627`. **§4.6 adopts b7 §4.2 verbatim.** `onLifecycle` kinds are snake_case (b4 risk 21, b7 `:599`); an earlier revision of this brief typed them SCREAMING_SNAKE — corrected. |
| `docs/briefs/b4-proto-additions.md:13` (b9 row), `:459-537` (§3.10/§3.11 control channel, `ExtensionsBody`, `SUPERVISOR_EXTENSIONS_PATH`), `:689` (§3.16), `:913-917` (§4.2), §7 items 8, 18, 20, 21, §9 | `STOPPING_FLUSH_TIMEOUT = 5 s`; `POST /control/lifecycle {"kind":"stopping"}` (on the D5 loopback control listener `127.0.0.1:8446`) blocks until the next `SaveClientState` or the timeout; on `STOPPING` the client also snapshots dirty buffers into the client-state image (`unsaved_buffers`, D6) — which replaces this brief's earlier ask to autosave them to disk (`:13`). `LifecycleHooks` and in-canvas toasts were **deleted** – only `project::Event::LifecycleNotice { kind, seconds }` remains and the entry crate forwards it to the shell (`:689`; `LifecycleKind::as_str()` = `"idle_stop_in" \| "session_cap_in" \| "stopping" \| "resumed"`, risk 21), which owns the toasts and the "Keep alive" button. **Extensions**: `POST /control/extensions { "install": [ids] }` (supervisor → server) at startup from `manifest.extensions` and `devcontainer.json` `customizations.zed.extensions`, and later whenever the list changes (D5; supersedes b8's `remote_extensions/pending.json`); `POST $SUPERVISOR_URL/extensions { "installed": [ids] }` (server → supervisor) after every change, which **b8 relays to the control plane (D18) and this brief consumes into `workspaces.installed_extensions` (D19)** — `POST /api/sandboxes/{name}/extensions` in §4.2. `POST $SUPERVISOR_URL/ports` → `{ url: string \| null }`, `url` per D8 (slot URL for public, `/open` link for private); a refused private forward (no free slot) is a non-2xx `{ error }` the server surfaces to the client. `:1071` (b4 §9 b9 row): consistent with this brief except the `onLifecycle` spelling — adopted here. b4 risk 20 = the port map (§7 item 20 here). |
| `zed/crates/remote/src/remote_client.rs:166, 639` | `MAX_RECONNECT_ATTEMPTS = 3` is the SSH default; b1 overrides it to 20 for WebSocket (risk 5). |

### Package types verified in the scratch install (`/private/tmp/…/scratchpad/b9check/node_modules`)

| Anchor | Note |
|---|---|
| `@vercel/sandbox/dist/sandbox.d.ts:205-225` | `GetSandboxParams { name, resume?: boolean (default false; a persistent sandbox still auto-resumes on the first SDK call that needs a session), signal?, onResume?: (sandbox) => Promise<void> }`; `:646` `static get(...) : Promise<Sandbox>` (throws `APIError` on `not_found`, no `null`); `:648-678` `getOrCreate` docs: existing name → returned **without resuming and with creation params ignored**; `snapshot_not_found` → stale sandbox deleted and re-created. |
| `sandbox.d.ts:383, 391, 446-460, 706, 736-760, 792-797, 862, 870-874, 927, 1046, 1066, 1237-1249` | `status` union is `"pending" \| "running" \| "stopping" \| "stopped" \| "failed" \| "aborted" \| "snapshotting"`; `expiresAt: Date \| undefined`; `static list({ tags? })` → `Promise<Paginator<{ sandboxes: [{ name, status, createdAt: number, … }] }>>` (**must be awaited**, iterates items, only one tag filter per call, `:447-452`); `currentSession(): Session`; `runCommand({ …, detached: true }) → Promise<Command>` (`Command.cmdId`, `command.d.ts:79`), `getCommand(cmdId)`; `readFile({ path }) → Promise<NodeJS.ReadableStream \| null>`; `domain(p)` **throws** if the port has no route; `stop() → Promise<SandboxSnapshot & { snapshot?: SnapshotMetadata }>` where `activeCpuDurationMs` and `networkTransfer` are **optional** (tsc: TS2322/TS18048 when read as non-optional); `extendTimeout(ms)`; `snapshot({ expiration }) → Snapshot` (`snapshotId`, `sizeBytes` getters, `snapshot.d.ts:41, 57`); `update({ ports, … })`; `listSnapshots()` → `Paginator<{ snapshots: [{ id, sizeBytes, status, expiresAt?, lastUsedAt? }] }>`. |
| `@vercel/sandbox/dist/sandbox.js:24, 615-807, 1064, 1173` | `snapshot_not_found` = `APIError` with HTTP 410 and `json.error.code`. `withResume` wraps `runCommand`, `getCommand`, `mkDir`, `openInteractive`, `readFile`, `readFileToBuffer`, `downloadFile`, `writeFiles`, `updateNetworkPolicy`, **`extendTimeout`** and `snapshot`; **not** `stop`, `update`, `delete`, `listSnapshots` (control-plane calls). |
| `@vercel/sandbox/dist/utils/paginator.d.ts` | `Paginator<Page, Key> = Page & AsyncIterable<Item> & { pages(), toArray() }`. |
| `@clerk/nextjs/dist/types/webhooks.d.ts`, `server/types.d.ts:9` | `verifyWebhook(request: RequestLike)` with `RequestLike = NextRequest \| NextApiRequest \| GsspRequest` – a plain `Request` is TS2345; the webhook route takes `NextRequest`. |
| `@clerk/react/dist/hooks-74kNS3WZ.mjs:600-626`, `@clerk/shared/dist/react/contexts.js:55` | `SignIn = withClerk(...)`; the HOC calls `useAssertWrappedByClerkProvider`, which throws "`SignIn` can only be used within the <ClerkProvider /> component." → the sign-in page must render under a `ClerkProvider` (§3.27). |
| `@clerk/backend/dist/internal.js:7350-7362, 7825-7831` | `isRequestEligibleForHandshake()`: only `GET` with `Sec-Fetch-Dest: document\|iframe` or `Accept: text/html`; anything else with an expired session token is `signedOut` → `auth()` returns `userId: null`. Clerk's session token lives **60 s** and is refreshed by the frontend SDK on a 50 s interval ("How Clerk works"), so a `/w/*` page without `ClerkProvider` cannot call Clerk-authenticated routes after the first minute → the editor cookie in §3.8. |
| `workflow/dist/api-workflow.js:1-15`, `package.json` exports `./api` | Under the `workflow` export condition `start`, `getRun`, `runStep`, … are stubs that throw "Move this call to a step function". Every `start()`/`getRun()` inside a workflow lives in a `"use step"` function (`stepRunChild`, `stepRunStatus`). |
| `@workflow/vitest/dist/index.js:9-46, 100-120` | Builds `workflows.mjs` + `steps.mjs` bundles and runs them **in-process** in the vitest worker ("in-process handler routing … direct handlers"). Steps are a separate bundle instance from the test file, so a fake that keeps state in module scope is duplicated; `tests/helpers/fake-sandbox.ts` keeps its state on `globalThis` (§6). Exports `workflow(options): Plugin[]`, `waitForSleep`, `waitForHook`. |
| `@vercel/blob/dist/index.d.ts:2` | `issueSignedToken`, `presignUrl` exported in 2.8.0 (Vercel Signed URLs page: `operations: ['get']`, `validUntil` ≤ 7 days, default 1 h). The rebuild tarball is fetched by the supervisor through a presigned `GET` URL; no streaming route. |
| `drizzle-orm 0.45.2` | §4.1 type-checks with `NodePgDatabase<typeof schema> \| PgliteDatabase<typeof schema>` once `import { sql } from "drizzle-orm"` is present (the partial index in `sessions` uses it). |

### Community fork (read-only evidence for the shell)

| Anchor | Note |
|---|---|
| `zed-web/web/static/workspace.html:88-89` | `import init from "./zed_web_workspace.js"; … await init();` – wasm-bindgen `--target web` glue is an ES module with a default `init`. Our loader does the same with `/editor/<build>/zed_web.js`. |
| `workspace.html:125-146` | `globalThis.__zedOpenExternalUrl = (rawUrl) => …` – host callbacks through a global. b7 replaced this with an explicit `host` object passed to `start()`; the shell implements b7's shape. |
| `workspace.html:148-155` | Boot overlay removed after `init()` resolves; error text on failure. Our overlay is staged (b7 `bootProgress` stages) and dissolves on `ready`. |
| `zed-web/web/entrypoint.sh:4-25` | Fork's server is configured by `ZED_WEB_*` env vars; our supervisor takes `ZS_*` env plus the manifest. Not copied. |

### Rust fork (`zed/`)

| Anchor | Note |
|---|---|
| `zed/Cargo.toml:670` | `jsonwebtoken = "10.0"` (workspace dep, used by b2 to verify; re-verified 2026-09-02 during reconciliation). The control plane mints with `jose`; the shared test fixture keypair (`zed/crates/remote_server/tests/fixtures/es256_*.pem`, created by b2 §6 — `crates/remote_server/tests/` does not exist in the checkout yet, so `readFixtureKeys()` skips until b2 lands) is reused by `tests/tokens.test.ts` to prove cross-implementation compatibility. No Cargo changes in this brief; D10 (vendored `yawc`/`alacritty_terminal`/`lsp-types`/`agent-client-protocol` under `zed/vendor/`) touches nothing here and this brief contains no `<org>` placeholder. |
| `zed/crates/remote/src/remote_client.rs:166, 639`, `zed/crates/paths/src/paths.rs:144-160`, `zed/crates/workspace/src/workspace.rs:11040, 11099` | Re-verified anchors: `MAX_RECONNECT_ATTEMPTS = 3` and its check; Linux `data_dir()` = `$XDG_DATA_HOME/zed` → `/vercel/.local/share/zed` under b8's `HOME=/vercel` (the D9 tarball path); `open_remote_project_with_new_connection`/`open_remote_project_with_existing_connection` exist today — D16's `open_remote_project_in_new_window_with_client` is b1's addition and b7's consumer, nothing in the shell depends on it. |

## 3. Change list

Directory tree after this brief (new unless marked *modified*/*deleted*):

```
apps/web/
  package.json                      modified
  next.config.ts                    modified
  proxy.ts                          new  (Next 16 name for middleware)
  vercel.ts                         new
  drizzle.config.ts                 new
  vitest.config.ts                  new
  vitest.integration.config.ts      new
  .env.example                      new
  eslint.config.mjs                 modified (ignores)
  scripts/
    keygen.ts  rotate-secrets.ts  fetch-editor-bundle.ts
  lib/
    env.ts  ids.ts  db.ts  schema.ts  redis.ts  auth.ts  editor-cookie.ts  api.ts  crypto.ts  tokens.ts
    port-token.ts  ports.ts  secrets.ts  github.ts  sandbox.ts  usage.ts  billing.ts  regions.ts  plans.ts  audit.ts
    manifest.ts  connect.ts  sandbox-auth.ts  csp.ts  ratelimit.ts  concurrency.ts
  drizzle/                          generated migrations (committed)
  workflows/
    steps/sandbox-steps.ts  steps/db-steps.ts  steps/github-steps.ts  steps/child-steps.ts
    create-workspace.ts  connect-workspace.ts  stop-workspace.ts  restart-session.ts
    rebuild-workspace.ts  delete-workspace.ts  prebuild.ts  gc.ts
  app/
    layout.tsx                      DELETED (two root layouts below)
    page.tsx                        DELETED (moved into (site))
    manifest.ts                     PWA manifest (BUILD-SPEC §3.6 line 185)
    (site)/layout.tsx               root layout #1: <html>/<body>, next/font, globals.css, ClerkProvider inside <body>
    (site)/page.tsx                 redirect("/workspaces")
    (site)/sign-in/[[...sign-in]]/page.tsx
    (site)/(dashboard)/layout.tsx   nav + <UserButton />
    (site)/(dashboard)/workspaces/page.tsx
    (site)/(dashboard)/workspaces/new/page.tsx
    (site)/(dashboard)/workspaces/[id]/page.tsx
    (site)/(dashboard)/repos/page.tsx
    (site)/(dashboard)/repos/[id]/page.tsx
    (site)/(dashboard)/secrets/page.tsx
    (site)/(dashboard)/settings/page.tsx
    (site)/(dashboard)/usage/page.tsx
    (site)/(dashboard)/orgs/[id]/page.tsx      org policy (allowed installations, network allowlist, spend cap, members)
    (site)/(dashboard)/audit/page.tsx          audit-log list (own + org)
    (site)/(dashboard)/admin/page.tsx          owner/admin: force-stop, force-delete, flagged users (§7.3 line 350)
    (editor)/layout.tsx             root layout #2: bare <html>/<body>, no font, no globals.css, no ClerkProvider
    (editor)/w/[id]/page.tsx        server component, auth gate
    (editor)/w/[id]/editor-shell.tsx   client component
    (editor)/w/[id]/editor-shell.css
    (editor)/w/[id]/zs-host.ts      b7 ZsHost implementation + loader
    api/workspaces/route.ts
    api/workspaces/[id]/route.ts
    api/workspaces/[id]/connect/route.ts
    api/workspaces/[id]/session/route.ts       re-mints the editor cookie
    api/workspaces/[id]/stop/route.ts
    api/workspaces/[id]/rebuild/route.ts
    api/workspaces/[id]/keepalive/route.ts
    api/workspaces/[id]/ports/route.ts
    api/workspaces/[id]/ports/[port]/open/route.ts   303 → https://<slot-host>/__zs/auth?zs_port_token=…&next=/ (D8)
    api/workspaces/[id]/client-errors/route.ts
    api/repos/route.ts
    api/repos/[id]/prebuilds/route.ts
    api/me/settings/route.ts  api/me/keymap/route.ts  api/me/dotfiles/route.ts
    api/secrets/route.ts
    api/admin/workspaces/[id]/route.ts         POST force-stop / DELETE force-delete
    api/sandboxes/[name]/manifest/route.ts
    api/sandboxes/[name]/git-token/route.ts
    api/sandboxes/[name]/ports/route.ts
    api/sandboxes/[name]/ports/[port]/route.ts  DELETE (unforward)
    api/sandboxes/[name]/activity/route.ts
    api/sandboxes/[name]/extensions/route.ts    POST { installed } – the supervisor's relay (D18) → workspaces.installed_extensions (D19)
    api/sandboxes/[name]/logs/route.ts
    api/sandboxes/[name]/client-errors/route.ts
    api/webhooks/github/route.ts  api/webhooks/clerk/route.ts  api/webhooks/stripe/route.ts
    api/cron/sweep/route.ts  api/cron/gc/route.ts  api/cron/snapshot-usage/route.ts  api/cron/invoice/route.ts
  public/editor/.gitkeep            `scripts/fetch-editor-bundle.ts` fills <build>/ before `next build` (§3.30)
  public/sw.js                      service worker, scope /w/ (§3.31)
  tests/
    helpers/setup.ts  helpers/db.ts  helpers/fake-sandbox.ts  helpers/request.ts  helpers/keys.ts
    helpers/fixture.ts                reads ../../docs/contracts/fixtures/manifest.example.json (D19) – never a local copy
    tokens.test.ts  crypto.test.ts  usage.test.ts  sandbox-auth.test.ts  manifest.test.ts  port-token.test.ts  ports.test.ts
    sandbox-conformance.test.ts  csp.test.ts  editor-cookie.test.ts
    routes/workspaces.test.ts  routes/connect.test.ts  routes/sandboxes.test.ts  routes/ports-open.test.ts
    routes/webhooks-github.test.ts  routes/cron-sweep.test.ts  routes/secrets.test.ts
    workflows/create-workspace.integration.test.ts  workflows/stop-workspace.integration.test.ts
    workflows/rebuild-workspace.integration.test.ts  workflows/restart-session.integration.test.ts
../../packages/sdk/                 typed client + zod schemas shared with desktop/Playwright (§3.32)
../../docs/contracts/fixtures/manifest.example.json   created by b8 §3.26 from §4.7 (D19); consumed by tests/manifest.test.ts and b8's manifest.rs tests
```

`vercel.ts` lives in `apps/web` (the Vercel project's root directory), not `infra/` as §11.1 sketches: Vercel only reads it from the built project root. `infra/` may re-export it for documentation but nothing consumes that. `/api/sandboxes/{name}/restore-tarball` from the first draft is gone: the supervisor downloads the rebuild tarball through a Blob signed URL (§4.7 `restore.tarballUrl`; b8 on disk still fetches a bearer route, `b8:334, 1201` — §9). `tests/helpers/fixtures/manifest.json` from the previous revision is gone as well: D19 names one fixture, `docs/contracts/fixtures/manifest.example.json`, which b8 creates and this brief reads through `tests/helpers/fixture.ts`. `PUT /api/workspaces/{id}/extensions` is gone: b7 declined the `onExtensionsChanged` host callback (b7 §3.21 `:627`) and D18/D19 route installed-extension reporting supervisor → control plane (`POST /api/sandboxes/{name}/extensions`). `lib/port-session.ts` became `lib/port-token.ts` (ES256 bootstrap token, D8/b8 §3.10) and `lib/ports.ts` (proxy-slot allocation, D8).

### 3.1 `package.json` (modified)

Lines `5-10` scripts and `11-25` dependency blocks are replaced with §5. Nothing else changes.

### 3.2 `lib/env.ts` (new)

Single zod-validated view of `process.env`, lazily evaluated (build-time safety: Marketplace variables are absent during the first `next build`).

```ts
import { z } from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),          // Neon integration; POSTGRES_URL fallback
  POSTGRES_URL: z.string().url().optional(),
  ZS_DB_DRIVER: z.enum(["pg", "pglite"]).default("pg"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  KV_REST_API_URL: z.string().url().optional(),        // Upstash-via-KV names
  KV_REST_API_TOKEN: z.string().optional(),
  ZS_REDIS: z.enum(["upstash", "memory"]).default("upstash"),
  CLERK_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  CRON_SECRET: z.string().min(16).optional(),
  ZS_JWT_PRIVATE_KEY: z.string().optional(),           // PKCS#8 PEM, P-256
  ZS_JWT_KID: z.string().default("k1"),
  ZS_JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),   // SPKI PEM during rotation
  ZS_JWT_PREVIOUS_KID: z.string().optional(),
  ZS_JWT_ISSUER: z.string().default("zs"),
  ZS_EDITOR_COOKIE_SECRET: z.string().optional(),      // base64, 32 bytes; HS256 key for the zs_editor cookie (§3.8)
  ZS_SECRETS_KEYS: z.string().optional(),              // JSON {"<version>":"<base64 32 bytes>"}
  ZS_SECRETS_ACTIVE_KEY_VERSION: z.coerce.number().int().optional(),
  ZS_CLIENT_BUILD_ID: z.string().optional(),           // "<zed-commit>-<patch>" (§11.2:459) – bundle used for NEW workspaces
  ZS_SERVER_BUILD_ID: z.string().optional(),           // ZS_BUILD_ID baked into ZS_IMAGE_REF
  ZS_IMAGE_REF: z.string().optional(),                 // "zs-workspace:<build>" or "zs-workspace@sha256:…"
  ZS_BUILDER_IMAGE_REF: z.string().optional(),
  ZS_CONTROL_PLANE_URL: z.string().url().optional(),   // public origin sandboxes call back to; handed to the supervisor verbatim as its ZS_CONTROL_PLANE_URL (origin, no "/api": b8 §3.3 appends /api/sandboxes/{name}/… itself, b8:179-180)
  ZS_EDITOR_BUNDLE_SOURCE: z.string().url().optional(),// where scripts/fetch-editor-bundle.ts pulls editor/<build>.tar from
  ZS_EDITOR_BUNDLES_KEEP: z.coerce.number().int().default(5),
  ZS_CSP_UNSAFE_EVAL: z.enum(["0", "1"]).default("1"), // "1" until b7 ships the patched wasm_thread (b7 risk 2)
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
  ZS_DEFAULT_REGION: z.enum(["iad1", "sfo1", "cle1", "cdg1"]).default("iad1"),
  ZS_PORT_POOL: z.string().default("3000,3001,4000,5000,5173,8000,8080,8888"),
  ZS_RPC_PORT: z.coerce.number().default(8443),
  ZS_PROXY_SLOTS: z.string().default("8444,8445,8446,8447"), // D8: four private-port proxy slots, declared at sandbox create, one allocated per private forward. The literal D8 range overlaps ZS_HEALTH_PORT (8445, BUILD-SPEC §6.2 line 302) and the D5 control listener / b8 loopback API (8446) inside the VM – §7 item 20 (unresolved port map, also b2 §7.16 and b4 risk 20); env() logs the overlap and the value follows the tech lead's port map without a code change
  ZS_HEALTH_PORT: z.coerce.number().default(8445),     // the port probeHealth polls (b8 §4.4; BUILD-SPEC §6.2 line 302)
  ZS_IDLE_MINUTES_DEFAULT: z.coerce.number().default(30),
  ZS_RETENTION_DAYS: z.coerce.number().default(30),
  ZS_SESSION_TIMEOUT_MS: z.coerce.number().default(4 * 3600_000),   // rolling horizon
  ZS_SESSION_CAP_MS: z.coerce.number().default(24 * 3600_000),      // platform cap (Pro)
  ZS_SANDBOX_DRIVER: z.enum(["real", "fake"]).default("real"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_METER_ACTIVE_CPU: z.string().optional(),      // Stripe Billing meter event names (§3.14)
  STRIPE_METER_MEMORY: z.string().optional(),
  STRIPE_METER_EGRESS: z.string().optional(),
  STRIPE_METER_SNAPSHOT: z.string().optional(),
  ZS_LOG_SINK_URL: z.string().url().optional(),
  ZS_LOG_SINK_TOKEN: z.string().optional(),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  VERCEL_URL: z.string().optional(),
});
export type Env = z.infer<typeof envSchema>;
export function env(): Env;                       // memoized parse; throws EnvError listing missing keys
export function requireEnv<K extends keyof Env>(...keys: K[]): { [P in K]-?: NonNullable<Env[P]> };
export function controlPlaneUrl(): string;        // ZS_CONTROL_PLANE_URL ?? `https://${VERCEL_URL}` – the origin the supervisor receives as ZS_CONTROL_PLANE_URL (b8:152, 1243) and the single manifest.allowedOrigins entry (D5)
export function controlApiBase(): string;         // `${controlPlaneUrl()}/api` – base of the sandbox-facing routes, used by tests and docs only; the supervisor derives it itself (b8:179-180) and no env var carries it
export function envTag(): string;                 // VERCEL_ENV ?? "development" – the single sandbox tag value (§4.8)
export function portPool(): number[];
export function proxySlots(): number[];           // ZS_PROXY_SLOTS parsed: exactly four distinct ports (D8), none equal to ZS_RPC_PORT and none in portPool(); overlap with ZS_HEALTH_PORT is logged, not fatal, until the port map lands (§7 item 20)
export function infraPorts(): number[];           // [ZS_RPC_PORT, ...proxySlots(), ZS_HEALTH_PORT] deduplicated – the ports user forwards may never target (b8 INFRA_PORTS)
```

### 3.3 `lib/ids.ts` (new)

```ts
export type IdPrefix = "ws" | "sb" | "ses" | "con" | "repo" | "pb" | "sec" | "inv";
export function newId(prefix: IdPrefix): string;          // `${prefix}_` + 20 chars Crockford base32 from crypto.getRandomValues
export function newConnectId(): string;                   // newId("con") – the per-connect session id (D1): the JWT `sid`, ConnectInfo.sessionId, Hello.session_id; fresh on every successful /connect, never a persistence key
export function newSandboxName(workspaceId: string, generation: number): string; // `sb-${envShort()}-${workspaceId.slice(3).toLowerCase()}-g${generation}`; envShort = prod|prev|dev (names are unique per Vercel project and immutable; the env segment keeps preview and production sandboxes apart when they share a project)
export function newPrebuildSandboxName(prebuildId: string): string;              // `pb-${envShort()}-${prebuildId.slice(3).toLowerCase()}`
export function newSandboxToken(): { token: string; hash: string }; // token = "zsb_" + base64url(32 bytes); hash = sha256 hex
export function sha256Hex(input: string): string;
export function timingSafeEqualHex(a: string, b: string): boolean;
```

### 3.4 `lib/schema.ts` (new) – full Drizzle schema in §4.1

### 3.5 `lib/db.ts` (new)

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;
export function getDb(): Db;                      // lazy singleton; ZS_DB_DRIVER=pg → new Pool({ connectionString }) + attachDatabasePool(pool) (from @vercel/functions); pglite → new PGlite() in-memory (tests) or dataDir
export async function migrateDb(db: Db): Promise<void>;   // drizzle-orm/node-postgres/migrator or drizzle-orm/pglite/migrator with { migrationsFolder: "drizzle" }
export function _resetDbForTests(): void;
```

`pg` over TCP against the Neon pooled `DATABASE_URL` works on Fluid Compute and keeps one dialect (`postgresql`) and one migration folder for prod, docker-postgres dev and PGlite tests. `drizzle-orm/neon-http` was rejected because it has no interactive transactions (needed by `reserveWorkspace` and `openOrReuseSession`).

### 3.6 `drizzle.config.ts` (new)

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  out: "./drizzle",
  schema: "./lib/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? process.env.POSTGRES_URL! },
});
```

### 3.7 `lib/redis.ts`, `lib/ratelimit.ts`, `lib/concurrency.ts` (new)

Small interface with two implementations; every lock and counter in the system goes through it.

```ts
// redis.ts
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { exMs?: number; nx?: boolean }): Promise<boolean>; // false when nx and key exists
  del(key: string): Promise<void>;
  incr(key: string, exMs?: number): Promise<number>;
  mget(keys: string[]): Promise<(string | null)[]>;
}
export function kv(): KV;                                  // upstash (Redis.fromEnv() or KV_REST_API_* mapped) | memory
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined>; // SET NX PX; undefined when not acquired
export const keys = {
  activity: (ws: string) => `zs:activity:${ws}`,          // last input unix ms (from activity pings)
  health:   (ws: string) => `zs:health:${ws}`,            // last activity ping unix ms (TTL 120 s)
  cpu:      (ws: string) => `zs:cpu:${ws}`,               // consecutive pings with no session and >80 % CPU (abuse rule, §4.10)
  listening:(ws: string) => `zs:listening:${ws}`,         // JSON number[] from the last activity ping's listening[] (ports route); the non-loopback :8445/health body carries no listening list (b8 §4.4)
  busy:     (ws: string) => `zs:busy:${ws}`,              // "<phase>" while the last ping reported busy || phase !== "ready" (D13; TTL 120 s) – the sweep and the activity directive treat it as activity
  keepalive:(ws: string) => `zs:keepalive:${ws}`,
  lock:     (name: string) => `zs:lock:${name}`,
  idem:     (userId: string, key: string) => `zs:idem:${userId}:${key}`,  // Idempotency-Key → cached response (24 h)
  repos:    (userId: string) => `zs:repos:${userId}`,     // GET /api/repos cache (60 s)
};
// ratelimit.ts – @upstash/ratelimit sliding windows (memory-backed under ZS_REDIS=memory)
export type LimitName = "sandbox.manifest" | "sandbox.git-token" | "sandbox.ports" | "sandbox.activity" | "sandbox.logs" | "sandbox.client-errors" | "sandbox.extensions"
  | "user.workspaces.create" | "user.connect" | "user.keepalive" | "user.secrets" | "user.client-errors";
export async function limit(name: LimitName, subject: string): Promise<void>;   // throws ApiError(429, "rate_limited") with Retry-After
export const LIMITS: Record<LimitName, { tokens: number; windowSec: number }>;  // sandbox: manifest 60/60, git-token 30/60, ports 30/60, activity 10/60, logs 120/60, client-errors 60/60, extensions 30/60 (§4.2 `POST /api/sandboxes/{name}/extensions`); user: workspaces.create 10/600, connect 60/60, keepalive 30/60, secrets 60/60, client-errors 60/60
// concurrency.ts
export async function mapConcurrent<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]>; // tiny p-limit; used by the sweep and gc
```

Lifecycle notices are no longer queued in Redis: the supervisor derives `IDLE_STOP_IN`/`SESSION_CAP_IN` from the `idleStopAt`/`sessionCapAt` it receives on every activity ping (the b8 revision on disk still relays a `notices[]` queue from the response, `b8:321, 782-790` — §9 lists the delta; the reason for the timestamps is §8 R2-17: a queued `STOPPING` is never delivered in time), raises `STOPPING` itself when it is asked to stop (b8 `stop_child` → `POST /control/lifecycle {"kind":"stopping"}` on the D5 control listener) and `RESUMED` when its `first-boot.done` marker exists at boot (b8 `:726, 822`; the agent holds it until the first `session_active`, `:786`). D13: while a ping says `busy || phase !== "ready"` the route treats the workspace as active (`keys.activity = now`, `keys.busy = phase`), so a 30-minute `postCreateCommand` is never idle-stopped and the boot overlay keeps seeing `boot:<phase>`.

### 3.8 `lib/auth.ts`, `lib/editor-cookie.ts` (new)

```ts
// auth.ts
import { auth, clerkClient } from "@clerk/nextjs/server";
export interface Viewer { userId: string; orgIds: string[]; via: "clerk" | "editor-cookie" }
export async function requireViewer(opts?: { workspaceId?: string; allowEditorCookie?: boolean }): Promise<Viewer>;
// 1. `const { userId } = await auth()` → viewer (via "clerk"); 2. else if allowEditorCookie && opts.workspaceId: verifyEditorCookie(cookies(), workspaceId) → viewer (via "editor-cookie"); 3. else throw ApiError(401). orgIds come from the memberships table (not Clerk's *active* org), so an org member whose active org differs still sees org workspaces.
export async function ensureUser(viewer: Viewer): Promise<schema.User>;   // upsert users row on first sight (works without Clerk webhooks)
export async function requireWorkspaceAccess(viewer: Viewer, workspaceId: string, opts?: { allowStates?: WorkspaceState[] }): Promise<schema.Workspace>; // owner or member of workspace.orgId; 404 (not 403) when not visible
export async function requireRepoAccess(viewer: Viewer, repoId: string): Promise<schema.Repo>;
export async function requireOrgRole(viewer: Viewer, orgId: string, roles: MembershipRole[]): Promise<void>;   // 403 org_role_required
export async function githubUserToken(userId: string): Promise<string>;  // (await clerkClient()).users.getUserOauthAccessToken(userId, "github") → data[0].token

// editor-cookie.ts – first-party session for the editor page (no ClerkProvider on /w/*, see §2 Clerk rows)
export const EDITOR_COOKIE = "zs_editor";
export interface EditorClaims { sub: string; ws: string; aud: "zs-editor"; iat: number; exp: number; jti: string }
export async function mintEditorCookie(userId: string, workspaceId: string): Promise<{ value: string; expires: Date }>; // jose SignJWT HS256 with ZS_EDITOR_COOKIE_SECRET, exp = +12 h
export async function verifyEditorCookie(jar: ReadonlyRequestCookies, workspaceId: string): Promise<EditorClaims | null>; // jwtVerify({ algorithms: ["HS256"], audience: "zs-editor" }) and claims.ws === workspaceId
export function editorCookieAttributes(workspaceId: string, expires: Date): CookieAttributes; // HttpOnly; Secure (not in dev); SameSite=Strict; Path=/api/workspaces/<id>; Expires
```

Why: Clerk's `__session` JWT lives 60 s and only clerk-js refreshes it (§2). The editor page deliberately loads no Clerk script, so every `fetch()` from the shell (`/connect` on reconnect, `/keepalive`, `/stop`, `/session`, `/client-errors`, `/extensions`) authenticates with `zs_editor`, which `proxy.ts` mints on every `/w/:id` **document** request (the document request still handshakes with Clerk, so `auth()` is fresh there) and `POST /api/workspaces/{id}/session` re-mints (the shell calls it every 6 h and after a `401`). The cookie is path-scoped to one workspace, `SameSite=Strict`, and carries no Clerk material.

### 3.9 `lib/api.ts` (new)

```ts
export class ApiError extends Error { constructor(public status: number, public code: string, message?: string, public details?: unknown) }
export function json<T>(body: T, init?: ResponseInit): Response;
export function error(status: number, code: string, message?: string, details?: unknown): Response; // body { error: { code, message, details? } }
export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S, opts?: { maxBytes?: number }): Promise<z.infer<S>>; // 400 invalid_body; 413 payload_too_large
export function handler<R extends Request = Request, P extends Record<string, string> = Record<string, string>>(
  fn: (req: R, ctx: { params: Promise<P> }) => Promise<Response>): typeof fn;   // catches ApiError → error(), unknown → 500 with request id logged. Routes that need NextRequest (Clerk webhook) instantiate R = NextRequest.
export function bearer(req: Request): string | null;
export async function idempotent(req: Request, userId: string, fn: () => Promise<Response>): Promise<Response>; // Idempotency-Key header → kv SET NX (24 h) → replay cached { status, body }; no header → fn()
```

### 3.10 `lib/crypto.ts` (new) – AES-256-GCM secrets envelope (§4.4)

```ts
export interface SecretKeys { active: number; keys: Map<number, Buffer> }   // 32-byte keys
export function loadSecretKeys(e = env()): SecretKeys;     // parses ZS_SECRETS_KEYS + ZS_SECRETS_ACTIVE_KEY_VERSION; throws if active missing or any key != 32 bytes
export function encryptSecret(plaintext: string, aad: string, keys?: SecretKeys): string;   // "v1:<kv>:<iv>:<ct>:<tag>" base64url fields
export function decryptSecret(envelope: string, aad: string, keys?: SecretKeys): string;    // throws SecretError("unknown_key_version" | "malformed" | "auth_failed")
export function parseEnvelope(envelope: string): { version: 1; keyVersion: number; iv: Buffer; ct: Buffer; tag: Buffer };
export function needsRotation(envelope: string, keys?: SecretKeys): boolean;
export function rotateEnvelope(envelope: string, aad: string, keys?: SecretKeys): string;
export function secretAad(scope: "user" | "org" | "repo", scopeId: string, name: string): string; // `${scope}:${scopeId}:${name}` (the previous revision's "workspace" scope carried the port-session HMAC secret, which D8/b8 §3.10 removed – nothing per-workspace is encrypted any more)
```

Uses `node:crypto` `createCipheriv("aes-256-gcm", key, iv)` with a fresh 12-byte IV per encryption, `setAAD(Buffer.from(aad))`, 16-byte tag. The AAD binds a ciphertext to its row so a copied envelope cannot be replayed under another name.

### 3.11 `lib/tokens.ts` (new) – ES256 session JWTs (§4.3)

```ts
import { SignJWT, jwtVerify, importPKCS8, importSPKI, type JWTPayload } from "jose";

export interface SessionClaims extends JWTPayload { iss: string; sub: string; ws: string; sid: string; aud: string; iat: number; exp: number; jti: string }
export interface SigningKeys {
  active: { kid: string; privateKey: CryptoKey; publicSpkiPem: string };
  previous?: { kid: string; publicSpkiPem: string };
  issuer: string;
}
export function loadSigningKeys(e = env()): Promise<SigningKeys>;   // importPKCS8(ZS_JWT_PRIVATE_KEY, "ES256"); public SPKI derived with node:crypto createPublicKey(pem).export({ type: "spki", format: "pem" })
export function publicKeyPems(keys: SigningKeys): string[];        // active first, then previous – the manifest's jwt.publicKeys (b8 wants bare PEM strings)
export interface MintInput { userId: string; workspaceId: string; sessionId: string /* per-connect con_… id (D1) */; audience: string; ttlSeconds?: number /* default 3600, max 3600 */ }
export async function mintSessionToken(input: MintInput, keys?: SigningKeys): Promise<{ token: string; jti: string; expiresAt: Date; kid: string }>;  // ws = workspaceId (stable identity), sid = sessionId (per connect, informational – D1; §3.18)
export async function verifySessionToken(token: string, expect: { audience: string; workspaceId: string }, keys?: SigningKeys): Promise<SessionClaims>;
```

`mintSessionToken` = `new SignJWT({ ws: workspaceId, sid: sessionId }).setProtectedHeader({ alg: "ES256", typ: "JWT", kid }).setIssuer(issuer).setSubject(userId).setAudience(audience).setIssuedAt().setExpirationTime(now + ttl).setJti(newJti()).sign(privateKey)` — `ws` is the stable workspace id b2 checks against `--workspace-id`, `sid` the per-connect id (D1). `verifySessionToken` = `jwtVerify(token, (hdr) => keyFor(hdr.kid), { issuer, audience, algorithms: ["ES256"], clockTolerance: 30, requiredClaims: ["exp", "aud", "iss", "sub", "ws", "sid", "jti"] })` then constant-time compare of `payload.ws`. Verification is used by tests only; the RPC path is verified by b2. Private-port bootstrap tokens are ES256 as well (§3.12, D8/b8 §3.10) but carry `aud = portAudience(audience)`, so `verifySessionToken` — and b2's `/rpc`, which compares `aud` to `--audience` — rejects them.

Rotation: set `ZS_JWT_PREVIOUS_PUBLIC_KEY`/`_KID` to the old pair and a new `ZS_JWT_PRIVATE_KEY`/`ZS_JWT_KID`; the manifest carries both public keys; every subsequent supervisor start writes both PEMs (`b8:624 write_jwt_keys`) and passes two `--jwt-public-key` flags (`b2:558`). A resume therefore picks up new keys without recreating the sandbox.

### 3.12 `lib/sandbox-auth.ts`, `lib/port-session.ts` (new)

```ts
// sandbox-auth.ts – per-sandbox bearer
export type SandboxPrincipal =
  | { kind: "workspace"; workspace: schema.Workspace; sandboxName: string; tokenGeneration: number }
  | { kind: "prebuild"; prebuild: schema.Prebuild; repo: schema.Repo; sandboxName: string; tokenGeneration: number };
export async function requireSandbox(req: Request, sandboxName: string): Promise<SandboxPrincipal>;
// Authorization: Bearer zsb_… ; `sb-` names resolve workspaces.sandbox_name, `pb-` names resolve prebuilds.sandbox_name; timingSafeEqualHex(sha256(token), row.sandbox_token_hash); 401 sandbox_unauthorized on any mismatch; 410 sandbox_retired when workspace.deleted_at / prebuild.deleted_at set
export async function rotateSandboxToken(target: { kind: "workspace" | "prebuild"; id: string }): Promise<{ token: string; generation: number }>;   // newSandboxToken(); UPDATE sandbox_token_hash, sandbox_token_generation+1; returns plaintext once

// port-token.ts – private-port BOOTSTRAP token (D8; b8 §3.10 BootstrapVerifier, §4.5). The proxy's own `zs_port_session` cookie (HMAC under a per-boot key) is minted by b8, never here.
export const PORT_BOOTSTRAP_TTL_SECS = 600;                 // b8 BOOTSTRAP_MAX_AGE_SECS (:574): the verifier rejects exp - iat > 600
export const PORT_BOOTSTRAP_PARAM = "zs_port_token";        // b8 BOOTSTRAP_PARAM (:571); D8's `/__zs/auth?zs_port_token=...&next=/`
export function portAudience(audience: string): string;     // `${audience}/ports` – distinct from the RPC audience so that b2's /rpc verifier (aud must equal --audience) and verifySessionToken reject a bootstrap token; emitted in the manifest as jwt.portAudience and passed by b8 to BootstrapVerifier::new (§7 item 7h)
export interface PortBootstrapClaims { iss: string; sub: string; ws: string; sid: `port:${number}`; aud: string; iat: number; exp: number; jti: string }   // b8 BootstrapClaims (:578)
export async function mintPortBootstrapToken(input: { userId: string; workspaceId: string; audience: string; port: number }, keys?: SigningKeys): Promise<{ token: string; jti: string; expiresAt: Date }>;
// new SignJWT({ ws: workspaceId, sid: `port:${port}` }).setProtectedHeader({ alg: "ES256", typ: "JWT", kid }).setIssuer(issuer).setSubject(userId).setAudience(portAudience(audience)).setIssuedAt().setExpirationTime(iat + 600).setJti(newJti()).sign(privateKey) – same keys as the session token (b8 verifies with manifest.jwt.publicKeys, all keys tried, kid ignored)
export async function verifyPortBootstrapToken(token: string, expect: { audience: string; workspaceId: string }, keys?: SigningKeys): Promise<{ port: number; claims: PortBootstrapClaims }>;
// tests only – mirrors b8's verifier: audience portAudience(expect.audience), algorithms ["ES256"], leeway 30, required exp/aud/iss/sub/ws/sid/jti, ws match, sid /^port:(\d+)$/ with port ∈ 1..65535 ∖ infraPorts(), exp - iat ≤ 600
```

```ts
// ports.ts – proxy-slot allocation (D8): four slots per workspace, one private forward each
export const PROXY_SLOT_COUNT = 4;
export type SlotHosts = Record<string /* slot port */, string /* host of domain(slot) */>;
export async function allocateSlot(db: Db, workspaceId: string, port: number): Promise<number>;   // inside the caller's transaction: SELECT slot FROM forwards WHERE workspace_id = $1 AND slot IS NOT NULL FOR UPDATE; first free of proxySlots(); throws ApiError(409, "no_free_slot", "all four private-port slots are in use – unforward one first") when none is free
export function slotHost(ws: schema.Workspace, slot: number): string | null;                       // ws.currentSlotHosts?.[String(slot)] ?? null (written at create/resume from handle.domain(slot), §4.8)
export function privateForwardUrl(workspaceId: string, port: number): string;                       // `${controlPlaneUrl()}/api/workspaces/${workspaceId}/ports/${port}/open` – the value shown in the UI, stored in forwards.url and sent to the supervisor (D8; b4 §4.2)
export function authRedirect(slotHostname: string, token: string, next = "/"): string;              // `https://${slotHostname}/__zs/auth?zs_port_token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}` (b8 §3.11 AUTH_PATH)
```

Tokens are delivered only as `runCommand` env at every supervisor start (§3.18) and rotated at every start, so a stopped sandbox's snapshot never contains a live token. A prebuild builder gets its own `zsb_` token (`prebuilds.sandbox_token_hash`) so `zs-agent prebuild` can fetch its manifest and git tokens. Nothing secret is written for private ports: the bootstrap token lives 10 minutes in a redirect URL, the proxy's cookie key is per boot and in memory (b8 §3.10), and the previous revision's `portSessionSecret` (a shared HMAC key in the manifest) is gone with it (§9).

### 3.13 `lib/regions.ts`, `lib/plans.ts`, `lib/audit.ts` (new)

```ts
// regions.ts
export type Region = "iad1" | "sfo1" | "cle1" | "cdg1";
export const REGION_COORDS: Record<Region, { lat: number; lon: number }>;
export function nearestRegion(req: Request): Region;   // geolocation(req) from @vercel/functions → haversine; ZS_DEFAULT_REGION when latitude missing
// plans.ts
export type Plan = "free" | "pro" | "team" | "enterprise";
export type MachineType = "vcpu2" | "vcpu4" | "vcpu8" | "vcpu32";
export const MACHINES: Record<MachineType, { vcpus: 2 | 4 | 8 | 32; memoryGb: number }>;  // 2/4, 4/8, 8/16, 32/64 (2 GB per vCPU, pricing page)
export const PLAN_LIMITS: Record<Plan, { maxWorkspaces: number; machines: MachineType[]; maxConcurrentVcpus: number; idleMinutes: { min: 5; max: 240; default: number }; retentionDays: number; egressCapBytesPerMonth: number }>;
// machines: free ["vcpu2"], pro/team ["vcpu2","vcpu4","vcpu8"], enterprise adds "vcpu32". The pricing page's Resource limits table caps Pro at 8 vCPUs / 16 GB; only Enterprise gets 32/64, so `vcpu32` is refused with 402 plan_limit below enterprise (Sandbox.create would fail otherwise).
export function assertCanCreate(user: schema.User, org: schema.Org | null, running: number, machine: MachineType, spendCents: number): void; // throws ApiError(402|403)
// audit.ts
export type ActorType = "user" | "sandbox" | "system" | "cron";
export async function audit(entry: { actorType: ActorType; actorId: string; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown>; ip?: string }): Promise<void>;
```

### 3.14 `lib/usage.ts`, `lib/billing.ts` (new) – metering math (§4.5) and Stripe meters

```ts
// billing.ts
export async function pushLedgerToStripe(period: string): Promise<{ pushed: number; skipped: number }>;
// for every usage_ledger row with stripe_pushed_at IS NULL and subject's stripeCustomerId set: stripe.billing.meterEvents.create({ event_name: STRIPE_METER_*, payload: { stripe_customer_id, value }, identifier: `${row.id}:${metric}` }) – `identifier` makes retries idempotent on Stripe's side; then set stripe_pushed_at
export async function draftInvoices(period: string): Promise<number>;   // one invoices row per (subject, period) from SUM(cost_cents); Stripe creates the actual invoice from meters; our row records amount + stripeInvoiceId when the invoice.finalized webhook arrives
```

### 3.15 `lib/github.ts` (new)

```ts
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";

export function appAuth(): ReturnType<typeof createAppAuth>;   // createAppAuth({ appId, privateKey, clientId, clientSecret })
export async function installationToken(installationId: number, opts?: { repositoryIds?: number[]; permissions?: Record<string, "read" | "write"> }): Promise<{ token: string; expiresAt: Date }>;
// auth({ type: "installation", installationId, repositoryIds, permissions }) → { token, expiresAt }
export async function installationOctokit(installationId: number): Promise<Octokit>;
export async function listInstallationRepos(installationId: number): Promise<Array<{ id: number; owner: string; name: string; defaultBranch: string; private: boolean }>>; // apps.listReposAccessibleToInstallation, paginated
export async function userInstallations(userId: string): Promise<Array<{ id: number; accountLogin: string; accountType: "User" | "Organization" }>>; // GET /user/installations with the user's Clerk GitHub OAuth token
export async function fetchDevcontainer(installationId: number, owner: string, repo: string, ref: string): Promise<{ hash: string; raw: string } | null>; // .devcontainer/devcontainer.json or .devcontainer.json; hash = sha256(raw)
export async function resolveRef(installationId: number, owner: string, repo: string, ref: { branch?: string; pullRequest?: number; revision?: string }): Promise<{ branch: string | null; sha: string; gitRef: string | null /* "refs/pull/N/head" for PRs */ }>;
export async function verifyGithubWebhook(req: Request): Promise<{ event: string; deliveryId: string; rawBody: string; payload: unknown }>; // verify(GITHUB_WEBHOOK_SECRET, rawBody, req.headers.get("x-hub-signature-256")) else 401
export function cloneUrl(owner: string, name: string): string;  // https://github.com/${owner}/${name}.git
```

Installation tokens are minted only inside `POST /api/sandboxes/{name}/git-token` (the supervisor's credential helper, b8 §3.13) – never inside a workflow step and never passed to `Sandbox.create` (§4.8), so no GitHub token is ever persisted by the Workflow world (BUILD-SPEC §7.8 "never stored").

### 3.16 `lib/sandbox.ts` (new) – the only module that imports `@vercel/sandbox`

A narrow interface so steps and route handlers are testable without the SDK, plus a fake selected by `ZS_SANDBOX_DRIVER=fake` (Workflow integration tests cannot `vi.mock`). Shapes below were type-checked against `@vercel/sandbox@3.2.1` (§2).

```ts
export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";   // SessionMetaData.status, sandbox.d.ts:460
export interface SandboxUsage { activeCpuDurationMs: number; ingressBytes: number; egressBytes: number }                  // defaulted to 0 when the SDK omits them
export interface SandboxHandle {
  readonly name: string;
  readonly status: SandboxStatus;
  readonly region: string;
  readonly expiresAt: Date | undefined;
  readonly currentSessionId: string | undefined;    // sandbox.currentSession().sessionId
  domain(port: number): string;                     // sandbox.domain(port) – "https://<id>.vercel.run"; THROWS when the port was not declared (sandbox.d.ts:860)
  runDetached(input: { cmd: string; args: string[]; env?: Record<string, string>; cwd?: string; sudo?: boolean }): Promise<{ cmdId: string }>;   // runCommand({ ..., detached: true }) → Command.cmdId
  run(input: { cmd: string; args: string[]; env?: Record<string, string>; cwd?: string; sudo?: boolean; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  waitCommand(cmdId: string, timeoutMs: number): Promise<{ exitCode: number }>;   // getCommand(cmdId).wait() with an AbortSignal timeout
  killCommand(cmdId: string, signal: "SIGTERM" | "SIGKILL"): Promise<void>;       // getCommand(cmdId).kill(signal)
  extendTimeout(ms: number): Promise<void>;         // WARNING: wrapped in withResume by the SDK – call only after status === "running" was just observed
  updatePorts(ports: number[]): Promise<void>;      // sandbox.update({ ports }) – full list, does not auto-resume
  stop(): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage }>;   // res.snapshot?.id / .sizeBytes; usage from res.activeCpuDurationMs ?? 0, res.networkTransfer?.ingress ?? 0, ?.egress ?? 0
  snapshot(expirationMs: number): Promise<{ snapshotId: string; sizeBytes: number }>;         // sandbox.snapshot({ expiration }) → Snapshot.snapshotId / .sizeBytes; auto-resumes a stopped sandbox
  readFile(path: string): Promise<ReadableStream<Uint8Array> | null>;   // sandbox.readFile({ path }) → Readable.toWeb(); auto-resumes a stopped sandbox (only used on a VM we resumed on purpose)
  delete(): Promise<void>;
  listSnapshotIds(): Promise<string[]>;             // for await over sandbox.listSnapshots() → s.id (control-plane call, does not resume)
}
export interface CreateSandboxInput {
  name: string; region: Region; vcpus: 2 | 4 | 8 | 32; ports: number[]; timeoutMs: number;
  image?: string; source?: { type: "snapshot"; snapshotId: string };    // git source is never used: the supervisor clones (b8 risk 2, §4.8)
  env: Record<string, string>; networkPolicy: "allow-all" | { allow: string[] }; tags: Record<string, string>;   // ≤ 5 tags
  snapshotExpirationMs: number; keepLastSnapshots: number;
}
export interface SandboxApi {
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  // Sandbox.getOrCreate({ name, resume: true, image | source, resources: { vcpus }, ports, timeout, region, env, networkPolicy, tags, persistent: true, snapshotExpiration, keepLastSnapshots: { count } }).
  // getOrCreate makes a retried step idempotent on `name` ONLY in the sense that a second call returns the existing sandbox: creation params are ignored for an existing name and the sandbox is not resumed unless resume: true (persistence doc "Get or create"). We pass resume: true so a retry after a died first session gets a running VM; an expired-snapshot name is deleted and re-created by the SDK (fine at create time – nothing to keep).
  get(name: string, opts: { resume: boolean; onResume?: (s: SandboxHandle) => Promise<void> }): Promise<SandboxHandle | null>; // Sandbox.get({ name, resume, onResume }); null on APIError not_found; SandboxError("snapshot_expired") on 410 snapshot_not_found
  listByTag(tag: Record<string, string>): AsyncIterable<{ name: string; status: SandboxStatus; createdAt: Date }>; // `for await (const s of await Sandbox.list({ tags }))` (one tag only; createdAt: number → Date)
  deleteSnapshot(snapshotId: string): Promise<void>;                          // Snapshot.get({ snapshotId }).delete(); not_found is success
}
export class SandboxError extends Error { code: "image_not_ready" | "not_found" | "snapshot_expired" | "snapshot_region_mismatch" | "quota" | "unknown"; retryable: boolean }
export function sandboxApi(): SandboxApi;   // real | fake by ZS_SANDBOX_DRIVER
```

`SandboxError.code` is derived from `APIError.json?.error?.code` and `response.status`: `image_not_ready` (images doc; retryable), `not_found` (images doc / `Sandbox.get`), `snapshot_not_found` → `snapshot_expired` (HTTP 410, `sandbox.js:24`; **not retryable** – the workspace must be rebuilt), `snapshot_region_mismatch` (snapshots doc; not retryable), `quota` for 402/429 quota messages; everything else with a 5xx/429 is `retryable`. `tests/sandbox-conformance.test.ts` compiles `lib/sandbox.ts`'s real driver against the SDK types (`satisfies`) so an SDK rename fails `typecheck` rather than production.

### 3.17 `lib/secrets.ts`, `lib/manifest.ts` (new)

```ts
// secrets.ts
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const RESERVED_SECRET_NAMES = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "PROMPT_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_PARAMETERS", "HOME", "PATH", "USER", "SHELL"]);
export function assertSecretName(name: string): void;   // 400 invalid_name unless SECRET_NAME; 400 reserved_name when name.startsWith("ZS_") || RESERVED_SECRET_NAMES.has(name)
export async function resolveEnvFor(workspace: schema.Workspace): Promise<{ names: string[]; values: Record<string, string> }>; // user < org < repo precedence (§7.9); decrypts with secretAad
export async function putSecret(scope, scopeId, name, value, actor): Promise<void>;   // assertSecretName + encrypt + upsert + audit (value never logged)
// manifest.ts
export async function buildManifest(principal: SandboxPrincipal): Promise<SandboxManifest>;   // §4.7; b8 Manifest shape; names only, no values
```

A repo- or org-scoped secret named `ZS_CONTROL_PLANE_URL`, `ZS_SANDBOX_NAME` or `ZS_SERVER_BIN` would otherwise redirect the supervisor (and every git-token request) to an attacker-chosen host for every user who opens a workspace on that repo; the `ZS_` prefix and the loader/shell denylist are rejected at `PUT /api/secrets`, and `supervisorEnvFor` (§3.18) spreads identity keys last so they always win even for rows written before this rule.

### 3.18 `lib/connect.ts` (new) – shared by the route and the workflow

```ts
export interface ConnectInfo { wsUrl: string; token: string; sessionId: string; serverBuild: string; clientBuild: string; sessionExpiresAt: string; sessionCapAt: string; audience: string }
// sessionId = newConnectId() on every successful call: the JWT `sid`, informational (telemetry, logs, the server's session bookkeeping – D1); NOT a persistence key. The identity the client persists under is the workspace id (ZsBootConfig.workspace.id === workspace.id, D1). The `sessions` row id (takeover/ledger bookkeeping) is never exposed either; the last minted sessionId is recorded in sessions.last_connect_id for log correlation with b2's ServeLogRecord.sid.
// sessionExpiresAt = the token's exp (ISO 8601) – b7 §3.21 ensure_fresh_token refreshes 60 s before it (BUILD-SPEC §4.3); sessionCapAt = session_started_at + ZS_SESSION_CAP_MS (ISO) for the shell's countdown.
export async function supervisorEnvFor(workspace: schema.Workspace, sandboxToken: string): Promise<Record<string, string>>;
// { ...decrypted user/org/repo secrets, ZS_CONTROL_PLANE_URL: controlPlaneUrl(), ZS_SANDBOX_TOKEN, ZS_SANDBOX_NAME, ZS_WORKSPACE_ID, ...(VERCEL_AUTOMATION_BYPASS_SECRET ? { ZS_BYPASS_SECRET } : {}) } – identity keys spread LAST (b8:191 strips ZS_SANDBOX_TOKEN/ZS_CONTROL_PLANE_URL/ZS_BYPASS_SECRET from children; ZS_BYPASS_SECRET → `x-vercel-protection-bypass`, D18)
export async function startSupervisor(handle: SandboxHandle, workspace: schema.Workspace, mode: "start" | "resume"): Promise<{ cmdId: string; tokenGeneration: number }>;
// rotateSandboxToken → runDetached({ cmd: "zs-agent", args: [mode], env, sudo: false }) → UPDATE workspaces SET supervisor_cmd_id = cmdId (persisted HERE, inside onResume, so a retried step that finds the VM already resumed still sees the cmdId). `resume` is an alias of `start` in b8 (:831, :846-847); the agent decides `resumed` from its first-boot.done marker.
export interface HealthProbe { ready: boolean; status: "booting" | "ready" | "degraded" | "stopping"; phase: "manifest" | "restore" | "clone" | "server_starting" | "dotfiles" | "post_create" | "post_start" | "warm" | "ready"; build: string | null; manifestBuild: string | null; resumed: boolean; busy: boolean; serverRunning: boolean; serverCrashLoop: boolean; serverRestarts: number; uptimeSecs: number }
// exactly the NON-loopback body of b8 §4.4 (:1215-1231): no lastError, listening, forwards or server.health reach a remote caller; `build` is the image's ZS_BUILD_ID, i.e. the server build; ready = status ∈ {ready, degraded} && serverRunning
export async function probeHealth(host8445: string, timeoutMs: number): Promise<HealthProbe | null>;   // GET https://<host8445>/health (b8 §4.4): 200 for ready|degraded, 503 + body while booting|stopping; null when unreachable; never throws
export async function openOrReuseSession(workspace: schema.Workspace, userId: string, host: string, clientBuild: string, tabId: string): Promise<{ session: schema.Session; takenOver: schema.Session | null }>;
// transaction: SELECT … FOR UPDATE on the open row (sessions_open_idx); same user + same tabId → reuse; other holder + takeover → close it (end_reason "takeover") and insert; other holder without takeover → ApiError(409 session_active); unique-violation race → re-read once and retry
export async function mintConnectInfo(workspace: schema.Workspace, session: schema.Session, host: string): Promise<ConnectInfo>;
// sessionId = newConnectId(); mintSessionToken({ userId: session.userId, workspaceId: workspace.id, sessionId, audience: workspace.audience }); UPDATE sessions SET tokens_minted = tokens_minted + 1, last_connect_id = sessionId
```

Health is polled on **8445** (the supervisor, BUILD-SPEC line 302, b2 §7.12, b8 §4.4, b8 §7 item 11), not on the RPC listener: only the supervisor reports `phase`/`busy` for the boot overlay, and the RPC listener's `/health` hands a remote caller the reduced body anyway. Note b8 on disk starts `serve` **as soon as the repository exists** and runs dotfiles/`postCreateCommand`/`postStartCommand` beside it with `busy = true` (`b8:820-827`), so `waitUntilReady` (§4.8) returns as soon as the server is up — a first boot with a 30-minute `postCreateCommand` becomes connectable early, and the shell keeps showing `boot:<phase>` from the activity pings (§3.25) while `busy` is true. The 35-minute ceiling in §4.8 is retained as an upper bound for clone/restore of very large repositories.

### 3.19 `workflows/steps/*.ts` (new) – `"use step"` functions (full Node access, retried 3× by default)

Every function used by §4.8 or §4.10 is declared here.

```ts
// sandbox-steps.ts
export async function stepCreateSandbox(input: CreateSandboxInput): Promise<{ name: string; region: string; host8443: string; host8445: string; slotHosts: SlotHosts; sessionId: string; expiresAt: string }>;  // create(); if status !== "running" → get(name, { resume: true }); throws RetryableError("image_not_ready", { retryAfter: "20s" }) or FatalError for quota/not_found/snapshot_region_mismatch. slotHosts = one hostname per proxy slot from handle.domain(slot) (D8; the four slots are in input.ports so domain() cannot throw)
export async function stepResumeSandbox(workspaceId: string, name: string): Promise<{ host8443: string; host8445: string; slotHosts: SlotHosts; sessionId: string; expiresAt: string; cmdId: string; tokenGeneration: number } | null>;
// get(name, { resume: true, onResume: (h) => startSupervisor(h, ws, "resume") }); null on not_found; FatalError("snapshot_expired") on snapshot_expired; cmdId/tokenGeneration are read back from the workspaces row (persisted by startSupervisor), so a retry whose get() finds the VM already running returns the cmdId of the supervisor that is actually running
export async function stepResumeSandboxQuiet(name: string): Promise<{ sessionId: string } | null>;   // get(name, { resume: true }) WITHOUT onResume: a VM to read files from (rebuild archive)
export async function stepStartSupervisor(workspaceId: string, sandboxName: string): Promise<{ cmdId: string; tokenGeneration: number }>;   // get(name,{resume:false}) → startSupervisor(h, ws, "start")
export async function stepProbeHealth(workspaceId: string, host8445: string, expectBuild: string): Promise<HealthProbe | null>;   // one probe (5 s timeout); writes workspaces.state_reason = `boot:${phase}` while the row is not yet running; never throws. The remote body has no lastError/listening (b8 §4.4) – listening comes from the activity ping, and a supervisor that died is detected through stepWaitForCommandExit (§4.8 waitUntilReady)
export async function stepSignalSupervisor(sandboxName: string, cmdId: string | null, signal: "SIGTERM"): Promise<void>;   // no-op when cmdId null
export async function stepWaitForCommandExit(sandboxName: string, cmdId: string, timeoutMs: number): Promise<{ exitCode: number | null }>; // null on timeout (never throws)
export async function stepStopSandbox(sandboxName: string): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage } | null>; // get(name, { resume: false }); null when already stopped/not found
export async function stepStopSandboxDiscard(sandboxName: string): Promise<SandboxUsage | null>;   // same, usage recorded by the caller under reason "rebuild"
export async function stepPeekSandbox(sandboxName: string): Promise<{ status: SandboxStatus; expiresAt: string | null } | null>;   // get(name, { resume: false })
export async function stepExtendTimeout(sandboxName: string, ms: number): Promise<void>;   // get(name,{resume:false}); only when status === "running" (extendTimeout auto-resumes otherwise)
export async function stepUpdatePorts(sandboxName: string, ports: number[]): Promise<void>;
export async function stepSnapshot(sandboxName: string, expirationMs: number): Promise<{ snapshotId: string; sizeBytes: number }>;
export async function stepDeleteSandbox(sandboxName: string, opts: { deleteSnapshots: boolean }): Promise<void>;  // get(name,{resume:false}); stop if running; listSnapshotIds → deleteSnapshot each; delete(); not_found is success
export async function stepArchiveWorkspaceDir(sandboxName: string, workspaceId: string): Promise<{ blobPathname: string; bytes: number; sha256: string }>; // run `tar czf /tmp/ws.tgz -C / workspaces vercel/.local/share/zed` – exactly D9's two paths (`/workspaces` and `$HOME/.local/share/zed`, the server data dir: client state under server_state/client_state, remote_extensions, language-server downloads; HOME=/vercel per b8 §7.1), relative to / because b8 extracts at / (D9). `~/.config/zed/{settings,keymap}.json` is deliberately NOT archived: b8 write_settings re-materialises both from manifest.settings on every boot (b8:750-753) and its version marker lives in the state dir, which is outside the tarball. readFile → put(`rebuild/${workspaceId}/${Date.now()}.tgz`, stream, { access: "private" })
export async function stepDeleteBlob(pathname: string): Promise<void>;
export async function stepListOrphanSandboxes(knownNames: string[]): Promise<string[]>;   // for await listByTag({ zs: envTag() }) minus knownNames; status !== "snapshotting"
export async function stepDeletePrebuildSnapshot(prebuildId: string): Promise<void>;
// db-steps.ts
export async function stepLoadWorkspace(workspaceId: string): Promise<schema.Workspace>;   // FatalError("workspace_missing") if missing/deleted
export async function stepReserveWorkspace(input: CreateWorkspaceInput & { userId: string }): Promise<schema.Workspace>;   // transaction: plan limits, insert workspaces(state='creating'), audit
export async function stepSetState(workspaceId: string, state: WorkspaceState, reason?: string, patch?: Partial<schema.Workspace>): Promise<void>;
export async function stepFinishRun(workspaceId: string, outcome: { ok: true } | { ok: false; error: string; state?: WorkspaceState }): Promise<void>; // ALWAYS clears workflow_run_id; on error sets state (default "error") + state_reason; called from every workflow's finally
export async function stepPickImage(workspaceId: string): Promise<{ kind: "snapshot"; snapshotId: string; prebuildId: string } | { kind: "image"; image: string } >; // fresh prebuild for (repo, branch) with status ready and commit == resolved sha → snapshot; else repo.image_ref ?? ZS_IMAGE_REF
export async function stepRecordSessionEnd(workspaceId: string, usage: SandboxUsage, endReason: string): Promise<void>;
// startedAt = workspace.session_started_at (VM wall time – a VM bills for the idle tail after the last tab closes, and may never have had a sessions row), endedAt = now; ledger idempotencyKey `stop:${workspaceId}:${currentSandboxSessionId}`; closes zero-or-one open sessions rows (end_reason = endReason)
export async function stepBumpGeneration(workspaceId: string, archive: { blobPathname: string; sha256: string }, fromImage: boolean): Promise<{ oldSandboxName: string; newSandboxName: string }>; // sandbox_generation+1, sandbox_name = newSandboxName(...), audience = new name, restore_kind='tarball', restore_blob_pathname, forwards.slot preserved (slots are per workspace, not per sandbox – the new generation declares the same four ports), image_ref = repo.image_ref ?? ZS_IMAGE_REF (fromImage → ignore prebuild), previous_sandbox_name = old (kept until the new generation is healthy)
export async function stepPurgeWorkspaceRows(workspaceId: string): Promise<void>;   // forwards deleted, open sessions closed, workspaces.deleted_at set (rows kept for ledger/audit)
export async function stepCreatePrebuildRow(input: { repoId: string; branch: string; commit: string }): Promise<schema.Prebuild>;
export async function stepSetPrebuildStatus(prebuildId: string, status: PrebuildStatus, patch?: Partial<schema.Prebuild>): Promise<void>;
export async function stepStartSupervisorForPrebuild(prebuildId: string, sandboxName: string): Promise<{ cmdId: string }>;   // rotateSandboxToken({kind:"prebuild"}) → runDetached("zs-agent", ["prebuild"], env)
export async function stepPrunePrebuilds(repoId: string, branch: string, keep: number): Promise<string[]>;   // mark deleted beyond `keep` newest ready rows; returns ids to delete snapshots for
export async function stepGcCandidates(now: string): Promise<{ expiredWorkspaces: string[]; prebuildsToDelete: string[]; knownSandboxNames: string[] }>;
export async function stepCloseStaleSessions(now: string): Promise<number>;   // sessions open > 25 h with workspace not running → ended_at = now, end_reason "stale"
export async function stepWarnRetention(now: string): Promise<number>;        // retention_until - 7 d < now && retention_warned_at IS NULL → e-mail hook (§7 item 18) + retention_warned_at = now
// child-steps.ts – `start()` / `getRun()` are stubs inside workflow context (workflow/dist/api-workflow.js), so:
export async function stepRunChild<T>(name: "stopWorkspace" | "createWorkspace" | "connectWorkspace" | "deleteWorkspace", args: unknown): Promise<T>;   // start(wf, [args]) then await run.returnValue inside the same step; propagates FatalError
export async function stepRunStatus(runId: string): Promise<"pending" | "running" | "completed" | "failed" | "cancelled" | "unknown">;   // getRun(runId).status – used by the sweep's dead-run reconciliation (called from a route, not a workflow)
```

### 3.20 `workflows/*.ts` (new) – `"use workflow"` orchestration, pseudocode in §4.8

Every workflow body is `try { … } catch (e) { await stepFinishRun(id, { ok: false, error: String(e) }); throw e; } finally { /* success path calls stepFinishRun({ ok: true }) before returning */ }`, so `workflow_run_id` can never outlive its run (the first draft left it set on every failure after `stepCreateSandbox`, which bricked the workspace: `/connect` → 423 forever, `DELETE` → 409 forever, sweep skipping the row).

### 3.21 `proxy.ts` (new)

```ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { editorCsp } from "@/lib/csp";
import { mintEditorCookie, editorCookieAttributes, EDITOR_COOKIE } from "@/lib/editor-cookie";

const isEditorDoc = createRouteMatcher(["/w/(.*)"]);
const isProtectedPage = createRouteMatcher(["/workspaces(.*)", "/repos(.*)", "/secrets(.*)", "/settings(.*)", "/usage(.*)", "/orgs(.*)", "/audit(.*)", "/admin(.*)"]);
const isProtectedApi = createRouteMatcher(["/api/repos(.*)", "/api/me(.*)", "/api/secrets(.*)", "/api/admin(.*)"]);   // default-deny: a forgotten requireViewer() fails closed
// /api/workspaces/* is NOT in the list: those routes accept Clerk OR the editor cookie and call requireViewer({ allowEditorCookie: true }) themselves.

export default clerkMiddleware(async (auth, req: NextRequest) => {
  if (isProtectedApi(req) || isProtectedPage(req)) await auth.protect();          // 401 JSON for API, redirect to sign-in for pages
  if (!isEditorDoc(req)) return NextResponse.next();
  const { userId } = await auth();
  if (!userId) return (await auth()).redirectToSignIn();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = editorCsp(nonce, { dev: process.env.NODE_ENV === "development", unsafeEval: env().ZS_CSP_UNSAFE_EVAL === "1" });   // §4.9
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  const wsId = req.nextUrl.pathname.split("/")[2];
  if (/^ws_[0-9A-HJKMNP-TV-Z]{20}$/.test(wsId) && req.headers.get("sec-fetch-dest") !== "empty") {   // document requests only
    const c = await mintEditorCookie(userId, wsId);                                // workspace access itself is checked in page.tsx; the cookie only proves "userId"
    res.cookies.set(EDITOR_COOKIE, c.value, editorCookieAttributes(wsId, c.expires));
  }
  return res;
});

export const config = {
  matcher: [
    // everything except static files, the editor bundle, the service worker, the PWA manifest, Workflow's well-known endpoint, and routes that authenticate on their own (sandbox bearer, webhook signatures, CRON_SECRET) – a Clerk outage must not fail the 30 s activity pings
    "/((?!_next|editor/|sw\\.js|manifest\\.webmanifest|\\.well-known/workflow/|api/sandboxes/|api/webhooks/|api/cron/|[^?]*\\.(?:html?|css|js(?!on)|wasm|tar|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
```

`/editor/` and `.well-known/workflow/` are excluded (the Workflow Next guide requires the latter; the former is static and must not pay a proxy invocation per wasm fetch). `createRouteMatcher` + `auth.protect()` is used for the default-deny list only; per-resource checks stay in handlers (`requireViewer`, `requireWorkspaceAccess`).

### 3.22 `next.config.ts` (modified, replaces `:1-7`)

```ts
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];
const nextConfig: NextConfig = {
  headers: async () => [
    { source: "/w/:id", headers: [...isolation, { key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "no-referrer" }] },
    { source: "/editor/:build/:path*", headers: [...isolation, { key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    { source: "/sw.js", headers: [{ key: "Service-Worker-Allowed", value: "/w/" }, { key: "Cache-Control", value: "no-cache" }] },
    { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ],
};
export default withWorkflow(nextConfig);
```

Headers live here rather than in `vercel.ts` (§3.5 line 171 says `vercel.ts`) because `next dev` honours `next.config.ts` and not `vercel.ts`; the CSP is per-request (nonce) and therefore in `proxy.ts`. `require-corp` means every subresource the editor loads is same-origin (bundle, assets, `sw.js`) or CORS-enabled (b2's `/files` and `/extensions/*` with `--allowed-origin`, §2), which is why the editor bundle cannot be served from a Blob origin.

### 3.23 `vercel.ts` (new)

```ts
import type { VercelConfig } from "@vercel/config/v1";
export const config: VercelConfig = {
  framework: "nextjs",
  crons: [
    { path: "/api/cron/sweep", schedule: "* * * * *" },
    { path: "/api/cron/gc", schedule: "17 3 * * *" },
    { path: "/api/cron/snapshot-usage", schedule: "47 0 * * *" },
    { path: "/api/cron/invoice", schedule: "23 2 1 * *" },
  ],
};
```

Per-route `maxDuration` is declared with the Next route-segment export (`export const maxDuration = 60` in `connect/route.ts`, `300` in the cron routes and `rebuild`), not through `functions` globs. Vercel Firewall rules (rate limit `/api/webhooks/*` and `/sign-in`, BotID on `/api/workspaces` POST) are configured in the dashboard and documented in `README.md`; they are not expressible in `vercel.ts` today.

### 3.24 Route handlers (new) – contracts in §4.2; each file exports `export const runtime = "nodejs"` and the methods listed

| File | Exports |
|---|---|
| `app/api/workspaces/route.ts` | `GET`, `POST` (wrapped in `idempotent()`) |
| `app/api/workspaces/[id]/route.ts` | `GET`, `PATCH` (idleMinutes, name), `DELETE`; ctx: `RouteContext<'/api/workspaces/[id]'>` |
| `app/api/workspaces/[id]/connect/route.ts` | `POST`, `export const maxDuration = 60` |
| `app/api/workspaces/[id]/session/route.ts` | `POST` → re-mints `zs_editor` (Clerk or a still-valid editor cookie) |
| `app/api/workspaces/[id]/stop/route.ts` | `POST` |
| `app/api/workspaces/[id]/rebuild/route.ts` | `POST` |
| `app/api/workspaces/[id]/keepalive/route.ts` | `POST` |
| `app/api/workspaces/[id]/ports/route.ts` | `GET`, `POST` (a private forward allocates one of the four proxy slots, D8), `DELETE` (frees it) |
| `app/api/workspaces/[id]/ports/[port]/open/route.ts` | `GET` → 303 to `https://<slot-host>/__zs/auth?zs_port_token=<jwt>&next=/` (D8; b8 §3.11/§4.5) |
| `app/api/workspaces/[id]/client-errors/route.ts` | `POST` (editor cookie or Clerk; resolves the sandbox name server-side) |
| `app/api/repos/route.ts` | `GET` (installations + repos), `POST` (register a repo for prebuilds/settings) |
| `app/api/repos/[id]/prebuilds/route.ts` | `GET`, `POST` |
| `app/api/me/settings/route.ts`, `keymap/route.ts`, `dotfiles/route.ts` | `GET`, `PUT` |
| `app/api/secrets/route.ts` | `GET`, `PUT`, `DELETE` |
| `app/api/admin/workspaces/[id]/route.ts` | `POST` `{ action: "stop" }`, `DELETE` – `requireOrgRole(owner|admin)` of the workspace's org; audit `admin.*` |
| `app/api/sandboxes/[name]/manifest/route.ts` | `GET` |
| `app/api/sandboxes/[name]/git-token/route.ts` | `POST` |
| `app/api/sandboxes/[name]/ports/route.ts` | `POST` |
| `app/api/sandboxes/[name]/ports/[port]/route.ts` | `DELETE` |
| `app/api/sandboxes/[name]/activity/route.ts` | `POST` |
| `app/api/sandboxes/[name]/extensions/route.ts` | `POST` `{ installed: string[] }` → 204 – the supervisor's relay of the server's `POST $SUPERVISOR_URL/extensions` (b4 §4.2, D18) → `workspaces.installed_extensions` (D19) |
| `app/api/sandboxes/[name]/logs/route.ts` | `POST` (JSON `LogBatch` or NDJSON, §4.2) |
| `app/api/sandboxes/[name]/client-errors/route.ts` | `POST` (supervisor-originated only) |
| `app/api/webhooks/github/route.ts` | `POST` |
| `app/api/webhooks/clerk/route.ts` | `POST(req: NextRequest)` – `verifyWebhook` requires `RequestLike` (§2) |
| `app/api/webhooks/stripe/route.ts` | `POST` |
| `app/api/cron/sweep/route.ts` | `GET`, `export const maxDuration = 300` (§4.10) |
| `app/api/cron/gc/route.ts` | `GET` → `start(gc, [{ now }])` |
| `app/api/cron/snapshot-usage/route.ts` | `GET` → daily snapshot GB-day accrual |
| `app/api/cron/invoice/route.ts` | `GET` → `withLock("invoice")` → `pushLedgerToStripe(prevPeriod)` + `draftInvoices(prevPeriod)`; idempotent per (subject, period) |

### 3.25 `app/api/sandboxes/[name]/activity/route.ts` – the lifecycle hinge

Body `ActivityReport` (D13 fields `lastInputAt`, `busy`, `phase`, `cpuBusyPct`; zod in §4.2, which also accepts the extra names b8 sends today). Writes `keys.activity(ws) = busy || phase !== "ready" ? now : (lastInputAt ?? previous)` (TTL `2 × idleMinutes`) — **D13: a sandbox that is cloning, restoring or running `postCreateCommand`/`postStartCommand` on the user's behalf counts as active, so the idle sweep never stops it mid-bootstrap** —, `keys.busy(ws) = phase` while busy (TTL 120 s) and `workspaces.state_reason = boot:<phase>` while the row is `running` and busy (cleared when `phase === "ready" && !busy`, which is what the overlay shows after `/connect` succeeded early), `keys.health(ws) = now` (TTL 120 s), `keys.listening(ws)` from `listening[].port` when present, bumps `workspaces.last_active_at` at most once a minute, maintains `keys.cpu(ws)` from `cpuBusyPct` for the abuse rule (D18: b8 reports it), and returns the `ActivityDirective`:

- `idleStopAt` = `max(lastInputAt, keepaliveAt, sessionStartedAt, busy ? now : 0) + idleMinutes × 60 000` (unix ms; `null` for prebuild principals),
- `sessionCapAt` = `sessionStartedAt + ZS_SESSION_CAP_MS` (unix ms),
- `stop` = `workspace.state === "stopping"` (backstop: if the SIGTERM path of §4.8 is lost, the supervisor stops itself on the next ping – b8 §3.16 step 8),
- `forwards` = the workspace's `ForwardView[]` (authoritative: b8 replaces its in-memory forward list with it on every ping, `b8:434`, so a forward added from the dashboard reaches the server's `PortsChanged` within one interval),
- `serverTime` = now (unix ms) so the supervisor can convert the absolute timestamps to countdown seconds without trusting its own clock.

This is what the supervisor turns into `IDLE_STOP_IN`/`SESSION_CAP_IN` frames (the proto `LifecycleNotice.kind` values of §5.5, lines 264-266; the JS callback the shell receives spells them `idle_stop_in`/`session_cap_in`, b4 §3.16 / §3.26 bullet 4) — the b8 revision on disk still expects a `notices[]` queue instead (`b8:321`); §9 lists the delta. The route is the hottest sandbox-facing endpoint: one DB read (by sandbox name, indexed), one conditional write, no notice queue.

### 3.26 Editor shell (new) – `app/(editor)/layout.tsx`, `w/[id]/page.tsx`, `editor-shell.tsx`, `zs-host.ts`, `editor-shell.css`

```tsx
// app/(editor)/layout.tsx – ROOT layout #2: no ClerkProvider, no analytics, no next/font (fonts come from the asset tarball), no globals.css
import "./editor.css";
export default function EditorRootLayout({ children }: LayoutProps<"/">) {
  return (<html lang="en"><body>{children}</body></html>);
}

// app/(editor)/w/[id]/page.tsx (server)
export const dynamic = "force-dynamic";
export default async function EditorPage(props: PageProps<"/w/[id]">) {
  const { id } = await props.params;
  const viewer = await requireViewer().catch(() => null);                 // Clerk (document requests handshake), org membership from `memberships`
  if (!viewer) return (await auth()).redirectToSignIn();
  const workspace = await requireWorkspaceAccess(viewer, id).catch(() => notFound());
  return <EditorShell workspaceId={id} build={workspace.clientBuild} initial={toShellWorkspace(workspace)} settingsUrl="/api/me/settings" keymapUrl="/api/me/keymap" />;
}
```

The bundle is chosen **per workspace** (`workspaces.client_build`, stamped at create from `ZS_CLIENT_BUILD_ID`): b1's `builds_compatible` is exact-match, so after a deploy an existing workspace keeps loading the bundle that matches the server in its image until it is rebuilt (§3.30 keeps the last `ZS_EDITOR_BUNDLES_KEEP` bundles in `public/editor/`).

`editor-shell.tsx` (`"use client"`) – props and state:

```ts
export interface ShellWorkspace { id: string; name: string; repo: string; branch: string | null; machine: MachineType; region: Region; state: WorkspaceState; stateReason: string | null; idleMinutes: number; serverBuild: string; clientBuild: string }
export interface EditorShellProps { workspaceId: string; build: string; initial: ShellWorkspace; settingsUrl: string; keymapUrl: string }
export type ShellPhase =
  | { kind: "booting"; stage: BootStage; detail?: string }               // BootStage = b7's bootProgress union
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "stopped"; reason: "idle" | "user" | "cap" | "error" | "unknown" }
  | { kind: "takeover-required" }
  | { kind: "taken-over" }
  | { kind: "restarting"; secondsLeft: number }
  | { kind: "unsupported-browser" }
  | { kind: "error"; message: string; retryable: boolean };
```

Behaviour (each bullet maps to §3.4 lines 159-162 and §3.6 lines 181-183; the loader steps follow b7 §3.30, whose `crates/zed_web/web/loader.js` is the reference implementation of the same contract):

1. On mount: if `!crossOriginIsolated` → phase `unsupported-browser` and stop (b7 §3.30). Register `/sw.js?build=<build>` (scope `/w/`). Read/create `tabId` in `sessionStorage` (survives reload, not a new tab); read **and clear** `sessionStorage.zsNext` (`{ takeover?: boolean; resume?: boolean }`, written by `reconnect()`, bullet 10). Then in parallel: `connect(zsNext?.resume ? "resume" : "open", zsNext?.takeover ?? false)`, `import(/* webpackIgnore: true */ \`/editor/${build}/zed_web.js\`)` then `const wasm = await mod.default({ module_or_path: \`/editor/${build}/zed_web_bg.wasm\` })` followed by `globalThis.__zsCallCtors?.() ?? wasm.__wasm_call_ctors?.()` (b7 §3.30; exactly once per page — the shell never calls `start` twice without a reload, b7 §7.3), `fetch(\`/editor/${build}/zed-assets.tar\`)` as `Uint8Array` (Cache Storage `zs-assets-${build}`), and `fetch(settingsUrl)`, `fetch(keymapUrl)`. `globalThis.__zsBindgenShimUrl = \`/editor/${build}/zed_web.js\`` is set before `start` (consumed by b7's patched `wasm_thread`, b7 §7.2; harmless before the patch lands). `hostOs` = `navigator.userAgentData?.platform ?? navigator.platform` mapped to `mac | windows | linux` (b7 picks `web.json`/`web-macos.json` from it, D12).
2. `connect(reason, takeover = false)` posts `{ takeover, clientBuild: build, reason, tabId }` and handles: `200` → `ConnectInfo` (a **fresh `sessionId` on every call**, D1 — the shell never compares it with an earlier one); `202 { status: "resuming", runId }` → poll `GET /api/workspaces/{id}` every 1.5 s (`stateReason` `boot:<phase>` feeds `booting.detail`) until `state === "running" && !workflowRunId`, then re-POST; `409 session_active` → phase `takeover-required` (dialog; re-POST with `{ takeover: true }`); `409 workspace_stopped` (a `reason: "reconnect"` call against a stopped/stopping workspace) → phase `stopped` ("click to resume" = `reconnect({ resume: true })`) and, when the call came through `refreshConnectInfo()`, the promise rejects with `{ code: "stopped", message }` so b7 §3.21 maps it to `RefreshError::Stopped` and b1 stops redialing at once (D2); `409 client_build_mismatch` → reload; `401` → `POST /session` once, then reject with `{ code: "unauthorized" }` (→ `RefreshError::Unauthorized`, b1 §7.14) and redirect to sign-in; `402/403/410` → `error`, not retryable; `423 workspace_busy` → wait 1.5 s and retry. A `reason: "reconnect"` call keeps polling `202/423` for up to 5 min so one b1 reconnect attempt spans a session-cap restart (b1 §7.5, D2).
3. Builds `ZsBootConfig` (b7 §4.2: `connect = { wsUrl, token, sessionId, takeover, serverBuild, sessionExpiresAt }` from step 2, `workspace = { id: workspaceId, paths: ["/workspaces/<repo>"] }` — `workspace.id` is the identity the client persists under (D1) —, `settingsJson`, `keymapJson`, `hostOs`) and the `ZsHost` (§4.6), then **`await start(JSON.stringify(config), assets, host)`** (three arguments, b7 §4.2; `assets` is the `Uint8Array` from step 1). `start()` is single-shot: a rejection `{ code, message }` is handled exactly like a `bootProgress("stopped", code)` (bullet 4), and every retry is a page reload (b7 §3.28 `:812`).
4. `host.bootProgress(stage, detail)` drives the overlay; `ready` dissolves it; `reconnecting` → phase `reconnecting`; `failed` → `error`; **`stopped` carries a `BootError` code as `detail`** (b7 §3.28 `close_code_detail`) and is mapped: `taken_over` (4001, also a stale epoch — b1 §4.4/b2 §7.19) → `taken-over` (offer "Take back" = `reconnect({ takeover: true })`); `session_busy` (4005) → `takeover-required`; `incompatible_server` (4002) → reload; `unauthorized` (4003) → `POST /session` then sign-in; `workspace_stopped` (our `409`, via `RefreshError::Stopped`) and `server_stopping` (D3: close 1001 "server going away" on SIGTERM/`STOPPING` — b7's code name predates D3's renumbering and covers the former 4004) → `stopped`, never a refresh; `reconnect_exhausted` (D2: 20 attempts, backoff capped at 8 s) → `error` with `retryable: true` and a "Reconnect" button (`reconnect()`); anything else → `error`. The optional `host.onClosed({ code, reason })` (accepted by b7 §3.21 `:622, :627`) receives the raw close frame and is used for telemetry only (`POST /client-errors` with `kind: "close"`), never for branching — the `detail` code is the contract. `host.onLifecycle(kind, seconds)` → toasts rendered by the shell (b4 deleted the in-canvas ones); kinds are **snake_case** exactly as b4 §3.16 `LifecycleKind::as_str()` and b7 §4.2 `ZsLifecycleKind` emit them (b4 risk 21): `idle_stop_in` shows "Keep alive" → `POST /keepalive`; `session_cap_in` shows a countdown and, when `seconds <= 30`, phase `restarting`; `stopping` → `stopped` (the wasm side snapshots dirty buffers into the client-state image and flushes it inside the 5 s window, D6 — the shell does nothing); `resumed` clears.
5. Top strip outside the canvas: workspace name, repo/branch, machine, region, Stop (`POST /stop`), Settings (link to dashboard, opens new tab), "Reconnect"/"Resume" (visible in `stopped`, `taken-over` and retryable `error` phases; calls `reconnect()`), "Open in desktop" → `zed://zs/w/{id}` (deep link parsing is out of scope; the link carries no token, desktop calls `/connect` itself; D7: the browser's workspace layout is not importable into desktop Zed, so the desktop opens the same repository with its own layout).
6. `visibilitychange` → `set_hidden(document.hidden)` and, when hidden, `flush_client_state()` (D7 trigger); `pagehide` → best-effort `flush_client_state()` (b7 §3.30: the 15 s dirty ticker and the `STOPPING` flush are the authoritative triggers, D7); `beforeunload` → `if (has_unsaved_changes()) event.preventDefault()` (b7's synchronous export, which replaces the `setDirty` host callback the previous revision requested). `fullscreenchange` → `navigator.keyboard?.lock(["KeyW","KeyT","KeyN","KeyQ","Tab"])` / `unlock()`. After a `taken_over`/`session_busy` close no flush is attempted (b7 §7.20).
7. `host.reportError(kind, message, stack)` → `POST /api/workspaces/{id}/client-errors` (editor cookie; the shell never learns the sandbox name).
8. Every 6 h and after any `401`: `POST /api/workspaces/{id}/session` to refresh `zs_editor`.
9. No `style` props anywhere in the SSR tree (CSP `style-src` without `'unsafe-inline'` blocks `style=""` attributes; nonces do not apply to attributes). Progress is a `data-progress` attribute plus `ref.current.style.setProperty("--zs-progress", …)` after mount (CSSOM writes are allowed). `data-phase` on the overlay root for Playwright.
10. `reconnect(opts: { takeover?: boolean; resume?: boolean } = {})` — the host `reconnect()` of D2, a connection **from scratch** (new options, not a redial, b1 §3.3 step 2): it writes `sessionStorage.zsNext = opts` and calls `location.reload()`; bullet 1 turns that into `connect("resume" | "open", takeover)`. A fresh boot attaches warm when the server still holds the epoch and is otherwise a fresh session (D3); resuming a stopped workspace goes through `/connect`'s `202` path. An in-place `reconnect()` export that re-dials without rebuilding the App is b7's follow-up (b7 §7.9) and needs no shell change when it lands. Unsaved buffers on this path: a stop is covered by the `STOPPING` snapshot (D6); takeover and exhaustion rely on the `beforeunload` guard (b1 §7.9).

### 3.27 `(site)` tree (new) – root layout #1 and thin dashboard pages

`app/(site)/layout.tsx` is the root layout for everything except `/w/*`: `<html>` with the `next/font` variables, `globals.css`, `<body><ClerkProvider>…</ClerkProvider></body>` (Clerk quickstart: "`ClerkProvider` goes inside `<body>`, not wrapping `<html>`"). `app/(site)/sign-in/[[...sign-in]]/page.tsx` renders `<SignIn />`, which asserts a `ClerkProvider` ancestor (§2). `(dashboard)/layout.tsx` adds nav + `<UserButton />`. Pages: `workspaces/page.tsx` (list with state, repo, branch, machine, last active, cost to date from `usage_ledger`), `workspaces/new/page.tsx` (installation → repo → branch/PR → machine → region → devcontainer detection banner; the create button sends an `Idempotency-Key`), `workspaces/[id]/page.tsx` (detail, ports, sessions, danger zone), `repos/[id]/page.tsx` (prebuild branches, default machine, idle timeout), `secrets/page.tsx`, `settings/page.tsx` (settings/keymap JSON editors + dotfiles), `usage/page.tsx`, `orgs/[id]/page.tsx` (allowed installations, network allowlist, spend cap, members – owner/admin), `audit/page.tsx` (own actions + org actions for admins), `admin/page.tsx` (force-stop/delete, flagged users; `requireOrgRole`). Each uses server actions that call the same `lib/*` functions as the route handlers (no HTTP hop). Not detailed further; they carry no protocol.

### 3.28 `app/(site)/page.tsx` (new, replaces `app/page.tsx:1-69`): `redirect("/workspaces")`. `app/layout.tsx` and `app/page.tsx` are deleted (§2).

### 3.29 Tests (new) – §6.

### 3.30 `scripts/fetch-editor-bundle.ts` (new) – bundle delivery

Vercel builds `apps/web` from git, so a bundle "dropped" into `public/editor/` by a separate CI job never reaches `next build`. The `prebuild` npm script runs this file: it reads `ZS_CLIENT_BUILD_ID`, downloads `editor/<build>.tar` from `ZS_EDITOR_BUNDLE_SOURCE` (a private Blob store via signed URL, or a GitHub Release asset) into `public/editor/<build>/` when absent, then downloads the previous `ZS_EDITOR_BUNDLES_KEEP - 1` builds listed in `editor/manifest.json` at the same source (mirrored to `public/editor/manifest.json`) so workspaces created on older images keep a matching bundle. Producer: b7 §6's nightly `web_bundle` CI job packs b7 §3.31's `<out_dir>/<build_id>/` as `editor/<build_id>.tar` and maintains `editor/manifest.json` (`{ "builds": ["<build_id>", …] }`, newest first) — the only writer of both. Files kept in `public/editor/<build>/`: `zed_web.js`, `zed_web_bg.wasm`, `zed-assets.tar`, `build.json` (b7 §3.31 step 7: `{ build_id, commit, wasm_bytes, wasm_brotli_bytes }`; the script asserts `build_id === <build>` — there is no separate `BUILD_ID` file). b7's `index.html`/`loader.js` (step 8) are the dev harness only: the script drops them on unpack and they are never served — `apps/web` implements the same loader contract in `zs-host.ts` (§3.26). Bundles are same-origin by necessity (`crossOriginIsolated`, §3.22).

### 3.31 `public/sw.js`, `app/manifest.ts` (new) – service worker and PWA (BUILD-SPEC §3.5 line 172, §3.6 line 185)

`sw.js` (scope `/w/`, `Service-Worker-Allowed: /w/`): on `install`, precaches `/editor/<build>/{zed_web.js,zed_web_bg.wasm,zed-assets.tar}` for the build named in the registration query (`/sw.js?build=<id>`); `fetch` handler answers only `GET /editor/*` from cache (cache-first; immutable) and **never** intercepts `/api/*`, `/w/*` documents or cross-origin requests; `activate` drops caches of builds no longer in `public/editor/manifest.json`. CSP: `worker-src 'self' blob:` already covers it. `app/manifest.ts` returns `{ name: "Zed Codespaces", start_url: "/workspaces", display: "standalone", scope: "/", icons }`; the editor page links it so the browser offers "install".

### 3.32 `packages/sdk/` (new) – shared contract (BUILD-SPEC §11.1 line 447)

`packages/sdk/src/index.ts` exports the zod schemas and `*View`/`ConnectInfo`/`SandboxManifest`/`ActivityReport` types from §4.2/§4.7 plus a thin `fetch`-based client (`createClient({ baseUrl, fetch })` with `workspaces.connect(id, input)` etc.). `apps/web` imports the schemas from it (`@zs/sdk`, pnpm workspace package); the desktop deep-link handler and Playwright share the same contract. `docs/contracts/fixtures/manifest.example.json` (D19; created by b8 §3.26 from §4.7, next to b8's JSON Schema `docs/contracts/sandbox-manifest.v1.json`) is the fixture both briefs test against; `tests/helpers/fixture.ts` reads it from the monorepo root and fails the suite loudly when it is missing, and `packages/sdk`'s `sandboxManifest` zod schema is what `tests/manifest.test.ts` parses it with.

## 4. New types and messages

### 4.1 Drizzle schema (`lib/schema.ts`)

```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, text, integer, bigint, boolean, timestamp, jsonb, numeric, bigserial, primaryKey, index, uniqueIndex } from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "pro", "team", "enterprise"]);
export const workspaceStateEnum = pgEnum("workspace_state", ["creating", "running", "stopping", "stopped", "rebuilding", "deleting", "error"]);
export const machineTypeEnum = pgEnum("machine_type", ["vcpu2", "vcpu4", "vcpu8", "vcpu32"]);
export const regionEnum = pgEnum("region", ["iad1", "sfo1", "cle1", "cdg1"]);
export const secretScopeEnum = pgEnum("secret_scope", ["user", "org", "repo"]);
export const settingsKindEnum = pgEnum("settings_kind", ["settings", "keymap", "dotfiles"]);
export const portVisibilityEnum = pgEnum("port_visibility", ["private", "public"]);
export const prebuildStatusEnum = pgEnum("prebuild_status", ["queued", "building", "ready", "failed", "deleted"]);
export const imageStatusEnum = pgEnum("image_status", ["none", "building", "ready", "failed"]);
export const membershipRoleEnum = pgEnum("membership_role", ["owner", "admin", "member"]);
export const subjectTypeEnum = pgEnum("subject_type", ["user", "org"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "sandbox", "system", "cron"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "open", "paid", "void", "uncollectible"]);
export const restoreKindEnum = pgEnum("restore_kind", ["fresh", "snapshot", "tarball"]);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),                         // Clerk user id
  githubId: bigint("github_id", { mode: "number" }),
  githubLogin: text("github_login"),
  email: text("email"),
  plan: planEnum("plan").notNull().default("free"),
  idleMinutesDefault: integer("idle_minutes_default").notNull().default(30),
  spendCapCents: integer("spend_cap_cents"),
  stripeCustomerId: text("stripe_customer_id"),
  flaggedAt: ts("flagged_at"),                         // abuse rule (§4.10); creation refused while set
  flagReason: text("flag_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [uniqueIndex("users_github_id_idx").on(t.githubId)]);

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),                         // Clerk org id
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  plan: planEnum("plan").notNull().default("team"),
  allowedInstallationIds: jsonb("allowed_installation_ids").$type<number[] | null>(),
  networkAllowlist: jsonb("network_allowlist").$type<string[] | null>(),
  spendCapCents: integer("spend_cap_cents"),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [uniqueIndex("orgs_slug_idx").on(t.slug)]);

export const memberships = pgTable("memberships", {
  orgId: text("org_id").notNull().references(() => orgs.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: membershipRoleEnum("role").notNull().default("member"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("memberships_user_idx").on(t.userId)]);

export const githubInstallations = pgTable("github_installations", {
  installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),         // "User" | "Organization"
  repositorySelection: text("repository_selection").notNull(), // "all" | "selected"
  ownerUserId: text("owner_user_id").references(() => users.id),
  orgId: text("org_id").references(() => orgs.id),
  suspendedAt: ts("suspended_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [index("gh_inst_owner_idx").on(t.ownerUserId), index("gh_inst_org_idx").on(t.orgId)]);

export const repos = pgTable("repos", {
  id: text("id").primaryKey(),                         // repo_…
  installationId: bigint("installation_id", { mode: "number" }).notNull().references(() => githubInstallations.installationId),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  private: boolean("private").notNull().default(true),
  devcontainerHash: text("devcontainer_hash"),
  imageRef: text("image_ref"),                         // zs-workspace-<owner>-<name>:<hash> once built (§6.3)
  imageStatus: imageStatusEnum("image_status").notNull().default("none"),
  prebuildBranches: jsonb("prebuild_branches").$type<string[]>().notNull().default([]),
  prebuildWarmCommand: text("prebuild_warm_command"),  // optional shell command handed to `zs-agent prebuild` as ZS_PREBUILD_WARM_CMD (b8 §3.16/§4.6; D14)
  defaultMachine: machineTypeEnum("default_machine").notNull().default("vcpu2"),
  idleMinutes: integer("idle_minutes"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("repos_github_id_idx").on(t.githubRepoId), uniqueIndex("repos_owner_name_idx").on(t.owner, t.name)]);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),                         // ws_… ; the JWT `ws` claim, ZsBootConfig.workspace.id and b1's workspace_id – the client's stable identity (D1). The JWT `sid` is per connect (sessions.last_connect_id), never this id
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  orgId: text("org_id").references(() => orgs.id),
  repoId: text("repo_id").notNull().references(() => repos.id),
  name: text("name").notNull(),
  branch: text("branch"),
  revision: text("revision"),                          // resolved commit sha
  gitRef: text("git_ref"),                             // "refs/pull/N/head" for PR workspaces (manifest repo.ref)
  pullRequest: integer("pull_request"),
  machine: machineTypeEnum("machine").notNull(),
  region: regionEnum("region").notNull(),
  sandboxName: text("sandbox_name").notNull(),         // immutable per generation
  previousSandboxName: text("previous_sandbox_name"),  // set by rebuild until the new generation is healthy (§4.8)
  sandboxGeneration: integer("sandbox_generation").notNull().default(1), // bumps on rebuild
  imageRef: text("image_ref").notNull(),
  serverBuild: text("server_build").notNull(),         // ZS_BUILD_ID of imageRef at create/rebuild (manifest.build, connect.serverBuild)
  clientBuild: text("client_build").notNull(),         // bundle under public/editor/ the page loads (§3.26)
  prebuildId: text("prebuild_id"),
  restoreKind: restoreKindEnum("restore_kind").notNull().default("fresh"),
  restoreBlobPathname: text("restore_blob_pathname"),  // rebuild tarball; cleared after the supervisor reports phase >= dotfiles
  state: workspaceStateEnum("state").notNull().default("creating"),
  stateReason: text("state_reason"),                   // "boot:<phase>" during boot, workflow error text on error
  audience: text("audience").notNull(),                // JWT aud; = sandboxName, rotatable to `${sandboxName}.${n}`
  sandboxTokenHash: text("sandbox_token_hash"),
  sandboxTokenGeneration: integer("sandbox_token_generation").notNull().default(0),
  supervisorCmdId: text("supervisor_cmd_id"),
  currentWsHost: text("current_ws_host"),              // host of domain(8443) for the current session
  currentSlotHosts: jsonb("current_slot_hosts").$type<Record<string, string>>(),   // proxy-slot port → host of domain(slot) for the current sandbox session (D8); null while stopped
  currentHealthHost: text("current_health_host"),      // host of domain(ZS_HEALTH_PORT)
  currentSandboxSessionId: text("current_sandbox_session_id"),
  sessionStartedAt: ts("session_started_at"),          // VM session start: 24 h cap, usage wall time
  sandboxExpiresAt: ts("sandbox_expires_at"),          // platform session timeout as last observed/extended (§4.10)
  workflowRunId: text("workflow_run_id"),              // in-flight lifecycle run, null when idle
  workflowRunStartedAt: ts("workflow_run_started_at"),
  lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  idleMinutes: integer("idle_minutes").notNull().default(30),
  installedExtensions: jsonb("installed_extensions").$type<string[]>().notNull().default([]),
  retentionUntil: ts("retention_until"),
  retentionWarnedAt: ts("retention_warned_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  lastStoppedAt: ts("last_stopped_at"),
  deletedAt: ts("deleted_at"),
}, (t) => [
  uniqueIndex("workspaces_sandbox_name_idx").on(t.sandboxName),
  index("workspaces_owner_state_idx").on(t.ownerUserId, t.state),
  index("workspaces_state_active_idx").on(t.state, t.lastActiveAt),
  index("workspaces_retention_idx").on(t.retentionUntil),
  index("workspaces_run_idx").on(t.workflowRunId),
]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),                         // ses_… ; internal (ledger/audit/takeover) – NOT the JWT sid, which is minted per connect (D1) and recorded below
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull().references(() => users.id),
  sandboxGeneration: integer("sandbox_generation").notNull(),
  sandboxSessionId: text("sandbox_session_id"),        // Vercel session id
  holderTabId: text("holder_tab_id").notNull(),        // sessionStorage id of the tab that holds the session (same tab reload → silent takeover)
  wsHost: text("ws_host").notNull(),
  clientBuild: text("client_build"),
  serverBuild: text("server_build"),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
  endReason: text("end_reason"),
  tokensMinted: integer("tokens_minted").notNull().default(0),
  lastConnectId: text("last_connect_id"),              // the last per-connect `sid` (con_…) minted for this row (D1); log correlation with b2's ServeLogRecord.sid and /health.session
}, (t) => [index("sessions_ws_started_idx").on(t.workspaceId, t.startedAt), uniqueIndex("sessions_open_idx").on(t.workspaceId).where(sql`ended_at IS NULL`)]);

export const prebuilds = pgTable("prebuilds", {
  id: text("id").primaryKey(),                         // pb_…
  repoId: text("repo_id").notNull().references(() => repos.id),
  branch: text("branch").notNull(),
  commit: text("commit").notNull(),
  region: regionEnum("region").notNull(),
  imageRef: text("image_ref").notNull(),
  sandboxName: text("sandbox_name"),                   // pb-… builder; a sandbox principal (§3.12)
  sandboxTokenHash: text("sandbox_token_hash"),
  sandboxTokenGeneration: integer("sandbox_token_generation").notNull().default(0),
  snapshotId: text("snapshot_id"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  status: prebuildStatusEnum("status").notNull().default("queued"),
  error: text("error"),
  workflowRunId: text("workflow_run_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  readyAt: ts("ready_at"),
  deletedAt: ts("deleted_at"),
}, (t) => [index("prebuilds_repo_branch_idx").on(t.repoId, t.branch, t.createdAt), uniqueIndex("prebuilds_sandbox_name_idx").on(t.sandboxName)]);

export const forwards = pgTable("forwards", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  port: integer("port").notNull(),
  visibility: portVisibilityEnum("visibility").notNull().default("private"),
  label: text("label"),
  url: text("url"),                                    // public: https://<domain(port)>; private: the control plane /open link (D8)
  slot: integer("slot"),                               // private forwards only: the proxy slot (one of ZS_PROXY_SLOTS) the supervisor binds to `port` (D8); null for public
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.port] }), uniqueIndex("forwards_slot_idx").on(t.workspaceId, t.slot)]);   // a slot is held by at most one forward per workspace; NULLs do not collide

export const secrets = pgTable("secrets", {
  id: text("id").primaryKey(),                         // sec_…
  scope: secretScopeEnum("scope").notNull(),
  scopeId: text("scope_id").notNull(),                 // userId | orgId | repoId
  name: text("name").notNull(),                        // SECRET_NAME, not ZS_*, not RESERVED_SECRET_NAMES (§3.17)
  ciphertext: text("ciphertext").notNull(),            // "v1:<kv>:<iv>:<ct>:<tag>"
  keyVersion: integer("key_version").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("secrets_scope_name_idx").on(t.scope, t.scopeId, t.name)]);

export const settingsDocs = pgTable("settings_docs", {
  userId: text("user_id").notNull().references(() => users.id),
  kind: settingsKindEnum("kind").notNull(),
  content: text("content").notNull(),                  // JSONC for settings/keymap; JSON { repoUrl, installCommand } for dotfiles
  version: integer("version").notNull().default(1),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.kind] })]);

export const usageLedger = pgTable("usage_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  subjectType: subjectTypeEnum("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  period: text("period").notNull(),                    // "YYYY-MM" UTC
  workspaceId: text("workspace_id"),
  sandboxSessionId: text("sandbox_session_id"),
  source: text("source").notNull(),                    // "stop" | "snapshot_daily" | "adjustment"
  vcpuSeconds: numeric("vcpu_seconds", { precision: 18, scale: 3 }).notNull().default("0"),
  provisionedGbHours: numeric("provisioned_gb_hours", { precision: 18, scale: 6 }).notNull().default("0"),
  egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
  snapshotGbDays: numeric("snapshot_gb_days", { precision: 18, scale: 6 }).notNull().default("0"),
  costCents: integer("cost_cents").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  stripePushedAt: ts("stripe_pushed_at"),
  recordedAt: ts("recorded_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("usage_idem_idx").on(t.idempotencyKey), index("usage_subject_period_idx").on(t.subjectType, t.subjectId, t.period)]);

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),                         // inv_…
  subjectType: subjectTypeEnum("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  period: text("period").notNull(),
  stripeInvoiceId: text("stripe_invoice_id"),
  amountCents: integer("amount_cents").notNull(),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("invoices_subject_period_idx").on(t.subjectType, t.subjectId, t.period)]);

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorType: actorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),                    // "workspace.create" | "workspace.stop" | "secret.put" | "git_token.issue" | "admin.stop" | …
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ip: text("ip"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("audit_target_idx").on(t.targetType, t.targetId, t.createdAt), index("audit_actor_idx").on(t.actorId, t.createdAt)]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  provider: text("provider").notNull(),                // "github" | "clerk" | "stripe"
  deliveryId: text("delivery_id").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.provider, t.deliveryId] })]);

export type User = typeof users.$inferSelect; export type Workspace = typeof workspaces.$inferSelect; export type Prebuild = typeof prebuilds.$inferSelect; /* … one alias per table */
export type WorkspaceState = (typeof workspaceStateEnum.enumValues)[number];
export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];
```

`settings_docs.content` is `text` rather than the `json` the spec lists (§7.2 line 335) because Zed's `settings.json` and `keymap.json` are JSONC with comments; storing them as JSON would strip user comments. The manifest carries them as JSON **strings** (`serde_json::Value::String`), see §4.7.

### 4.2 Route contracts

Common: user routes require `requireViewer()` (Clerk; workspace-scoped routes also accept the editor cookie, §3.8); errors are `{ error: { code, message, details? } }`; `401 unauthenticated`, `404 not_found` (also for foreign workspaces), `400 invalid_body` with zod issues, `409 conflict`, `402 plan_limit`, `423 locked`, `429 rate_limited` (with `Retry-After`), `413 payload_too_large`, `500 internal`. IDs in paths are validated with `^(ws|repo)_[0-9A-HJKMNP-TV-Z]{20}$`; sandbox names with `^(sb|pb)-[a-z0-9-]{1,60}$`.

```ts
// POST /api/workspaces   (rate limit user.workspaces.create; Idempotency-Key honoured via idempotent(); 403 account_flagged when users.flagged_at set)
export const createWorkspaceInput = z.object({
  repo: z.union([z.object({ repoId: z.string() }), z.object({ installationId: z.number().int(), owner: z.string(), name: z.string() })]),
  ref: z.union([z.object({ branch: z.string() }), z.object({ pullRequest: z.number().int().positive() }), z.object({ revision: z.string().regex(/^[0-9a-f]{7,40}$/) })]).optional(),
  machine: z.enum(["vcpu2", "vcpu4", "vcpu8", "vcpu32"]).optional(),
  region: z.enum(["iad1", "sfo1", "cle1", "cdg1"]).optional(),     // default nearestRegion(req)
  idleMinutes: z.number().int().min(5).max(240).optional(),
  name: z.string().min(1).max(64).optional(),
  orgId: z.string().optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInput>;
// → 202 { workspace: WorkspaceView, runId: string }   (start(createWorkspace, [{ workspaceId, userId }]) after stepReserveWorkspace inline)
// errors: 402 plan_limit (workspaces, machine not in plan – vcpu32 below enterprise –, spend cap), 403 installation_not_allowed (org policy), 404 repo_not_found, 409 image_building (repo image not ready and no base fallback allowed by org)

export interface WorkspaceView { id; name; repo: { id; owner; name; defaultBranch }; branch; revision; pullRequest; machine; region; state; stateReason; workflowRunId: string | null; idleMinutes; serverBuild; clientBuild; lastActiveAt; createdAt; lastStoppedAt; retentionUntil; costToDateCents; forwards: ForwardView[] }
// GET /api/workspaces → 200 { workspaces: WorkspaceView[] }   (owner or org member; excludes deleted)
// GET /api/workspaces/{id} → 200 { workspace: WorkspaceView }    (editor cookie accepted – the shell polls this while resuming)
// PATCH /api/workspaces/{id} { name?, idleMinutes? } → 200 { workspace }
// DELETE /api/workspaces/{id} → 202 { runId }  (start(deleteWorkspace)); 409 workspace_busy only while workflowRunId is set AND stepRunStatus(runId) is pending/running (a terminal run no longer blocks)

// POST /api/workspaces/{id}/connect   (Clerk or editor cookie; rate limit user.connect; maxDuration 60)
export const connectInput = z.object({ takeover: z.boolean().default(false), clientBuild: z.string().optional(), reason: z.enum(["open", "reconnect", "resume"]).default("open"), tabId: z.string().min(8).max(64) });
// 200 ConnectInfo (§3.18) when state === running, workflowRunId null and the 8445 health probe answers ready/degraded with server.running (fast path, no workflow); sessionId is a fresh con_… id on every call and equals the token's `sid` (D1) – the client keys nothing on it
// 202 { status: "resuming", runId } when state === stopped and reason ∈ {open, resume}: startLifecycle(connectWorkspace) and, if the run has not finished within 45 s, answer 202 (the shell/host polls GET /api/workspaces/{id})
// 409 workspace_stopped when reason === "reconnect" and state ∈ {stopped, stopping} – a reconnecting tab must never resume a VM (idle stop must end at "stopped, click to resume", Appendix B line 588); the shell turns it into a `{ code: "stopped" }` rejection of refreshConnectInfo() → b1 RefreshError::Stopped, which short-circuits the reconnect budget (D2)
// 409 { error: { code: "session_active", holder: { startedAt } } } when another open sessions row exists for this generation with a different (userId, tabId) and takeover=false (same user + same tabId → silent reuse/takeover)
// 409 client_build_mismatch { serverBuild, clientBuild } when clientBuild is provided and differs from workspace.clientBuild (client must reload)
// 423 workspace_busy for creating|stopping|rebuilding|deleting or while a run is in flight; 410 workspace_deleted; 500 sandbox_unhealthy when the health probe fails 3× (the sweep reconciles the row, §4.10)

// POST /api/workspaces/{id}/session → 204 + Set-Cookie zs_editor (Clerk or a still-valid editor cookie)
// POST /api/workspaces/{id}/stop → 202 { runId } | 200 { state: "stopped" } when already stopped
// POST /api/workspaces/{id}/rebuild { fromImage?: boolean } → 202 { runId }; 409 when running a lifecycle run
// POST /api/workspaces/{id}/keepalive → 200 { keptAliveUntil: string }  (SET zs:keepalive:<ws> = now, TTL idleMinutes; sweep and the activity directive treat it as activity)
// GET /api/workspaces/{id}/ports → 200 { ports: ForwardView[]; listening: number[] (from keys.listening, written by the activity route from the ping's listening[]); slotsFree: number (D8: 4 − private forwards) }
// POST /api/workspaces/{id}/ports { port: 1..65535 ∉ infraPorts(), visibility, label? } → 200 { forward: ForwardView }
//   public: url = https://<domain(port)> when port ∈ pool, else after stepUpdatePorts (does not resume a stopped sandbox: 409 workspace_not_running); slot = null
//   private: slot = allocateSlot(db, id, port) inside the insert transaction (D8: one of the four proxy slots; 409 no_free_slot when all four are held – unforward one first); url = privateForwardUrl(id, port) = `${controlPlaneUrl()}/api/workspaces/{id}/ports/{port}/open`; the supervisor learns { port, slot } from the next activity directive's forwards[] (or from its own POST /ports answer) and binds the slot's proxy to `port`
// GET /api/workspaces/{id}/ports/{port}/open (Clerk; browser navigation) → 303 authRedirect(slotHost(ws, forward.slot), token) = `https://<slot-host>/__zs/auth?zs_port_token=<jwt>&next=/` with jwt = mintPortBootstrapToken({ userId, workspaceId: id, audience: ws.audience, port }) (D8; b8 §3.10/§4.5: ES256, aud = portAudience(audience), sid = "port:<port>", exp = iat + 600; the proxy verifies it with the manifest's public keys and sets its own `zs_port_session` HMAC cookie for that slot host). 404 when no forward for that port or the forward is public; 409 workspace_not_running (no slot hosts while stopped).
// DELETE /api/workspaces/{id}/ports?port=N → 204 (frees the slot)
// POST /api/workspaces/{id}/client-errors { build, kind: "panic" | "boot" | "error" | "perf" | "close", message (≤ 4 KiB), stack? (≤ 64 KiB), marks?: Record<string, number> } → 202   (editor cookie or Clerk; rate limit user.client-errors; forwarded to ZS_LOG_SINK_URL with workspaceId + sandboxName; kind "close" carries onClosed's { code, reason } for telemetry, §3.26 bullet 4)
export interface ForwardView { port: number; visibility: "private" | "public"; label: string | null; url: string | null; slot: number | null }   // slot: the proxy slot of a private forward (D8; b8 binds ProxyConfig.bound_port = port on that slot)
// (The previous revision's PUT /api/workspaces/{id}/extensions is gone: installed extensions reach the control plane through the supervisor's relay, POST /api/sandboxes/{name}/extensions below – D18/D19; b7 declined the onExtensionsChanged host callback.)

// GET /api/repos → 200 { installations: [{ installationId, accountLogin, accountType, repos: RepoView[] }] } (live from GitHub, cached 60 s in kv per user)
// POST /api/repos { installationId, owner, name } → 200 { repo: RepoView } (registers/refreshes repos row incl. devcontainer hash)
// GET /api/repos/{id}/prebuilds → 200 { prebuilds: PrebuildView[] }
// POST /api/repos/{id}/prebuilds { branch } → 202 { runId } (dedupe: 200 { prebuild } when a queued/building one exists for the same branch+head)
// GET|PUT /api/me/settings  → { content: string; version: number }  PUT body { content: string (≤ 512 KiB, must parse as JSONC), version?: number } → 409 version_conflict on stale version
// GET|PUT /api/me/keymap    → same
// GET|PUT /api/me/dotfiles  → { repoUrl: string | null; installCommand: string | null }
// GET /api/secrets?scope=user|org|repo&scopeId=… → 200 { secrets: [{ name, scope, scopeId, updatedAt }] } (never values)
// PUT /api/secrets { scope, scopeId, name, value (≤ 64 KiB) } → 204 ; 400 invalid_name | reserved_name (§3.17); DELETE /api/secrets { scope, scopeId, name } → 204   (rate limit user.secrets)
// POST /api/admin/workspaces/{id} { action: "stop" } → 202 { runId }; DELETE → 202 { runId }   (requireOrgRole owner|admin; audit admin.stop / admin.delete)
```

Sandbox-facing (bearer `zsb_…`, `requireSandbox` → `SandboxPrincipal`; rate-limited per sandbox name; every request carries `X-ZS-Build` (logged, never trusted) and, from preview deployments, `x-vercel-protection-bypass` from `ZS_BYPASS_SECRET` (D18) — Vercel strips it before the route sees it). These shapes are the contract b8 consumes (b8 header; D18/D19); the request parsers also accept the field names the b8 revision on disk sends today, so b8 converges by changing only what it *reads* (§9):

```ts
// GET  /api/sandboxes/{name}/manifest → 200 SandboxManifest (§4.7)                                             limit 60/min
// POST /api/sandboxes/{name}/git-token { host?: "github.com", protocol?: "https", path?: "owner/repo" | "owner/repo.git" } (an empty body `{}` – what b8's credential path sends today, b8:330 – means "the workspace repository") → 200 { username: "x-access-token", token, expiresAt: string /* RFC 3339, Date.toISOString() – b8 parse_rfc3339_utc (:693) */ }; 404 host_unsupported for anything but github.com; installation token scoped to repositoryIds [repo.githubRepoId] (path, when present, must name that repo → else 403 repo_not_allowed); prebuild principals get the prebuild's repo. Dotfiles (b8 §7 item 18): when `path` names the owner's dotfiles.repoUrl repository (any installation), the response is the owner's GitHub OAuth token from githubUserToken(ownerUserId) with username "x-access-token" – this needs `credential.useHttpPath = true` on b8's side so git sends `path` (§7 item 7j); without it dotfiles clones fall back to installation scope as today.    limit 30/min; audit "git_token.issue"
// POST /api/sandboxes/{name}/ports { port, visibility: "public" | "private", label?: string | null, action?: "forward" | "unforward" } → 200 { url: string | null, visibility, slot: number | null }; action "unforward" (b8:308) behaves exactly like DELETE below and answers 204. public outside the pool → stepUpdatePorts on the running sandbox; private → allocateSlot (D8), 409 { error: { code: "no_free_slot", message } } when the four slots are held – b8 relays the non-2xx and b4's ForwardPort surfaces `message` to the client (b4 §4.2)    limit 30/min
// DELETE /api/sandboxes/{name}/ports/{port} → 204 (frees the slot)
// POST /api/sandboxes/{name}/activity ActivityReport → 200 ActivityDirective (§3.25)                              limit 10/min (ping every 30 s → 2/min nominal)
// POST /api/sandboxes/{name}/extensions { installed: string[] (each ^[a-z0-9][a-z0-9_-]{0,63}$, ≤ 200) } → 204   the relay of the server's POST $SUPERVISOR_URL/extensions (b4 §4.2, D18) → UPDATE workspaces SET installed_extensions (D19; prebuild principals: ignored with 204 – the list lands in the snapshot)    limit 30/min
// POST /api/sandboxes/{name}/logs → 204 (any 2xx is success for b8, :333). Two bodies are accepted (≤ 256 KiB and ≤ 200 lines either way; 413 above): `Content-Type: application/json` → LogBatch below; `Content-Type: application/x-ndjson` (what b8 §3.6 encode_ndjson sends today) → one LogLine { ts, level, target, msg, sid?, fields? } per line, mapped to LogBatch entries with source = target    limit 120/min
// POST /api/sandboxes/{name}/client-errors { build, kind: "server_crash" | "boot", message, stack?, marks? } → 202  (supervisor-originated crash reports; the browser uses /api/workspaces/{id}/client-errors)

export const activityReport = z.object({                 // D13: lastInputAt, busy, phase, cpuBusyPct are the contract; the rest is tolerated (b8 ActivityPing on disk, :313-318)
  lastInputAt: z.number().int().nullable().optional(),   // unix ms – the server's /health.last_input_at (b2 is_input_envelope; replays and terminal acks excluded, D20)
  sessionActive: z.boolean(),
  busy: z.boolean(),                                     // D13: a lifecycle command (dotfiles/postCreate/postStart/postAttach), clone or restore is running
  phase: z.enum(["manifest", "restore", "clone", "server_starting", "dotfiles", "post_create", "post_start", "warm", "ready"]),   // D13; b8 §3.8 Phase (snake_case; `warm` = the prebuild LSP warm-up, D14 — reported by b8 §4.4 during `zs-agent prebuild`)
  cpuBusyPct: z.number().min(0).max(100).nullable().optional(),   // D18: b8 reports it; the abuse rule (§4.10) is inert while absent
  listening: z.array(z.object({ port: z.number().int(), pid: z.number().int().optional(), process: z.string().optional() })).max(256).optional(),   // b8 ListeningPortWire; feeds keys.listening
  sid: z.string().nullable().optional(),
  serverBuild: z.string().optional(), supervisorBuild: z.string().optional(), uptimeSeconds: z.number().int().optional(),   // b8's names today
  serverUptimeSecs: z.number().int().optional(), agentUptimeSecs: z.number().int().optional(),
  status: z.enum(["booting", "ready", "degraded", "stopping"]).optional(),
});
export interface ActivityDirective { idleStopAt: number | null; sessionCapAt: number | null; stop: boolean; forwards: ForwardView[]; serverTime: number }   // unix ms; forwards is authoritative for the supervisor's in-memory list (b8:434)
export const logEntry = z.object({ ts: z.number(), level: z.string(), source: z.string(), msg: z.string(), sid: z.string().optional(), fields: z.record(z.unknown()).optional() });
export const logBatch = z.object({ workspaceId: z.string().optional(), sandboxName: z.string().optional(), sessionId: z.string().optional(), build: z.string().optional(), entries: z.array(logEntry).max(200) });   // identity fields are optional: the bearer already names the sandbox
export const logLineNdjson = logEntry.omit({ source: true }).extend({ target: z.string() });   // b8 §3.6 LogLine; target → source
export const installedExtensions = z.object({ installed: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(200) });
```

Webhooks and cron:

```ts
// POST /api/webhooks/github  – verifyGithubWebhook; dedupe on x-github-delivery via webhook_deliveries; 200 { handled: boolean }
//   installation (created|deleted|suspend|unsuspend), installation_repositories (added|removed) → github_installations/repos rows
//   push { ref: "refs/heads/<b>", after } → if b ∈ repo.prebuildBranches: withLock(`prebuild:${repoId}:${b}`, 60_000, () => start(prebuild, [{ repoId, branch: b, commit: after }]))
//   pull_request opened|synchronize → no-op v1 (create-from-PR resolves the head at create time)
// POST /api/webhooks/clerk   – `POST(req: NextRequest)`; verifyWebhook(req) from "@clerk/nextjs/webhooks"; user.created|updated → upsert users (githubId from external_accounts[provider === "oauth_github"].provider_user_id); user.deleted → soft-delete + start(deleteWorkspace) per workspace; organization.* / organizationMembership.* → orgs/memberships
// POST /api/webhooks/stripe  – stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET); customer.subscription.* → users/orgs.plan; invoice.finalized|paid → invoices.stripeInvoiceId/status
// GET  /api/cron/sweep, /api/cron/gc, /api/cron/snapshot-usage, /api/cron/invoice – `Authorization: Bearer ${CRON_SECRET}` else 401 (Vercel sends it automatically); 200 { ran: true, … } ; 200 { ran: false, reason: "locked" } when another instance holds the lock
```

### 4.3 Connect and health types (`lib/connect.ts`) – see §3.18. `ActivityDirective` – see §3.25/§4.2.

### 4.4 Secrets envelope

`v1:<keyVersion>:<iv:b64url 12B>:<ct:b64url>:<tag:b64url 16B>`; key = `ZS_SECRETS_KEYS[keyVersion]`; AAD = `secretAad(scope, scopeId, name)`. Rotation: add the new key under a higher version, set `ZS_SECRETS_ACTIVE_KEY_VERSION`, run `pnpm zs:rotate-secrets` (script `scripts/rotate-secrets.ts`: `rotateEnvelope` for every `secrets` row with `key_version < active`; nothing per workspace is encrypted any more since the port-session HMAC secret left with D8/b8 §3.10), then drop the old key.

### 4.5 Usage math (`lib/usage.ts`)

```ts
export interface SessionUsageInput { machine: MachineType; startedAt: Date /* workspaces.session_started_at */; endedAt: Date; activeCpuMs: number; egressBytes: number }
export interface SessionUsage { vcpuSeconds: number; provisionedGbHours: number; egressBytes: number }
export function sessionUsage(i: SessionUsageInput): SessionUsage;
// vcpuSeconds = activeCpuMs / 1000 (Vercel's "Active CPU" already accounts CPU time, not wall time)
// provisionedGbHours = MACHINES[machine].memoryGb × max(wallMs, 60_000) / 3_600_000   (1-minute minimum, pricing page); wall = VM session, so the idle tail after the last tab closes is billed
export function snapshotGbDays(sizeBytes: number, days: number): number;   // sizeBytes / 1e9 × days
export interface PriceTable { activeCpuCentsPerHour: number; memoryCentsPerGbHour: number; egressCentsPerGb: number; snapshotCentsPerGbMonth: number; margin: number }
export const VERCEL_LIST_IAD1: PriceTable = { activeCpuCentsPerHour: 12.8, memoryCentsPerGbHour: 2.12, egressCentsPerGb: 15, snapshotCentsPerGbMonth: 8, margin: 1 };   // pricing page 2026-08-21
export function priceCents(u: SessionUsage & { snapshotGbDays?: number }, p: PriceTable): number;  // round half up at the end, margin applied once
export function periodOf(d: Date): string;   // "YYYY-MM" in UTC
export function costToDate(rows: Array<{ costCents: number }>): number;
```

### 4.6 Browser host (`app/(editor)/w/[id]/zs-host.ts`) – b7 §4.2, verbatim

b7 §4.2 (`:945-978`) is the contract; the shell implements `ZsHost` and passes it as the **third** argument of `start(configJson, assets, host)`:

```ts
import type { ZsBootConfig, ZsHost, ZsLifecycleKind, ZsBootStage } from "@zs/sdk/zed-web";   // copied from b7 §4.2, single source in packages/sdk
// export interface ZsBootConfig { buildId: string; connect: { wsUrl: string; token: string; sessionId: string; takeover?: boolean; serverBuild?: string; sessionExpiresAt?: string }; workspace: { id: string; paths: string[] }; settingsJson?: string; keymapJson?: string; backend?: "auto" | "webgpu" | "webgl"; hostOs?: "mac" | "windows" | "linux" }
// export type ZsLifecycleKind = "idle_stop_in" | "session_cap_in" | "stopping" | "resumed";   // b4 §3.16 LifecycleKind::as_str() – snake_case (b4 risk 21)
// export interface ZsHost { bootProgress(stage: ZsBootStage, detail: string): void; refreshConnectInfo(): Promise<ZsBootConfig["connect"]>; saveDocument(kind: "settings" | "keymap", json: string): Promise<void>; reportError(kind: "panic" | "boot", message: string, stack: string): void; onLifecycle(kind: ZsLifecycleKind, seconds: number): void }
// exports of zed_web.js: start(configJson: string, assets: Uint8Array, host: ZsHost): Promise<void>; flush_client_state(): Promise<void>; set_hidden(hidden: boolean): void; has_unsaved_changes(): boolean; build_id(): string
export function createHost(shell: ShellController): ZsHost & { onClosed(info: { code: number; reason: string }): void };
// bootProgress(stage, detail)         → ShellPhase (§3.26 bullet 4; "stopped" carries a BootError code in `detail`)
// refreshConnectInfo()                → connect("reconnect") with 5-min polling through 202/423; resolves { wsUrl, token, sessionId (fresh per call, D1), serverBuild, sessionExpiresAt }; rejects { code: "stopped" } on 409 workspace_stopped (→ b1 RefreshError::Stopped, terminal, D2) and { code: "unauthorized" } after a failed /session re-mint (→ RefreshError::Unauthorized, terminal); any other failure rejects { code: "unavailable" } (→ RefreshError::Other, retried by b1 with backoff, ≤ 20 attempts)
// saveDocument(kind, json)            → debounced PUT /api/me/settings | /api/me/keymap (editor cookie); rejects on 409 version_conflict so the wasm side can surface it
// reportError(kind, message, stack)   → POST /api/workspaces/{id}/client-errors
// onLifecycle(kind, seconds)          → the shell's toasts and the "Keep alive" button (§3.26 bullet 4)
// onClosed({ code, reason })          → telemetry only (client-errors kind "close"); optional on the wasm side (b7 §3.21 :622)
```

The host additions the previous revision asked b7 for were decided in b7 §3.21 (`:622-627`): **`onClosed` accepted** as an optional callback (b7 emits it from `connect::observe` next to the `stopped` progress event); **`onLifecycle` became part of the base contract** with snake_case kinds; **`keepAlive`/`stop` declined** (no wasm-side caller in v0 — both affordances live in the shell, BUILD-SPEC §7.6); **`setDirty` declined** in favour of the synchronous `has_unsaved_changes()` export the `beforeunload` handler calls; **`onExtensionsChanged` declined** (installed-extension reporting is supervisor → control plane, D18/D19, and `extensions_ui` is not wired on wasm in v0); **`openExternal` declined** (`gpui_web` already opens URLs with `window.open`). No `window.__zs` global is assumed; the two globals the shell *sets* before `start` are `__zsBindgenShimUrl` (b7 §3.30) and — read, not set — `__zsCallCtors` from b7's glue patch. Hidden tabs call `set_hidden(true)`, which shortens the client-state interval to 5 s (b4 §3.7, D7), and simply stop receiving `requestAnimationFrame` (BUILD-SPEC §3.6 "Visibility").

### 4.7 Sandbox manifest (`GET {ZS_CONTROL_PLANE_URL}/api/sandboxes/{name}/manifest`; b8 §3.4/§4.1 consume it, the JSON Schema and fixture live in `docs/contracts/` – b8 §3.26, D19)

```ts
export interface SandboxManifest {                     // camelCase = b8 Manifest (serde rename_all); unknown extra fields are ignored by b8; every b8 validate() rule that survives is kept (version, identity cross-check, repo dir under ZS_WORKSPACES_DIR, ≥ 1 PEM, ports ∉ infra set)
  version: 1;
  workspaceId: string;                                 // prebuild principals: the prebuild id (b8 uses it only for logs); cross-checked against ZS_WORKSPACE_ID (b8:249)
  sandboxName: string;                                 // cross-checked against ZS_SANDBOX_NAME
  sandboxGeneration: number;                           // workspaces.sandbox_generation (b8 reads it today, :204)
  userId: string;                                      // owner; "system" for prebuilds
  build: string;                                       // workspaces.server_build (ZS_BUILD_ID of the image; mismatch → b8 health "degraded"); equal at create to the image's `ZS_BUILD_ID`, which is what b8 actually passes as `serve --client-build` (b8 §4.6: from the image `ENV`, not from this field); a workspace's bundle and image are one build id (§3.26), and a swapped image only marks b8's health `degraded` (b8 §3.4)
  region: Region;
  repo: { owner: string; name: string; cloneUrl: string; defaultBranch: string; revision: string /* branch name, or sha when pinned */; depth: number /* 0 = full; 0 whenever revision is a sha or ref is set */; ref?: string /* "refs/pull/N/head" – D18: b8 fetches that ref before checkout */ };
  workspaceDir: string;                                // `/workspaces/${repo.name}` (b8 repo.path)
  restore: { tarballUrl: string; sha256: string | null } | null;   // rebuild only: presignUrl(issueSignedToken({ pathname, operations: ["get"], validUntil: +1 h }), { operation: "get", access: "private" }) – minted on every manifest fetch, never stored; b8 streams the URL directly (no bearer); the archive is D9's `/workspaces` + `$HOME/.local/share/zed`, extracted at `/`
  dotfiles: { repoUrl: string; installCommand: string | null } | null;
  env: Record<string, string>;                         // NON-secret env: ZS_WORKSPACE_ID, ZS_REGION, devcontainer remoteEnv literals; values are visible in the manifest
  secretNames: string[];                               // names only; values arrived as runCommand env of zs-agent start/resume (§3.18)
  jwt: { issuer: string; audience: string; portAudience: string /* `${audience}/ports` – the aud of private-port bootstrap tokens (§3.12); b8 hands it to BootstrapVerifier::new, §7 item 7h */; publicKeys: string[] /* SPKI PEMs, active first */ };
  forwards: Array<{ port: number; visibility: "public" | "private"; label: string | null; url: string | null; slot: number | null }>;   // same shape as ForwardView (§4.2) and the nullable `forwards.url` column (§4.1); b8 §3.4 models `url: Option<String>`. private: url = /api/workspaces/{id}/ports/{port}/open and slot = the proxy slot to bind to `port` (D8); public: url = https://<domain(port)>, slot null; url is null while the workspace is stopped and for a public forward outside the pool until stepUpdatePorts has run
  proxySlots: number[];                                // D8: the four slot ports declared at sandbox create (ZS_PROXY_SLOTS); b8 runs one proxy per slot with ProxyConfig.bound_port taken from forwards[].slot, and treats them as infra ports
  portPool: number[];
  idle: { minutes: number };
  session: { id: string /* Vercel sandbox session id */; startedAt: number /* unix ms */; capAt: number /* startedAt + ZS_SESSION_CAP_MS */; resumed: boolean /* informational: b8 decides `resumed` from its first-boot.done marker (:726) */ };
  devcontainer: { configHash: string } | null;         // the supervisor reads devcontainer.json from the clone itself (b8 §3.4/§3.14; the hash is informational)
  settings: { settings: string; keymap: string } | null;   // JSONC document TEXT as JSON strings (serde_json::Value::String) – D18: b8's write_settings writes them verbatim (b8:750-753)
  logs: { flushIntervalSecs: 5; maxBatch: 200; maxBatchBytes: 262144 };   // match b8 §3.6 constants; b8 may keep its own constants and ignore these
  activity: { intervalSecs: 30 };
  allowedOrigins: string[];                            // [controlPlaneUrl()] → one `serve --allowed-origin` each (D5; b2 CORS for /files, /extensions/*, /health)
  extensions: string[];                                // workspaces.installed_extensions → b8 POST /control/extensions { install } at startup (D5) – the reinstall path after a rebuild; kept current by the relay (D18/D19)
  prebuild?: { id: string; branch: string; commit: string };   // present for pb- principals: clone + postCreate + ZS_PREBUILD_WARM_CMD, then exit 0 (§4.8 prebuild; D14: b8 owns `zs-agent prebuild`)
}
```

There is no `portSessionSecret` any more (D8/b8 §3.10: the proxy's cookie key is per boot and in memory; the bootstrap token is verified with `jwt.publicKeys`). `tests/manifest.test.ts` deserialises the emitted document with the fixture rules (`session.capAt > session.startedAt`, forward/pool ports ∉ `infraPorts()`, `proxySlots.length === 4`, ≥ 1 PEM, camelCase keys, no secret value substring, `jwt.portAudience === jwt.audience + "/ports"`, private forwards carry a `slot`) and parses `docs/contracts/fixtures/manifest.example.json` (D19) with the same `sandboxManifest` zod schema from `packages/sdk`; b8's `manifest.rs` tests (`example_manifest_parses`, `fixture_validates_against_schema`) read the same file.

### 4.8 Workflows (`workflows/*.ts`) – step-by-step

All `"use workflow"` functions take one serializable object and return one; every SDK call is inside a `"use step"` function from §3.19 (default 3 retries; `FatalError` for user-visible failures; `RetryableError` with `retryAfter` for `image_not_ready`). Every body ends with `stepFinishRun` on both paths (§3.20); the pseudocode below omits the boilerplate `try/catch/finally`.

```ts
// create-workspace.ts
export async function createWorkspace(input: { workspaceId: string; userId: string }): Promise<{ ok: true }> {
  "use workflow";
  const ws = await stepLoadWorkspace(input.workspaceId);
  const image = await stepPickImage(ws.id);                                    // snapshot (fresh prebuild) | image
  const created = await stepCreateSandbox({                                    // image_not_ready → RetryableError(retryAfter "20s"); quota/not_found → FatalError → finally sets state error
    name: ws.sandboxName, region: ws.region, vcpus: MACHINES[ws.machine].vcpus,
    ports: dedupe([ZS_RPC_PORT, ...proxySlots(), ZS_HEALTH_PORT, ...portPool()]), timeoutMs: ZS_SESSION_TIMEOUT_MS,   // D8: the four proxy slots are declared at create (never updated later); the RPC and health listeners likewise
    image: image.kind === "image" ? image.image : undefined,
    source: image.kind === "snapshot" ? { type: "snapshot", snapshotId: image.snapshotId } : undefined,   // never a git source: the supervisor clones with the credential helper (b8 §3.14, risk 2); no GitHub token ever enters workflow state
    env: { ZS_WORKSPACE_ID: ws.id, ZS_SANDBOX_NAME: ws.sandboxName, ZS_REGION: ws.region },   // identity only; ZS_BUILD_ID comes from the image; no secrets, no tokens
    networkPolicy: orgAllowlist ?? "allow-all",
    tags: { zs: envTag(), ws: ws.id, owner: input.userId },                     // ≤ 5 tags; `zs: <env>` is the ONE tag gc filters on (Sandbox.list allows a single tag filter)
    snapshotExpirationMs: ZS_RETENTION_DAYS × 86_400_000, keepLastSnapshots: 1,
  });
  await stepSetState(ws.id, "creating", "boot:manifest", { currentWsHost: created.host8443, currentSlotHosts: created.slotHosts, currentHealthHost: created.host8445, currentSandboxSessionId: created.sessionId, sessionStartedAt: now, sandboxExpiresAt: created.expiresAt, prebuildId: image.kind === "snapshot" ? image.prebuildId : null, restoreKind: image.kind === "snapshot" ? "snapshot" : ws.restoreKind });
  const { cmdId } = await stepStartSupervisor(ws.id, ws.sandboxName);          // rotates zsb_ token, runDetached zs-agent start with secrets in env, persists supervisor_cmd_id
  await waitUntilReady(ws.id, ws.sandboxName, created.host8445, cmdId, ws.serverBuild, 35 * 60_000);  // b8 starts serve as soon as the repo exists and runs postCreateCommand beside it (busy/phase reported, D13), so this normally returns after clone/restore; 35 min is the ceiling for huge clones
  await stepSetState(ws.id, "running", null, { restoreBlobPathname: null });   // a tarball restore is complete once the supervisor is ready; the blob is deleted by rebuildWorkspace; state_reason keeps showing boot:<phase> from the activity route while busy (§3.25)
  return { ok: true };
}
// shared helpers (plain async functions inside the workflow file; every await is a step or sleep). D13: both wait on the supervisor's health / the supervisor command's exit, never on a fixed sleep – the sleep below only paces the polls.
async function waitUntilReady(workspaceId: string, sandboxName: string, host8445: string, cmdId: string, expectBuild: string, ceilingMs: number): Promise<void> {
  const deadline = Date.now() + ceilingMs;   // Date.now() is deterministic-replay safe in Workflow DevKit (documented); a step-returned `now` may be used instead
  for (;;) {
    const h = await stepProbeHealth(workspaceId, host8445, expectBuild);       // writes state_reason = `boot:${phase}` for the overlay; null when unreachable (b8 §4.4 reduced body: no lastError/listening)
    if (h && h.serverRunning && (h.status === "ready" || h.status === "degraded")) {
      if (h.build && !buildsCompatible(h.build, expectBuild)) throw new FatalError(`build_mismatch:${h.build}`);   // h.build is the image's ZS_BUILD_ID = the server build; b1 builds_compatible is exact match
      return;
    }
    const exit = await stepWaitForCommandExit(sandboxName, cmdId, 1_000);    // the agent exits 2 (config), 3 (manifest unavailable) or 4 (repo materialisation failed) instead of reporting lastError remotely (b8 §3.17) – nothing will recover, fail fast
    if (exit.exitCode !== null) throw new FatalError(`supervisor_exit:${exit.exitCode}:${h?.phase ?? "unreachable"}`);
    if (Date.now() > deadline) throw new FatalError(`health_timeout:${h?.phase ?? "unreachable"}`);
    await sleep("5s");
  }
}
async function waitUntilGone(workspaceId: string, host8445: string | null, capMs: number): Promise<void> {   // used only when no supervisor cmdId is known (a row from before startSupervisor persisted it)
  const deadline = Date.now() + capMs;
  for (;;) {
    const h = host8445 ? await stepProbeHealth(workspaceId, host8445, "") : null;
    if (!h || h.status === "stopping" && !h.serverRunning) return;           // the agent set status = stopping and the server is gone (b8 §3.16 step 8), or the listener is already down
    if (Date.now() > deadline) return;                                       // proceed to stop() anyway; the directive's stop: true backstop covers a supervisor that comes back
    await sleep("2s");
  }
}

// connect-workspace.ts – used only for stopped → running (the running fast path is inline in the route)
export async function connectWorkspace(input: { workspaceId: string; userId: string }): Promise<{ host: string }> {
  "use workflow";
  const ws = await stepLoadWorkspace(input.workspaceId);
  await stepSetState(ws.id, "stopped", "resuming");                            // §7.2 has no "resuming" state: keep `stopped`, set state_reason; workflow_run_id (set by startLifecycle) marks the run in flight
  const resumed = await stepResumeSandbox(ws.id, ws.sandboxName);              // Sandbox.get({ name, resume: true, onResume: startSupervisor(h, ws, "resume") }) – rotates the token, runs `zs-agent resume`, persists supervisor_cmd_id
  if (!resumed) throw new FatalError("sandbox_missing");                       // not_found or snapshot_expired: finally → state error "sandbox_missing"; dashboard offers "rebuild" (from image; the tarball is gone with the snapshot)
  await stepSetState(ws.id, "stopped", "boot:manifest", { currentWsHost: resumed.host8443, currentSlotHosts: resumed.slotHosts, currentHealthHost: resumed.host8445, currentSandboxSessionId: resumed.sessionId, sessionStartedAt: now, sandboxExpiresAt: resumed.expiresAt, supervisorCmdId: resumed.cmdId });
  await waitUntilReady(ws.id, ws.sandboxName, resumed.host8445, resumed.cmdId, ws.serverBuild, 3 * 60_000);
  await stepSetState(ws.id, "running", null);
  return { host: resumed.host8443 };
}

// stop-workspace.ts
export async function stopWorkspace(input: { workspaceId: string; reason: "idle" | "user" | "cap" | "rebuild" | "delete" | "abuse" | "lost" }): Promise<{ stopped: boolean }> {
  "use workflow";
  const ws = await stepLoadWorkspace(input.workspaceId);
  if (ws.state === "stopped") return { stopped: false };
  await stepSetState(ws.id, "stopping", input.reason);                         // from now on the activity directive answers stop: true (backstop if the signal below is lost)
  await stepSignalSupervisor(ws.sandboxName, ws.supervisorCmdId, "SIGTERM");   // b8 §3.16 step 8: on SIGTERM the agent POSTs /control/lifecycle {"kind":"stopping"} on the D5 control listener (b4 waits ≤ 5 s for SaveClientState, which under D6 carries the dirty buffers; D18: b8's POST budget exceeds that 5 s) → SIGTERM child → TERM_GRACE (3 s today, b8:503) → SIGKILL group → logs.flush
  if (ws.supervisorCmdId) await stepWaitForCommandExit(ws.sandboxName, ws.supervisorCmdId, 25_000);   // D13/b8 §7 item 10: wait on the supervisor's own exit, never a fixed sleep; 25 s caps > 5 s flush + SIGTERM + grace + log flush; null on timeout, proceed anyway
  else await waitUntilGone(ws.id, ws.currentHealthHost, 25_000);              // no cmdId known (a row from before the supervisor persisted it): poll :8445/health until it is unreachable or reports stopping – still the supervisor's health, not a sleep (D13)
  const res = await stepStopSandbox(ws.sandboxName);                            // sandbox.stop() → snapshot + usage (optional fields defaulted); null when already stopped
  await stepRecordSessionEnd(ws.id, res?.usage ?? ZERO_USAGE, input.reason);    // VM wall time from session_started_at; ledger idempotencyKey `stop:${ws.id}:${ws.currentSandboxSessionId}`; closes an open sessions row if any
  await stepSetState(ws.id, input.reason === "rebuild" ? "rebuilding" : "stopped", input.reason, { lastStoppedAt: now, retentionUntil: now + retentionDays, retentionWarnedAt: null, currentWsHost: null, currentSlotHosts: null, currentHealthHost: null, supervisorCmdId: null, sandboxExpiresAt: null });   // forwards rows (and their slots) survive a stop: the manifest re-delivers them on resume
  return { stopped: true };
}

// restart-session.ts – session cap (§7.5 line 368): stop + resume in ONE run so workflow_run_id stays set throughout and /connect answers 423 (never 409 workspace_stopped) to the reconnecting tab
export async function restartSession(input: { workspaceId: string }): Promise<{ ok: true }> {
  "use workflow";
  await stepRunChild("stopWorkspace", { workspaceId: input.workspaceId, reason: "cap" });      // the supervisor raised SESSION_CAP_IN from sessionCapAt; the shell shows "restarting"
  await stepRunChild("connectWorkspace", { workspaceId: input.workspaceId, userId: "system" });
  return { ok: true };
}

// rebuild-workspace.ts – crash-safe order: nothing that holds the user's files is deleted before the new generation is healthy
export async function rebuildWorkspace(input: { workspaceId: string; fromImage: boolean; userId: string }): Promise<{ ok: true }> {
  "use workflow";
  const ws = await stepLoadWorkspace(input.workspaceId);
  if (ws.state === "running") await stepRunChild("stopWorkspace", { workspaceId: ws.id, reason: "rebuild" });
  await stepSetState(ws.id, "rebuilding", "archive");
  await stepResumeSandboxQuiet(ws.sandboxName);                                   // Sandbox.get({ resume: true }) WITHOUT onResume: no supervisor, just a VM to read files from (readFile auto-resumes anyway)
  const archive = await stepArchiveWorkspaceDir(ws.sandboxName, ws.id);           // tar → private Blob `rebuild/<ws>/<ts>.tgz` (+ sha256)
  const usage = await stepStopSandboxDiscard(ws.sandboxName);
  await stepRecordSessionEnd(ws.id, usage ?? ZERO_USAGE, "rebuild");
  const gen = await stepBumpGeneration(ws.id, archive, input.fromImage);          // new sandbox_name/audience/port secret, restore_kind='tarball', restore_blob_pathname, previous_sandbox_name = old
  await stepRunChild("createWorkspace", { workspaceId: ws.id, userId: input.userId });   // manifest.restore.tarballUrl → supervisor downloads before starting serve; waits until ready
  await stepDeleteSandbox(gen.oldSandboxName, { deleteSnapshots: true });         // only now – the new generation is healthy
  await stepSetState(ws.id, "running", null, { previousSandboxName: null });
  await stepDeleteBlob(archive.blobPathname);
  return { ok: true };
}
// If the child create fails, finally leaves state error with the OLD sandbox and the blob intact; `previous_sandbox_name` and `restore_blob_pathname` tell the dashboard/admin what to retry.

// delete-workspace.ts
export async function deleteWorkspace(input: { workspaceId: string; userId: string }): Promise<{ ok: true }> {
  "use workflow";
  const ws = await stepLoadWorkspace(input.workspaceId);
  await stepSetState(ws.id, "deleting");
  if (ws.state === "running" || ws.state === "stopping") await stepRunChild("stopWorkspace", { workspaceId: ws.id, reason: "delete" });
  await stepDeleteSandbox(ws.sandboxName, { deleteSnapshots: true });             // Sandbox.get({ resume: false }) → listSnapshots → each delete → sandbox.delete(); not_found is success
  if (ws.previousSandboxName) await stepDeleteSandbox(ws.previousSandboxName, { deleteSnapshots: true });
  if (ws.restoreBlobPathname) await stepDeleteBlob(ws.restoreBlobPathname);
  await stepPurgeWorkspaceRows(ws.id);                                            // forwards deleted, open sessions closed, workspaces.deleted_at set (rows kept for ledger/audit)
  return { ok: true };
}

// prebuild.ts
export async function prebuild(input: { repoId: string; branch: string; commit: string }): Promise<{ prebuildId: string; snapshotId: string }> {
  "use workflow";
  const pb = await stepCreatePrebuildRow(input);                                   // status queued; region = repo default region; imageRef = repo.imageRef ?? ZS_IMAGE_REF; sandbox_name = newPrebuildSandboxName(pb.id)
  const created = await stepCreateSandbox({ name: pb.sandboxName, region: pb.region, vcpus: 4, ports: [ZS_RPC_PORT, ZS_HEALTH_PORT], timeoutMs: 3_600_000, image: pb.imageRef, env: { ZS_PREBUILD: "1", ZS_WORKSPACE_ID: pb.id, ZS_SANDBOX_NAME: pb.sandboxName, ZS_REGION: pb.region }, networkPolicy: "allow-all", tags: { zs: envTag(), pb: pb.id }, snapshotExpirationMs: 0, keepLastSnapshots: 1 });   // b8 §3.16 prebuild sequence expects exactly [8443, 8445]; no proxy slots for a builder
  await stepSetPrebuildStatus(pb.id, "building");
  const { cmdId } = await stepStartSupervisorForPrebuild(pb.id, pb.sandboxName);   // zs-agent prebuild (D14: owned by b8 §3.16): manifest (pb- principal, §3.12) → clone via credential helper → postCreateCommand → optional ZS_PREBUILD_WARM_CMD from repos.prebuild_warm_command (≤ 20 min; the headless LSP warm-up of BUILD-SPEC §6.4 stays b8 §7.14's open item) → exit 0; the runCommand env adds ZS_PREBUILD_WARM_CMD when the repo sets one
  const exit = await stepWaitForCommandExit(pb.sandboxName, cmdId, 3_000_000);
  if (exit.exitCode !== 0) throw new FatalError(`prebuild_failed:${exit.exitCode ?? "timeout"}`);   // finally → status failed
  const snap = await stepSnapshot(pb.sandboxName, 0);                             // sandbox.snapshot({ expiration: 0 }) – VM shuts down after snapshot (documented); do not stop()
  await stepSetPrebuildStatus(pb.id, "ready", { snapshotId: snap.snapshotId, sizeBytes: snap.sizeBytes, readyAt: now });
  await stepDeleteSandbox(pb.sandboxName, { deleteSnapshots: false });            // keep the prebuild snapshot; delete the builder sandbox
  for (const id of await stepPrunePrebuilds(input.repoId, input.branch, 3)) await stepDeletePrebuildSnapshot(id);   // keep last three (§6.4 line 315)
  return { prebuildId: pb.id, snapshotId: snap.snapshotId };
}

// gc.ts (nightly)
export async function gc(input: { now: string }): Promise<{ deletedWorkspaces: number; orphanedSandboxes: number; prunedPrebuilds: number; warned: number }> {
  "use workflow";
  const warned = await stepWarnRetention(input.now);                              // 7 days before retention_until (§7 item 18)
  const c = await stepGcCandidates(input.now);                                    // expired = stopped AND retention_until < now AND retention_warned_at IS NOT NULL
  for (const id of c.expiredWorkspaces) await stepRunChild("deleteWorkspace", { workspaceId: id, userId: "system" });
  const orphans = await stepListOrphanSandboxes(c.knownSandboxNames);            // Sandbox.list({ tags: { zs: envTag() } }) minus known names (workspaces incl. previous_sandbox_name, prebuild builders) – a preview deployment never sees production sandboxes
  for (const name of orphans) await stepDeleteSandbox(name, { deleteSnapshots: true });
  for (const id of c.prebuildsToDelete) await stepDeletePrebuildSnapshot(id);
  await stepCloseStaleSessions(input.now);
  return { deletedWorkspaces: c.expiredWorkspaces.length, orphanedSandboxes: orphans.length, prunedPrebuilds: c.prebuildsToDelete.length, warned };
}
```

`buildDevcontainerImage` (§7.4) belongs to brief **b10**, the devcontainer image builder workflow written after the first implementation round (D14); this brief only reads `repos.image_ref`/`image_status` and starts nothing for it. Platform retention (persistence doc): `snapshotExpiration` counts from the snapshot's **last use** and Vercel deletes sandboxes that cannot resume after 14 days of inactivity; `retention_until = last_stopped_at + retentionDays` is recomputed at every stop, so it tracks the platform timer as long as `retentionDays ≤ 30`; the sweep/gc treat it as advisory and act on the SDK's `snapshot_expired`/`not_found` answers.

### 4.9 Editor CSP (`lib/csp.ts`, used by `proxy.ts`)

```ts
export function editorCsp(nonce: string, opts: { dev: boolean; unsafeEval: boolean }): string;
// default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic' 'wasm-unsafe-eval'<opts.dev || opts.unsafeEval ? " 'unsafe-eval'" : "">;
// connect-src 'self' wss://*.vercel.run https://*.vercel.run; worker-src 'self' blob:; img-src 'self' blob: data:;
// style-src 'self' 'nonce-<n>' (no 'unsafe-inline': the shell has one static stylesheet and no style attributes);
// font-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; upgrade-insecure-requests
```

`https://*.vercel.run` is required in `connect-src` beside `wss:` because `/files` upload/download (§3.6) and `/extensions/*/assets` (§9) are plain HTTPS fetches to the sandbox; the cross-origin half of that (CORS preflight, `Access-Control-Allow-Origin`, `Cross-Origin-Resource-Policy` under COEP) is b2's `--allowed-origin` (`b2:540`), fed from `manifest.allowedOrigins`. `'unsafe-eval'` is on in production while `ZS_CSP_UNSAFE_EVAL=1` because the pinned `wasm_thread` fork calls `js_sys::eval` (b7 risk 2); the flag flips to `0` when b7 lands the patched fork. `tests/csp.test.ts` asserts the header shape for both flag values and that the SSR HTML of `/w/[id]` contains no `style=` attribute.

### 4.10 Cron sweep (`app/api/cron/sweep/route.ts`)

```ts
export const maxDuration = 300;
export async function GET(req: Request): Promise<Response> {
  if (req.headers.get("authorization") !== `Bearer ${requireEnv("CRON_SECRET").CRON_SECRET}`) return error(401, "unauthenticated");
  const result = await withLock(keys.lock("sweep"), 55_000, async () => {
    const now = Date.now(), budgetEnd = now + 50_000;
    const out = { stopped: 0, warnedCap: 0, extended: 0, capped: 0, reconciledRuns: 0, reconciledVms: 0, abuse: 0, skipped: 0 };

    // 1. Dead runs: workflow_run_id set but the run is terminal or older than 15 min → clear it (state error unless the row is already stopped/running consistently)
    const stuck = await db.select().from(workspaces).where(and(isNotNull(workspaces.workflowRunId), isNull(workspaces.deletedAt)));
    await mapConcurrent(stuck, 8, async (w) => {
      const st = await stepRunStatus(w.workflowRunId!);   // plain function here (route context), name kept for symmetry
      if (st === "completed" || st === "failed" || st === "cancelled" || st === "unknown" || now - w.workflowRunStartedAt!.getTime() > 15 * 60_000) {
        await db.update(workspaces).set({ workflowRunId: null, workflowRunStartedAt: null, ...(st !== "completed" ? { state: "error", stateReason: `run_${st}` } : {}) }).where(eq(workspaces.id, w.id)); out.reconciledRuns++;
      }
    });

    const running = await db.select().from(workspaces).where(and(eq(workspaces.state, "running"), isNull(workspaces.workflowRunId), isNull(workspaces.deletedAt)));
    const [acts, keeps, healths, cpus, busies] = await Promise.all([keys.activity, keys.keepalive, keys.health, keys.cpu, keys.busy].map((k) => kv().mget(running.map((w) => k(w.id)))));
    await mapConcurrent(running, 8, async (w, i) => {
      if (Date.now() > budgetEnd) { out.skipped++; return; }                                          // the next minute's invocation continues (rows are ordered by last_active_at)
      const lastActive = Math.max(Number(acts[i] ?? 0), Number(keeps[i] ?? 0), w.lastActiveAt.getTime());
      const idleMs = now - lastActive, thresholdMs = w.idleMinutes * 60_000;
      const sessionAge = now - (w.sessionStartedAt?.getTime() ?? now);

      // 2. Dead VM: no activity ping for > 5 min → ask the platform
      if (healths[i] === null && now - w.updatedAt.getTime() > 5 * 60_000) {
        const peek = await sandboxApi().get(w.sandboxName, { resume: false });
        if (!peek || peek.status === "stopped" || peek.status === "failed" || peek.status === "aborted") {
          await startLifecycle(w.id, stopWorkspace, { workspaceId: w.id, reason: "lost" }); out.reconciledVms++; return;   // stopWorkspace on an already-stopped VM records zero usage and moves the row to stopped
        }
        await audit({ actorType: "cron", actorId: "sweep", action: "workspace.unhealthy", targetType: "workspace", targetId: w.id });
      }
      // 3. Abuse (§7.11 line 395): no session, not busy (D13) and > 80 % CPU for 15 consecutive minutes – keys.cpu is incremented by the activity route only when !sessionActive && !busy && cpuBusyPct > 80 (a postCreateCommand at 100 % is not abuse)
      if (Number(cpus[i] ?? 0) >= 30) { await startLifecycle(w.id, stopWorkspace, { workspaceId: w.id, reason: "abuse" }); await flagUser(w.ownerUserId, "sustained_cpu_no_session"); out.abuse++; return; }
      // 4. Idle stop (the supervisor already showed idle_stop_in from idleStopAt). D13: never while the supervisor reports busy || phase !== "ready" – the activity route already refreshes keys.activity in that case; keys.busy is the explicit guard
      if (idleMs >= thresholdMs && !busies[i]) { await startLifecycle(w.id, stopWorkspace, { workspaceId: w.id, reason: "idle" }); out.stopped++; return; }
      // 5. Session cap: controlled stop + resume 30 min before the platform cap (the supervisor showed SESSION_CAP_IN from sessionCapAt)
      if (sessionAge >= ZS_SESSION_CAP_MS - 30 * 60_000) { await startLifecycle(w.id, restartSession, { workspaceId: w.id }); out.capped++; return; }
      // 6. Rolling timeout: only touch the platform when the horizon is < 3.5 h away (sandbox_expires_at is updated by every extend and by connect/create)
      const desiredExpiry = Math.min(now + ZS_SESSION_TIMEOUT_MS, (w.sessionStartedAt?.getTime() ?? now) + ZS_SESSION_CAP_MS);
      const expiresAt = w.sandboxExpiresAt?.getTime() ?? 0;
      if (expiresAt - now < 3.5 * 3600_000 && desiredExpiry - expiresAt > 30 * 60_000) {
        const peek = await sandboxApi().get(w.sandboxName, { resume: false });
        if (peek?.status === "running") { await peek.extendTimeout(desiredExpiry - (peek.expiresAt?.getTime() ?? now)); await db.update(workspaces).set({ sandboxExpiresAt: new Date(desiredExpiry) }).where(eq(workspaces.id, w.id)); out.extended++; }
      }
    });
    return out;
  });
  return json(result ? { ran: true, ...result } : { ran: false, reason: "locked" });
}
```

`startLifecycle(id, wf, args)` = `withLock(keys.lock(`lifecycle:${id}`), 30_000, async () => { const run = await start(wf, [args]); await db.update(workspaces).set({ workflowRunId: run.runId, workflowRunStartedAt: new Date() }).where(and(eq(workspaces.id, id), isNull(workspaces.workflowRunId))); })`. Sandboxes are created with a rolling `timeout` of 4 h (not 24 h as §7.5 line 369 says) so that a dead control plane cannot leave VMs billing for a day; the sweep keeps the horizon 4 h ahead while the workspace is not idle, which is the spec's "extends as needed". With `sandbox_expires_at` cached, a minute's sweep makes one SDK call per workspace only when an extension is due (≈ every 30 min per workspace) or a ping is missing; at 8-way concurrency and ~300 ms per call, 1,000 running workspaces fit in the 50 s budget (`tests/routes/cron-sweep.test.ts` guards this with the fake).

## 5. Cargo/package changes

No Cargo changes. `zed/Cargo.toml:670` (`jsonwebtoken = "10.0"`) is the verifier side and is b2's concern.

`apps/web/package.json` – exact dependency lines (versions read from the npm registry on 2026-09-02; pinned, no carets, renovate bumps them):

```json
"scripts": {
  "dev": "next dev",
  "prebuild": "tsx scripts/fetch-editor-bundle.ts",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "typecheck": "next typegen && tsc --noEmit",
  "db:generate": "dotenv -e .env.local -- drizzle-kit generate",
  "db:migrate": "dotenv -e .env.local -- drizzle-kit migrate",
  "db:push": "dotenv -e .env.local -- drizzle-kit push",
  "test": "vitest run",
  "test:integration": "vitest run -c vitest.integration.config.ts",
  "zs:rotate-secrets": "dotenv -e .env.local -- tsx scripts/rotate-secrets.ts",
  "zs:keygen": "tsx scripts/keygen.ts"
},
"dependencies": {
  "@clerk/nextjs": "7.8.4",
  "@electric-sql/pglite": "0.5.8",
  "@octokit/auth-app": "8.3.1",
  "@octokit/rest": "22.0.1",
  "@octokit/webhooks-methods": "6.0.0",
  "@upstash/ratelimit": "2.0.8",
  "@upstash/redis": "1.38.3",
  "@vercel/blob": "2.8.0",
  "@vercel/functions": "3.9.5",
  "@vercel/sandbox": "3.2.1",
  "@zs/sdk": "workspace:*",
  "drizzle-orm": "0.45.2",
  "jose": "6.2.10",
  "next": "16.3.4",
  "pg": "8.23.0",
  "react": "19.2.8",
  "react-dom": "19.2.8",
  "server-only": "0.0.1",
  "stripe": "22.6.1",
  "workflow": "4.8.5",
  "zod": "4.5.4"
},
"devDependencies": {
  "@tailwindcss/postcss": "^4",
  "@types/node": "^20",
  "@types/pg": "8.23.1",
  "@types/react": "^19",
  "@types/react-dom": "^19",
  "@vercel/config": "0.7.0",
  "@workflow/vitest": "4.0.21",
  "dotenv": "17.4.2",
  "dotenv-cli": "11.0.0",
  "drizzle-kit": "0.31.10",
  "eslint": "^9",
  "eslint-config-next": "16.3.4",
  "tailwindcss": "^4",
  "tsx": "4.23.13",
  "typescript": "^5",
  "vite-tsconfig-paths": "6.1.1",
  "vitest": "4.1.11"
}
```

`packages/sdk/package.json`: `{ "name": "@zs/sdk", "private": true, "type": "module", "exports": { ".": "./src/index.ts", "./zed-web": "./src/zed-web.ts" }, "dependencies": { "zod": "4.5.4" } }`; the root `pnpm-workspace.yaml` gains `packages: ["apps/*", "packages/*"]`.

Notes on choices: `@vercel/sandbox` 3.2.1 is the current major; the SDK reference page (the "v2" API the task names: `name`, `Sandbox.get({ name })`, `getOrCreate`, `persistent`, `onResume`) is what 3.x exposes and its persistence doc's migration table is from v1 → v2; every shape used here was type-checked against the installed `dist/*.d.ts` (§2). `@electric-sql/pglite` is a runtime dependency only because `ZS_DB_DRIVER=pglite` is allowed for local dev; move it to dev if that is dropped. `@vercel/queue` is not used: GitHub push fan-out goes straight to `start(prebuild)` under a 60 s Redis debounce (Workflow is already durable; Queues would add a hop with no benefit). `octokit` meta-package is avoided in favour of the two small packages actually used. No `p-limit`: `lib/concurrency.ts` is 15 lines.

## 6. Tests

Vitest 4 with two configs: `vitest.config.ts` (unit + route tests, `environment: "node"`, `plugins: [tsconfigPaths()]`, `setupFiles: ["tests/helpers/setup.ts"]` which sets `ZS_DB_DRIVER=pglite`, `ZS_REDIS=memory`, `ZS_SANDBOX_DRIVER=fake`, `ZS_EDITOR_COOKIE_SECRET`, test keys from `tests/helpers/keys.ts`) and `vitest.integration.config.ts` (`plugins: [workflow()]` from `@workflow/vitest`, `include: ["**/*.integration.test.ts"]`, `testTimeout: 60_000`; no `vi.mock`, hence the env-selected fakes).

`tests/helpers/db.ts`: `export async function testDb(): Promise<Db>` → `new PGlite()` + `migrateDb` + seed (`user_test`, `repo_test`, one installation). `tests/helpers/fake-sandbox.ts`: in-memory `SandboxApi` recording every call (`calls: Array<{ method; args }>`), simulating `status` transitions, `expiresAt`, `domain(port) = "https://<name>-<port>.fake.vercel.run"` (throws for undeclared ports like the SDK), configurable failures (`failNextCreateWith("image_not_ready", n)`, `failNextGetWith("snapshot_expired")`), a scripted `/health` answer per host (`setHealth(host, HealthProbe | null)`) consumed by a `fetch` shim in `probeHealth`, and **state on `globalThis.__zsFakeSandbox`** because `@workflow/vitest` runs the steps bundle as a separate module instance in the same worker (§2). `tests/helpers/request.ts`: `req(method, path, { body?, bearer?, cron?, cookies?, headers? })`, `mockViewer(userId)` (`vi.mock("@clerk/nextjs/server", () => ({ auth: async () => current, clerkClient: async () => fakeClerk }))`) and `editorCookieFor(userId, workspaceId)`. `tests/helpers/keys.ts`: `generateKeyPair("ES256", { extractable: true })` → `exportPKCS8`/`exportSPKI` for two kids, plus `readFixtureKeys()` loading `zed/crates/remote_server/tests/fixtures/es256_private.pem` when present (skipped otherwise). `tests/helpers/fixture.ts`: `loadManifestFixture()` reads `docs/contracts/fixtures/manifest.example.json` from the monorepo root (D19; b8 §3.26 creates it from §4.7 next to its JSON Schema) and throws a descriptive error naming the path when it is absent, so a missing or stale fixture fails the suite rather than a silently-skipped test.

### 6.1 `tests/tokens.test.ts`

| Test | Asserts |
|---|---|
| `mints_es256_with_expected_claims` | Decoded header `{ alg: "ES256", typ: "JWT", kid: "k1" }`; payload has `iss: "zs"`, `sub`, `ws === workspaceId`, `sid === sessionId` (the `con_…` id passed in, D1) with `sid !== ws`, `aud`, `iat`, `exp === iat + 3600`, `jti` 22+ chars; `verifySessionToken` round-trips. |
| `ttl_capped_at_one_hour` | `ttlSeconds: 7200` → `exp - iat === 3600`. |
| `rejects_wrong_audience_workspace_issuer` | Three tokens; each mismatch throws with codes `audience`, `workspace`, `issuer`; error message never includes the token. |
| `rejects_expired_beyond_tolerance` | `exp = now - 120` throws; `exp = now - 10` verifies (clockTolerance 30). |
| `rejects_hs256_and_none` | Hand-built `alg: "HS256"` token signed with the public PEM bytes, and `alg: "none"` → both throw. |
| `kid_rotation_selects_previous_key` | Token minted under previous key (kid `k0`) verifies while `ZS_JWT_PREVIOUS_*` set; fails once removed; `publicKeyPems()` returns `[k1, k0]` in that order. |
| `port_bootstrap_token_is_not_a_session_token` | A `mintPortBootstrapToken` token → `verifySessionToken({ audience })` throws with code `audience` (the same check b2's `/rpc` applies against `--audience`); an ES256 session token → `verifyPortBootstrapToken` throws `audience`; the bootstrap token's `exp - iat === 600` and `sid === "port:3000"`. |
| `interop_with_serve_fixture` (skipped when fixture absent) | Token minted with b2's fixture private key verifies with its public key via jose; asserts the claim set b2's `Claims` requires. |

### 6.2 `tests/crypto.test.ts`, `tests/port-token.test.ts`, `tests/ports.test.ts`, `tests/editor-cookie.test.ts`

| Test | Asserts |
|---|---|
| `round_trip` | `decryptSecret(encryptSecret(p, aad), aad) === p` for empty, 1-byte, 64 KiB and multibyte plaintexts. |
| `unique_iv_per_call` | Two envelopes of the same plaintext differ in the iv and ct fields. |
| `aad_mismatch_fails` | Decrypt with a different aad → `SecretError("auth_failed")`; tampering one ct byte → same. |
| `unknown_key_version` | Envelope with `kv=9` → `SecretError("unknown_key_version")`. |
| `rotation` | `needsRotation` true for old version; `rotateEnvelope` produces active version and decrypts to the same plaintext; `scripts/rotate-secrets.ts` rotates every `secrets` row below the active version and nothing else (no per-workspace ciphertext exists any more, D8). |
| `load_keys_validation` | Missing active version, non-32-byte key, malformed JSON → descriptive errors naming the env var, never echoing key bytes. |
| `port_bootstrap_matches_b8_verifier` | `mintPortBootstrapToken({ port: 3000 })` decodes to header `{ alg: "ES256", typ: "JWT", kid }` and claims `{ iss: "zs", aud: "<audience>/ports", sub, ws, sid: "port:3000", iat, exp: iat + 600, jti }` — exactly the set b8 `BootstrapVerifier::verify` requires (b8 §3.10 `:583-585`, D8); `verifyPortBootstrapToken` rejects `sid` on infra ports / `"port:0"` / `"sess"` (`port`), `exp - iat = 3600` (`expired`), an expired token, a wrong `ws` (`workspace`), a session-audience token (`audience`) and HS256/`none`. |
| `slot_allocation` (`tests/ports.test.ts`) | Four private forwards on one workspace take the four `proxySlots()` in order; a fifth → `ApiError(409, "no_free_slot")`; `DELETE` frees the slot and the next private forward reuses it; a duplicate slot violates `forwards_slot_idx`; a public forward has `slot === null`; `privateForwardUrl`/`authRedirect` yield `…/api/workspaces/<id>/ports/3000/open` and `https://<host>/__zs/auth?zs_port_token=<t>&next=%2F`; `proxySlots()` refuses fewer or more than four ports and any overlap with `ZS_RPC_PORT` or the pool, and only *logs* an overlap with `ZS_HEALTH_PORT` (§7 item 20). |
| `editor_cookie` | `mintEditorCookie` → HS256, `aud zs-editor`, `exp` +12 h; `verifyEditorCookie` rejects other workspace, expired, ES256-signed; attributes are `HttpOnly; SameSite=Strict; Path=/api/workspaces/<id>`. |

### 6.3 `tests/usage.test.ts`

| Test | Asserts |
|---|---|
| `session_usage_math` | vcpu4, 30 min wall, `activeCpuMs = 900_000`, 1 GiB egress → `vcpuSeconds 900`, `provisionedGbHours 4` (8 GB × 0.5 h), `egressBytes 1073741824`. |
| `one_minute_minimum` | 5 s wall → `provisionedGbHours === memoryGb / 60`. |
| `idle_tail_is_billed` | `sessionStartedAt` 60 min ago, last `sessions` row closed 30 min ago → wall = 60 min (VM time), not 30. |
| `no_user_session_still_ledgers` | Workspace created and never opened → `stepRecordSessionEnd` inserts one row keyed `stop:<ws>:<sbxSession>`. |
| `price_matches_vercel_example` | pricing-page example "Build and test: 30 min, 4 vCPU at 100 % CPU" → activeCpu 26 cents, memory 8 cents (rounding rule documented in the test). |
| `margin_applied_once` | `margin 1.5` → exactly 1.5× the list total. |
| `snapshot_gb_days_and_period` | `snapshotGbDays(32e9, 1) === 32`; `periodOf(new Date("2026-09-02T23:59:59Z")) === "2026-09"`. |
| `stripe_meter_push_idempotent` | `pushLedgerToStripe` sends one `meterEvents.create` per (row, metric) with `identifier = row.id:metric`; a second run pushes nothing. |

### 6.4 `tests/sandbox-auth.test.ts`, `tests/manifest.test.ts`, `tests/sandbox-conformance.test.ts`, `tests/csp.test.ts`

Bearer accepted only for the matching sandbox name (`401` on wrong name, wrong token, missing header, and after `rotateSandboxToken`); `410` after `deleted_at`; timing-safe compare is used (spy); a `pb-` name resolves a `prebuild` principal and `sb-` a `workspace` principal; `x-` names → 400. Manifest: `manifest_matches_contract` round-trips through the fixture rules (no `portSessionSecret` key at all, `capAt > startedAt`, forward/pool ports ∉ `infraPorts()`, `proxySlots` is exactly four ports equal to `proxySlots()`, ≥ 1 PEM, camelCase keys, `settings.settings` is a string, `env` contains no secret value, `secretNames` lists them, both public keys during rotation, `jwt.portAudience === jwt.audience + "/ports"`, `restore` null vs `{ tarballUrl (https, signed), sha256 }` by generation state, `repo.ref` for a PR workspace, `allowedOrigins === [controlPlaneUrl()]`, `extensions` equals `installed_extensions`, every private forward has a `slot` and the `/open` url, every public one `slot === null`, `session.id === currentSandboxSessionId`); a prebuild principal's manifest carries `prebuild`, repo secrets only, no user settings/dotfiles, empty `forwards`. `fixture_parses_with_sdk_schema`: `docs/contracts/fixtures/manifest.example.json` (D19) parses with `packages/sdk`'s `sandboxManifest` zod schema and satisfies the same rules — this is the test both briefs pin the contract with. Conformance: `lib/sandbox.ts`'s real driver is compiled with `satisfies` against `Sandbox`/`Snapshot` types (a rename fails `typecheck`). CSP: `editorCsp` for `unsafeEval` true/false, nonce present, no `'unsafe-inline'`; the SSR HTML of `/w/[id]` (rendered with `react-dom/server` and a stub workspace) contains no `style=` attribute; `next.config.ts` headers include COOP/COEP/CORP for `/w/:id`, `/editor/:build/:path*` and `Service-Worker-Allowed` for `/sw.js`.

### 6.5 Route tests (`tests/routes/*.test.ts`)

| File | Cases |
|---|---|
| `workspaces.test.ts` | `POST` creates row in `creating` and starts `createWorkspace` (spy on `workflow/api` `start`); plan limit → 402; `vcpu32` on pro → 402; flagged user → 403; foreign org installation → 403; **same `Idempotency-Key` twice → one row, identical response**; `GET` list hides other users' and deleted rows; org member sees a teammate's org workspace; `GET /{id}` of another user → 404; `PATCH idleMinutes: 3` → 400; `DELETE` → 202 and second `DELETE` → 409 busy while the run is pending; `DELETE` after the run is terminal (`stepRunStatus` stubbed `failed`) → 202. |
| `connect.test.ts` | running + healthy fake (8445 probe scripted `ready`) → 200 `ConnectInfo` with `wsUrl === "wss://<host8443>/rpc"`, **`sessionId` a fresh `con_…` id on every call, equal to the token's `sid` and never equal to `workspace.id`, while the token's `ws === workspace.id` across open / stop+resume / takeover (D1) and `sessions.last_connect_id` records the latest**; `sessionExpiresAt` equals the token's `exp`; `tokensMinted` increments; token verifies with `aud === workspace.audience`; open session held by another user without takeover → 409 `session_active`; with `takeover: true` → 200 and the previous session row `ended_at` set with `end_reason "takeover"`; **same user + same `tabId` → 200 without takeover (`same_tab_reload_no_takeover`)**; same user + new `tabId` → 409; two parallel calls for a fresh workspace → both 200, one `sessions` row (`concurrent_connect_race`); stopped + `reason open` → starts `connectWorkspace`, 202 when the fake never becomes healthy within the shortened deadline; **stopped + `reason reconnect` → 409 `workspace_stopped` and `start` NOT called (`reconnect_does_not_resume_stopped_workspace`)**; stopping (`workflowRunId` set) + reconnect → 423 then, after the fake run completes and the row is `running`, 200 with the new host (`refresh_blocks_through_resume`); `clientBuild` mismatch → 409; workspace on an older `clientBuild` than `ZS_CLIENT_BUILD_ID` still connects; **expired Clerk session + valid `zs_editor` cookie → 200; editor cookie for another workspace → 401**. |
| `sandboxes.test.ts` | `activity` writes kv keys, bumps `last_active_at` once a minute and returns `{ idleStopAt, sessionCapAt, stop, forwards, serverTime }` (`activity_response_shape`; `stop: true` once state is `stopping`; keepalive moves `idleStopAt`; `forwards` lists the workspace's `ForwardView[]` with slots); **`busy: true` or `phase: "post_create"` with a stale `lastInputAt` keeps `keys.activity` at `now`, sets `keys.busy`, moves `idleStopAt` forward and writes `state_reason = "boot:post_create"` on a running row (`busy_counts_as_activity`, D13)**; `listening: [{ port: 3000 }]` → `keys.listening === [3000]`; `cpuBusyPct: 95` increments `keys.cpu` only when `sessionActive: false` and `busy: false`; a ping in b8's on-disk field names (`serverBuild`, `uptimeSeconds`, …) parses (`accepts_b8_ping_shape`); `git-token` with `{ host: "github.com", protocol: "https", path: "owner/repo" }` returns `{ username, token, expiresAt: <RFC 3339 string> }` from the mocked `@octokit/auth-app` (`vi.mock`) scoped to `repositoryIds: [githubRepoId]`, an empty body `{}` returns the same token (`git_token_empty_body`), `path` naming the owner's dotfiles repo returns the mocked Clerk OAuth token (`git_token_dotfiles_oauth`), audit row written, `host: "gitlab.com"` → 404, 31st call in a minute → 429; `pb-` principal can fetch manifest and git-token (`prebuild_principal_can_fetch_manifest_and_git_token`); `ports` `POST { port, visibility: "public", label }` inside pool → `{ url, visibility, slot: null }` without `updatePorts` call, outside pool → `updatePorts` called with the full merged list; `POST { port, visibility: "private" }` → `{ url: <open link>, visibility, slot: 8444 }` and the forwards row holds the slot, the fifth private → 409 `no_free_slot` (`private_forward_allocates_slot`); `POST { action: "unforward", port }` → 204 like `DELETE /ports/3000` → 204 (slot freed); `extensions` `POST { installed: ["toml", "html"] }` → 204 and `workspaces.installed_extensions` equals it, an invalid id → 400 (`extensions_relay`, D18/D19); `logs` JSON batch → 204, NDJSON body with `Content-Type: application/x-ndjson` → 204 with `target` mapped to `source` (`logs_ndjson`), > 256 KiB → 413; `client-errors` (sandbox-facing) accepts the bearer and rejects a Clerk viewer; `/api/workspaces/{id}/client-errors` accepts the editor cookie and rejects a stranger. |
| `ports-open.test.ts` | `GET /ports/{port}/open` → 303 to `https://<slotHost>/__zs/auth?zs_port_token=<jwt>&next=%2F` where `<slotHost>` is `currentSlotHosts[forward.slot]`; the JWT passes `verifyPortBootstrapToken` with `aud === audience + "/ports"`, `sub === userId`, `sid === "port:3000"`, `exp - iat === 600`; a public forward or no forward → 404; stopped (no slot hosts) → 409. |
| `webhooks-github.test.ts` | Bad signature → 401; duplicate delivery id → 200 `{ handled: false }`; `push` on a prebuild branch starts `prebuild` once even when delivered twice within 60 s; `installation.deleted` soft-deletes installation and repos. |
| `cron-sweep.test.ts` | Missing/incorrect bearer → 401; idle workspace past threshold → `stopWorkspace` started and `workflowRunId` set; keepalive key defers stop; session age 23 h 45 min → `restartSession` started; `sandboxExpiresAt` 3 h ahead → `extendTimeout` called with the right delta and the fake asserts `resume: false` on `get` (`peek_uses_resume_false`); 5 h ahead → no SDK call; row with a terminal `workflowRunId` → cleared, state `error` (`workflow_failure_clears_run_id`); no ping for 6 min and fake status `stopped` → `stopWorkspace(reason "lost")` (`sweep_reconciles_dead_vm`); `zs:cpu` ≥ 30 → `stopWorkspace(reason "abuse")` + user flagged; a row past its idle threshold whose `zs:busy` key is set is **not** stopped (`busy_workspace_not_idle_stopped`, D13); 1,000 running rows with the fake finish under 50 s (`sweep_scales`); lock held → `{ ran: false }`. |
| `secrets.test.ts` | `PUT` stores ciphertext (row never equals plaintext), `GET` lists names only, precedence user < org < repo in `resolveEnvFor`, invalid name → 400 `invalid_name`, `ZS_CONTROL_PLANE_URL` / `LD_PRELOAD` → 400 `reserved_name` (`reserved_secret_prefix_rejected`); `supervisorEnvFor` with a pre-existing `ZS_CONTROL_PLANE_URL` secret row still yields the control plane's origin (`identity_env_wins`). |

### 6.6 Workflow integration tests (`tests/workflows/*.integration.test.ts`, `@workflow/vitest`)

| Test | Asserts |
|---|---|
| `create_workspace_happy_path` | With the fake sandbox: `start(createWorkspace)` → `run.returnValue`; fake recorded `getOrCreate` with `ports` `[8443, 8444, 8445, 8446, 8447, …pool]` (D8: the four proxy slots, deduplicated against the health port), `persistent: true`, `keepLastSnapshots 1`, `tags.zs === envTag()`, **no `source`** (D19), `env` **without** any secret value or `ZS_SANDBOX_TOKEN`; then `runDetached("zs-agent", ["start"])` env **with** `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_PLANE_URL === controlPlaneUrl()` (the origin, no `/api`) and the decrypted secret; health probes hit `host8445` and the row's `state_reason` walks `boot:manifest → boot:clone → null` (the fake reports `ready` with `serverRunning` while `phase: "post_create"`, `busy: true`, as b8 does); workspace ends `running` with `supervisorCmdId`, `currentWsHost`, `currentSlotHosts` (four entries), `currentHealthHost`, `sessionStartedAt`, `sandboxExpiresAt`, `workflowRunId null`. |
| `create_fails_fast_when_supervisor_exits` | The fake's `runDetached` command exits 3 while health stays unreachable → the run fails within one poll with `supervisor_exit:3:unreachable`, state `error`, `workflowRunId null` (no 35-minute wait). |
| `create_retries_image_not_ready` | `failNextCreateWith("image_not_ready", 2)` → three attempts, success; `failNextCreateWith("quota", 1)` → run fails, workspace `error` with reason, `workflowRunId null`. |
| `health_timeout_clears_run_id_and_sets_error` | Health scripted to stay `booting`/`post_create` past a shortened ceiling → run fails, state `error` `health_timeout:post_create`, `workflowRunId null`, the sandbox is left running for the operator (not deleted). |
| `connect_workspace_records_new_cmd_id` | Stopped workspace with `supervisorCmdId null` → after `connectWorkspace` the row has the cmdId from the fake's `runDetached("zs-agent", ["resume"])`, `sandboxTokenGeneration + 1`, and a retried `stepResumeSandbox` (fake makes the first attempt throw after `get` resolved) still ends with exactly one `runDetached` and the matching cmdId. |
| `stop_records_ledger_idempotently` | `start(stopWorkspace)` → fake `stop()` returns `{ activeCpuDurationMs: 600000, networkTransfer: { ingress: 0, egress: 5e8 } }` (the SDK shape; the handle maps it to `usage`); SIGTERM sent, `waitCommand` observed before `stop()` and **no `sleep` step in the run** (D13); one `usage_ledger` row with `vcpuSeconds 600`, wall time from `sessionStartedAt`, cost computed; re-running the step (call `stepRecordSessionEnd` twice) inserts nothing new; a second run with `stop()` returning `{}` (all optional fields absent) records zero usage without throwing; `forwards` rows and their slots survive the stop. |
| `stop_without_cmd_id_polls_health` | A row with `supervisorCmdId null` → the run polls the fake's `:8445/health` (scripted `ready` → `stopping` → unreachable) and calls `stop()` right after the listener goes away — under 6 s of fake time, no fixed 20 s wait (D13). |
| `restart_session_keeps_run_id` | `restartSession` → `workflowRunId` stays set across the child stop and resume (a `/connect reason reconnect` during the run gets 423, never 409), ends `running` with a new `currentWsHost`. |
| `rebuild_crash_keeps_old_sandbox_and_blob` | `rebuildWorkspace` with the child `createWorkspace` failing → old sandbox not deleted, blob not deleted, `previousSandboxName`/`restoreBlobPathname` set, state `error`, `workflowRunId null`; happy path → old sandbox deleted only after the new generation's health passed, blob deleted last, `sandboxGeneration + 1`, `forwards` rows keep their slots, the archive command names exactly `workspaces vercel/.local/share/zed` (D9 — and nothing else, `archive_paths_are_exactly_d9`), the new generation's manifest carries `restore.tarballUrl` as a presigned https URL. |
| `delete_removes_snapshots` | `deleteWorkspace` → fake records `get({ resume: false })`, `listSnapshotIds` then `deleteSnapshot` per id then `delete`; `forwards` gone; `workspaces.deleted_at` set. |
| `prebuild_keeps_last_three` | Four `prebuild` runs for one branch → the oldest marked `deleted` and its snapshot deleted; builder sandbox (`pb-…`, tagged `zs: envTag()`) deleted with `deleteSnapshots: false`; `stepStartSupervisorForPrebuild` rotated a `pb` token. |
| `gc_ignores_other_env` | Fake holds sandboxes tagged `zs: "production"` and `zs: "preview"`; `gc` under `VERCEL_ENV=preview` deletes only unknown `preview` ones and lists with a single-tag filter. |

End-to-end (Playwright against a preview deployment with real sandboxes, §13) is owned by the testing brief; this brief's shell exposes `data-phase` on the overlay root so those tests can assert the stages.

## 7. Risks and open questions

1. **`@vercel/sandbox` 3.2.1 shapes are verified; behaviour is not.** Types were checked against `dist/*.d.ts` (§2). Still unverified against the live platform: whether `domain(port)` changes on resume (the design never caches it – stored per session, re-read on every `/connect`), whether `getOrCreate({ resume: true })` on a name whose first session died returns a usable running VM (§3.16 falls back to `get({ resume: true })`), and how long `stop()` takes for a 64 GB disk (the 25 s exit wait in `stopWorkspace` is not on that path). `tests/sandbox-conformance.test.ts` catches renames at `typecheck` time; month-one telemetry covers the rest.
2. **Auto-resume is broader than the docs' short list.** The SDK wraps `readFile`, `snapshot` and **`extendTimeout`** in `withResume` (§2), not only `runCommand`/`writeFiles`. Every path that touches a possibly-stopped sandbox other than `connectWorkspace`/rebuild passes `resume: false` and checks `status === "running"` before `extendTimeout` (§3.19, §4.10); the fake asserts `resume: false` on `stepStopSandbox`, `stepDeleteSandbox` and the sweep's peek (§6.5). A race between the peek and `extendTimeout` can still boot a VM without a supervisor; the sweep's dead-VM rule (§4.10 step 2) would stop it within ~6 min. Not verifiable until month one.
3. **Session id semantics — decided by D1/D3.** `workspace_id` (= `ZsBootConfig.workspace.id`, the JWT `ws`) is the client's stable identity for persistence, the connection pool and the sandbox name; `sessionId`/`sid` is minted per connect (`con_…`, §3.18), informational, and resume is keyed on the server's epoch (D3), never on `sid`. The earlier resolution `sessionId === sid === workspaceId` is withdrawn (b2 §9.2 and b7 §3.28 record the same). The persistence key survives rebuild because it is the workspace id and because the client-state image lives in `$HOME/.local/share/zed`, which the D9 tarball carries.
4. **Audience string.** §4.3 says `aud = sandboxName`; to allow "rotate the `aud` on the next resume" without a new sandbox, `workspaces.audience` is a separate column defaulting to the sandbox name and the supervisor passes it to `serve --audience` from `manifest.jwt.audience` (b8 does this today). Private-port bootstrap tokens use `jwt.portAudience = "<audience>/ports"` (§3.12) so that b2's `/rpc`, which compares `aud` with `--audience`, cannot accept one; b8's `BootstrapVerifier` must be constructed with that value (item 7h) — until it is, b8 on disk rejects our bootstrap tokens with `WrongAudience` and private ports fail loudly rather than opening a hole.
5. **Token placement.** b1 removed the query-string form (subprotocol on both targets, `b1:576-583`); `?zs_token=` survives only for b2's `<a download>` `/files` path. The shell never builds a token URL; if b2's download form is used from the shell, tokens appear in `*.vercel.run` access logs for 1 h, single-audience.
6. **b7 host additions — decided (b7 §3.21, D2).** `onClosed` accepted (optional); `onLifecycle` is part of the base contract with snake_case kinds; `keepAlive`/`stop`/`setDirty`/`onExtensionsChanged`/`openExternal` declined, with the replacements listed in §4.6. `RefreshError::Stopped` exists in b1 (D2) and b7 §3.21 maps `{ code: "stopped" }` to it, so a reconnect against a stopped workspace stops at the first refresh instead of exhausting 20 attempts; the control plane side (`409 workspace_stopped`, never a resume) is unchanged. Still open on b7's side: `close_code_detail` names `server_stopping` for the former 4004 while D3 renumbered that close to 1001 — the shell maps both to `stopped`, so nothing breaks either way; and `start()` is single-shot, so every retry is a reload until b7's in-place `reconnect()` export lands (b7 §7.9). `'unsafe-eval'` stays on (`ZS_CSP_UNSAFE_EVAL=1`) until b7 lands the patched `wasm_thread` (b7 §7.2).
7. **b8 follow-ups this brief depends on.** Items (a)-(g) of the previous revision are now **decided**: D18 (`manifest.repo.ref`, settings `Value::String` verbatim, `x-vercel-protection-bypass` from `ZS_BYPASS_SECRET`, `cpuBusyPct`), D5 (`--allowed-origin` from `manifest.allowedOrigins`), D14 (`zs-agent prebuild` owned by b8 — already in b8 §3.16 on disk), D9 (tarball = `/workspaces` + `$HOME/.local/share/zed`, extracted at `/`). b8 on disk already sends the bypass header (`:289`), reports `cpuBusyPct` (`:316`), writes settings verbatim (`:750`) and has `prebuild`; `repo.ref` (it derives `refs/pull/N/head` from `pullRequest` today, `:737`) and `--allowed-origin` are the remaining edits there. New asks against the b8 revision on disk: (h) construct `BootstrapVerifier` with `manifest.jwt.portAudience` (= `"<audience>/ports"`) instead of `manifest.audience` (§3.12); (i) fetch `restore.tarballUrl` directly (a presigned https URL, no bearer) instead of a `restore-tarball` route; (j) set `credential.useHttpPath = true` so the credential helper passes `path` and the dotfiles OAuth token of §4.2 works (b8 §7 item 18); (k) run one proxy per `manifest.proxySlots` entry bound to `forwards[].slot` (b8 §7 item 5 — `ProxyConfig.bound_port` is ready) and treat the slots as infra ports; (l) read `ActivityDirective { idleStopAt, sessionCapAt, stop, forwards, serverTime }` and derive the `idle_stop_in`/`session_cap_in` countdowns locally instead of relaying a `notices[]` queue (§3.25, item 21); (m) `POST /api/sandboxes/{name}/extensions { installed }` as the relay target of the server's `POST $SUPERVISOR_URL/extensions` (D18). (h)-(j) and (m) are one-line changes; (k) and (l) are the two pieces of real work.
8. **Unsaved buffers on stop — decided by D6.** On `LifecycleNotice STOPPING` the client writes every dirty buffer's path, text and version into the client-state image (new table `unsaved_buffers`, b4 §3.8) and flushes `SaveClientState` inside the stopping window; the next open reopens them dirty. The client never writes the workspace filesystem without the user saving, so the earlier ask (autosave to disk inside `Stopping`) is withdrawn. `stopWorkspace` keeps giving b4 the full flush window (5 s, plus b8's budget above it per D18) before `stop()`. Takeover and exhaustion paths rely on `has_unsaved_changes()` + `beforeunload` (b7); b1 §7.9 remains the open UX item for a copy/export of dirty text after a terminal close.
9. **In-place server upgrade on resume.** After a deploy, existing workspaces keep their image's server build and load the matching bundle (§3.26/§3.30), so nothing breaks, but they never receive the new build until `rebuild`. A `GET /api/builds/{build}/zed-remote-server` signed-Blob route plus a b8 "replace the binary when `manifest.build` differs" step would give Codespaces-style upgrades; deferred, tracked here.
10. **Clerk specifics not verified in-page**: the exact `OauthAccessToken` shape and provider string for `getUserOauthAccessToken` (`"github"` per current lowercase convention; older SDKs used `"oauth_github"`), and the `external_accounts` layout in `user.created` webhook payloads. `lib/auth.ts:githubUserToken` isolates both. Verified: `ClerkProvider` inside `<body>` (quickstart), 60 s session token refreshed by the frontend SDK ("How Clerk works"), handshake only for document requests (`@clerk/backend` source).
11. **Sandbox `timeout` at 4 h with sweep extension** contradicts §7.5 line 369 ("Timeouts at create are 24 hours"). Chosen for cost safety; flip `ZS_SESSION_TIMEOUT_MS` to 24 h to follow the spec literally.
12. **Every-minute cron on Pro** is allowed (Hobby is once per day); cron delivery is best-effort and may double-fire, hence the Redis lock and idempotent stop starts. A sweep that exceeds its 50 s budget leaves the tail for the next minute (`skipped` counter); alert when `skipped > 0` for 5 consecutive minutes.
13. **Region choice** uses `geolocation(request)` latitude/longitude, available only on Vercel; locally it falls back to `ZS_DEFAULT_REGION`. Snapshots are region-locked (`snapshot_region_mismatch`), so the region is immutable per workspace (§7.5 line 372) and prebuild snapshots are only used for workspaces in the prebuild's region.
14. **Marketplace variable names**: Neon injects `DATABASE_URL` (skill-verified); Upstash exposes `UPSTASH_REDIS_REST_URL/TOKEN` and Vercel-KV-compatible `KV_REST_API_URL/TOKEN` depending on how the store was created; both are accepted. Supabase/Prisma Postgres would need their own URL names in `env.ts`.
15. **Vercel terms for end-user sandboxes** (§7.11, line 395) and Hobby limits (10 concurrent, 45 min sessions) mean nothing here runs meaningfully on a Hobby team; the free plan is modelled in `plans.ts` but gated by `PLAN_LIMITS`. `vcpu32` is Enterprise-only (pricing page Resource limits) and gated the same way.
16. **AI model-provider proxy (`/api/ai/*`, BUILD-SPEC §8 line 402) is brief b11** (D15, written after the first implementation round): v0 ships with `language_models` disabled on wasm (in-sandbox agents are the AI experience) and b11 owns streaming, per-user rate limits, key lookup from `secrets` (scope user) and `maxDuration`. Stated explicitly so the shell does not advertise providers; `proxy.ts`'s matcher and `lib/ratelimit.ts` gain nothing for it here.
17. **Retention notice e-mail.** `stepWarnRetention` marks `retention_warned_at` and calls a `notify()` hook; the mail provider (Resend via Marketplace, or Clerk e-mail) is not chosen here – gc only deletes rows that were warned, so an unwired hook delays deletion instead of deleting silently.
18. **Vercel Firewall rules** for `/api/webhooks/*`, `/sign-in` and BotID on `POST /api/workspaces` are dashboard configuration (documented in `README.md`), not code; the application-level `@upstash/ratelimit` windows in §3.7 are the enforced floor.
19. **b8 on disk lags the contract.** The b8 revision on disk (19:22, no §9) was derived from this brief's *previous* revision and predates D5/D8/D13/D18: it already reads `ZS_CONTROL_PLANE_URL` as the origin (adopted here), parses `expiresAt` as RFC 3339 (adopted here), posts `{ action, … }` for ports and NDJSON logs (both accepted here), but it expects `ActivityResponse { notices[], idleMinutes, sessionCapAt, serverTime, forwards }`, a bearer `restore-tarball` route, a `Manifest` without `session`/`allowedOrigins`/`repo.ref`/`proxySlots`/`jwt.portAudience` (and with `build.{server,client}`, `jwtPublicKeys[].spkiPem`, `repo.path`, `restore.{kind,tarballPath}`, `env.names`, `idle.idleMinutes`, `controlPlaneUrl`), `BootstrapVerifier` on `manifest.audience`, and its own loopback API on 8446 (item 20). §4.2's parsers accept every request body it sends; the response shapes, the manifest (D18/D19 fix them on this brief's names) and item 7(h)-(m) are what b8 must pick up. The integration point that fails first is the manifest — b8's `validate` rejects nothing, but the fields it reads are absent — which is exactly why `fixture_parses_with_sdk_schema` and b8's `example_manifest_parses` share one file (D19).
20. **Port map — unresolved, needs the tech lead** (also b2 §7.16, b4 risk 20). D8 declares proxy slots 8444-8447; BUILD-SPEC §6.2 line 302 and b8 put the health listener this brief polls on 8445 (D13), and D5/b8 put serve's control listener / the supervisor's loopback API on 8446. Two listeners cannot share 8445 or 8446 inside the VM, and the control plane cannot fix that by declaring ports. This brief keeps every port as data (`ZS_PROXY_SLOTS`, `ZS_HEALTH_PORT`, `ZS_RPC_PORT`), declares their deduplicated union at create, follows D8's literal range by default, logs the overlap at startup and emits `proxySlots` in the manifest; whichever way the map is settled (slots moved to e.g. 8447-8450, or health/control moved off 8445/8446), the change here is an env default and the manifest value, nothing structural.
21. **Timestamps vs `notices[]`.** With `ActivityDirective` the supervisor computes `idle_stop_in`/`session_cap_in` countdowns from `idleStopAt`/`sessionCapAt` against `serverTime` (b8 item 7l); `RESUMED` is raised by b8 from its marker and held until `session_active` (b8 `:786`), and b4's `on_session_attached` replays a pending `Resumed` after every fresh attach (b2 §9.2) — the control plane never sends notices, so a `STOPPING` cannot be lost in a queue (§8 R2-17). If the tech lead prefers b8's `notices[]` relay after all, the route gains a queue keyed on `(kind, issuedAt)` and `stop: true` stays as the backstop; nothing else in this brief changes.

## 8. Review log

Line numbers in "evidence" are those of the sibling briefs **as they stand now**; several reviewer citations pointed at earlier revisions (b1 §4.1 moved from ~343 to 427-495, b2 `ServeArgs` from ~430 to 554-577, b4 deleted `LifecycleHooks`), which is noted where it changed the verdict.

### Reviewer 1 – wrong claims

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | `WebSocketSessionRefresh::refresh` takes a third `cx: &mut AsyncApp` and returns `Task<Result<WebSocketSession, RefreshError>>` | **Accepted** (`b1:492-495`) | §2 row rewritten with the full signature and `RefreshError`. |
| 2 | Anchors: b1 struct span, b2 `ServeArgs` span, BUILD-SPEC 315/335/393-395/430, `postcss.config.mjs:1-7` | **Accepted, re-anchored to current files** – b1's struct is now `:427-447` (not 343-358 either), b2's `ServeArgs` `:554-577`; BUILD-SPEC `:315` (prebuild), `:335` (settings_docs), `:375` (CSP is `script-src 'self' 'wasm-unsafe-eval'`), `:393-395` (§7.11), `:430` ("no inline script"); postcss `1-7`. | Header, §2, §3.30, §4.1, §4.9, §7 citations updated. |
| 3 | `snapshot_not_found` (HTTP 410) is the expired-snapshot resume case; images page documents `image_not_ready`/`not_found`; snapshots page `snapshot_region_mismatch` | **Accepted** (`sandbox.js:24`, `sandbox.d.ts:652-653`, both doc pages fetched) | `SandboxError.code` gains `snapshot_expired` (non-retryable) and `snapshot_region_mismatch`; `connectWorkspace` fails fast with `sandbox_missing` and `stepFinishRun` clears the run id (§3.16, §3.19, §4.8). |
| 4 | `stop()` usage fields are optional; §6.6 fake shape disagreed with the handle | **Accepted** (tsc TS2322/TS18048 reproduced) | `SandboxHandle.stop()` returns `{ snapshotId?, snapshotSizeBytes?, usage: SandboxUsage }` with defaults; the fake returns the SDK shape and the handle maps it; a `{}` case is tested (§3.16, §6.6). |
| 5 | Status union includes `aborted`/`snapshotting`; `Sandbox.list()` is a `Promise<Paginator>`; `createdAt: number`; one tag per filter | **Accepted** (`sandbox.d.ts:446-460`, `paginator.d.ts`, tags page) | `SandboxStatus` type, `listByTag` awaits the promise and converts `createdAt`; gc uses a single `zs: <env>` tag (§3.16, §4.8). |
| 6 | `verifyWebhook(req)` needs `NextRequest` | **Accepted** (TS2345 reproduced; `RequestLike` at `server/types.d.ts:9`) | `handler` is generic over the request type; the Clerk route is `POST(req: NextRequest)` (§3.9, §3.24, §4.2). |
| 7 | `sql` never imported in §4.1 | **Accepted** | `import { sql } from "drizzle-orm"` added (§4.1). |
| 8 | Root `app/layout.tsx` (fonts, `globals.css`, body classes) applies to `/w/[id]`; a nested layout cannot opt out | **Accepted** (`app/layout.tsx:2-3, 22-26`; Next `layout.md:142-145`) | `app/layout.tsx` and `app/page.tsx` deleted; two root layouts `app/(site)/layout.tsx` and `app/(editor)/layout.tsx`; the tree and §3.26-3.28 rewritten. |
| 9 | `<SignIn />` throws outside `ClerkProvider` | **Accepted** (`withClerk` → `useAssertWrappedByClerkProvider`) | Sign-in page lives under `(site)`, whose root layout renders `ClerkProvider` (§3.27). |
| 10 | Health must be polled on `:8445` (BUILD-SPEC 302, b2 risk 12, b8 §4.4), not 8443 | **Accepted** | `probeHealth`/`stepProbeHealth` poll `domain(8445)`; `waitUntilReady` loop with 35 min / 3 min ceilings, `boot:<phase>` surfaced through `stateReason` (§3.18, §3.19, §4.8). |
| 11 | `restartSession` undefined | **Accepted** | `workflows/restart-session.ts` defined (§4.8) and tested (§6.6). |
| 12 | `stepStartChild` vs `stepRunChild`; seventeen step functions undeclared | **Accepted** (stub confirmed in `workflow/dist/api-workflow.js`) | §3.19 now declares every step used by §4.8/§4.10 (`stepRunChild`, `stepLoadWorkspace`, `stepResumeSandboxQuiet`, `stepStopSandboxDiscard`, `stepBumpGeneration`, `stepDeleteBlob`, `stepPurgeWorkspaceRows`, `stepCreatePrebuildRow`, `stepSetPrebuildStatus`, `stepStartSupervisorForPrebuild`, `stepWaitForCommandExit`, `stepPrunePrebuilds`, `stepListOrphanSandboxes`, `stepDeletePrebuildSnapshot`, `stepCloseStaleSessions`, `stepProbeHealth`, `stepPeekSandbox`, `stepFinishRun`, `stepRunStatus`, `stepWarnRetention`); `stepResolveSource`/`stepResolveSourceForRepo` removed (no git source). |
| 13 | Files missing from the tree (`lib/csp.ts`, bridge, `tests/helpers/setup.ts`, scripts, `/ports/[port]/open`, `restart-session.ts`) | **Accepted** | All present in §3's tree (bridge became `zs-host.ts`). |
| 14 | `ActivityResponse` shape disagreed between §3.25 and §4.2 | **Accepted, superseded** | Both now emit `ActivityDirective { idleStopAt, sessionCapAt, stop }` (§3.25, §4.2). *Amended after D13/D18: the ping carries `busy`/`phase`/`cpuBusyPct` and the directive adds `forwards`/`serverTime`; the b8 revision on disk still expects a `notices[]` queue — §7 items 19/21, §9.* |
| 15 | "Core 3 + cache components" attribution unverifiable | **Accepted** | Attribution removed; the quickstart sentence is quoted instead (§2, §3.27). |
| 16 | `getOrCreate` is only partially idempotent (params ignored, not resumed, dead session on retry, silent re-create on expired snapshot) | **Accepted** (persistence doc "Get or create", `sandbox.d.ts:648-656`) | `create()` passes `resume: true`, falls back to `get({ resume: true })` when not running, and the caveats are documented (§3.16, §7 item 1). |

### Reviewer 1 – missing items

| # | Item | Verdict | What changed |
|---|---|---|---|
| M1 | COEP + cross-origin `/files` fetches need CORS; "b2 defines none" | **Partially accepted** – b2 *does* implement CORS behind `--allowed-origin` (`b2:540`); what was missing is b9 delivering the origin | `manifest.allowedOrigins`, b8 follow-up (c), §3.22/§4.9 wording (§7 item 7). |
| M2 | `vcpu32` is Enterprise-only | **Accepted** (pricing page Resource limits: Pro max 8 vCPU / 16 GB) | `PLAN_LIMITS.machines` excludes it below enterprise; 402 tested (§3.13, §6.5). |
| M3 | Snapshot expiration counts from last use; 14-day platform retention | **Accepted** (persistence doc) | `retention_until` recomputed at each stop; gc acts on SDK answers; documented after §4.8. |
| M4 | Blob signed URLs make the restore-tarball route unnecessary | **Accepted** (`issueSignedToken`/`presignUrl` present in 2.8.0; signed-URLs page) | Route removed; `manifest.restore.tarballUrl` is a presigned `GET` URL minted per manifest fetch (§4.7). |
| M5 | Failed-run reconciliation | **Accepted** | `stepFinishRun` in every workflow's `finally`; sweep step 1 reaps terminal/stale runs; DELETE allowed once the run is terminal (§3.20, §4.2, §4.10, §6.5/§6.6). |
| M6 | Does `@workflow/vitest` run steps in-process? | **Verified: yes**, but the steps bundle is a separate module instance | Fake state lives on `globalThis` (§2, §6). |
| M7 | `readFile` auto-resumes; confirm `listSnapshots` does not | **Verified** (`withResume` call list in `sandbox.js`; `listSnapshots` is a plain client call) | Documented in §2/§3.16; `extendTimeout` also found to auto-resume → guarded (§7 item 2). |
| M8 | Minor SDK shapes (`cmdId`, `readFile({ path })`, snapshot rows, `domain` throws) | **Accepted** | `SandboxHandle` rewritten (§3.16). |

### Reviewer 2 – wrong claims

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | b8 disagrees on env var, `resume` command, manifest, activity, ports, git-token and logs | **Accepted** (every delta confirmed against `b8:118, 159-240, 257-282, 302, 689, 961-1010`) | b8 added to the must-agree list as the authority; `ZS_CONTROL_URL` = origin + `/api`; `onResume` runs `zs-agent resume`; §4.7 manifest is b8's `Manifest` field-for-field (plus ignorable extensions); activity/ports/git-token/logs contracts rewritten (§3.25, §4.2); `portSessionSecret` column and `session` block added; fixture contract test (§6.4). Two b8-side nits (`repo.ref`, settings as strings) filed in §7 item 7. *Amended during reconciliation: the b8 anchors cited in this row belong to a b8 revision that is not on disk; §2 re-anchors every row to b8 as it stands (`ZS_CONTROL_PLANE_URL` is the origin and there is no `ZS_CONTROL_URL`; `resume` is an alias of `start`; `expiresAt` is RFC 3339; logs are NDJSON-or-JSON; the HMAC `portSessionSecret` is gone — D8), D18/D19 fix the manifest on this brief's field names, and §9 lists what b8 must pick up.* |
| 2 | Clerk session token expires after 60 s; `fetch()` never handshakes; every shell call fails after a minute | **Accepted** (`isRequestEligibleForHandshake` source; "How Clerk works") | First-party `zs_editor` cookie minted by `proxy.ts` on document requests, `POST /session` re-mint, `requireViewer({ allowEditorCookie })`; tested (§3.8, §3.21, §6.5). |
| 3 | §4.6 contradicts b7's `start(config, host)` / `ZsHost`; `crossOriginIsolated`, `__wasm_call_ctors`, `hostOs`, `'unsafe-eval'` | **Accepted** for the contract shape and loader requirements (`b7:740-748, 850-871`). **Rejected** for "toasts and Keep alive are rendered in-canvas by b4": b4 deleted `LifecycleHooks` and the toast arm (`b4:663, 913`); the shell owns them. | §4.6 adopts b7 verbatim with optional host extensions; loader steps in §3.26; `ZS_CSP_UNSAFE_EVAL` decision (§4.9). |
| 4 | Reconnect after idle stop resumes the VM forever | **Accepted** | `reason: "reconnect"` on stopped/stopping → 409 `workspace_stopped`; only `open|resume` may resume; close 4004/1001 → phase `stopped`; test added (§3.26, §4.2, §6.5). b1 `RefreshError::Stopped` requested (§7 item 6). *D2 delivered `RefreshError::Stopped` (the shell rejects `refreshConnectInfo()` with `{ code: "stopped" }`); D3 folded 4004 into 1001 — §3.26 bullet 4 maps b7's `server_stopping` and `workspace_stopped` codes to `stopped`.* |
| 5 | `restartSession` missing; 3-attempt/7 s reconnect budget cannot survive a restart | **Accepted** for the workflow; **partially outdated** for the budget: b1 risk 5 now decides 20 attempts, 8 s cap, refresh inside `connect` with no timeout | `restartSession` keeps `workflow_run_id` set throughout; host `refreshConnectInfo` polls `202/423` for 5 min (§3.26, §4.8, §6.6). |
| 6 | `sessionId` must be the stable workspace id | **Accepted** (`b1:744`, `b2:748`) | `sid === sessionId === workspaceId`; `sessions` rows are internal; tests assert stability across stop/resume/takeover (§3.11, §3.18, §6.5). *Superseded by D1: the stable identity is `workspace_id` (JWT `ws`, `ZsBootConfig.workspace.id`); `sessionId`/`sid` is minted per connect and informational (§3.18, §6.5 `connect.test.ts`, §9).* |
| 7 | Same-tab reload prompts takeover; transport 409 unhandled | **Accepted** | `tabId` + `sessions.holder_tab_id`, silent same-tab takeover, 4005 → `takeover-required` (§3.18, §3.26, §4.2, §6.5). |
| 8 | Git `source` leaks a token into workflow state, clones twice, breaks shallow+sha and PR modes | **Accepted** (`b8:1209`, `b8:604-612`) | No git `source`; `repo.revision/ref/depth` in the manifest; tokens minted only in `/git-token`; risk 10 closed (§3.15, §4.7, §4.8). |
| 9 | Prebuild builders cannot authenticate | **Accepted** | `pb-` principals: regex, `prebuilds.sandbox_*` columns, `SandboxPrincipal.kind`, manifest branch, test (§3.12, §4.1, §4.7, §6.4/§6.5). |
| 10 | ES256 port token is a valid RPC token; b8 uses HMAC `v1.` tokens and `/__zs/auth`; `/open` route missing | **Accepted** (`b2:179-194` validates no `sid` binding; `b8:513, 1031-1033`) | `lib/port-session.ts` (b8 format), `/ports/[port]/open` → 303, `verifySessionToken` no longer used for ports, negative test (§3.12, §4.2, §6.1/§6.2). *Superseded by D8 and b8 §3.10 on disk (ES256 bootstrap token in `zs_port_token`, proxy-minted `zs_port_session` HMAC cookie under a per-boot key — the `v1.` HMAC format this row attributed to the control-plane token is the cookie's): `lib/port-token.ts` mints ES256 with `aud = <audience>/ports`, which closes the RPC-reuse hole this finding raised without any shared secret (§3.12, §7 item 4, §9).* |
| 11 | Failures after `stepCreateSandbox` brick the workspace; stopped VMs stay `running` | **Accepted** | Same as R1-M5 plus sweep step 2 (`stopWorkspace(reason "lost")`) and tests (§4.10, §6.5, §6.6). |
| 12 | `supervisorCmdId` not repopulated on resume; retried `stepResumeSandbox` skips `onResume` | **Accepted** | `startSupervisor` persists the cmdId inside `onResume`; `stepResumeSandbox` reads it back; `stop: true` directive as backstop; test (§3.18, §3.19, §3.25, §6.6). |
| 13 | Rebuild order not crash-safe; no restore columns | **Accepted** | Reordered (archive → bump → create → wait → delete old → delete blob); `restore_kind`, `restore_blob_pathname`, `previous_sandbox_name` columns; test (§4.1, §4.8, §6.6). |
| 14 | Reserved secret names override supervisor identity env | **Accepted** | `ZS_` prefix + denylist → 400 `reserved_name`; identity spread last; tests (§3.17, §3.18, §6.5). |
| 15 | Version skew after deploy; bundle delivery to `public/editor/` unspecified | **Accepted** | `workspaces.server_build/client_build`, per-workspace bundle, `scripts/fetch-editor-bundle.ts` prebuild with retention, same-origin rationale; in-place server upgrade deferred (§3.26, §3.30, §7 item 9). |
| 16 | CORS, not CSP, is the blocker; b2 has no CORS | **Partially accepted** – b2 implements CORS (`b2:540`); b9 now delivers `allowedOrigins` (§4.7, §7 item 7). |
| 17 | Queued STOPPING notice never delivered; unsaved buffers lost | **Accepted** | Notice queue removed; b8 raises STOPPING synchronously; `stopWorkspace` waits for the supervisor to exit (≤ 25 s ≈ 3 + 5 + 10 + 3 s, b4 `STOPPING_FLUSH_TIMEOUT` is 5 s now, not 2 s); `beforeunload` guard via `setDirty`; buffer autosave requested from b4 (§3.7, §3.26, §4.8, §7 item 8). *Amended: the autosave ask is replaced by D6 (dirty buffers snapshotted into the client-state image on `STOPPING`); `setDirty` by b7's `has_unsaved_changes()`; the exit wait stands and the cmdId-less fallback polls health instead of sleeping (D13); b8's budget now exceeds the 5 s flush (D18).* |
| 18 | Health on 8445 with b8's phases; 30-minute `postCreateCommand` | **Accepted** (duplicate of R1-10 with the ceiling argument) | 35 min first-boot / 3 min resume ceilings; `phase`/`lastError` surfaced (§4.8). *Amended: b8 on disk starts `serve` before `postCreateCommand` and reports `busy`/`phase` (D13), so the ceiling is rarely reached; a remote caller gets no `lastError` (b8 §4.4 reduced body) — `waitUntilReady` uses the supervisor command's exit code instead (§4.8).* |
| 19 | Usage must use VM wall time; key must not depend on a user session | **Accepted** | `stepRecordSessionEnd` uses `session_started_at`, key `stop:${workspaceId}:${sandboxSessionId}`; tests (§3.19, §4.5, §6.3). |
| 20 | `requireWorkspaceAccess({ orgId: null })` 404s org members on `/w` | **Accepted** | `page.tsx` uses `requireViewer()`; org membership from `memberships`; test (§3.8, §3.26, §6.5). |
| 21 | Shell cannot post to `/api/sandboxes/{name}/client-errors` | **Accepted** | `POST /api/workspaces/{id}/client-errors` (editor cookie) (§3.24, §4.2). |
| 22 | b2 implements `?token=`, not `zs_token` | **Rejected as stale**: current b2 uses `?zs_token=` (`b2:542-545, 719`) and b1 has no query placement at all (`b1:149, 576-583`) | §2 row corrected to the subprotocol form; §7 item 5. |
| 23 | `style-src` without `'unsafe-inline'` blocks SSR `style` attributes | **Accepted** (Next CSP guide `:44-60`) | No `style` props; CSSOM after mount; SSR test (§3.26, §4.9, §6.4). |
| 24 | Sweep does not scale; gc ignores env | **Accepted** (single-tag filter confirmed) | `sandbox_expires_at` cache, 8-way concurrency, 50 s budget with carry-over, single `zs: <env>` tag and env-prefixed names; perf and env tests (§3.3, §4.8, §4.10, §6.5/§6.6). |

### Reviewer 2 – missing items

| # | Item | Verdict | What changed |
|---|---|---|---|
| M1 | Service worker + PWA manifest | **Accepted** | `public/sw.js`, `app/manifest.ts`, headers, registration (§3.22, §3.26, §3.31). |
| M2 | `/api/ai/{provider}` pass-through | **Deferred explicitly** (§7 item 16) – out of this brief's scope; stated so nothing advertises it. |
| M3 | Admin surface, org management, audit pages | **Accepted** | `(dashboard)/orgs/[id]`, `audit`, `admin` pages; `api/admin/workspaces/[id]`; `requireOrgRole` (§3.8, §3.24, §3.27). |
| M4 | Invoicing / Stripe meters | **Accepted** | `lib/billing.ts`, `api/cron/invoice`, `usage_ledger.stripe_pushed_at`, webhook `invoice.*`, test (§3.14, §3.23, §4.1, §4.2, §6.3). |
| M5 | Abuse controls | **Accepted** with a data dependency | Sweep step 3 + `users.flagged_at` + creation refusal; egress cap in `PLAN_LIMITS`; `cpuBusyPct` must come from b8 (§7 item 7g). |
| M6 | Rate limits and Firewall for user routes | **Accepted** | `lib/ratelimit.ts` windows on create/connect/keepalive/secrets/client-errors; Firewall documented as dashboard config (§3.7, §3.23, §7 item 18). |
| M7 | Default-deny in `proxy.ts`; exclude sandbox/webhook/cron from the Clerk matcher | **Accepted** | `createRouteMatcher` + `auth.protect()` for the non-workspace API and dashboard pages; matcher excludes `api/sandboxes|webhooks|cron`, `sw.js`, `manifest.webmanifest` (§3.21). |
| M8 | `packages/sdk` | **Accepted** | §3.32, §5. |
| M9 | Idempotency for `POST /api/workspaces` | **Accepted** | `idempotent()` helper, kv key, test (§3.9, §4.2, §6.5). |
| M10 | Concurrent `/connect` race on `sessions_open_idx` | **Accepted** | `openOrReuseSession` transaction with `FOR UPDATE` and one retry on unique violation; test (§3.18, §6.5). |
| M11 | `keepAlive` bridge | **Accepted** | Host extension `keepAlive()` (§4.6); the toast button lives in the shell (b4 removed the in-canvas one). *b7 §3.21 declined `keepAlive` (no wasm-side caller in v0); the shell-side toast button is the whole mechanism (§4.6).* |
| M12 | Deployment-protection bypass decision | **Decided**: supervisor sends `x-vercel-protection-bypass` from `ZS_BYPASS_SECRET` (b8 follow-up d); env delivered by `supervisorEnvFor` (§3.18, §7 item 7). *Confirmed by D18; b8 on disk already sends it (`b8:289`).* |
| M13 | Client persistence/extensions on rebuild; `installed_extensions` never written | **Accepted** | Archive includes `vercel/.local/share/zed` and `vercel/.config/zed` (b8 must extract at `/`); `PUT /api/workspaces/{id}/extensions` fed by `onExtensionsChanged` (§3.19, §3.24, §4.6, §7 item 7f). *Amended: D9 fixes the tarball to exactly `/workspaces` + `$HOME/.local/share/zed` (`.config/zed` dropped — b8 rewrites settings from the manifest); b7 declined `onExtensionsChanged`, so `installed_extensions` is written by the supervisor's relay `POST /api/sandboxes/{name}/extensions` (D18/D19, §4.2).* |
| M14 | Twenty test gaps | **Accepted** – each listed case is now in §6.1-§6.6 (reconnect-does-not-resume, refresh-blocks-through-resume, same-tab-reload, session-id stability, run-id clearing, dead-VM reconciliation, new cmdId, rebuild crash safety, reserved secrets + identity wins, port token rejected, prebuild principal, manifest fixture, activity shape, CSP/no-style/COOP-COEP, editor cookie, `resume:false` assertions, usage idle tail/no-session, org member on `/w`, idempotency key, sweep perf, gc env). |
| M15 | `dotenv` version; SDK conformance test | **Accepted** | `dotenv 17.4.2` pinned (`npm view` 2026-09-02); `tests/sandbox-conformance.test.ts` (§5, §6.4). |
| M16 | `beforeunload` guard | **Accepted** via the requested `setDirty` host callback (§3.26, §4.6). *b7 declined `setDirty`; the guard calls b7's synchronous `has_unsaved_changes()` export instead (§3.26 bullet 6).* |
| M17 | Retention deletion notice | **Accepted** | `retention_warned_at`, `stepWarnRetention`, gc deletes only warned rows; provider left open (§3.19, §4.1, §4.8, §7 item 17). |

Post-review amendments (2026-09-02, after `DECISIONS.md`): the entries above record the state the reviewers saw. Rows whose outcome a tech-lead decision or a sibling delta later changed carry an italic note rather than being rewritten, so the log stays honest: R1-14 (activity shape, D13), R2-1 (b8 anchors and names), R2-6 (session id, D1), R2-10 (port token, D8), R2-17 (unsaved buffers, D6; no fixed sleep, D13), M11/M16 (host callbacks b7 declined), M12 (D18), M13 (D9, D18/D19). The full decision-by-decision record is §9.

## 9. Reconciliation log

Applied on 2026-09-02 against `docs/briefs/DECISIONS.md` (D1-D20) and the sibling briefs' sections 7 and 8 as they stand on disk (b1 20:06, b2 20:05, b3 20:05, b4 20:04, b5 20:02, b6 19:59, b7 19:39, b8 19:22). Every brief was grepped for `b9`; b3 and b5 address nothing to this brief (b3 §9: "b9 untouched"; b5 §9: "b9 address[es] nothing"). Everything re-stated about the Zed checkout was re-verified read-only (`zed/Cargo.toml:670`, `crates/remote/src/remote_client.rs:166, 639`, `crates/paths/src/paths.rs:144-160`, `crates/workspace/src/workspace.rs:11040, 11099`; `crates/remote_server/tests/`, `zed/vendor/` and `docs/contracts/` do not exist yet — b2, b1/b5/b6 and b8 create them); no cargo command was run and no file outside this brief was modified. Nothing was shortened: superseded text is replaced by the decided text with its rationale kept, and review-log rows carry notes instead of being deleted.

### 9.1 Decisions

| Decision | Touches this brief? | What changed |
|---|---|---|
| **D1** identity | Yes | `ConnectInfo.sessionId` is a fresh per-connect `con_…` id (`newConnectId`, §3.3) equal to the JWT `sid`; `MintInput.sessionId`, `mintSessionToken` sets `sid = sessionId` (§3.11); `sessions.last_connect_id` (§4.1); `ZsBootConfig.workspace.id = workspace.id` is the client's persistence identity (§3.26); `/connect` contract and tests no longer assert `sessionId === workspace.id` (§4.2, §6.1, §6.5); §2 b1/b2 rows; §7 item 3 rewritten as decided; §8 R2-6 annotated. |
| **D2** reconnect budget | Yes | `refreshConnectInfo()` rejects `{ code: "stopped" }` on `409 workspace_stopped` (→ `RefreshError::Stopped`, terminal) and `{ code: "unauthorized" }` after a failed `/session` re-mint; `reconnect_exhausted` handled as a retryable error with a "Reconnect" button; the shell's from-scratch `reconnect({ takeover?, resume? })` via `sessionStorage.zsNext` + reload (§3.26 bullets 2, 4, 5, 10; §4.6); §2 b1 rows; §7 item 6. |
| **D3** session semantics | Yes | Close-code mapping: 4001 (taken over / stale epoch), 4005 (busy), **1001 = server going away (the former 4004)**; `bootProgress("stopped", code)` vocabulary from b7 §3.28; page reload = fresh session (§3.26 bullet 4, §2 b1 row). Heartbeat/16 MiB: no shell impact. |
| **D4** terminal restore | No | Rows travel inside the client-state image the server stores; nothing here. |
| **D5** control listener | Yes | `manifest.allowedOrigins` → one `serve --allowed-origin` each (already emitted; §2 b2 rows updated for `--control-secret-file`/`--control-listen`, the loopback `/control/*` routes and `ZS_CONTROL_LISTENING=`); `manifest.extensions` is the list b8 installs through `POST /control/extensions { install }` at startup (§4.7); the stop sequence names the control listener (§4.8). |
| **D6** unsaved buffers | Yes | The autosave ask to b4 (§7 item 8, §8 R2-17) is withdrawn; `stopWorkspace` keeps the full flush window; the shell does nothing on `stopping` beyond the phase change (§3.26 bullet 4); §2 b4 row. |
| **D7** client-state store | Yes | Flush triggers in the shell are `visibilitychange` → `set_hidden(document.hidden)` + `flush_client_state()`, `pagehide` best-effort, `STOPPING` on the wasm side (§3.26 bullet 6; §2 b7 row); "Open in desktop" notes that the layout does not move to desktop (§3.26 bullet 5). |
| **D8** private ports | Yes | `ZS_PROXY_SLOTS`/`proxySlots()`/`infraPorts()` (§3.2), `lib/ports.ts` (§3.12: `allocateSlot`, `slotHost`, `privateForwardUrl`, `authRedirect`), `forwards.slot` + `forwards_slot_idx`, `workspaces.current_slot_hosts` replacing `current_proxy_host` (§4.1), `POST /ports` private → slot or 409 `no_free_slot`, `/open` → 303 `https://<slot-host>/__zs/auth?zs_port_token=<jwt>&next=/`, `ForwardView.slot`, ports response `slot` (§4.2), manifest `forwards[].slot` + `proxySlots` (§4.7), create declares the four slots and `slotHosts` are stored at create/resume (§3.19, §4.8), tests (§6.2 `slot_allocation`, §6.5, §6.6). The bootstrap token became ES256 (`lib/port-token.ts`, `aud = <audience>/ports`; §3.12) per b8 §3.10 — the `v1.` HMAC format of the previous revision is b8's *cookie*, not the token. Port-range collision → §7 item 20. |
| **D9** rebuild tarball | Yes | `stepArchiveWorkspaceDir` archives exactly `workspaces` + `vercel/.local/share/zed` relative to `/` (`.config/zed` dropped; §3.19, §4.7, §6.6 `archive_paths_are_exactly_d9`); §7 item 7(f) marked decided; §8 M13 annotated. |
| **D10** vendored deps | No | No Cargo changes, no `<org>` placeholder (grep verified); §2 Rust-fork row says so and re-points the yawc mention to `zed/vendor/yawc`. |
| **D11** wasm home | No | Client-side paths; nothing here. |
| **D12** web keymap | No (touch) | `hostOs` already passed; §3.26 bullet 1 notes b7 picks `web.json`/`web-macos.json` from it. |
| **D13** activity ping | Yes | `activityReport` zod: `busy`, `phase`, `cpuBusyPct`, `listening` (§4.2); the route treats `busy || phase !== "ready"` as activity (`keys.activity = now`, `keys.busy`, `state_reason = boot:<phase>` on a running row), feeds `keys.listening`/`keys.cpu` (§3.25, §3.7); the sweep guards idle stop on `keys.busy` and the abuse counter excludes busy (§4.10); **no fixed sleeps**: `stopWorkspace` waits on the command exit or polls health (`waitUntilGone`), `waitUntilReady` polls health and the supervisor's exit code (§4.8); `HealthProbe` is b8 §4.4's reduced body (§3.18); tests (§6.5 `busy_counts_as_activity`, `busy_workspace_not_idle_stopped`; §6.6 stop tests). |
| **D14** prebuild / b10 | Yes | `zs-agent prebuild` is b8's (§4.8 comments, §2 b8 row); `repos.prebuild_warm_command` → `ZS_PREBUILD_WARM_CMD` (§4.1, §4.8); the devcontainer image builder is brief b10 (§4.8 note, §7 items 7/19). |
| **D15** AI proxy / b11 | Yes | §7 item 16 names b11. |
| **D16** shell entry point | No | b1 adds it, b7 consumes it; the shell only supplies `ZsBootConfig`. §2 Rust-fork row records the existing `open_remote_project_*` functions for orientation. |
| **D17** terminal ownership | No | Nothing here. |
| **D18** supervisor contract | Yes | `supervisorEnvFor` emits `ZS_CONTROL_PLANE_URL` (origin) and `ZS_BYPASS_SECRET` (§3.18); `POST /api/sandboxes/{name}/extensions { installed }` is the relay target (§3.24, §4.2, tree); `repo.ref`, settings-as-strings, `cpuBusyPct` marked decided (§4.7, §7 item 7); the stop wait is sized for a stopping budget above 5 s (§4.8); the reserved-name denylist and tests name `ZS_CONTROL_PLANE_URL` (§3.17, §6.5). |
| **D19** control-plane contract | Yes | No git `source` (already; §4.8, §6.6); tarball per D9; installed-extensions relay consumed into `workspaces.installed_extensions` (§4.2); fixture path `docs/contracts/fixtures/manifest.example.json` everywhere (tree, §3.32, §4.7, §6 intro, §6.4 `fixture_parses_with_sdk_schema`); D13 honoured (§3.25, §4.10). |
| **D20** serve contract | Touch | `lastInputAt` excludes replays and the b3/b4 messages (§4.2 zod comment); `GET /extensions/{id}/assets/*` noted in the CORS row (§2). No shell change. |

### 9.2 Sibling deltas addressed to b9

| Source | Item | Change here |
|---|---|---|
| b1 §3.3 step 2/5 (`:245, :281-283`), §4.1 (`:426-560`), §7 items 3, 5, 9, 14 | `new(url, workspace_id, session_id, token)`; identity = `workspace_id`; `RefreshError::{Unauthorized, Stopped, Other}`; 1001 replaces 4004; host `reconnect()` builds new options; wasm 401 indistinguishable from transient failure. | §2 b1 rows re-anchored; `sid` per connect (D1); `{ code: "stopped" }` / `{ code: "unauthorized" }` rejections and the close-code mapping (§3.26); `reconnect()` as reload-from-scratch (§3.26 bullet 10); §7 items 3, 6, 8. |
| b2 §9.2 rows for b9 (`:1233-1236`), §7.3, §7.12, §7.13, §7.16, §7.19, §3.8 CORS (`:635`), §4 (`:905-928`) | `sid === workspaceId` superseded — "b9's claim minting must follow D1"; `?zs_token=` confirmed for `/files` downloads; `allowedOrigins` → `--allowed-origin` with `/extensions/*` in CORS and CORP `cross-origin`; polls 8445 confirmed; port clash; 4001 covers a stale epoch. | §3.11/§3.18 mint `sid` per connect; §2 b2 rows rewritten (CORS set, `ServeArgs` flags, control-listener contract, `sid` informational); §3.26 bullet 4 (stale epoch → `taken_over`); §7 item 20 mirrors b2 §7.16. |
| b3 | Nothing addressed to b9 (b3 §9). | — |
| b4 `:13` (b9 row), risk 21 (`onLifecycle` spelling), risk 20 (port map), risk 8/18 (relay, tarball), §4.2 (`{ install }` / `{ installed }` bodies, `url` per D8, slot refusal), §9 b9 row | `onLifecycle` kinds must be snake_case; installed extensions arrive through the supervisor relay; tarball per D9; the autosave ask is replaced by D6; a refused private forward is a non-2xx `{ error }`. | Snake_case kinds everywhere (§2, §3.26, §4.6); `POST /api/sandboxes/{name}/extensions { installed }` (§3.24, §4.2, §6.5); 409 `no_free_slot` with a message b4 surfaces (§4.2); D6/D9 applied; §7 item 20. |
| b5 | Nothing addressed to b9 (b5 §9). | — |
| b6 §9 (b9 §4 item 6 flush triggers) | `pagehide`/`visibilitychange` wording matches D7 (iii). | §3.26 bullet 6 names `visibilitychange` → `set_hidden` + flush, `pagehide` best-effort (D7). |
| b7 `:15` (header b9 row), §3.21 (`:622-628`), §3.28 (`:806-846`), §3.30 (`:885-897`), §4.2 (`:945-978`), §7 items 2, 9, 11, 20, §8 R2-2/3/5/7/16/17/20 | b9's copies of the contract predate the three-argument `start` and `onLifecycle`; `onClosed` accepted, `keepAlive`/`stop`/`setDirty`/`onExtensionsChanged`/`openExternal` declined; `set_hidden`/`has_unsaved_changes` exports; `bootProgress("stopped", code)` vocabulary; `connect.takeover`; `{ code: "stopped" }` mapping; `ensure_fresh_token` off `sessionExpiresAt`; CSP `'unsafe-eval'` owned by b7; reload-based reconnect; no query-string token. | §2 b7 rows and §4.6 rewritten to b7 §4.2 verbatim; §3.26 rewritten (three-argument `start`, `__zsCallCtors`, `__zsBindgenShimUrl`, `set_hidden`, `has_unsaved_changes`, `connect.takeover`, code mapping, `reconnect()`); `ConnectInfo.sessionExpiresAt` = token `exp`, `sessionCapAt` added (§3.18); `PUT /extensions` and the declined host extensions removed (tree, §3.24, §4.2, §4.6); §7 item 6. |
| b8 §7 items 2, 3, 4, 5, 9, 10, 11, 12, 16, 17, 18, 20; §2 rows citing b9 (`:44-52`); §3.3, §3.5, §3.6, §3.10, §3.11, §3.16, §4.1-§4.6 | Drop git `source`; shared fixture; private `url` = `/open` link; accept `phase`/`busy`; 303 to `/__zs/auth?zs_port_token=…`; slots 8444-8447; honour `busy`; wait on exit, not sleep; poll 8445 for phase; no env JWT fallback; tarball with data dir; unsaved buffers; private dotfiles; builder owner. Plus the on-disk shapes b8 sends (`ZS_CONTROL_PLANE_URL`, `{}` git-token body, `{ action }` ports, `ActivityPing` names, NDJSON logs, RFC 3339 `expiresAt`, `zs-agent resume` alias, reduced health body). | Every item is either done, decided (D8/D9/D13/D14/D18/D19) or listed in §7 item 7(h)-(m): §2 b8 rows re-anchored to the on-disk lines; `ZS_CONTROL_PLANE_URL` adopted (§3.2, §3.17, §3.18, §6.5/§6.6); request parsers accept b8's on-disk bodies (§4.2); `expiresAt` RFC 3339 (§4.2, §6.5); `HealthProbe` = reduced body and supervisor-exit detection (§3.18, §4.8); dotfiles OAuth token (§4.2); prebuild per b8 §3.16 (§4.8); the deltas b8 must still pick up are §7 items 19 and 21. |

### 9.3 Contradictions removed

- `sessionId === sid === workspaceId` (§2, §3.11, §3.18, §4.1, §4.2, §6.1, §6.5, §7 item 3; §8 R2-6 annotated).
- `ZS_CONTROL_URL` = origin + `/api` and the `b8:118-131` anchor (§2, §3.2, §3.17, §3.18, §6.5, §6.6; §8 R2-1 annotated).
- HMAC `portSessionSecret` in the manifest, `lib/port-session.ts`, `?t=<token>`, `workspaces.port_session_secret_ciphertext`, the "workspace" secret scope and its rotation (§2, §3.3, §3.10, §3.12, §4.1, §4.2, §4.4, §4.7, §6.1, §6.2, §6.4; §8 R2-10 annotated).
- Close code 4004 in the shell mapping (§2, §3.26); SCREAMING_SNAKE `onLifecycle` kinds; `start(configJson, host)` with `assets` inside the config; `setDirty`, `keepAlive`, `stop`, `onExtensionsChanged`, `openExternal` host extensions; `PUT /api/workspaces/{id}/extensions` (§2, §3, §3.24, §3.26, §4.2, §4.6; §8 M11/M13/M16 annotated).
- `vercel/.config/zed` in the rebuild tarball (§3.19, §6.6; §8 M13 annotated); the b4 autosave request (§7 item 8; §8 R2-17 annotated).
- `else await sleep("20s")` in `stopWorkspace` and the `lastError`-based fatal in `waitUntilReady` (§4.8); `keys.listening` written by the health probe (§3.7, §3.19).
- `zs-agent resume = start --resumed`, `TERM_GRACE = 10 s`, `POST_CREATE_TIMEOUT (:594)`, `write_jwt_keys (:624)` and every other b8 line anchor that does not exist on disk (§2, §3.11 rotation paragraph left as is since `write_jwt_keys` exists at `b8:756`).
- `tests/helpers/fixtures/manifest.json` as the shared fixture (tree, §3.32, §4.7, §6).

### 9.4 Unresolved after this pass

1. **Port map** (§7 item 20): D8's 8444-8447 vs the 8445 health listener and the 8446 control listener / supervisor loopback API — same open item as b2 §7.16 and b4 risk 20; this brief keeps the ports as configuration and follows D8's literal range by default.
2. **b8 amendment** (§7 items 19, 21, §7 item 7(h)-(m)): the b8 revision on disk must adopt §4.7's manifest, `ActivityDirective`, `jwt.portAudience`, the presigned `restore.tarballUrl`, `useHttpPath`, the proxy slots and the `/extensions` relay target; until then the shared fixture test on either side fails, which is the intended signal.
3. **b7's `server_stopping` naming** for close 1001 after D3 (§7 item 6) — cosmetic; the shell maps both names to `stopped`.
4. **Whether the host `reconnect()` reloads or re-dials in place** is b7's call (b7 §7.9, b4 §9); the shell implements the reload form and needs no change for the other.

### 9.5 Contract pass (2026-09-02)

Cross-brief mismatches found by the CONTRACTS.md audit and fixed here:

- §3.30: the bundle metadata is b7 §3.31's `build.json` (`build_id`), not a `BUILD_ID` file; `editor/<build>.tar` and `editor/manifest.json` are produced by b7 §6's nightly `web_bundle` job (named there now); `index.html`/`loader.js` are b7's dev harness and are not served — the served set is `zed_web.js`, `zed_web_bg.wasm`, `zed-assets.tar`, `build.json`.
- §4.7 `build` comment: b8 passes the image's `ZS_BUILD_ID` as `serve --client-build` (b8 §4.6), not `manifest.build`; equal at create, and a mismatch is only reported as `degraded`.
- §3.7: `"sandbox.extensions"` added to `LimitName`/`LIMITS` (30/60) — the limit was previously only a comment on the §4.2 route line.
- §4.7 `forwards[].url` is `string | null`, matching `ForwardView.url` (§4.2), the nullable `forwards.url` column (§4.1) and b8 §3.4's `Option<String>`.
- §3.18 `HealthProbe.phase` and the §4.2 activity zod `phase` enum gain `"warm"` (b8 §3.8 `Phase::Warm`, reported during prebuild; D14).
