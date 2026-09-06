# Handoff: Zed Codespaces

**Latest owner direction (2026-09-06): no tests in `zedspaces`.** All web,
supervisor, and image test suites, fixtures, test-only runtime helpers and CI
test jobs have been removed. Keep lint, type checking and production builds.
Tests in the separate `zed/` fork are unchanged. Older test plans, orchestration
scripts and results below are historical, not instructions to restore tests.
The test-heavy CI rerun `34051650584` was canceled during this cleanup.
No deployment was performed; multiplayer remains undeployed.
Cleanup validation: web lint/typecheck/production build, supervisor fmt/Clippy/release
build, actionlint, shellcheck, Dockerfile `--check`, and `git diff --check` passed.
The web build retained dynamic-filesystem tracing warnings; its packaging guard
passed (largest Function trace 15.5 MiB). Tests were removed, not run.

**Owner direction (2026-09-06, latest):** this is greenfield with no users.
Breaking production changes and removing obsolete code are authorized. Do not
add legacy modes or compatibility shims. This supersedes the older instructions
to preserve old editor generations. Multiplayer now replaces the web singleton
path: no feature flag or takeover UI. See [the current implementation](docs/briefs/multiplayer.md).
Before removal, the full Chromium suite passed 19/19; app/Rust checks and the production web build passed.
Multiplayer and layout also passed on Firefox and WebKit; see the brief for historical evidence.
Multiplayer is not yet deployed. Its fork implementation is published as
`648cf2f801`; the app and release-gate changes accompany this revision.
The production CI environment still lacks `VERCEL_TOKEN`.

