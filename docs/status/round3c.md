# Round 3c browser boot status (2026-09-04)

The first browser session that renders Zed against the local stack, on top of round 3b (`docs/status/round3b.md`). Diagnosis moved from screenshots to console and network evidence (`apps/web/.zs-dev/netdiag.mjs`).

## 1. Result

- Boot reaches `Rendered first frame` and `ready` in about 4 s (Chromium, WebGPU on Metal; SwiftShader about 12 s) for a fresh session and for a session that takes the lease over from another tab. Editor chrome, status bar and the workspace paint; no panic in the boot path.
- Bundle `c3cf80c0d-d6a2a2d4-names` (names kept, 115 MB raw, 40 MB name section) is what the stack serves; workspace `ws_J06KWEVQRXBW76KCN96X`. A stripped bundle of the same tree is `c3cf80c0d-ddd6aa92`.

## 2. Root causes fixed

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | "Opening the window" hang, then a `RefCell already borrowed` flood | `ProjectPanel::new` stored `std::time::Instant::now()` through a nested `use std::{.., time::{Duration, Instant}}` import; on wasm the std clock panics ("time not implemented") and the abort leaves the `App` `RefCell` borrowed | 13 live sites moved to `web_time::Instant`, including the whole undo-transaction chain (`text`, `language`, `multi_buffer`, `editor`, `project`, `vim`) that would have panicked on the first keystroke; `web-time` added to ten crates; `lsp_store::buffer_transaction_now` collapsed to one definition |
| 2 | Second tab taking over sometimes stalls at the window stage with the same flood; also seen in a first tab that took over a stale lease | Not a Rust panic: `parking_lot`'s wasm parker executes `memory.atomic.wait32`, which browsers forbid on the main thread. The thrown `RuntimeError: Atomics.wait cannot be called in this context` unwinds through wasm without running destructors, so a contended mutex on the main thread (`Worktree::remote` against a worker during the worktree replay) leaked gpui's `App` borrow | `vendor/parking_lot_core` (0.9.12) spins on a thread the embedder marks; `gpui_web::WebDispatcher::new` marks the main thread (D42). `fuzzy_nucleo`'s matcher pool moved from a std to a `parking_lot` mutex, the one std mutex genuinely shared with workers |
| 3 | Console: CSP violation for `cdn.agentclientprotocol.com` on every boot | `AgentRegistryStore::refresh` fetched the ACP registry from the tab | Skipped in the browser build (agents launch on the sandbox) |
| 4 | "Restricted Mode" and a trust prompt for the checkout | Zed's worktree trust defaults | `session.trust_all_worktrees = true` in the web settings overrides (D41) |

## 3. Tooling

- `script/build-web --names` keeps the wasm name section (id suffix `-names`); `ZS_BUILD_WEB_ARGS=--names apps/web/scripts/dev-cycle.sh` builds, publishes, restarts the stack, creates a demo workspace and traces the boot. Chrome then prints Rust function names in panic stacks, which is what identified cause 2.
- `apps/web/.zs-dev/netdiag.mjs <ws> [takeover]`: deduped console errors, full text of the first panic, failed requests, non-2xx responses, WebSocket open/close; the `takeover` scenario opens a second session once the first is ready.

## 4. Verification

| # | Command | Result |
|---|---|---|
| 1 | `./script/check-wasm` (whole `zed_web` closure) | OK |
| 2 | `cargo check` natively: the 13 clock crates, `project`, `zed_web_core`, `fuzzy_nucleo`; `cargo test -p zed_web_core` | OK, 31 tests pass |
| 3 | `cargo fmt --check` on every touched crate | clean |
| 4 | Takeover loop, stripped bundle before the parker fix | 2 failures in 16 runs (`Atomics.wait` exception then the borrow flood) |
| 5 | Takeover loop, names bundle before the parker fix | 1 failure in 3 runs, stack named `parking_lot_core::thread_parker::imp::ThreadParker::park` under `Worktree::remote` |
| 6 | Takeover loop, `c3cf80c0d-d6a2a2d4-names` with the parker fix (`parker-takeover-{1..12}.log`) | 12 of 12 runs clean, 24 sessions to `ready`, no panic, no `Atomics.wait` exception, no page error |

## 5. Open

- `GET /api/ai/keys` is aborted (`net::ERR_ABORTED`) in about 80 % of sessions right at `ready` (`apps/web/.zs-dev/keys-trace.mjs`): the request is sent 110 ms after the window stage, the 200 arrives, and the body reader is cancelled before the chunked stream's terminator. Serving the same response with a `Content-Length` (`keys-onepiece.mjs`, 5 of 5 clean) removes it, so the cancellation is on the wasm side of `gpui_web::http_client`'s body pump; the JSON is read in full and the inventory is correct, so nothing breaks. Needs an instrumented bundle to place the drop.
- std `Mutex`/`Condvar`/`OnceLock` contention on the main thread would hit the same browser rule; the remaining std sites in the closure (`agent_servers::acp`, `askpass`, `gpui_wgpu` error slot, `settings_ui`, `llama_cpp`) are either main-thread-only or not exercised in the browser.
- Round 4 (Playwright suite, test hooks, b11-rust) and the filed control-plane bugs are unchanged and next.
