# Zedspaces

GitHub Codespaces, with Zed in your browser.

Live at **[code.purduehackers.com](https://code.purduehackers.com)**.

Zed's Rust UI is compiled to WebAssembly and runs in the tab. A Vercel Sandbox
runs the repository, terminal, language servers, and patched Zed remote server.
The browser connects directly to that VM over an authenticated WebSocket.

Paste a **public GitHub repository** into the dashboard, or open
`/new/owner/repo?branch=main`. No login, GitHub App, or GitHub token is needed.
Public cloning works; authenticated GitHub pushes and private repositories are
not part of this version.
Vim mode is enabled by default: press `i` to enter insert mode.

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

Old workspaces automatically upgrade when opened or resumed.
It preserves repository files and Zed's saved editor state, then replaces the VM
and browser build together. Connected tabs reload after the upgrade completes;
running terminal commands and dev servers need restarting. Failed upgrades keep
the old generation and backup for retry. Idle workspaces stay stopped until opened.

## Browser defaults

The editor fills the tab, without a second workspace status bar. It bundles
**Kintsugi Dark Flared**, **Ioskeley Mono** for UI and
**IoskeleyMono Nerd Font** for buffers and terminals, including icon glyphs.
No local font install is needed; user settings still override these defaults.

Use **F1** or **Alt/Option+Shift+P** for the command palette,
**Alt/Option+P** for files, and **Ctrl+`** for the terminal. These supplement
the native shortcuts when the browser reserves them; F1 follows the
[Codespaces convention](https://docs.github.com/en/codespaces/reference/using-the-vs-code-command-palette-in-codespaces).

Dockerfile, HTML and TOML highlighting are bundled alongside the existing
languages. Dockerfile and HTML use language servers already pinned in the
workspace image; TOML currently has syntax support only. This is a curated
bundle, not general browser extension installation.

New clones fetch the selected branch's full history. An older shallow checkout
can fetch its missing history with `git fetch --unshallow origin`.

## Multiplayer

Anonymous multiplayer is live: share a workspace's `/w/<id>`
URL to edit together with live cursors and round avatars. Zed's existing
CRDT and project protocol run through the sandbox's WebSockets; there is no
WebRTC signaling service, hosted Zed account, or second collaboration database.
Files and language servers are shared; terminals and saved layouts belong to
each tab. Closing the first tab does not end the project.

Avatars sit at the far right, using Zed's person-icon fallback style. Names such as
“Anonymous Owl” appear on hover and beside cursors; no external avatar requests are made.

This is a breaking replacement for single-editor sessions, not an optional mode.
There is no takeover UI or old-editor compatibility path. The matching client/server release is deployed at
[code.purduehackers.com](https://code.purduehackers.com); see
[implementation and limits](docs/briefs/multiplayer.md).

## Development

The modified Zed fork at `zed/` is a pinned submodule of
[purduehackers/zed](https://github.com/purduehackers/zed), on its default
`zedspaces` branch.
Keep this fork close to upstream: only browser/runtime integration and explicitly
approved UI changes belong there. Product behavior, sandbox configuration and
deployment belong in this repository; prefer settings, assets and host integration
over edits to shared Zed components. Shell prompts stay unchanged.
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
pnpm build
```

This repository has no test suites. CI runs lint, type checking, and builds.
Diagnose browser problems from console/network evidence. The local working tree has the diagnostic helper
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

The production deployment uses real Vercel Sandboxes and Turso. Public cloning,
browser editing/saving, and stop/resume persistence were checked live; see the
[deployment results](docs/status/deployment.md). Set provider spending controls
before sharing this intentionally open, shared app.

The **Release Zedspaces** Actions workflow builds matching browser/server
artifacts and can publish the image, assets, and Vercel app in one manual run.
The [current production build passed](https://github.com/purduehackers/zedspaces/actions/runs/34054725092)
and was published using the local Vercel login. Tests and their release gates
are removed. Publishing from Actions still needs the `production` environment's
`VERCEL_TOKEN`; its public Blob token is configured. Local CLI publication does not.
See [CI setup and release checks](docs/deploy-vercel.md#ci-releases).

## Source map

The cleanup reduced maintained web implementation from 30,289 to 14,640 lines
(51.7%; nonblank lines fell 52.2%). Tests, migrations, generated code and assets
are excluded from both counts. Run `node infra/source-metrics.mjs` to recount;
see [validation and remaining gaps](docs/status/deslop.md).

- `apps/web/` — dashboard, editor shell, API, database, and workflows.
- `zed/` — modified Zed, WASM platform integration, and remote server.
- `sandbox/supervisor/` — Rust VM supervisor.
- `sandbox/image/` — Linux server and workspace-image builds.
- `infra/` — build helpers and reproducible source-size metrics.

Zed is an upstream project of [Zed Industries](https://github.com/zed-industries/zed).
Zedspaces is an experimental integration, not an official Zed or GitHub product.
Upstream component licenses still apply.
