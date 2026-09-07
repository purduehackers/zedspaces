# Handoff: Zed Codespaces

**Latest owner direction (2026-09-07): remove calling entirely.** Calls, screen
sharing, their custom title-bar controls, host bridge, API, signaling, media CSP
allowance and TURN configuration are removed and deployed; the unfinished device
selectors are discarded. App `8bc7d90`, fork `9534a9d8fb`, matching build
`9534a9d8f-34158944970.1` are live at code.purduehackers.com. CI passed. Live
Chromium verified no call UI/bridge/media activity, API 404 and two-way editing/saving.
An old-build workspace automatically upgraded with its exact uncommitted file and
full Git history preserved. Collaborative editing and its approved avatars stay.
Only the new build may defer upgrades: older bundles require the deleted host ABI
and need a file-preserving bootstrap upgrade. Their pinned assets remain retained.

**Architecture constraint:** preserve Zed's native UI and functionality. Browser
support belongs at the web-platform boundary, so native editor behavior runs through
browser capabilities. Do not add custom feature/UI replacements inside Zed; explicit
owner-requested feature removals are allowed. This supersedes the calls priority and
any broader permission for fork changes below. Historical call validation is not a
request to restore calling.

**Earlier browser feature pass (2026-09-07; calls superseded above).** The sequence shipped:
clipboard, accessibility/input adapters, ZIP exports, debugger, inline Python REPL,
and audio/screen-sharing calls. App `55fd6cb`, fork `ad778ac746`, matching build
`ad778ac74-34127509100.1` are live. CI passed; local authenticated publication
deployed the matching image/assets and Vercel app. Live Chromium verified fresh/denied/delayed clipboard
reads, Vim registers, terminal text, PNG-to-Markdown paste, full-document accessible
text and IME composition without consuming candidate-navigation keys. Firefox and
WebKit also booted and passed text clipboard checks. Real assistive-technology and
physical mobile/IME checks have not been run.
Production ZIP checks passed: save-before-download, 7.3 MB streaming download,
folder export, Unicode, ignored-file choices, integrity, confinement and cleanup.
The cached semantic-subtree fix and modal/composite keyboard handling are deployed.
Live Node debugging passed terminal launch, child sessions, breakpoints, stack,
variables, stepping, continue and disconnect. Live Python launch, breakpoints,
stack/variables, stepping, continue and terminate also pass. New-tab task/debug
configuration replay and debugger control labels are in the deployed release.
Inline Python executes live: Unicode, persistent values, Markdown/PNG, errors and
input() pass through the real editor. The browser-clock and control-reply fixes
are deployed. Run, Interrupt (namespace retained), Restart (fresh namespace), and
Shutdown pass through the actual editor on the published image. Kernels use the
private process tunnel, not preview ports. Production protocol checks also passed
missing-ipykernel errors, token replay rejection and process cleanup.
Calls are deployed: native Zed controls, three-peer joins, actual tab capture with
decoded remote video, screen stop, leave/rejoin, origin and participant-secret guards
pass. The 19:42 UTC app-only follow-up fixes Chromium receiving packets without
decoding audio: remote playback now uses media elements, not a Web Audio-only graph.
Nonzero synthetic audio decoding and mute/deafen pass locally in Chromium/Firefox
and through production's native controls; blocked-playback retry also passes locally
and in production Chromium. No fork/image change.
The real built-in mic opened but supplied silence with the MacBook lid closed (Apple's
hardware mic disconnect); spoken audio is not verified. Optional TURN is unconfigured.
Secondary Vim clipboard checks pass: insert-register, dot repeat, motion/object
replacement, cancellation, Helix paste action and macros suspended during reads.
A stale browser picker click caused a command-palette bounds panic; the web-only
guard is deployed and delayed stale-row focus/click checks pass. TypeScript source-map
breakpoints/stepping pass, including two fast-start launches using the adapter's
`runtimeSourcemapPausePatterns` setting; see README. One Atomics.wait exception on
the older `042113f25` build was not reproduced and remains unclassified.
Folder context-menu downloads and aborted-stream temporary cleanup also pass.
Current diagnostics: `/tmp/zedspaces-browser-features.qRKGq9/`.
See [deployment evidence](docs/status/deployment.md) for release pins and cleanup.

