# Vercel deployment checklist

The application is intentionally shared and login-free. Anyone with the URL can
operate every workspace and consume the team's Sandbox budget. Public GitHub
cloning needs no GitHub token. Do not store personal secrets here.

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

## Matching artifacts

The current production client is `c3cf80c0d-db30d12a`. Build the pinned Zed
submodule for Linux with that **same** ID; a stock Zed release has no `serve` endpoint.

```sh
# Repository root; local Docker build only, no GitHub or registry push.
ZS_BUILD_ID=c3cf80c0d-db30d12a sandbox/image/build-server.sh --docker

# After explicit registry/login approval: resolve/pin the base, then build/publish.
# sandbox/image/build.sh --update-base
# ZS_BUILD_ID=c3cf80c0d-db30d12a sandbox/image/build.sh --engine docker --push

cd apps/web
pnpm editor:pack c3cf80c0d-db30d12a <new-output-directory>
```

The image build scripts need VCR access even to pull the base image. Confirm
`sandbox/image/base.lock` is digest-pinned, and wait for the published image to
be **ready**. Set `ZS_IMAGE_REF` to its digest, not a rolling tag. The image must
contain this server and the updated `zs-agent` (empty GitHub credentials).

Host the packaged `editor/` directory without authentication. Configure
`ZS_EDITOR_BUNDLE_SOURCE` to its parent URL, **not** the `/editor` URL, and
`ZS_EDITOR_BUNDLES=c3cf80c0d-db30d12a` (plus older builds still in use).
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
pnpm test
pnpm test:integration
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
