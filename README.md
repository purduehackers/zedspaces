# Zedspaces

[Zed in your browser](https://code.purduehackers.com), backed by Vercel Sandboxes or local Docker containers.
An open-source cloud development environment: sign in with GitHub, open a public
repository, and get your own ready-to-code workspace. Think Codespaces, with Zed.

Zed's Rust UI runs as WebAssembly in the tab. The sandbox runs the remote server,
Git, terminals, language servers, debugger adapters, and Jupyter kernels.
The Next.js control plane uses Drizzle ORM with SQLite/libSQL on Turso.

## Before you host it

GitHub sign-in is required. Workspaces, settings, and management actions are scoped
to their owner; sharing a workspace URL does not grant another account access.
Automatically exposed preview ports are still public. Never put secrets in previews.
Set provider spending limits and `ZS_MAX_RUNNING_WORKSPACES` for your expected usage
before sharing a deployment (default: 5 concurrent sandboxes across all accounts).

## Open a repository

Create a workspace from the dashboard, or open a public GitHub repository directly:

~~~text
https://code.purduehackers.com/new/OWNER/REPO
https://code.purduehackers.com/new/OWNER/REPO?branch=main
~~~

Sign in with GitHub, then the repo is cloned into a sandbox owned by your account.
Opening the same repo link again returns to your workspace instead of making
another copy. Each account gets its own workspace, so these links also work for
workshops, tutorials, and shared starter projects. On your own deployment,
replace `code.purduehackers.com` with your domain.
GitHub is used only for identity (`read:user`, `user:email`); tokens are discarded
after sign-in. Cloning is public and unauthenticated; edits are not pushed to GitHub.
Older anonymous workspaces remain stored but are not exposed to newly created accounts.

## What’s supported

Public GitHub cloning, multiplayer cursors, stop/resume, file-preserving upgrades,
port previews, extensions, clipboard, uploads, ZIP export, debugging, and the
inline REPL are supported. Calls, screen sharing, AI assistants, private
GitHub repositories, and desktop integration are not included.
Notebooks use Zed's existing cell UI with rich-output saving. Python is bundled;
other locally installed Jupyter kernels appear in the native kernel picker.
After installing a kernelspec with `--user`, run **repl: refresh kernelspecs**.
User kernelspecs survive upgrades; keep their interpreters/environments under
`/workspaces` so those survive too. System-wide package installs are not preserved.
Notebook input prompts, widgets, and external kernel provisioners are not supported.
Accessibility support is still in progress.

The editor retains up to 32 live/replay connections per workspace for the owner’s tabs. Disconnected
slots are reclaimed when someone joins; they no longer impose a lifetime visitor
limit. Rejoining keeps saved editor state and terminal ownership. If a replay was
reclaimed, the tab needs a fresh snapshot rather than replaying old edits.

The dashboard, onboarding, and loading screens use Purdue Hackers’ fonts and the dark palette from Purdue Hackers Events. This branding does not change Zed’s editor theme. Bundled font sources and license information are in `apps/web/public/fonts/purdue-hackers/NOTICE.txt`; brand fonts are not covered by this project’s MIT license.

Existing workspaces open their matching editor while updates download in the
background. Zed's **Restart to Update** replaces the VM and browser together.
Files and editor state survive; terminal commands must be restarted.

Browser GPU/context loss rebuilds graphics resources in the existing tab,
keeping the editor and connection alive. Recovery is bounded: repeated failures
offer diagnostics and an explicit reconnect, never an automatic page reload.
Download diagnostics before reconnecting if you have unsaved edits.

## Repository

- **apps/web** — dashboard, browser host, API, database, and workspace workflows.
- **sandbox** — Rust supervisor and workspace image.
- **zed** — pinned [Zed fork](https://github.com/purduehackers/zed) submodule.

Keep the Zed fork close to upstream. Prefer browser-platform bridges, settings,
and sandbox services over changes to shared Zed UI or editor behavior.

~~~sh
git clone --recurse-submodules https://github.com/purduehackers/zedspaces.git
cd zedspaces
~~~

When updating an existing clone, run `git submodule update --init --recursive`.
Editor bundles and server binaries are build artifacts, not committed source.

## Run locally with Docker

Run workspaces on your machine with Docker Desktop, OrbStack, or Docker Engine. You need Node 24 and pnpm 11.20.0 on the host. The launcher downloads matching editor/server binaries and builds the workspace image from public base images. You don’t need Rust, Vercel, Turso, or Blob credentials.

Clone this repository, then install the web dependencies. Docker mode doesn’t need the Zed submodule:

~~~sh
git clone https://github.com/purduehackers/zedspaces.git
cd zedspaces/apps/web
pnpm install --frozen-lockfile
~~~

Create a separate [GitHub OAuth app](https://github.com/settings/developers) for local sign-in. Set its homepage to `http://127.0.0.1:3100` and callback to `http://127.0.0.1:3100/api/auth/callback/github`. Save its credentials in `apps/web/.env.docker.local`:

~~~dotenv
GITHUB_CLIENT_ID=your_local_client_id
GITHUB_CLIENT_SECRET=your_local_client_secret
~~~

Start the app and open [localhost:3100](http://127.0.0.1:3100):

~~~sh
pnpm dev:docker
~~~

Sign in, then open a public repo from the dashboard or `/new/repo_owner/repo_name`. The first startup downloads the release and builds an image. Later starts reuse both. Linux x86-64 images run through Docker’s emulation on Apple Silicon.

The launcher keeps SQLite, signing keys, workflow state, and rebuild archives in `apps/web/.zs-dev/docker`. Project files and editor settings stay in each container’s writable layer. **Stop** preserves them; **Delete** removes the container and its files. Don’t prune stopped Zedspaces containers if you want to keep their workspaces.

The app, editor connections, and previews bind to `127.0.0.1`. A second listener on port 3101 accepts only authenticated sandbox callbacks and signed archive requests. Workspace containers receive no Docker socket, host-directory mounts, GitHub tokens, or cloud credentials. Run repositories you trust: local containers aren’t Vercel’s VM isolation, and they can reach your network.

Use **Stop** in the dashboard before shutting down. Ctrl+C stops the web app, not running containers. Idle workspaces stop while the app runs; a container also stops when its session timeout expires. Restarting the launcher keeps existing workspaces available.

To fetch the latest editor release, stop the launcher and run:

~~~sh
pnpm dev:docker --update
~~~

Existing workspaces retain their matching editor until you choose **Restart to Update**. Rebuild archives stay on disk and preserve project files across replacement containers.

Set `ZS_DEV_PORT` to change the web port; the callback relay uses the next port. Update the OAuth app’s callback too. Set `ZS_DOCKER_ROOT` to use another state directory. Keep that directory with its containers: it holds their ownership scope and signing keys. `ZS_DOCKER_RELEASE_URL` can point to your fork’s `docker-release.json`.

The local image includes Node.js, Python, common web language servers, and the Python REPL. Install other tools inside the workspace. Privileged Docker-in-Docker, devcontainer images/Compose services, and domain-based network allowlists aren’t supported locally. Production still uses Vercel Sandboxes; Docker mode refuses production builds.

## Develop the native runtime locally

Requires Node 24, pnpm 11.20.0, the pinned Rust 1.97.1 toolchain, and the Zed
build dependencies. The Linux toolchain setup is in
[setup-zed](.github/actions/setup-zed/action.yml). The browser build additionally
needs WASI SDK, wasm-bindgen, and Binaryen; use the versions pinned there.

Build a real browser bundle first, then start the local stack:

~~~sh
zed/script/build-web --build-id dev-local --out-dir ../apps/web/public/editor
cd apps/web
pnpm install --frozen-lockfile
ZS_CLIENT_BUILD_ID=dev-local pnpm dev:local
~~~

The local launcher builds the native server and supervisor, generates development
keys, and uses a dedicated SQLite file. It binds to http://127.0.0.1:3100.
Configure a separate GitHub OAuth app with callback
`http://127.0.0.1:3100/api/auth/callback/github`, and provide its `GITHUB_CLIENT_ID`
and `GITHUB_CLIENT_SECRET` in `apps/web/.env.local`. Sandbox/cloud credentials
are not needed. Do not expose this local process backend
to the internet. `ZS_SKIP_BUILD=1` reuses existing native binaries.

Use **F1** or **Alt/Option+Shift+P** for commands, **Alt/Option+P** for files,
and **Ctrl+`** for the terminal. Vim mode is on by default; press **i** to type.
The bundled theme and Nerd Fonts can be changed in Zed settings.
Run **web: toggle screen reader mode** for full-document text access and Tab
navigation. Focused numeric controls support Up/Down and Home/End; dropdowns
open with Down Arrow.

~~~sh
# apps/web
pnpm lint
pnpm typecheck
pnpm build

# repository root
cargo fmt --manifest-path sandbox/supervisor/Cargo.toml --check
cargo clippy --locked --manifest-path sandbox/supervisor/Cargo.toml --lib --bins -- -D warnings
cargo build --locked --release --manifest-path sandbox/supervisor/Cargo.toml
~~~

There are no test suites in this repository. CI runs lint, type checking, and
builds. The Zed submodule retains upstream tests. Diagnose browser failures from
console and network evidence.

### Browser diagnostics

In browser DevTools, `zedspaces.snapshot()` returns a bounded record of boot
stages, errors, resource timings, connection and page events.
`zedspaces.download()` saves it as JSON; `zedspaces.clear()` clears the record.
The browser shell also offers **Download diagnostics** when the editor fails.
URL credentials, queries, fragments and known token formats are redacted, but
error text and paths may contain project information: review before sharing.
This record stays in the tab and is not uploaded. Existing automatic error
reports remain separate and are capped per tab.

Use `await zedspaces.profile(10)` for an opt-in, 10-second frame-pacing sample
(1–30 seconds, visible tab only). For CPU stacks, memory, network inspection,
and full profiling, use the browser's own DevTools. The Performance timeline
includes `zedspaces:*` boot-phase timings. Long-task observations are included
where the browser supports them. No editor contents or WebSocket payloads are
read by this recorder.

## Deploy your fork

Deployment requires a Vercel project with **apps/web** as its root, Turso,
a private Blob store for rebuild archives, and a public Blob store for editor
assets. The configured sandbox duration and cron schedule require Vercel Pro.
Use [the environment template](apps/web/.env.example) for production values.
Generate signing material with `pnpm zs:keygen`; never commit it.
Create a GitHub OAuth app with your public homepage and callback
`https://YOUR-DOMAIN/api/auth/callback/github`. Set `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, and a random `BETTER_AUTH_SECRET` in Vercel.
Use separate OAuth apps and databases for local development and production.

The **Release Zedspaces** workflow builds matching Linux and browser artifacts.
Enable its **deploy** input to publish an image, upload assets, migrate the
database, and deploy the app. Ordinary Git auto-deploy is disabled because the
WASM client and sandbox server must be released with a matching build ID.
App builds on Vercel fetch precompiled bundles; they do not compile Zed.

Configure these GitHub Actions repository variables:

| Variable | Value |
| --- | --- |
| VERCEL_ORG_ID | Your Vercel team ID |
| VERCEL_PROJECT_ID | Your Vercel project ID |
| VERCEL_TEAM_SLUG | Your team slug |
| VERCEL_PROJECT_SLUG | Your project slug |
| ZS_PUBLIC_URL | Your public HTTPS origin |
| ZS_BASE_IMAGE | Your digest-pinned Sandbox base image |
| ZS_BUILD_RUNNER | Optional runner label; defaults to ubuntu-24.04 |

Set the **VERCEL_TOKEN** and **EDITOR_ASSETS_READ_WRITE_TOKEN** Actions secrets.
The latter must belong to the public Blob store named by
`ZS_EDITOR_BUNDLE_SOURCE`. Production database and runtime secrets live in
Vercel environment settings, not GitHub artifacts.

For the first release, build your own base from the pinned public Vercel Sandbox
source. This avoids depending on another team's private registry:

~~~sh
vercel vcr login docker
docker buildx bake 'https://github.com/vercel/sandbox.git#8e471d48548c1d8f3287bc66f650f2e87d041445:images' universal \
  --set 'universal.tags=vcr.vercel.com/TEAM/PROJECT/sandbox-base:vercel-8e471d48548c' \
  --set 'universal.attest=type=provenance,disabled=true' --push
docker buildx imagetools inspect vcr.vercel.com/TEAM/PROJECT/sandbox-base:vercel-8e471d48548c
~~~

Set `ZS_BASE_IMAGE` to that image with its reported `@sha256:…` digest.
Configure the non-release values in the environment template first, including
your public origin and both Blob stores. The release workflow fills in the
matching image and editor build values. Keep Drizzle migrations: they support
fresh databases and existing deployments.

## Licensing

The Zedspaces app and supervisor are [MIT licensed](LICENSE).
The Zed submodule, bundled assets, and third-party dependencies retain their
respective licenses; the root license does not relicense them.
