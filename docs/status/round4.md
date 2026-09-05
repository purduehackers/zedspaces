# Round 4 — 2026-09-05 UTC

The expanded **50-case Playwright matrix passed in one run**, with no skips/retries, on the rebuilt Shared-mutex-fix bundles: [full5 report](../../apps/web/test-results/round4-full-5-report/index.html), [JSON](../../apps/web/test-results/round4-full-5.json), [log](../../apps/web/.zs-dev/round4-full-5.log). Its saved Next log has no panic/trap. Cached implementation/review work was not repeated; the unavailable Workflow runner was replaced by direct continuation. One earlier Firefox close-time panic remains unresolved below.

The original [workspace](http://127.0.0.1:3100/w/ws_J06KWEVQRXBW76KCN96X) now points to validated stripped production build `c3cf80c0d-db30d12a`. The owner approved the local app restart/repoint at 18:58 UTC; the workspace remains user-stopped since 04:53 UTC, with the same URL. API/document/manifest/bundle checks returned200; saved-state and snapshot hashes, all other workspace fields, and all other workspace rows were unchanged. Browser boot was not run during this repoint, to preserve the stopped state. The earlier owner-approved OrbStack restart restored PostgreSQL. **No project/fork commits, pushes or external deployments** occurred.

## Changes and evidence

- Browser lane: D47 tree + live shell, trimmed title flags and closed-dock reload are built/tested. D46's right terminal exposed a test focus error; focus is now restored after clicking. The D6 fixture alone disables autosave and inventories both real terminal tabs before dirtying, verifying unchanged disk, restored dirty text, fresh shell IDs/CWDs and command output.
- Settings lane: explicit hidden/STOPPING flushes now join in-flight settings saves; host PUTs are immediate and serialized per document. A held-PUT regression proves hidden completion waits for HTTP 200 before reload. Genuine errors/conflicts remain failures.
- Smoke: the actual application reader proves exact expected inventory bytes, HTTP 200, EOF and no cancellation before classifying Chromium151's spurious `ERR_ABORTED`. Partial/cancelled/ambiguous reads still fail (17 focused tests). No product HTTP-pump workaround.
- Final race fix: full2 found intermittent WebKit startup failure. Structural WASM mapping proved terminal environment `Shared::poll → record_waker → std::Mutex → wait32`. A standalone valid-address WASM test reproduces WebKit's misleading OOB wording. Vendored futures-util0.3.32 now uses D42's browser-safe parking_lot only for browser Shared locks; native poisoning/no-std semantics stay unchanged. The deterministic worker-held-lock regression passed in all three engines on `db30d12a-test`: nine probes each observed exactly one main-thread park, then verified wake/completion/clone/drop cleanup. [Report](../../apps/web/test-results/round4-contention-report/index.html).
- Integration: migration path resolved before cwd changes; dev-only WebKit CSP correction; native stack uses its own Next output/log; supervisor bootstrap uses `git switch`, not forbidden checkout. b11 Rust implementation remains unchanged.
- Runner cleanup reaps only the exact recorded Next PID's telemetry helper, revalidating identity before each signal. Seventeen mocked-process tests and actual contention-run shutdown passed; owner3100 remained untouched.

## Verification actually run

Rust: rustup1.97.1 first on PATH. JavaScript: `fnm exec --using=v24.19.0`. Browser runs preserve earlier bundles/databases and name all four projects explicitly.

| Check | Actual result |
|---|---|
| `dev-local.sh browser --project=chromium --project=firefox --project=webkit --project=smoke` | **Full5:50 passed**,395.73s, zero skips/retries. Earlier: full1:17 passed/9 failed/21 not run; full2:43/1/3; full3:47 passed; full4:42 passed/2 failed/3 skipped/3 not run (fixture rate limit + mistaken LSP skip flag) |
| Full5 matrix: editor11 (includes Shared contention) + session4 + D47 layout1 | **16/16 each** Chromium, Firefox, WebKit, including real LSP completions |
| Stripped-production smoke | **2/2 passed** |
| Isolated WebKit session after full2 trap | **4/4 passed**; did not by itself prove the race fixed |
| `pnpm test --maxWorkers=2` | Final expanded run: **634 passed, 2 skipped**, 95.73s (includes 13 trap-diagnostics and 17 scoped telemetry-cleanup tests) |
| `tsc --noEmit --incremental false`; `pnpm lint` | Passed; lint has one pre-existing diagnostic-script warning |
| `script/build-web` production + `--test-hooks` | Both Shared-fix `c3cf80c0d-db30d12a` builds passed; test Rust30m58s, production42m01s including lock wait, plus optimization/package time |
| Focused Shared contention Playwright | **3/3 passed**, 102.40s, no skips/retries; nine forced contentions verified |
| Focused Firefox D47 reload/close, stronger late-error capture | **3/3 passed**; original full4 close-time RefCell panic not reproduced or fixed |
| `script/check-wasm -p zed_web --features zed_web/test-hooks` | Shared-fix source passed,4m19s; accidental Rust1.98 check stopped, not passed |
| Native `cargo check -p zed -p zed_web -p remote -p remote_server` | Final Shared-fix check passed, 13m00s |
| `dev-local.sh e2e` on isolated port3120 with fresh server | **14 JS +1 real Rust client passed**, including save-to-disk, stop/snapshot/delete |
| futures-util standalone native tests / no-std check | **3 tests passed** / passed; native poisoning preserved |
| Earlier audited Rust filters | Core39; remote websocket36 (external case excluded), remote14; server serve/pty/terminal/stale/client_state/control99/20/5/4/12/12; terminal20; project17+4; terminal_view7; workspace11+2; db8. Proto terminal filter matched zero, not a meaningful pass. [Logs](../../apps/web/.zs-dev/handoff-native) |

Full5 boot-to-editable: Chromium **3,367ms**, Firefox **7,475ms**, WebKit **5,347ms**. Only Chromium has the default hard 15s budget; Firefox/WebKit timings are recorded, not budget-gated. Production smoke ready **1,922ms**. Built `db30d12a` production WASM **74,946,370 bytes /19,909,006 brotli**; test **75,015,559 /19,943,597**.

## Remaining / not run

D42 now reuses each editor workspace (nine creates total, below the unchanged10/10min limit); full5 enabled the installed LSP tools. Full4's Firefox layout passed its pre-close assertions but reported a late App/WebWindow RefCell panic during page closure. Capture/assertions now include closure and enrich empty panic stacks; three focused reruns and full5 were clean, **not proof of a fix for that separate teardown race**. Owner3100 now serves the validated bundle with test hooks/routes disabled. No owner resume was performed; test stacks3110/3120 and their telemetry helpers are stopped.

Reports, traces and bundles remain. The focused close runner mistakenly omitted `ZS_KEEP_E2E=1`, pruning ten older browser-test databases through full4 plus its own temporary database; their contents are no longer retained. Owner/native databases were not targeted and remain. Full5 database `zs_browser_20260905013146` is retained. Disposable test workspaces were cleaned; retained native fixture `e2e-693ce5f5` and its stopped workspace remain.

Round5 has not launched. Not run: live AI, external websocket dial, six env-gated server cases needing global `/Users/zed` setup, Vercel/Turso/image publishing. Broader port forwarding, tasks/rebuild, IME/clipboard, file transfer and extensions remain outside this matrix.