**Approved feature order (2026-09-07):** clipboard → accessibility/input → project
and folder ZIP export → debugger (JS/TS, Python first) → inline Python Jupyter REPL
→ calls (audio and screen sharing first). Native/desktop integration is permanently
out of scope, not a backlog item. Reuse Zed's components through browser-specific
adapters; sandbox services and product behavior belong in Zedspaces. ZIP exports
contain working files, not recovery/editor-state archives. Full notebook editing,
camera video and a contacts/account system are not included in this first pass.

**Owner direction (2026-09-06): finish through publication.** Commit, push and
deploy completed project changes without asking again. This supersedes older
permission gates below; it does not authorize unrelated actions or destructive
Git commands. Verify the matching release on production before handing it back.

**Owner direction (2026-09-06): keep the Zed fork close to upstream.** Only
necessary web/runtime integration and explicitly approved UI changes belong in
`purduehackers/zed`. Product behavior, sandbox configuration and deployment belong
in `zedspaces`; use settings/assets/host integration before changing shared Zed
components. Keep shell prompts and terminal titles as they were. This overrides
older plans for extra fork features.

**Deferred editor updates deployed (2026-09-07 UTC).** App `81f8f2b`, fork
`6981604fa8`, matching WASM/server `6981604fa-34083879179.1` are live at
code.purduehackers.com, committed and pushed. Update-capable workspaces boot their
pinned editor first, then cache the new bundle after reaching interactive. Zed's
unchanged native `UpdateButton` shows download progress and Restart to Update;
its in-canvas confirmation offers Later and warns that everyone's terminals
restart. Only confirmation starts the existing file-preserving rebuild. The fork
contains a small web-only status/action adapter; download/lifecycle logic lives
in the app. Pre-adapter builds need one bootstrap upgrade before they can defer.
Release publication retains every live workspace's pinned browser bundle.

Two production releases verified the actual deferred path: a fresh independent
Chromium tab loaded the old build before downloading the new one, editing/saving
continued while ready, and Later left the old sandbox running. Confirming update
restarted both profiles on the new build without downloading WASM/assets again.
The exact uncommitted file and full Git history survived generation 2 → 3.
Native check/retry/dismiss controls also worked. CI/checks and production builds
passed; no repository tests were added. A browser-only fetch receiver bug found
during live verification was fixed and redeployed. Existing owner workspaces were
not modified. See [deployment evidence](docs/status/deployment.md) and the
[browser stub inventory](docs/status/browser-gaps.md).

**Fork cleanup + automatic ports deployed (2026-09-07 UTC).** App `c6343dc`, fork
`30a7787187`, and matching WASM/server `30a778718-34078287451.1` are live at
code.purduehackers.com. Both repositories are committed and pushed. Compared against
upstream base `c3cf80c0d1`: removed the abandoned AI-proxy client, edit-prediction
proxy, provider overrides, origin plumbing and their tests; restored upstream
language-model tests and provider registration except required WASM dependency
gates. Removed the unused desktop workspace-opening wrapper, desktop restore
guards and test-only `run --user-data-dir` addition. The sandbox server is now
opt-in via `--features serve`, already used by both Zedspaces image build paths.
Required WASM/threading/filesystem/SQLite/transport adaptations, multiplayer,
browser shortcuts, language support and approved appearance changes remain.

The shipped avatar change uses a person icon in web-only title-bar code;
the shared `Avatar` component is unchanged. Animal artwork is removed, but names
and colors remain. Reverted the proposed shell prompt, terminal title and terminal
localhost-link rewriting changes. Automatic port exposure remains entirely in the
app/supervisor: 12 reusable public HTTP/WebSocket proxy slots (8444–8447,
8452–8459), plus RPC 8443 and health 8448. Live Vercel create/update calls returned
HTTP 500 with 15 declared ports but succeeded with 14; do not restore the 15th.
Control/VM services are excluded. Closed listeners free slots; explicit unforward
stays off until the listener closes. No database migration.

Local validation: production and diagnostic-feature WASM compile checks, native
server compile checks with/without `serve`, and 19 existing `zed_web_core` checks
passed. Release CI built both production Zed artifacts; the final port fix passed
web and supervisor CI. The image is ready in VCR and Vercel production is READY.
Live verification passed automatic upgrade/recovery with full Git history and an
uncommitted file preserved, simultaneous boot in two Chromium profiles, and
automatic IPv4/IPv6 HTTP/WebSocket exposure plus closed-listener removal. No root
test suite was added or run. Upstream local-AI provider probes emit non-blocking
CSP messages; no browser panic or page error occurred. Exact artifacts, limits and
cleanup are in [current deployment evidence](docs/status/deployment.md).

