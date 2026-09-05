# Zedspaces cleanup — 2026-09-05

`purduehackers/zedspaces` was created private and empty. No project/fork commit,
push, deployment or registry publication was performed. The initial cleanup was
manual because Truffler was unavailable. The owner subsequently installed it;
the follow-up below used Truffler 0.4.2 successfully.

## Size and scope

Measured with `node infra/source-metrics.mjs`, before and after, using the same
source-only scope: `apps/web/{app,lib,workflows,scripts}`. Excludes tests,
migrations, generated `.well-known`, dependencies, artifacts and documents.

| Source | Before | After |
|---|---:|---:|
| App | 9,350 | 4,633 |
| Libraries | 16,641 | 7,233 |
| Workflows | 2,674 | 1,324 |
| Scripts | 1,624 | 1,471 |
| Total physical lines | 30,289 | 14,661 |
| Nonblank lines | 28,140 | 13,481 |

51.6% fewer physical lines, 52.1% fewer nonblank lines; 195 → 138 files.
Detailed snapshots: `.zs-dev/deslop-baseline.json` and the latest
`.zs-dev/truffler-metrics.json`; `deslop-final-metrics.json` records the initial cleanup.
AI/key storage, billing, secrets/admin/org UI, custom-image and prebuild code
were deleted, not archived. The obsolete image builder and CI jobs were also
removed (outside this metric). Public cloning, editor shell, settings, ports,
crash-safe lifecycle, Drizzle/Turso, internal VM tokens and shared capacity
guards remain. The built WASM's empty key-inventory endpoint remains compatible.
Historical DB migrations/data remain; no destructive SQL migration was applied.
The Zed fork was not changed by this cleanup (still 290 dirty paths).

## Validation

Evidence below is under `apps/web/.zs-dev/` unless stated otherwise.

| Check | Actual result | Log |
|---|---|---|
| Unit suite | 394 passed, 1 skipped | `deslop-unit-5.log` |
| Workflow integration | 6 passed | `deslop-integration-2.log` |
| Native E2E | 14 JS tests + 1 real Rust client passed | `deslop-native-3.log` |
| Typecheck / lint | Passed; lint 0 errors/warnings | `deslop-typecheck-6.log`, `deslop-lint-4.log` |
| Production build | Passed; 44 traces, largest 15.7 MiB | `deslop-build-4.log` |
| Production HTTP smoke | Pages, API, removed-route 404s, non-mutating HEAD, asset headers passed | `deslop-production-http-smoke.log` |
| Frozen install / Drizzle check | Passed | `deslop-install-frozen-2.log`, `deslop-drizzle-check-2.log` |
| Shell / CI | ShellCheck passed; both workflow YAMLs parsed (CI not run) | CLI output |
| Public GitHub clone | Correct checkout and production editor ready | `deslop-public-clone-browser.log` |
| Browser matrix | 39 passed; 1 Chromium cold-load failure; 10 serial cases not run | `deslop-browser-3.log`, `test-results/deslop-browser-3.json` |
| Focused Chromium functions | All 10 passed, including completions | `deslop-browser-4.log`, `test-results/deslop-browser-4.json` |
| Focused Chromium boot retry | Passed unchanged 15 s limit: 5.457 s total / 0.872 s editor leg | `deslop-browser-5.log`, `test-results/deslop-browser-5.json` |

All 50 distinct browser cases have a passing latest result across runs 3–5,
including completions in all three engines and production-bundle smoke tests.
This is **not** a single clean 50-case run: the main matrix had one timing
failure, followed by successful focused runs. The complete attempt history is
in `.zs-dev/deslop-browser-aggregate.json`; the earlier 47-pass run skipped three
completion cases and is not counted as complete coverage.

Public clone used port 3120 and `/private/tmp/zs-deslop-public.1aAmA3`, workspace
`ws_X99ET0ZNKYXSV5JPXT5F`. `octocat/Hello-World` HEAD was
`7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`; the editor reached ready in 17.5 s.
The console/network diagnostic logged an aborted empty AI-inventory request,
not a panic. The test workspace and its server were stopped; data was retained.

Earlier failures remain visible: stale branding/matcher assertions were fixed;
a production build conflicted with `.next/workflow-data`, disrupting a test stop.
Builds now use `.next-production`, and the harness isolates each run's Workflow
state beside its SQLite database (the Next plugin otherwise ignores `distDir`).
An overloaded browser run was interrupted. The next run still missed Chromium's
15 s total-load bar: 18.247 s, including 14.506 s WASM transfer; the editor leg was
1.932 s. The final focused retry was 5.457 s total (3.636 s transfer, 0.872 s
editor leg). No timing assertion was relaxed; local delivery timing varied
substantially under the concurrent validation/build load.

## Truffler follow-up

Truffler 0.4.2 is installed at `/Users/ray/.bun/bin/truffler`. It searches JS/TS
symbols; it is not an automatic rewrite tool. Searches for `assertRepo`,
`RepoParams`, `resetGithub`, `ensureUser`, `prebuild` and `org`, followed by
reference checks, identified three dead declarations: `assertRepoId`,
`RepoParams`, and the empty `_resetGithubForTests` hook. Removed those and the
unused mock export; kept helpers with callers and the legacy database anchors.
This removed another 13 implementation lines. Named queries worked; an empty
query probe did not finish promptly and was interrupted, not counted as passed.

Follow-up validation: typecheck and lint passed; unit tests **394 passed, 1 skipped**
(`truffler-typecheck-1.log`, `truffler-lint-1.log`, `truffler-unit-1.log`). The
build, workflow integration, native and browser results above are from the
initial cleanup; those were not rerun for this unused-declaration removal.
No Zed edits, commits, pushes or deployments.

## Remaining boundaries

- The original owner's workspace URL on port 3100 now returns 404 under the
  SQLite app. Its legacy control-plane data was not migrated/deleted; its local
  sandbox directory and saved client-state metadata remain. This is not a
  completed migration of that old workspace. A final read-only probe of its
  existing supervisor returned `ok: true`, `phase: ready`, `serverUp: true`.
  Do not recreate or GC it blindly.
- Linux/amd64 server build is still running, not passed. VCR base/image access,
  Turso setup/migration and live Vercel Sandbox lifecycle remain unvalidated.
  See [deployment checklist](../deploy-vercel.md); cloud actions need approval.
