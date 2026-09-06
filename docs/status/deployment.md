# Production deployment — 2026-09-06 UTC

Live: https://code.purduehackers.com. Vercel project `purdue-hackers/zedspaces`,
production deployment `dpl_Erxk22dfUtWZJRC27T18nRW9vXi1` is READY; DNS is verified
and HTTPS works without a login/deployment-protection gate.

## Published configuration

- Application source: `main` at `c3746689d5f1dcd6f998fbc1753782c3d76689f7`, plus
  local UX cleanup, release helper/configuration, upload exclusions and a root
  Node 24 / pnpm 11.20.0 package-manager pin.
  CLI upload used an isolated checkout; the owner's dev build/state was untouched.
  These deployment fixes and image-build fixes are not committed or pushed yet.
- Zed fork: `0641c4c48806e94b352abbce64baac9c48a8a7c7`. Matching Linux server and
  production browser build: `0641c4c48-dd4fda5d`; production test hooks are absent.
  The old `c3cf80c0d-db30d12a` bundle remains served for existing workspaces.
- Workspace image:
  `vcr.vercel.com/purdue-hackers/zedspaces/zs-workspace@sha256:09ffb61d541e9630a2d9bfdba1bd37370a788868e85ab73a2ff84e03836f8b4d`.
  VCR reports ready; local image assertions and an actual Sandbox boot passed.
- Official Vercel universal base built from pinned source because its upstream
  registry reference returned 404. Provenance/digest are in `sandbox/image/base.lock`.
  VCR publication requires OCI media types with zstd compression.
- Turso Starter in `iad1`, Drizzle migrations applied and remote schema/KV/FK
  readiness passed. No Postgres/Redis/GitHub credentials or login provider.
- Private Blob `zedspaces-rebuilds`; separate public Blob `zedspaces-editor-assets`
  hosts the editor tar/manifest. Uploaded bytes were downloaded and checksum-verified.
- Fresh internal signing/cookie/cron secrets; Sandbox uses Vercel OIDC.
  Five active/admitted workspaces maximum. This remains one public shared space.

## Checks actually run

Evidence is retained under `apps/web/.zs-dev/` (ignored).

| Check | Result / evidence |
|---|---|
| Vercel production build | Passed; 44 Function traces, largest 16.5 MiB; `ux-deploy-vercel-1.log` |
| Web typecheck, lint, unit | Passed; 399 unit tests passed, one skipped; `ux-ci-*` logs |
| Workflow integration | Six passed before publication; `ux-web-integration-1.log` |
| Supervisor | Unchanged since previous release's fmt/clippy and 163 passing tests; `deploy-supervisor-tests.log` (not rerun this release) |
| Image | All local assertions and real Sandbox runtime probe passed; `ux-deploy-image-assertions-1.log`, `ux-deploy-image-probe-1.log` |
| Public clone | Real Sandbox cloned `octocat/Hello-World`; not shallow, three commits; `ux-deploy-cloud-create-1.log`, browser runtime probe |
| Browser boot | Production Chromium ready; matching new WASM/server, WSS connected, cross-origin isolation, no test hooks or HTML status strip |
| Browser save | Exact 63-byte typed README verified on VM; `ux-deploy-browser-edit-4.log` |
| Terminal | Ctrl+backtick opened the terminal; typed command wrote the expected marker on the VM; same edit log |
| Stop/resume | Exact saved bytes and SHA-256 preserved; `ux-deploy-cloud-stop-1.log`, `ux-deploy-browser-resume-1.log` |
| CI definitions | actionlint, ShellCheck, Dockerfile check, release unit tests passed; no GitHub Actions run or secret setup performed |
| Cron | Earlier release verified both schedules and HTTP 200 sweep; not independently retested this release |

The latest test workspace is `ws_PEH163TG5MVDF42HDWT4`, stopped after verification
with its files intact (`ux-deploy-cloud-stop-final.log`). Its saved README SHA-256 is
`60989461dd6527b773e126a057e2b9d907785fa1e10a0d1edc0a530d3ef0d4fb`.
The older test workspace `ws_TS4FYB0BMB1PB40KZHRH` remains stopped. No public GitHub commits/pushes
were made by its clone/edit checks. Browser diagnostics used console/network/RPC
evidence, not screenshots. macOS retained an old NXDOMAIN result temporarily;
scoped tests used a publicly resolved Vercel IP while preserving hostname/TLS checks.

Earlier failures remain recorded: OrbStack exited during the first image build;
the resumed cached build rejected non-OCI compression; the first deployment chose
an incompatible pnpm before the root pin was added. The successful image push
was independently verified because its running shell script had been edited and
exited 127 after publication. Initial browser automation typed in Vim normal mode;
the final exact-content test enters insert mode and waits for IME selection sync.

The first two new browser-edit attempts used an absolute file-finder query and
never opened the README; the relative query worked. The third exposed a bulk
`Input.insertText`/IME replacement edge case (a shared prefix was lost). It was
not fixed or claimed passed: the final save test uses real character key events.
Bulk insertion/paste/IME needs a separate investigation before claiming coverage.

Not run in production: full cross-browser matrix, rebuild/Blob restore,
port-forward checks, natural idle-stop/session-cap expiry, spending controls.
The earlier intermittent Firefox close-time panic remains unresolved. The prior
local browser matrix passed; it is not a claim that these cloud cases passed.

Existing owner workspaces were not edited, restarted, rebuilt, repointed or
unshallowed. They retain their old editor image until explicitly rebuilt.
The prior deployment `dpl_8v9d9p3TF4Fthj4XpLr6dqmXV9CL` and its image/bundle
remain available as rollback artifacts. The new release CI is local-only until
both repositories are pushed and its two production secrets are configured.