**Automatic upgrades + appearance deployed (2026-09-06, 22:03 UTC).**
App `c6d4151`, fork `4e766bcb8e`, matching production WASM/server
`4e766bcb8-34060994866.1` are live at code.purduehackers.com.
[Release CI passed](https://github.com/purduehackers/zedspaces/actions/runs/34060994866);
local Vercel authentication published the image/assets and deployed the app.
Opening/resuming an outdated workspace now starts the existing file-preserving
rebuild before loading WASM. Image, server and client pins move together; retry
uses the preserved archive, and duplicate upgrade runs are no-ops. Connected tabs
wait through STOPPING/backup/create before reloading; ordinary idle stops do not
auto-resume. Rebuild recovery pointers now survive child-create success until
parent cleanup, and clear atomically before deleting the archive.
Live verification: an old workspace returned `202 upgrading`, then moved to the
new image/build. Its existing browser automatically reloaded; both independent
Chromium profiles reached ready on the new bundle. The opening tab requested no
editor assets until the upgrade completed. Repository revision and original
uncommitted file contents survived. Stop/resume and stale-client/reconnect guards
also passed. CI/local checks passed; no test suite was added or run.
The verification workspace `ws_16XFMPW5J0WCZ9WRSYXQ` was left intact after someone
added a greeting to its file. Automated browser sessions were closed. Do not wipe it.
See [current deployment evidence](docs/status/deployment.md) for exact artifacts and limits.

**Appearance (included in the release above).**
Fork `4e766bcb8e` bundles the owner's Kintsugi theme and Ioskeley fonts (UI 15px,
Nerd Font buffers 14px with `aalt`, same Nerd Font in terminals). Browser presence
uses 32 bundled animal avatars and matching Anonymous Animal cursor labels;
round avatars occupy the title bar's far-right controls, with names on hover.
`check-wasm -p zed_web`, the fork's six existing settings checks, and asset
inventory validation passed. CI's production pack contains all eight font faces,
32 animal SVGs and the Kintsugi theme; two browsers booted that bundle live.
Logs: `apps/web/.zs-dev/animals-theme-{wasm-check-2,settings-check}.log`.

**Workspace wipe (2026-09-06, owner-authorized):** all seven production workspaces
and three old build/check sandboxes were deleted. Final inventory: no sandboxes,
recoverable snapshots, private workspace blobs, open sessions or visible workspaces.
Only audit/deletion metadata remains; repositories and release artifacts were kept.

**Multiplayer deployed (2026-09-06, 20:19 UTC):**
[code.purduehackers.com](https://code.purduehackers.com) serves app `8e2e3df`
and matching production WASM/server `648cf2f80-34054725092.1` (fork `648cf2f801`).
[Release CI passed](https://github.com/purduehackers/zedspaces/actions/runs/34054725092);
image/assets and Vercel deployment were published with the existing local Vercel login.
The Turso multiplayer index migration is applied. Two independent Chromium sessions
edited bidirectionally; the survivor saved after the first closed, and the exact
126 bytes were read back from the real sandbox. Normal-profile boot passed with
cache unchanged. See [deployment evidence and diagnostic caveat](docs/status/deployment.md).
This is live for **new workspaces**. Existing owner workspaces were not changed;
old generations need recreation. Only the current editor bundle is served.

**Latest owner direction (2026-09-06): no tests in `zedspaces`.** All web,
supervisor, and image test suites, fixtures, test-only runtime helpers and CI
test jobs have been removed. Keep lint, type checking and production builds.
Tests in the separate `zed/` fork are unchanged. Older test plans, orchestration
scripts and results below are historical, not instructions to restore tests.
The test-heavy CI rerun `34051650584` was canceled during this cleanup.
Cleanup was pushed as `8e2e3df` and deployed in the release above.
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
Multiplayer is deployed in the release above. Its fork implementation is published as
`648cf2f801`; the app and release-gate changes accompany this revision.
The production CI environment still lacks `VERCEL_TOKEN`; local authenticated
CLI publication works without adding one.

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
  settings, window, workspace chrome and diagnostic hooks. The obsolete AI proxy is removed.
- `zed/crates/zed_web_core/` — host-testable logic split out of `zed_web` so it can be unit
  tested natively: settings merging, asset pack, host detection and boot config.
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
- **The owner's standing rules:** finish completed changes through commit, push and deployment
  (latest authorization above). Never run `git checkout`, `stash`, `reset` or `clean`.

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
