# Round 3b integration status (2026-09-03)

The wasm closure loop's tail (`project` → `zed_web`), the first real bundle, the first browser boot and the integrator pass on top of round 3 (`docs/status/round3.md`). Precedence: DECISIONS.md (D1-D40) > CONTRACTS.md > briefs. Commands in `zed/` on macOS (Darwin 27.0.0), Rust 1.97.1, wasm-bindgen-cli 0.2.120, binaryen `wasm-opt` 132, `brotli` 1.2.0, Playwright 1.62.1 on node 26.7.0. Tree at `c3cf80c0d1be…` (upstream `git_ui: Fix 'Go Back' skipping the Git Graph view (#63597)`).

## 1. Wasm status: clean at the graph level, red in the browser

- `./script/check-wasm` (default list, now the whole `zed_web` closure: **207** crates incl. `project workspace editor … zed_web` and every vendored crate; closes R4-1/R4-2): **OK**, 0 errors (`target/wasm-logs/20260903-150731-check.log`, 35 s incremental). Wasm-only rustc warnings: **33 in 8 crates** — `sandbox` 10, `client` 7, `settings_ui` 5, `title_bar` 3, `recent_projects` 3, `settings` 2, `remote_connection` 1, `language_models` 1 (unused imports 15, never-used fns/methods/statics/consts 11, never-read fields 4, unneeded `mut` 2, unused variable 1). CI's `-D warnings` (`ci-config.toml`) would fail `check_wasm` until their owners clean them. Non-rustc noise, left as is: one `-Ctarget-feature` `atomics` unstable-feature note per crate and cc-rs `-Wunused-parameter` on the tree-sitter shim's `__assert_fail` (five grammars' build scripts).
- `./script/build-web` (`20260903-150943-build.log`): `web-release` build OK → `wasm-bindgen --target web` → `patch-wasm-bindgen-memory.sh` (ctor helper added, DataView retry added, shared-memory accessor no-op) → `wasm-opt -Oz … --enable-simd` (new flag: the linked module carries v128/i8x16 instructions; the emitting crate is not attributed) → eval gate OK → asset tar → `build.json`. `.cargo/config.toml` now exports `__heap_base` (wasm-bindgen 0.2.120's threads transform needs it; b7 §3.16 had it as "only if step 4b needs it").
- **Boot blocker (open, `crates/fs`)**: `WasmFs::abs()` (`wasm_fs.rs:588`) and the symlink-target branch (`:308`) use `Path::is_absolute()`, which is always `false` on `wasm32-unknown-unknown` (std's non-unix `path` impl returns `has_root() && prefix().is_some()`; unix-style paths have no prefix). Every `WasmFs` entry point rejects every path; first hit is `insert_dir("/home/web/.config/zed")` at boot stage `settings` (panic at `wasm_fs.rs:555`). Native `cargo test -p fs wasm_fs` cannot see it. Fix: `path.has_root()` at both sites (or a wasm cfg). `util`, `paths`, `zed_web`, `zed_web_core` have no other `is_absolute()` on the wasm side.
- `repl` stays out of `zed_web` (`ZS-TODO(b7)`, `crates/zed_web/Cargo.toml:126`); three `ZS-TODO(wasm)` markers in the tree (`project`, `copilot`, `agent_servers`).

## 2. Bundle `c3cf80c0d-0`

| Item | Value |
|---|---|
| Location | `apps/web/public/editor/c3cf80c0d-0/{zed_web.js 185,885 B, zed_web_bg.wasm, zed-assets.tar, build.json}`; `manifest.json` = `{"builds":["c3cf80c0d-0"]}`; the `dev-0` stub is still beside it |
| `zed_web_bg.wasm` | raw **74,713,531 B** (95 MB before `wasm-opt`); gzip -9 **23,926,013 B**; brotli **19,776,809 B** (q5, as `build.json` records it) |
| Budget | 223 KB (1.1 %) under b7 §6's nightly `--max-brotli-bytes 20000000`; any growth trips it (BUILD-SPEC 3.4 planned 15-18 MB) |
| `zed-assets.tar` | 3,302,400 B |
| Tracking | the whole `apps/web/public/editor/` tree is untracked and **not** gitignored (75 MB); `ZS_CLIENT_BUILD_ID` is still `dev-0` in `.env.example` (no `.env.local`), so new workspaces do not see the real bundle |

## 3. Browser smoke (`pnpm test:browser`, `apps/web/tests/e2e-browser/smoke.spec.ts`)

- Setup: the spec serves `public/` with the editor route's isolation headers and the bundle CSP, overlays b7's dev harness (`zed/crates/zed_web/web/{index.html,loader.js}`) onto `/editor/c3cf80c0d-0/`, and drives headless Chromium 151 (SwiftShader). Test 2 also spawns `zed/target/debug/remote_server serve` with a throwaway ES256 key.
- **Result: FAIL, 2/2** (`exit 1`; 2.5 min + 3.3 min, both on the 150 s / 200 s `expect.poll` for a terminal stage). Trace of the same bundle (`scratchpad/boot-debug.cjs`): `crossOriginIsolated=true`, `[zed-web] build c3cf80c0d-0`, stages `booting → assets` (asset pack 434 files, 8 `wasm_thread` workers, WebGPU probe fails → WebGL2 on SwiftShader, host os `mac`) `→ settings` all at t+0.8 s, then `panicked at crates/fs/src/wasm_fs.rs:555:36: WasmFs::insert_dir needs an absolute path: path is not absolute: "/home/web/.config/zed"`, `pageerror: unreachable`, no further stage. So the glue, the threads transform, `__heap_base`, the ctor helper, the asset pack and the gpui_web graphics path all work; the boot dies on the §1 blocker before `connecting`. The `[zed-web] panic` console line is available to the spec (`log.errors`) but not polled — R4b-2.

## 4. Verification

| # | Command | Result |
|---|---|---|
| 1 | `cargo check -p zed -p zed_web -p remote -p remote_server -p project -p workspace -p editor` | PASS: `Finished` 1m 16s, 0 errors, 0 rustc warnings (only the upstream `block v0.1.6` future-incompat note) |
| 2 | `cargo test -p remote websocket` | PASS: 37 passed |
| 3 | `cargo test -p remote_server serve` / `pty` / `client_state` / `control` | PASS: 102 / 20 / 12 / 14 passed |
| 4 | `cargo test -p terminal remote` | PASS: 20 passed |
| 5 | `cargo test -p db client_state` / `cargo test -p fs wasm_fs` | PASS: 8 / 15 passed |
| 6 | `cargo test -p project remote` | PASS: 21 passed |
| 7 | `cargo test -p workspace remote` | PASS: 11 passed |
| 8 | `./script/check-vendor-pins` | PASS: `OK` (21 crates) |
| 9 | `./script/check-wasm` (default list, 207 crates) | PASS: `check-wasm: OK` (`20260903-150731-check.log`) |
| 10 | `./script/build-web` | PASS: bundle at `apps/web/public/editor/c3cf80c0d-0` (`20260903-150943-build.log`, exit 0) |
| 11 | `pnpm test:browser` | FAIL: 2 failed (test 1 `the boot reaches connecting` 2.5 m, test 2 `boots to ready … mounts the canvas` 3.3 m; both time out after the `settings`-stage panic, §3); `apps/web/test-results/` holds Playwright's error contexts |

Not re-run this round (unchanged since round 3 rows 7-9): `cargo test -p zed_web_core`, `cargo metadata --locked --offline`, `build-web --check-only`. No code change by the integrator this round; the CONTRACTS edits are §5.4 (three rows marked **landed**: `WasmFs`, `sign_in_supported`, `KeymapOs`/`set_platform_style`), §13.1 (`__heap_base` line, `--enable-simd`, `AR_wasm32_unknown_unknown = script/wasm-ar` as in the tree) and §13.2 (rows for `async-tar`, the nine `pet*` crates, `tree-sitter-{python,rust,bash}`, `tree-sitter-{cpp,yaml,md}`, the `sqlite-wasm-rs` provenance rule; the 21-entry `[workspace] exclude`). Closes R4-6.

## 5. Gaps for round 4

| # | Gap | Owner |
|---|---|---|
| R4b-1 | **Boot blocker**: `WasmFs` `is_absolute()` → `has_root()` (§1); then re-run `pnpm test:browser` and fix whatever the boot hits next (`database`, `languages`, `window`, `ready` are unexercised). | fs / b6 |
| R4b-2 | Smoke spec: fail as soon as `log.errors` carries a `[zed-web] panic` line instead of burning the 150 s / 200 s timeouts; the `connect_failed` detail expectation in test 1 is unverified; add a `playwright.config.ts` (timeouts, `webServer`, retries) and wire the job into CI after R4b-1. | b7 / b9 |
| R4b-3 | Clean the 33 wasm-only rustc warnings in `sandbox client settings_ui title_bar recent_projects settings remote_connection language_models` before `-D warnings` reaches `check_wasm`. | crate owners |
| R4b-4 | `apps/web/public/editor/*/` (minus `dev-0`) in `.gitignore` or rely on `scripts/fetch-editor-bundle.ts`; set `ZS_CLIENT_BUILD_ID=c3cf80c0d-0` (and the `ZS_EDITOR_BUNDLES*` source) for new workspaces / the staleness rule; retire the `dev-0` stub. | b9 |
| R4b-5 | Briefs lag the tree: b5 §3 item 2 / b7 §3.16 should record `__heap_base` as carried and b7 §3.31 step 5 the `--enable-simd` flag (CONTRACTS §13.1 already does); attribute the simd128 emitter (likely a `#[target_feature(enable = "simd128")]` path) and decide whether to keep it. | b5, b7 |
| R4b-6 | Brotli headroom is 1.1 %: measure at q11 as the CDN would, and either raise the budget with a reason or trim (grammars, `languages` with `load-grammars`, fonts in the asset tar). | b7 |
| R4b-7 | Carried: R4-4 (`repl`), R4-7 (E1 local-backend e2e, G7/E3 image job on Linux, G8/E5 Vercel sandbox e2e incl. stop → resume, E4 b11 real provider + `zed_web` consumer, E2). | b7, local-backend, b8, b9, b11 |
| — | Leftovers, harmless: four orphaned `tail -n0 -f …/build-web-{2,3,4}.log` processes (PIDs 56599, 61640, 66562, 70830) from the killed earlier attempt; `scratchpad/boot-debug.cjs` is a throwaway trace script, not part of the tree. | — |
