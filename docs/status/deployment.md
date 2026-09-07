# Production deployment — 2026-09-07

Current production, verified 11:12 UTC: app `fe30d19`, fork `1ea9ecbca0`, matching
build `1ea9ecbca-34110736641.1`, deployment `dpl_9gpCr7SPcWHz5pz3qa7TyskxX4Bq`.
[Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34110736641)
passed; local authenticated publication deployed its matching image and assets.
Chromium's actual module reports the matching build, cross-origin isolation and
no test hooks. The disposable workspace upgraded through the update API, preserving files.
Production ZIP downloads passed save-before-download, 7.3 MB streaming, folder/
Unicode, ignored-file choices, integrity, path/origin refusal and temporary cleanup.
The rendering-cache accessibility fix is deployed; file-tree and tab semantics
now remain present across unchanged frames. Live Node debugging passed terminal
launch, child sessions, breakpoints, stack/variables, stepping and disconnect.
Real assistive-technology/mobile checks have not been run. Python live checks are
in progress. Inline REPL source and Linux protocol checks pass but are not yet live.
Owner workspaces were not modified; our verification workspace remains active.

## Earlier deferred-update verification — 05:53 UTC

Live: https://code.purduehackers.com, without login. Vercel project
`purdue-hackers/zedspaces`; production deployment
`dpl_5aj9gLgbmFWZ3mZKhcGvdqXzK2u9` is READY and aliased to the custom domain.

## Published release

- App source: `81f8f2ba4777c7d00e16612ea0e03dee645ba900`.
- Zed fork: `6981604fa82bac3f08f0508b78ae406d3c902f28`.
- Matching production WASM/server: `6981604fa-34083879179.1`; no test hooks.
- Workspace image:
  `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:56138f89e85a01670269298af61c4ff80db4aae00b133de477633be96e2aa109`.
- Public editor archive SHA-256:
  `afc10340484a60406194d36066abcd66ef9989149c257a971eb40b60df4a6706`.
  Uploaded bytes were downloaded and checksum-verified.
- Also served: `6981604fa-34083801978.1`, `4e766bcb8-34060994866.1`,
  `30a778718-34078287451.1`. Publication retains every live workspace's pin,
  plus the new and preceding deployed builds. The two `6981604fa` builds support
  deferred updates; earlier builds need one initial bootstrap upgrade.
- Update-capable workspaces open their pinned old editor, then cache the new
  JS/WASM/assets after interactive. Zed's existing update component displays
  progress, retry/dismiss and Restart to Update. The native confirmation offers
  Later and warns that shared terminals restart. Only consent mutates the sandbox.
- Product download/cache/lifecycle logic lives in the app. The fork adds the small
  web-only status/action bridge; upstream UpdateButton and prompt UI are unchanged.
- Public Git clones, anonymous multiplayer, Kintsugi/Ioskeley, person-icon avatars
  and automatic HTTP/WebSocket preview ports remain. Prompts/titles are unchanged.
- Port limit remains 12 previews plus RPC/health: 14 total. Fifteen declared ports
  previously caused Vercel Sandbox HTTP 500; do not restore that configuration.
- Turso schema, KV tables and FK enforcement passed a read-only check. No migration
  was needed or run. Owner workspaces and their data were not modified.

## Validation actually performed

Both [first-release CI](https://github.com/purduehackers/zedspaces/actions/runs/34083801978)
and [second-release CI](https://github.com/purduehackers/zedspaces/actions/runs/34083879179)
passed web lint/typecheck/build, supervisor/image checks and production server/WASM
builds. Actions used `deploy=false`; authenticated local Vercel publication deployed
the artifacts and app. The production CI environment still lacks `VERCEL_TOKEN`.
The browser fetch receiver correction passed
[web CI](https://github.com/purduehackers/zedspaces/actions/runs/34086184637).

Local production/diagnostic-feature WASM checks, native title-bar check, web
lint/typecheck/build, script syntax and diff checks passed. Vercel production
packaging checked 44 Function traces, largest 16.4 MiB; 19 existing dynamic-filesystem
tracing warnings remain. No test suite was added to or run in the app repository.
Temporary fault-injection diagnostics outside the repository exercised complete,
truncated, interrupted and superseded downloads, cache completeness, flush-before-
restart and refusal to reload a superseded release. These checks passed.

Disposable public `octocat/Hello-World` workspace `ws_XEVJRZVFEG1X0W34NRP4` started
on the preceding production build. Opening it bootstrapped generation 1 to the
first update-capable release in generation 2, preserving its uncommitted marker.
A live Chromium check found `fetch` called with an object receiver caused an
Illegal invocation before network discovery. Binding the default receiver fixed
this; the fix was deployed before the deferred-update validation below.

After publishing the second release:

- The already-open profile stayed on the first build and discovered the release.
- A fresh independent profile requested the old WASM at 05:45:32.220, reached ready
  at 05:45:36.153, then requested the new WASM at 05:45:36.801. Both actual running
  module IDs remained old, while all three new files were cached at exact lengths:
  JS 188,617; WASM 74,871,604; assets 37,591,040 bytes.
- An edit made and saved through Zed while the update waited was read back from
  the real sandbox. The generation and workspace pins had not changed.
- Native dismiss/check/retry controls were exercised. Choosing Later in the native
  restart prompt left generation 2 running. An outdated API target returned
  `409 release_changed` without changing the workspace.
- At 05:51:15, native Restart and Update initiated the rebuild. Both profiles
  received STOPPING and snapshotted client state. Both automatically reached ready
  by 05:52:25.635 on the second release in generation 3. Neither fetched WASM/assets
  again on reload; both consumed the staged CacheStorage responses. Discovery then
  returned `available:false` and the lifecycle run cleared.
- The exact two-line uncommitted marker, revision
  `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`, all three commits and
  `is-shallow-repository=false` survived. Git inventory showed only our marker.

Both profiles used normal cache settings, cross-origin isolation and production
bundles without diagnostic hooks. No panic or page error occurred. Existing
LM Studio/llama.cpp localhost probes still produce non-blocking CSP console errors;
CSP was not relaxed. Evidence came from console, network, DOM and sandbox reads,
not screenshots. Temporary diagnostics/artifacts are under
`/tmp/zedspaces-deferred-update.RfBNnC/` and ignored `apps/web/.zs-dev/` logs.

Cleanup completed at 05:59 UTC: the disposable workspace returns 410, and SDK
inventory for its exact sandbox-name prefix is empty. Its sandbox/snapshots were
deleted, not archived. Both automated browser profiles were closed. The existing
owner workspaces, including `ws_16XFMPW5J0WCZ9WRSYXQ` and its greeting, remain intact.

This release did not separately recheck Firefox/WebKit, stop/resume, unsaved-buffer
restoration, bidirectional editing, preview routing or pixel placement. The
[browser gap inventory](browser-gaps.md) is a source audit, not live feature testing.
