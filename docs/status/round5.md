# Round 5 — public Vercel/Turso preparation

The subsequent cleanup removed optional AI, billing, admin, secrets and custom
image/prebuild features. The results below describe the pre-cleanup tree; see
[cleanup validation](deslop.md) and the [README](../../README.md) for current scope.

2026-09-05. Implemented directly because the workflow runner was unavailable;
no agents were spawned. D43–D45 and the owner's SQLite/Turso + Drizzle direction
supersede the older Postgres/Redis/Clerk/GitHub App design.

## Implemented

- Drizzle `sqlite-core` schema and libSQL driver, fresh `drizzle-sqlite` migrations,
  Turso configuration in deployment and SQLite files locally. SQL-backed KV,
  rate limits and ownership-safe locks use the same database. Local transactions
  are serialized; workspace creation/resume admission is transactional.
- Shared, login-free workspace manager and public GitHub URL form.
  `/new/owner/repo` creates and redirects. Public clone credentials are empty;
  internal Sandbox JWTs, editor cookies and cron authentication remain.
- Clerk/GitHub App routes, sign-in page, obsolete picker/tests, Postgres
  migrations and Redis compatibility module were deleted, **not archived**.
  Original owner Postgres data was neither migrated nor deleted.
  `.pnpmfile.cjs` removes Drizzle's obsolete optional driver peers too: pnpm 11
  had retained Postgres/PGlite/Upstash bindings after their direct dependencies
  were removed. The resolved Drizzle dependency now includes only `@libsql/client`.
- Real Vercel Sandbox remains the deployment backend. Initial deployment can
  disable custom devcontainer builds and use the base image for every repo.
- Fail-closed deployment preflight, read-only Turso readiness check, editor asset
  packaging, local Linux server build recipe and Vercel upload/trace exclusions.
  Postbuild checks that Functions do not include editor WASM, local data or env
  files; deployment requires matching production client/server IDs.

## Actually run

Logs below are in `apps/web/.zs-dev/`.

| Check | Result | Evidence |
|---|---|---|
| Unit suite | 627 passed, 2 skipped (after optional-driver removal) | `round5-unit-6.log` |
| Workflow integration | 6 passed, 4 files (after optional-driver removal) | `round5-integration-5.log` |
| Browser matrix | 50 passed, all four projects | `round5-browser-2.log`, `test-results/round5-browser-2.json` |
| Native lifecycle E2E | 14 JS tests + one actual Rust client passed | `round5-native-2.log` |
| Anonymous public GitHub clone | `octocat/Hello-World` cloned; real editor connected | `round5-public-clone-browser.log`, `round5-public-clone-response.txt` |
| Typecheck | Passed | `round5-typecheck-7.log` |
| Lint | 0 errors; existing unused `EXPECT` warning | `round5-lint-5.log` |
| Production Next build | Passed, including TypeScript; 65 Function traces, largest 17.1 MiB | `round5-build-6.log` |
| Production runtime smoke | Pages/API/assets passed; Chromium hydration had no console/network errors | `round5-production-http-smoke-2.log` |
| Drizzle migration consistency | `drizzle-kit check` passed; schema generated | CLI output |
| Frozen dependency install | Passed after optional-driver removal | `round5-install-frozen-3.log` |
| Supervisor credentials | 15 Rust tests passed; local agent rebuilt | `round5-credential-tests.log`, `round5-supervisor-build.log` |
| Missing production configuration | Correctly refused build with exit 1 | `round5-preflight-missing-env.log` |

The public-clone test used its own port 3120 and SQLite root
`/private/tmp/zs-round5-public-20260905`, workspace
`ws_6SY0NG65MH35K70X3EWR`. Clone HEAD was
`7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`; the production editor became ready in
11.6 seconds. The test workspace and its own app server were stopped afterward;
its data and evidence remain. No screenshots were used for diagnosis.
The separate production smoke used port 3140 and its own SQLite database,
without creating a workspace or calling cloud services. Removed login/webhook
routes returned 404; a HEAD request to the create shortcut returned 405 without
creating anything. WASM headers were immutable and cross-origin isolated.

Earlier failing runs are retained. Fixes included SQLite FK-safe fixture clearing,
local connection transaction serialization, numeric KV increment encoding,
same-origin Host normalization, and Workflow scanning of custom Next outputs
(persistent pnpm patch). A native test now waits for lifecycle run ownership to
clear after the running state. The new trace checker had a syntax error in builds
3/4; build 5 passed after the fix. Remote-driver mock isolation was corrected
before the three readiness unit tests passed. These were not live Turso tests.
The first production HTTP smoke had an incorrect expectation for `/api/repos`'s
compatibility response shape; the corrected assertion passed without an app change.

## Remaining before a deployment claim

- The local Linux/amd64 `remote_server --features serve` build is **still running**
  under Docker emulation, using build ID `c3cf80c0d-db30d12a`.
  Started 19:55 UTC; active at 20:43 UTC. Log:
  `round5-linux-server-build-1.log`; exec session `32025`, build script PID `31719`.
  It is compiling, not stalled. No Linux binary success is claimed yet.
- Image base lookup returned **401 Unauthorized**. VCR login, base digest pinning,
  full image build/publication and Sandbox readiness have **not run**.
- Editor archive and manifest are packaged in
  `apps/web/.zs-dev/round5-editor-delivery/editor/`; publication has **not run**.
- Actual Turso migration/readiness, Blob setup, deployment secrets and live Vercel
  create/connect/edit/stop/resume validation have **not run**. No project was
  deployed, committed or pushed. Cloud setup and publication need explicit owner
  confirmation; see [the deployment checklist](../deploy-vercel.md).
- Round 4's intermittent Firefox close-time RefCell panic remains undiagnosed;
  the subsequent full browser matrices passed. Do not erase the earlier report.

The fork still has 290 modified/untracked paths. Tests made commits/local pushes
only in previously approved disposable fixtures. No forbidden Git operation was
used, and no project/fork publication occurred.