**CI repair (2026-09-06):** multiplayer is pushed in app `dc6b60a` / fork
`648cf2f801`, not deployed. [Its build-only run](https://github.com/purduehackers/zedspaces/actions/runs/34044679645)
passed production WASM and app/supervisor checks, but browser E2E exhausted disk
and the Linux server runner received a shutdown signal (cause unconfirmed).
CI now disables debug/incremental build data, reclaims unused hosted-runner SDKs,
no longer builds native E2E binaries, fails builds without stale
binary fallback, and records disk/memory usage during builds. See deploy-vercel.md.

**UX follow-up (2026-09-06):** the deployed cleanup removes the extra HTML status strip,
fixes WASM title-bar padding and macOS Option shortcuts, bundles a Nerd Font plus
Dockerfile/HTML/TOML syntax, and makes new clones fetch full history. See
[current validation and publication state](docs/status/ux-cleanup.md); these
changes are live for new workspaces. Existing workspaces keep their old editor
until explicitly rebuilt; the owner's was not changed. The new manual release
CI is pushed (`a442675` in the app, fork `a1f0292686`) and its
[first build-only run passed](https://github.com/purduehackers/zedspaces/actions/runs/34016549327),
including native/WASM artifacts and production browser smoke. The `production`
environment exists and its public Blob secret is set; `VERCEL_TOKEN` remains
an owner setup step. That run did not deploy. The multiplayer implementation and
new greenfield direction above supersede the earlier single-client plan.

**Production deployment (2026-09-06 UTC):** the owner authorized deployment and
completed DNS. [code.purduehackers.com](https://code.purduehackers.com) is live
on Vercel, backed by real Vercel Sandboxes, Drizzle/Turso and private Blob storage.
Public GitHub clone, browser save and stop/resume persistence passed live.
See [deployment results](docs/status/deployment.md) for exact artifacts, evidence
and remaining unverified cases. This supersedes the historical cloud blockers
below. Deployment build/configuration fixes are now pushed in `a442675`;
the deployed CLI upload includes the required root package-manager metadata and
pnpm-hook upload exception. The owner's original local workspace was untouched.

**Source publication (2026-09-05):** the owner authorized committing and pushing
to `purduehackers/zedspaces` and forking Zed to `purduehackers/zed`. The private
app repository's `main` branch pins `zed/` to the public fork's default
`zedspaces` branch (renamed from `zs` at the owner's request);
the redundant editor-only branch in `zedspaces` was removed. The editor commit
and upstream history are preserved. Clone with `--recurse-submodules`; existing
clones should run `git submodule sync --recursive` before updating submodules.
This supersedes the uncommitted/unpublished
state recorded below; it does not authorize Vercel deployment or registry
publication. Local state and compiled artifacts remain ignored.

**Latest cleanup (2026-09-05):** the owner requested a minimal public-only app.
AI/key storage, billing, org/admin UI, custom-image builders and prebuilds have
been removed, not archived. The base-image workspace lifecycle remains. Read
[`README.md`](README.md) for the current feature set; older feature descriptions
below are historical. `purduehackers/zedspaces` is the private project
repository. Database migration history and
existing data were preserved. Cleanup validation is recorded separately in
[`docs/status/deslop.md`](docs/status/deslop.md).
**Local runtime caveat:** the original workspace URL on port 3100 now returns
404 after the app hot-loaded the SQLite control plane. Its legacy row was not
migrated; its sandbox directory and saved client state remain. Do not treat
the historical API/running claims below as the current state, or GC/recreate
that sandbox to make the new database look consistent.

Written 2026-09-04; continuation results updated 2026-09-05 UTC. Where a claim was not verified
it says so. Round 4's rebuilt 50-case matrix passed and the validated production bundle is now
locally published. One separate Firefox close-time panic remains unresolved.

**Round 5 continuation:** the control plane is now Drizzle + SQLite/libSQL
(Turso in deployment), login-free, and public-GitHub-only. No auth archive was
kept. The local 50-case browser matrix, workflow tests and real public clone
are validated; Vercel deployment is **not** validated or performed. Read
[`docs/status/round5.md`](docs/status/round5.md) and
[`docs/deploy-vercel.md`](docs/deploy-vercel.md) for current results and cloud
prerequisites. The original Postgres data was not migrated or deleted; new local
stacks use a separate SQLite file. Do not use the historical Postgres setup below
as instructions for starting the new app.
The historical stopped-state claim below is no longer current: a later read-only
check on 2026-09-05 found the owner's original workspace running, with
`started_at` 19:04 UTC. Round 5 did not stop, recreate, migrate or delete it.

## 1. What this is

GitHub Codespaces with Zed as the editor. The Zed UI runs in a browser tab compiled to
WebAssembly; a VM holds the files, the language servers, the terminals and git. The deployment
target is Vercel: Next.js for the control plane, Vercel Sandbox for the VM.

The editor **works today** against a local stack. A browser tab boots the real Zed, connects to a
real `remote_server` over WebSocket, opens the project and renders. That is the milestone the last
few days of work reached.

## 2. Read these first, in this order

| File | What it is |
|---|---|
| [`SCOPE.md`](SCOPE.md) | Feasibility study. Why this is possible at all, what upstream already provides |
| [`BUILD-SPEC.md`](BUILD-SPEC.md) | The end to end build specification. Architecture, per-crate port plan, transport, proto, sandbox image, control plane, security, pipeline |
| [`docs/briefs/DECISIONS.md`](docs/briefs/DECISIONS.md) | **D1 to D47. Highest precedence document.** Later decisions beat earlier ones, and all of them beat the spec and the briefs |
| [`docs/briefs/CONTRACTS.md`](docs/briefs/CONTRACTS.md) | Interfaces frozen between workstreams: env vars, wire formats, file layouts |
| [`docs/status/round3c.md`](docs/status/round3c.md) | What was broken in the browser and how it was fixed |

Precedence when they disagree: DECISIONS beats CONTRACTS beats BUILD-SPEC beats the briefs.
The continuation's measured results and remaining gaps are in [`docs/status/round4.md`](docs/status/round4.md).

The eleven implementation briefs are in [`docs/briefs/`](docs/briefs/): `b1-ws-transport`,
`b2-serve-mode`, `b3-terminals`, `b4-proto-additions`, `b5-wasm-build-env`, `b6-leaf-gates`,
`b7-edge-gates-entry`, `b8-supervisor-image`, `b9-control-plane`, `b10-devcontainer-builder`,
`b11-ai-proxy`. Earlier status pages are `round1`, `round2`, `round2b`, `round3`, `round3b`.

## 3. Where the code lives

```
wed/
  zed/                    fork of zed-industries/zed, 290 changed or new paths
  apps/web/               Next.js 16 control plane, the editor shell, the local dev stack
  sandbox/supervisor/     zs-agent, the Rust supervisor that runs inside the VM
  sandbox/image/          VM image and the devcontainer builder
  infra/workflows/        the multi-agent workflow scripts that built this
  docs/                   briefs, contracts, status
```

### Inside the Zed fork

**New crates, written for this project:**

- `zed/crates/zed_web/` — the browser entry point. Boot sequence, host bridge, connect, keymap,
  settings, window, workspace chrome, AI proxy client, test hooks. About 9,100 lines.
- `zed/crates/zed_web_core/` — host-testable logic split out of `zed_web` so it can be unit
  tested natively: settings merging, asset pack, AI proxy URLs, boot config. About 4,300 lines.
- `zed/crates/zs_smol_shim/` — a `smol` stand-in for wasm.

**Upstream crates that already existed and were barely touched:**

- `zed/crates/gpui_web/` — GPUI's browser platform backend. Upstream. 120 lines changed here.
- `zed/crates/gpui_wgpu/` — the WebGPU and WebGL2 renderer plus cosmic-text. Upstream. Untouched.

This matters: **GPUI was not ported to the web by this project.** Zed ships that. The work was
compiling the rest of the editor to wasm and running it against that backend.

**Vendored dependencies** are in `zed/vendor/` with a per-crate rationale in
[`zed/vendor/README.md`](zed/vendor/README.md): `alacritty_terminal`, `wasm_thread`, `lsp-types`,
`agent-client-protocol`, `yawc`, `async-tar`, `parking_lot_core`, `futures-util`, the `pet-*` family and four
tree-sitter grammars. Each has a recorded upstream revision and diff.

## 4. How to run it

```bash
cd apps/web
./scripts/dev-local.sh            # full local stack on port 3100
./scripts/dev-local.sh e2e        # native loop: create, connect, stop
./scripts/dev-local.sh browser    # Playwright suite on its own port 3110 and database
./scripts/dev-local.sh stop       # stop it
./scripts/dev-local.sh clean      # and wipe local state
```

Rebuild and ship the browser bundle:

```bash
cd zed && ./script/build-web --out-dir ../apps/web/public/editor   # about 10 minutes
cd ../apps/web && ./scripts/dev-repoint.sh <build-id>                # publish only
# Optional: append explicit stopped workspace IDs from the selected local SQLite DB.
```

Two flags matter. `--names` keeps the wasm name section so browser stack traces show Rust function
names instead of `wasm-function[N]`; it costs 40 MB and must never be left as the serving bundle.
`--test-hooks` builds the `window.__zs_test` surface the Playwright suite needs and stamps the id
with `-test`.

Two scripts drive the loop:

- `apps/web/scripts/dev-cycle.sh` rebuilds, restarts and **recreates the demo workspace**, so the
  `/w/<id>` URL changes.
- `apps/web/scripts/dev-repoint.sh <build-id> [workspace-id ...]` publishes a bundle.
  Only explicitly named stopped, non-busy workspaces in the selected local SQLite database
  are repointed; it never resumes or recreates them. It no longer accesses Postgres.

Diagnostics live in `apps/web/.zs-dev/`. The important ones:

- `netdiag.mjs <workspace-id> [takeover]` — console errors with the first panic in full, failed
  requests, non-2xx responses, WebSocket lifecycle. The `takeover` scenario opens a second session.
- `verify-theme.mjs` and `png-sample.mjs` — screenshot then decode the PNG and report the colors
  the editor actually painted, so a claim about theming can be checked rather than eyeballed.
- `timed-load.mjs` — cold and warm load timings per boot stage.

**Diagnose from console and network evidence, not screenshots.** That is a standing instruction
from the repository owner and it is what found every bug listed below.

## 5. Exact state as of this handoff

### Runtime at final handover

The editor bundle is served on port 3100 with the existing workspace, `ws_J06KWEVQRXBW76KCN96X`, at
http://127.0.0.1:3100/w/ws_J06KWEVQRXBW76KCN96X. It points at stripped bundle `c3cf80c0d-db30d12a`.
With owner approval, the app was restarted with that `ZS_CLIENT_BUILD_ID` and only this workspace's
`client_build` was updated. The workspace was left stopped; it was not resumed or recreated.
After a host-clock/suspend jump wedged Docker, the owner approved an OrbStack restart. That
recovery succeeded: PostgreSQL is healthy. The original workspace API returns 200/stopped after
a user-stop request at 2026-09-05 04:53 UTC; the continuation did not resume it.
At the approved local repoint (2026-09-05 18:58 UTC), the API, editor document, manifest and bundle
answered HTTP 200 with the new production build. Saved client-state metadata/database and snapshot
hashes were unchanged, as were all other workspace fields and rows. Browser boot was not run during
this repoint, to preserve the user's stopped state; the prior 50-case matrix covered this bundle.
Local Postgres runs in Docker as `zs-local-postgres`, credentials `zs` / `zs` / `zs` on port 55432.

### Shipped in that bundle

The current bundle includes D47, the settings-flush fix and the browser Shared-mutex fix. Ayu Dark
theme, the owner's dock layout, font sizes, vim mode, autosave and `disable_ai: true` remain. Current
production WASM: 74,946,370 bytes (19,909,006 brotli); measured validation timings are in round4.md.

### D47: now built and locally published

These two changes were initially left unbuilt. The continuation built and published them, then
verified the following behavior with Playwright in Chromium, Firefox and WebKit:

1. **First run layout.** `zed_web/src/workspace_chrome.rs` plus one line in `boot.rs`. A workspace
   that restored no client-state image opens the project panel and a terminal. A returning tab
   keeps whatever layout it left.
2. **Title bar trim.** `zed_web_core/src/web_settings.rs` sets `show_project_items: false` and
   hides the onboarding banner, avatar, sign-in and user menu, keeping branch and worktree.

The initial D47 production WASM was 74,918,667 bytes (19,907,627 brotli), with regression bundle
`c3cf80c0d-d115954e-test`; both are superseded by `db30d12a` builds. The D47 test executes the
automatically created shell, checks actual title-bar settings, closes the docks, flushes and reloads.

**No project/fork changes are committed.** The owner approved commits and local filesystem pushes
only inside disposable test fixtures; those tests have now run. The original fork had 290 dirty
paths; the new futures-util vendor patch adds another dependency directory. No project/fork push
or external publishing was performed. `checkout`, `stash`, `reset` and `clean` remain forbidden.

## 6. What was fixed recently, so you do not rediscover it

| Symptom | Root cause |
|---|---|
| Every wasm worker hung before reaching Rust | wasm-bindgen 0.2.120 to 0.2.126 put the thread counter and lock at `__heap_base`, inside dlmalloc's first arena. Pinned to 0.2.127 |
| Background queue never drained, silently | `wasm_thread` blob workers cannot resolve a root-relative URL for the glue import. The shim URL is now made absolute in `gpui_web/src/dispatcher.rs` |
| Boot hung at "Opening the window", then a `RefCell already borrowed` flood | `std::time::Instant::now()` panics on wasm. Thirteen live call sites moved to `web_time`, including the whole undo transaction chain |
| Takeover intermittently stalled with the same flood | Browsers forbid `memory.atomic.wait32` on the main thread. The thrown JS exception unwinds through wasm without running destructors and leaked gpui's `App` borrow. Fixed by vendoring `parking_lot_core` so a marked thread spins (D42) |
| Editor appeared to hang at "Starting the editor" | A `--names` debug bundle, 114 MB, was left as the serving build while dev sent `Cache-Control: no-store`, so every load re-downloaded and re-compiled it |

The wasm debugging playbook is in the memory file
`~/.claude/projects/-Users-ray-Projects-play-wed/memory/wasm-panic-diagnosis.md`.

## 7. Open items, roughly in priority order

1. **Done: build/publish D47.** The dedicated regression passes in all three browsers.
   The original workspace URL and data were preserved; see the current-state note at the top.
2. **Round 4: rebuilt 50-case browser matrix passed; one separate teardown edge remains.** Direct continuation
   was necessary because the Workflow runner was unavailable; cached implementation/review work was
   not redone. `round4-full-5` passed 50/50 in 6.6 minutes with all four projects explicit, zero skips
   or retries, and no server-log panic/trap. The Shared regression reuses each editor fixture,
   keeping the full suite at nine creates under the unchanged10/10min limit. Native
   create/connect/edit/save/stop/snapshot/delete E2E also passed (14 JS tests + one real Rust client).
   An earlier full run found an intermittent WebKit terminal-startup trap: `futures-util::Shared`
   used a std mutex, bypassing D42. The browser-only vendor fix is built in `db30d12a-test`:
   its deterministic regression passed three forced contentions per engine (nine total).
   Both `c3cf80c0d-db30d12a` bundles and the full rerun are now validated. Full4 also exposed a
   Firefox App/WebWindow RefCell panic during page closure, after its assertions had finished.
   Capture now extends through close; three focused reruns and full5 were clean, but that separate
   race is not diagnosed or fixed. Preserve all earlier reports.
   Fixture commits/local pushes are approved; project/fork commits/pushes are not. The original
   workflow resume command, if its runner returns, is
   `Workflow({scriptPath: 'infra/workflows/zs-impl-round4.js', resumeFromRunId: 'wf_e8f91ae9-fea'})`;
   its cached implementation/review agents should not be re-derived.
3. **Round 5 implemented directly; cloud validation remains.** The workflow runner was not
   available, so its implementation work was performed directly without spawning agents.
   Drizzle/Turso, SQL KV, open access, public-only GitHub clones, `/new/owner/repo` and the shared
   homepage are in source and locally validated. Old Clerk/GitHub App routes, login pages,
   unused App picker and their tests were deleted entirely, not archived. See round5.md.
4. **Two diagnosed races/artifacts are covered.** Smoke now observes the application's actual
   inventory reader: only one exact 200 response with all expected bytes, true EOF and no cancel
   can classify Chromium's `ERR_ABORTED` as an event artifact; real failures still fail (17 unit
   cases). Settings flush now awaits serialized PUT responses, including overlapping flushes;
   a held-PUT D47 regression passes in all three engines. These changes are in `d569708e` builds.
   The Shared-mutex fix in item 2 is not an HTTP/GPU problem: a tiny valid-address WASM
   wait reproduces WebKit's misleading out-of-bounds wording (`.zs-dev/wasm-wait-diag.*`). The Shared
   fix is now included in validated `db30d12a`; the open Firefox teardown edge is distinct.
5. **Owner confirmation is required for cloud setup/publication.** Vercel Pro project, Turso
   database, private Blob store, VCR access and image/editor-asset publication remain. No project
   or fork push is needed for local Docker builds or a future CLI deployment. VCR base-image
   inspection returned 401; no login or publication was attempted. The Linux server build path
   is `ZS_BUILD_ID=<matching-client-id> sandbox/image/build-server.sh --docker`.
6. **Bundle size.** 75 MB of wasm, about 20 MB brotli compressed. Chromium will not put a resource
   that large in its disk cache regardless of headers, so the local reload cost is real and only a
   smaller bundle fixes it.

## 8. Traps

- **Never leave a `--names` bundle as a workspace's `client_build`.** It is for reading stack
  traces, nothing else.
- **A running sandbox server pins the client build it accepts.** Repointing the database row is not
  enough; stop and start the workspace or the RPC socket closes immediately with an unclean close.
- **Zed persists dock visibility and the active panel per workspace**, separately from settings, in
  the client-state image. Settings changes to layout can look ignored until that is cleared. It
  lives at `$TMPDIR/zs-local/sb-dev-<workspace>/home/Library/Application Support/Zed/server_state/`.
- **`next dev` forks a detached telemetry flusher per start.** Across hours of restarts these
  accumulate as orphans and drove machine load to 195. `NEXT_TELEMETRY_DISABLED=1` is now set in
  `dev-local.sh`; kill strays with a pattern match on `detached-flush.js`.
- **Cargo in `zed/` shares one target directory and serializes on a lock.** Two agents building at
  once is slow but safe; a bundle build is about 10 minutes.
- **Put rustup first:** `PATH=/Users/ray/.cargo/bin:$PATH`. Homebrew Cargo/Rust otherwise bypassed
  the repository's 1.97.1 toolchain. Use Node 24 (`fnm exec --using=v24.19.0 ...`), not the host's Node 26.
- **Browser defaults are only Chromium + smoke.** Name `--project=chromium --project=firefox
  --project=webkit --project=smoke` explicitly for the full matrix. Preserve old artifacts with
  `ZS_KEEP_TEST_BUNDLES=1 ZS_KEEP_E2E=1`. Do not set `ZS_SKIP_LSP_TOOLS=1` for a full run; it skips
  completions even when the binaries are installed. One focused continuation run omitted the
  database preservation flag and pruned ten older browser-test databases plus its temporary one;
  reports/traces/bundles, owner/native databases and full5's database remain.
- **The owner's standing rules:** no commits or pushes unless asked; never run `git checkout`,
  `stash`, `reset` or `clean`; no outward-facing actions such as GitHub pushes or Vercel deploys
  without explicit confirmation.

## 9. How this was built, and the record of it

The work ran as multi-agent workflows, one per round, scripted in `infra/workflows/`. Each round
fans out implementation lanes, runs adversarial review lenses per lane, applies fixes, then
integrates and writes a status page.

Run transcripts, including every subagent's full tool history, are under:

```
~/.claude/projects/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/subagents/workflows/
```

Thirteen runs are recorded there. `wf_e8f91ae9-fea` is round 4, the one to resume; its
`journal.jsonl` holds one line per completed agent with its full return value.

The full conversation transcript for the session that produced all of this:

```
~/.claude/projects/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312.jsonl
```

Persistent notes carried between sessions are in
`~/.claude/projects/-Users-ray-Projects-play-wed/memory/`: `zed-codespaces-scoping.md` for project
context, `wasm-panic-diagnosis.md` for the browser debugging playbook, and `ray-build-over-docs.md`
for a working preference worth honouring, which is to spend time on code and validation rather than
on long documents.

## 10. Verification commands

| Command | Scope |
|---|---|
| `cd zed && ./script/check-wasm` | The whole `zed_web` closure, about 207 crates, for wasm32 |
| `cd zed && cargo check -p zed -p zed_web -p remote -p remote_server` | Native |
| `cd zed && cargo test -p zed_web_core` | 39 tests, settings merge and asset pack |
| `cd apps/web && pnpm exec tsc --noEmit && pnpm lint && pnpm test` | Control plane |
| `cd apps/web && ./scripts/dev-local.sh e2e` | Native create, connect, stop loop |
| `cd apps/web && ./scripts/dev-local.sh browser --project=chromium --project=firefox --project=webkit --project=smoke` | Full Playwright matrix: 50/50 passed on rebuilt `db30d12a` bundles, including Shared contention |
