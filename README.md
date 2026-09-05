# Zedspaces

GitHub Codespaces, with Zed in your browser.

Zed's Rust UI is compiled to WebAssembly and runs in the tab. A Vercel Sandbox
runs the repository, terminal, language servers, and patched Zed remote server.
The browser connects directly to that VM over an authenticated WebSocket.

Paste a **public GitHub repository** into the dashboard, or open
`/new/owner/repo?branch=main`. No login, GitHub App, or GitHub token is needed.
Public cloning works; authenticated GitHub pushes and private repositories are
not part of this version.

## What's included

- The real Zed editor: file tree, terminals, language tooling, saved settings,
  and persistent editor layout.
- Workspace creation, stop/resume, file-preserving rebuild, deletion, and port
  forwarding. Idle VMs stop automatically.
- A Next.js control plane targeting Vercel, durable Vercel Workflows, and
  **Drizzle ORM with SQLite/libSQL**, deployed to **Turso**. The same database
  holds state, locks, and rate limits; no Postgres or Redis service.
- One base workspace image. No billing system, organization administration,
  stored provider keys, AI proxy, or custom-image/prebuild service.

This is deliberately **one shared space**: anyone who can reach it can read,
edit, stop, or delete any workspace and change shared settings. Proxy forwards
are shared too. Do not put secrets or sensitive work here. Internal VM tokens,
signed session tokens, origin checks, and cron authentication still apply.
Creation is rate-limited and defaults to five active/admitted workspaces.

## Development

The modified Zed fork at `zed/` is a pinned submodule of
[purduehackers/zed](https://github.com/purduehackers/zed), on its default
`zedspaces` branch.
The app, supervisor, and documentation live here on `main`. Clone with
submodules (repository access is required while the repository is private):

```sh
git clone --recurse-submodules https://github.com/purduehackers/zedspaces.git
cd zedspaces
```

For an existing clone, run `git submodule sync --recursive`, then
`git submodule update --init --recursive`. Compiled editor assets are not in
Git; the local stack builds them when needed.

Requires Node 24, pnpm 11.20.0, and the fork's pinned Rust 1.97.1 toolchain.
Read [HANDOFF.md](HANDOFF.md) before rebuilding WASM or changing an existing VM.

```sh
cd apps/web
pnpm install --frozen-lockfile
pnpm dev:local
```

The local adapter runs the supervisor and Zed server as processes, uses SQLite,
and binds to `http://127.0.0.1:3100`. It does not need cloud credentials.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm dev:local browser --project=chromium --project=firefox --project=webkit --project=smoke
```

Browser tests use a separate database and VM root. Diagnose failures from
console/network evidence. The local working tree also has the diagnostic helper
`apps/web/.zs-dev/netdiag.mjs` (ignored, not part of a fresh clone).

## Deploying to Vercel

Use `apps/web` as the project root. Deployment needs Vercel Pro, Turso, private
Vercel Blob storage for rebuilds, a published VCR workspace image, and hosted
editor assets. The Linux server and production WASM bundle must share a build
ID; Vercel downloads the prebuilt WASM instead of compiling Rust.

Follow the [deployment checklist](docs/deploy-vercel.md) and
[environment template](apps/web/.env.example). Run `pnpm deploy:check` and
`pnpm deploy:check:db` before deploying. They validate configuration/assets and
the live Turso database without provisioning or publishing anything.

Local execution is working. A live Vercel deployment and Sandbox create →
edit → stop → resume still require validation; local tests are not cloud
certification. Set provider spending controls before exposing this shared app.

## Source map

The cleanup reduced maintained web implementation from 30,289 to 14,661 lines
(51.6%; nonblank lines fell 52.1%). Tests, migrations, generated code and assets
are excluded from both counts. Run `node infra/source-metrics.mjs` to recount;
see [validation and remaining gaps](docs/status/deslop.md).

- `apps/web/` — dashboard, editor shell, API, database, workflows, and tests.
- `zed/` — modified Zed, WASM platform integration, and remote server.
- `sandbox/supervisor/` — Rust VM supervisor.
- `sandbox/image/` — Linux server and workspace-image builds.
- `infra/` — build helpers and reproducible source-size metrics.

Zed is an upstream project of [Zed Industries](https://github.com/zed-industries/zed).
Zedspaces is an experimental integration, not an official Zed or GitHub product.
Upstream component licenses still apply.
