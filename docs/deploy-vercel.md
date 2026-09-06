# Vercel deployment checklist

The application is intentionally shared and login-free. Anyone with the URL can
operate every workspace and consume the team's Sandbox budget. Public GitHub
cloning needs no GitHub token. Do not store personal secrets here.

Production: [code.purduehackers.com](https://code.purduehackers.com).
See [the measured deployment results](status/deployment.md).

## Required external setup (owner confirmation before doing it)

- Vercel **Pro** project, root `apps/web`, Node 24. The minute sweep cron and
  four-hour session timeout are not a Hobby configuration.
- Fresh Turso database and auth token; run `pnpm db:migrate` with those values.
  Never point the SQLite migration at an old Postgres database. Local data is
  not automatically transferred to Turso.
- Private Vercel Blob store for rebuild archives (`BLOB_READ_WRITE_TOKEN`).
- VCR access, a published workspace image, and an HTTPS host for editor assets.
- Fresh keys from `pnpm zs:keygen`, and every required value in
  `apps/web/.env.example`. Keep keys in the Vercel environment, never source.
- A canonical HTTPS domain: `ZS_CONTROL_URL=https://<domain>/api`. Disable Vercel
  deployment protection if the site should be openly accessible, or configure
  the automation bypass for protected previews and their sandbox callbacks.

Vercel's Sandbox SDK uses deployment OIDC automatically. GitHub OAuth/App
credentials, Clerk, Postgres and Redis are not used. Turso, Vercel and internal
session-signing credentials are still required.
For CLI deployment, link and deploy from the **repository root**, retaining
the configured `apps/web` root directory. Keep the root `package.json`: Vercel's
`vercel.ts` compiler needs its Node/pnpm pin before it reads the app manifest.
Both upload-ignore files explicitly retain `.pnpmfile.cjs`, which Vercel's
default `.pnp*` exclusion otherwise hides.

## CI releases

Run **Release Zedspaces** in GitHub Actions on `main`. By default it builds and
checks source and builds only; enable **deploy** to publish to the existing project/domain. The
pipeline follows [wack-hacker's release pattern](https://github.com/purduehackers/wack-hacker/blob/main/.github/workflows/image.yml):
one release at a time, immutable images, checks before promotion, and a release record.

The source is pushed and the `production` environment is restricted to `main`.
It needs two environment secrets:

- `VERCEL_TOKEN`: a token authorized for the existing Purdue Hackers project/VCR.
- `EDITOR_ASSETS_READ_WRITE_TOKEN`: the **public editor-assets** Blob store's
  token, not the private rebuild store token.

The Blob token is configured. `VERCEL_TOKEN` still needs to be added in GitHub;
the local Vercel CLI credential cannot create this token through its API.

Use environment reviewers if deployment approval is desired; naming an
environment alone does not enforce review. Project/team IDs are pinned in the
workflow. An optional `ZS_BUILD_RUNNER` repository variable selects a larger
Linux x64 runner; the default is `ubuntu-24.04` with two Cargo jobs.
CI disables debug/incremental artifacts, uses separate compact dependency caches,
and removes unused Android/.NET/Haskell/CodeQL SDKs only on disposable GitHub-hosted
runners.
Build failures stop immediately; `ZS_SKIP_BUILD=1` is the explicit reuse path.
Long builds emit disk/memory readings every minute and retain `build-resources.log`.
CI runs web lint/typecheck/build and supervisor formatting/Clippy/build checks.
The release workflow builds matching production WASM and Linux server artifacts
with separate Rust caches. All test suites, browser jobs, and temporary test
Sandboxes have been removed at the owner's request. Deployment builds the OCI/zstd
image, applies pending Drizzle migrations and checks Turso, checksum-verifies public assets, and
deploys from the repository root. Releases publish only the current bundle;
there is no old-editor compatibility mode. Opening an outdated workspace upgrades
its image and browser/server builds together through a file-preserving rebuild.
Failed deployment restores the previous project pins;
the release record identifies the image/build and previous settings for recovery.
The native/WASM artifacts are retained for 14 days, release records for 90 days.

`vercel.ts` disables independent Git-triggered deployments so a push cannot
bypass the matching-artifact pipeline. PR checks have no production secrets.
Build-only runs never migrate or deploy. A deployment explicitly applies pending
migrations. Restoring project pins does not undo a database migration.
There are no nightly or manually selectable test jobs. First builds are cold;
subsequent runs reuse caches.

The [first build-only run passed](https://github.com/purduehackers/zedspaces/actions/runs/34016549327):
web/supervisor checks, production WASM, Linux server, and production browser smoke.
It used app `a442675` and fork `a1f0292686`. Deployment was skipped by request;
the remote publishing/deployment lane is not yet verified.

## Matching artifacts

The current production client is `0641c4c48-dd4fda5d`. Build the pinned Zed
submodule for Linux with that **same** ID; a stock Zed release has no `serve` endpoint.

```sh
# Repository root; local Docker build only, no GitHub or registry push.
ZS_BUILD_ID=0641c4c48-dd4fda5d sandbox/image/build-server.sh --docker

# After explicit registry/login approval: resolve/pin the base, then build/publish.
# sandbox/image/build.sh --update-base
# ZS_BUILD_ID=0641c4c48-dd4fda5d sandbox/image/build.sh --engine docker --push

cd apps/web
pnpm editor:pack 0641c4c48-dd4fda5d <new-output-directory>
```

The image build scripts need VCR access even to pull the base image. Confirm
`sandbox/image/base.lock` is digest-pinned, and wait for the published image to
be **ready**. Set `ZS_IMAGE_REF` to its digest, not a rolling tag. The image must
contain this server and the updated `zs-agent` (empty GitHub credentials).

Host the packaged `editor/` directory without authentication. Configure
`ZS_EDITOR_BUNDLE_SOURCE` to its parent URL, **not** the `/editor` URL, and
`ZS_EDITOR_BUNDLES=<current-build>` and `ZS_EDITOR_BUNDLES_KEEP=1`.
Vercel's prebuild downloads the bundle; WASM is not compiled during deployment.
Local test assets and `.zs-dev` state are excluded from CLI uploads.

Every public repo clones on the base workspace image. Custom-image builders,
prebuilds, AI-provider plumbing, and Stripe billing have been removed.

## Verify, then deploy with confirmation

```sh
cd apps/web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm deploy:check   # reads .env.local; configuration + actual bundle validation
pnpm deploy:check:db # read-only live Turso schema/migration/FK check
pnpm build         # Vercel runs the same preflight automatically
```

These checks do not create resources, migrate remote data, publish artifacts, or
deploy. A local build is not a live Vercel certification. After the approved
deployment, verify the homepage and `/new/octocat/Hello-World`, then create →
connect → edit → stop → resume with console/network evidence. Check the cron's
authenticated sweep and confirm stale sandboxes stop. Set Vercel spending
alerts/limits before sharing the URL; the app caps active/admitted workspaces at
five by default and rate-limits creation, but has no per-person isolation.

Use Turso's **libSQL-compatible** database endpoint for `@libsql/client`. The
remote check requires foreign-key enforcement on fresh connections as well as
inside transactions. Setting `PRAGMA foreign_keys=ON` once on an HTTP client
does not configure its future connections; the app fails closed if enforcement
is off. The local driver explicitly enables it on its own connection.

Current platform references: [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference),
[Vercel limits](https://vercel.com/docs/limits). See
[Round 5 status](status/round5.md) for commands actually run and remaining blockers.
