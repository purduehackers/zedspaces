# Production deployment — 2026-09-08 UTC

Current production: app `11ee08a`, fork `f9f6d3a98e`, build
`f9f6d3a98-34207705070.1`, deployment `dpl_5v6fv2WjpjSoJAS1iNzoSEi3Eg99`.

- [CI](https://github.com/purduehackers/zedspaces/actions/runs/34207705070),
  matching image/assets publication, Vercel deployment and public verification pass.
- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:426ed9300764506b7abdb64310141edaeba533d6c2ea83d1c1a0f27204bc90c9`.
- Editor archive SHA-256: `102be18576d74de044d6c0d3c94cdaf40dc1b8ad76e31688b0099298610908b0`.
- Live Chromium: native Node PID picker/attach, completion controls/active selection,
  ArrowDown/dismissal, picker query focus, and folder drops after keyboard input pass.
  Scratch generation 3 retains exact README/baseline/uploads and three Git commits.
- Source follow-up buffers early adapter logs (the native log view was empty).
  Physical `space f` inside command-palette text still triggers file finder.
  Extension marketplace/runtime source checks pass; publication and live checks pending.
  No claim of real screen-reader/physical-device validation. Scratch cleanup pending.

Previous production: app `6ad97fd`, fork `7b39240f7e`, build
`7b39240f7-34200616408.1`, deployment `dpl_BVNdGaoh3mjkf8kPokEeyE6jgCSv`
at code.purduehackers.com. Browser files/imports/save adapters, completion/action
semantics and the sandbox-only Astro documentColor correction are deployed.

- [CI](https://github.com/purduehackers/zedspaces/actions/runs/34200616408) and
  matching-image/assets publication, Vercel deployment and public verification pass.
- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:f2a49089995cd3914d33153abc678a238a7bfde9959c9de9ffd670336ce30021`.
- Editor archive SHA-256: `dfc248ac361f0498ec4ef58ad20e917d6b332bdd2aa2e0b8e59e27bb5fbe4e9a`.
- Full WASM checking and isolated Chromium/Firefox/WebKit picker/download, nested
  directory, size/path rejection and save completion/error probes pass. Real Astro
  LSP documentColor returns an array for colored and colorless files after the patch.
- Live Chromium loads the actual published bundle (no route override) and uploads
  Unicode and binary files through its browser chooser; independent sandbox readback
  matches. Scratch `ws_WMJ3FX55AZ0PC8MG84F8` upgraded with the original README,
  uncommitted baseline and three Git commits preserved. Validation/cleanup ongoing.
- Real Node PID attach and evaluation pass a production DAP probe. The failed
  fixture lacked `type: node` and an IPv4 address; native process selection itself
  already uses remote RPC. Next source batch exposes adapter logs and picker labels.

Previous production: app `8db1569`, fork `cf857ded3c`, matching build
`cf857ded3-34188201299.1`, deployment `dpl_8cbSMBc9KX6chA7X5NgvUWHdwkYf`
is READY at code.purduehackers.com. Astro's upstream grammar/configs and installed
language server are connected through the web-language adapter, including its
TypeScript plugin. TOML now uses Taplo. Native Zed UI is unchanged.

- [Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34188201299)
  passed; matching image/assets were published and Vercel/public verification passed.
  Full WASM checking, Rust formatting/diff checks, native Astro/query/embedded-grammar
  checks and real Astro/Taplo LSP probes passed. Both TS server plugin probes passed;
  Astro/vtsls also passed inside the Linux image. No repository tests added/run.
- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:d7cde8ba82adc089dad81fb06ddadca48e9b738f2ab7b8bad38718242ada0150`.
- Editor archive SHA-256: `a5d70dafa5021f750625d25f4a5f88815dfdc7038943e68711e5bed3b4cb569b`.
- Live Chromium: native Copy Highlight JSON verifies Astro and injected TS/CSS
  tokens; diagnostics, default formatting/save, method-completion acceptance and
  TS import → Astro component definition pass. Taplo formatting/save and conflicting
  key diagnostics pass. Saved bytes were independently read from the sandbox.
- An old-build scratch workspace upgraded with identical fixture hashes, original
  README and full three-commit Git history. Only the current and previous
  `446d547b1-34183434009.1` builds may defer updates; live older pins remain retained.
- Known limitations: Astro/Volar returns null document colors for colorless files,
  causing a non-blocking Zed deserialization warning. Native completion acceptance
  works, but its suggestions are not exposed as semantic list options. No browser
  panic/page error; existing local-AI CSP and an untracked-file blame warning were
  observed. This pass did not run Firefox/WebKit, physical-device or real AT checks.
- The local image built, but its size guard failed on an inherited 1.38 GB base
  layer. The new Astro layer is 102 MB; VCR accepted and prepared the published
  image. All 47 Function traces passed, largest 16.4 MiB.

Temporary diagnostics: `/tmp/zedspaces-languages.YPK2G1/`. The final inventory
contained only our `language-fixture/` and its installed dependencies; the only
source changes from baseline were native formatting of Astro and TOML fixtures.
Cleanup verified: `ws_SHGE4PAVEQP4FBAFA527` returns 410 and its exact-prefix SDK
sandbox inventory is empty. Diagnostic browsers are closed; no owner workspace changed.

## Previous touch-focus release — 2026-09-08 UTC

Previous production: app `e01c4b7`, fork `446d547b19`, matching build
`446d547b1-34183434009.1`, deployment `dpl_DK7tQQsYQj1vwAMNgnEM6ht9z4wY`
is READY and aliased to code.purduehackers.com. One `gpui_web` file fixes keyboard
focus after non-text touch taps and IME editability after hardware commands enter
text mode. No native Zed UI changes; calls remain removed.

- [Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34183434009),
  local full `zed_web` WASM checking, formatting and diff checks passed. Matching
  image/assets were published locally after CI, then Vercel deployed and public
  verification passed. No repository tests were added or run.
- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:d2f6970bf294285068cb9fb11ecf6791a9f43a1286fca26dac515c8d9a2d8e7e`.
- Editor archive SHA-256: `13bc6958cfd0c1a08aa705f6a49192af033d2515d011555bcd2f2f8b49be9130`.
- The old-build focus failure and its separate non-screen-reader IME failure were
  reproduced. The deployed bundle passed touch emulation in Chromium/Firefox/WebKit
  with screen-reader mode on and off: Normal tap, Insert, Unicode, Escape,
  navigation and save. Chromium also passed browser IME composition, touch pan/cancel
  and host-field focus isolation. Semantic Tab exit/touch return passed in all three.
- Desktop checks passed in all three engines, plus Linux-style modifier emulation
  on macOS. Temporary diagnostics used the actual new bundle, without focus shims.
  Physical phones, keyboard layouts/IME and real VoiceOver/NVDA were not tested.
- The scratch upgrade preserved the exact pre-upgrade file (verified after removing
  only the known new diagnostic edit) and full Git history. Only the current and
  previous `4d657e7c9-34171767602.1` builds may defer upgrades; live older pins remain
  retained. All 47 Function traces pass; existing tracing/local-AI CSP warnings remain.

Cleanup verified: `ws_M2FK7WCVHQ580K3F9XHW` returns 410 and its exact-prefix SDK
sandbox inventory is empty. Before deletion, the final 7,470-byte file matched the
browser's SHA-256 and only our `input.txt` was untracked. No owner workspace changed.

## Previous input-adapter release — 2026-09-08 UTC

Previous production: app `85aaa48`, fork `4d657e7c95`, matching build
`4d657e7c9-34171767602.1`, deployment `dpl_2hpfwWzgM5mshKwmvPwDhqmugC73`
is READY and aliased to code.purduehackers.com. Five `gpui_web` files implement
layout-aware shortcuts, input/key-release filtering and semantic accessibility
focus/state fixes. No native Zed UI was added or replaced; calls remain removed.

- [Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34171767602)
  passed app/supervisor checks and matching browser/server builds. Local formatting,
  full `zed_web` WASM checking and diff checks passed. No root tests added/run.
- Authenticated local publication deployed the matching image/assets and Vercel app
  after CI (`deploy=false`). Public release verification passed.
- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:f90b8c2b3613837fa3f72d00df1506597489ec2e1cada20f4a09a7d8ff29fad9`.
- Editor archive SHA-256: `cca8895774f66ea0461e5018d7dc75dc13d35f82a508674a8f2d51d92b758b51`.
- Live desktop Chromium, Firefox and WebKit passed layout/fallback, Unicode,
  modifier, save and Tab checks; Chromium also passed IME and full-text AX checks.
  Linux modifier emulation passed on macOS; this was not physical Linux testing.
  Temporary isolated adapter probes passed hidden/disabled focus and live/busy
  semantics across all three engines. These probes are not full-editor e2e tests.
- Touch emulation failed: a file-tab tap in Vim Normal mode can leave focus on the
  page. Mobile support remains unfinished. Real VoiceOver/NVDA and physical layouts,
  IME and phones were not tested. Existing local-AI CSP warnings remain blocked.
- The disposable workspace upgraded from `9534a9d8f-34158944970.1` with its exact
  uncommitted Unicode fixture and full three-commit Git history preserved. Final
  saved bytes matched the sandbox readback. Only current and calls-removal builds
  may defer upgrades; older owner-workspace assets remain retained.

Cleanup verified: scratch workspace `ws_PHGMMHMDH554XQ7PRY1R` returns 410 and
its exact-prefix SDK sandbox inventory is empty. Only our `input.txt` fixture was
untracked before deletion. Diagnostic browsers are closed; no owner workspace changed.

## Previous calls-removal release — 2026-09-07 UTC

Previous production, verified 21:03 UTC: app `8bc7d90`, fork `9534a9d8fb`, matching
build `9534a9d8f-34158944970.1`, deployment `dpl_DGkFpHABt9RzAN8ed6ETsppsKusa`
is READY and aliased to code.purduehackers.com. Calls and screen sharing are removed,
including their custom Zed controls, host ABI, browser media, API/signaling, TURN
configuration and media CSP allowance. Collaborative editing/approved avatars stay.

- [Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34158944970)
  passed the matching server/browser builds and app/supervisor checks. The app-only
  CSP cleanup passed [web CI](https://github.com/purduehackers/zedspaces/actions/runs/34160022725).
  Local lint/typecheck/build and Rust formatting passed; no repository tests added/run.
- Authenticated local publication uploaded the ready VCR image and checksum-verified
  assets, then deployed Vercel production. Actions used `deploy=false`.
- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:3ab2c4b9ff6701d7a44ce13868d4773ad36a34a0bf119275f05f575886765ed6`.
- Editor archive SHA-256: `e3d856724adf0426b54826e06a0fcd3797239e7034dbb9d41b4505155c006103`.
- Retained builds: current, `ad778ac74-34127509100.1`, `4e766bcb8-34060994866.1`,
  `6981604fa-34083879179.1`. Only the current build is in `ZS_EDITOR_UPDATE_BUILDS`:
  older bundles require the deleted host ABI and must bootstrap-upgrade before boot.
  The release record retains the actual previous configuration for rollback.
- Disposable old-build workspace `ws_K4EEKEA7HNEECW5TGX22` returned `202 upgrading`,
  moved generation 1 → 2, and preserved its exact uncommitted file and full three-commit
  Git history. Two independent Chromium profiles booted the new module, exchanged edits
  both ways and saved; the sandbox file was independently read back and matched exactly.
- No call controls, `set_call_status` export, call network requests, peer connections,
  microphone or screen-capture requests. The removed API returns 404. No panic/page error.
  The initial editing diagnostics failed to insert text in Vim Normal mode; entering
  Insert mode and waiting for save completion passed. Those failed attempts are not passes.
- Production has no TURN credentials or call KV rows. No schema migration was needed/run.
  Packaging checked 47 Function traces, largest 16.4 MiB; 19 existing tracing warnings
  remain. Upstream local-AI probes still emit blocked CSP messages; CSP was not weakened.

Cleanup verified 21:04 UTC: the disposable workspace returns 410 and its exact-prefix
SDK sandbox inventory is empty. Only our `collaboration.txt` fixture was untracked
before deletion. Diagnostic browsers are closed; no owner workspace was modified.

## Earlier browser feature release — calls subsequently removed

Previous production, verified 19:42 UTC: app `55fd6cb`, fork `ad778ac746`, matching
build `ad778ac74-34127509100.1`, deployment `dpl_4mnehdi2JMwMVmadB4YVXYZeHtkz`.
[App-only CI](https://github.com/purduehackers/zedspaces/actions/runs/34156283163)
and local lint/typecheck/build passed. Authenticated Vercel CLI deployed the audio
playback fix; the existing WASM, server and image were retained, not rebuilt.
The build still reports 19 existing tracing warnings; all 48 Function traces pass.
[Release CI](https://github.com/purduehackers/zedspaces/actions/runs/34127509100)
passed web lint/typecheck/build, supervisor checks and both production Rust builds.
Actions deployment was intentionally skipped (`deploy=false`); authenticated local
publication deployed the matching image, checksum-verified assets and Vercel app.
No root test suite was added or run.

- Image: `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:2c69b503ae9ff699630cff30ed6811e09b3b675bab920c12f4454523a91fbf03`.
- Editor archive SHA-256: `817d2fe42dff64ef1db520fa0c4acf70bb6073ddd8be16135c539b15e4e57d06`.
- Retained builds: current, `c26ab6ba1-34121133575.1`, `4e766bcb8-34060994866.1`,
  and `6981604fa-34083879179.1`. Every existing workspace's pin remains available.

The actual Chromium module reports the new build, cross-origin isolation and no
test hooks. Zed's native Restart to Update confirmation upgraded the disposable
workspace and automatically reloaded the browser, preserving all fixture files.
The installed kernel bridge matches committed source. Actual editor Run, Interrupt,
Restart and Shutdown pass; interruption preserves variables, restart clears them,
and shutdown leaves no kernel processes or private listening ports. Earlier live
checks covered Unicode, persistent state, Markdown/PNG, errors and stdin input.

Initial production call checks covered Firefox synthetic audio packets to Chromium,
three peers, actual tab capture with decoded 1920×1080 video, mute/deafen, screen
stop, leave/rejoin, origin/schema/participant-secret/no-cache guards. Delayed stale
picker-row focus/click checks and a current command remained interactive without
a panic/page error. The first calls launcher ran before the upgrade was ready;
the first picker probe lacked an active kernel. Both diagnostics were corrected
and rerun successfully; neither initial attempt is counted as passed.

The audio follow-up reproduced a real Chromium bug: packets arrived, but the
Web Audio-only playback graph decoded zero samples despite a running AudioContext.
Native media-element playback fixes this. Temporary Chromium and Firefox diagnostics
now explicitly assert nonzero decoded audio energy, three peers, mute/unmute,
deafen/undeafen and leave/rejoin cleanup. Blocked-playback and delayed-rejection checks
pass. Production's native controls decoded nonzero synthetic audio before and after
deafen and rejoin; simulated playback denial exposes native Unmute Audio, whose retry
restores decoded audio. No panic/page error occurred. The first live attempt left a
background window unjoined; rerunning with explicit focus passed. Earlier asynchronous
stats waits did not reliably wait for their conditions; the new checks poll and assert
resolved values. Packet-only evidence is not treated as audible-audio verification.

A real MacBook Air microphone was opened previously, but supplied zero-level audio.
macOS reports the lid closed: [Apple hardware-disconnects the built-in microphone
in that state](https://support.apple.com/en-ie/guide/security/secbbd20b00b/web).
Spoken audio remains unverified. No audio was recorded; all capture tracks are stopped.

Earlier production checks passed clipboard text/PNG, Vim register/dot/motion/object/
macro paths, the Helix paste action, and Firefox/WebKit text clipboard. Accessibility
checks covered full-document text, IME composition/candidate keys, semantic subtree
retention, modal focus, and tree/picker/tab navigation. ZIP checks passed 7.3 MB
streaming, save-before-download, folder context menus, Unicode, ignored-file choices,
integrity, confinement and canceled-download cleanup. Node/Python debugger launch,
breakpoints, stack/variables, stepping and stop passed. TypeScript mapped stepping
and two fast-start breakpoint launches passed with `runtimeSourcemapPausePatterns`.

Not run: real VoiceOver/NVDA, physical IME/mobile input, spoken-audio playback, or
restrictive-network/TURN checks. TURN is unconfigured. One older-build debug shutdown
`Atomics.wait` exception was not reproduced and remains unclassified. Upstream
local-AI probes still emit blocked CSP messages; CSP was not weakened.
Diagnostics are outside the repository in `/tmp/zedspaces-browser-features.qRKGq9/`.

Cleanup verified at 19:43 UTC: audio fixture `ws_CWH4GRM73NG1VFX7AV3Z` returns 410
and its exact-prefix SDK sandbox inventory is empty. Git inventory was clean before
deletion. The earlier physical-mic fixture `ws_W5VH9ZR6B3EG7DAM8QZA` was also deleted
and its absence verified. Diagnostic browsers and the local signaling server are
closed; no owner workspace was modified.

Earlier cleanup verified at 14:13 UTC: disposable workspace `ws_AAVZ3V9Z1ZC1NEQNC1HQ`
returns 410 and SDK inventory for its exact sandbox prefix is empty. Its files
were inventoried before deletion and contained only our fixtures. All diagnostic
browser profiles are closed; owner workspaces were not modified.

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
