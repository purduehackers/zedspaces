# Zedspaces web app

The Next.js dashboard, browser editor shell, API, and durable workflows.
See the [project README](../../README.md) for architecture and scope, and the
[deployment checklist](../../docs/deploy-vercel.md) for Vercel setup.

One shared, login-free space. Public GitHub repositories only. State and KV use
**Drizzle + SQLite/libSQL (Turso)**; VMs use **Vercel Sandbox**. There is no
Postgres, Redis, billing system, AI proxy, or custom-image/prebuild service.
Anyone with access can operate every workspace; do not store personal secrets.

## Local development

Requires the modified `../../zed` working tree, Node 24, pnpm 11.20.0, and Rust
1.97.1. Read [HANDOFF](../../HANDOFF.md) before rebuilding editor assets.

```sh
pnpm install --frozen-lockfile
pnpm dev:local
```

This builds native binaries, creates local keys and SQLite state, and listens
on `127.0.0.1:3100`. `ZS_SKIP_BUILD=1 pnpm dev:local` reuses existing binaries.

```sh
pnpm typecheck
pnpm lint
pnpm build
```

There are no test suites or test-running CI jobs in this repository.

## Deployment

Vercel project root: this directory; Node 24; frozen install; `pnpm build`.
Fill [.env.example](.env.example), explicitly migrate Turso, publish matching
production Linux/WASM artifacts, then run `pnpm deploy:check` and
`pnpm deploy:check:db`. Publishing and deployment are separate, authorized steps.

`ZS_EDITOR_BUNDLE_SOURCE` is the parent URL **before /editor**. The build fetches
`<source>/editor/manifest.json` and `<source>/editor/<build>.tar`.
`pnpm editor:pack <build-id> <new-directory>` packages assets locally; it does
not publish. Production builds refuse local backends and test-hook bundles.

SQL migration history remains intact for existing databases. Removing optional
application features does not drop their historical tables or delete saved
workspace data; no destructive cleanup migration is run automatically.
