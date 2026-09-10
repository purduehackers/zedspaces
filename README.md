# Zedspaces

[Zed in your browser](https://code.purduehackers.com), backed by Vercel Sandboxes.
Paste a public GitHub repository, get a workspace, and share its URL to edit together.

Zed's Rust UI runs as WebAssembly in the tab. The sandbox runs the remote server,
Git, terminals, language servers, debugger adapters, and Jupyter kernels.
The Next.js control plane uses Drizzle ORM with SQLite/libSQL on Turso.

## Before you host it

**There is no login or workspace ownership boundary.** Anyone who can reach the
app can read, edit, stop, or delete any workspace and change shared settings.
Automatically exposed preview ports are public. Never put secrets or sensitive
repositories here. Set provider spending limits before sharing a deployment.
Internal VM tokens, signed connections, and cron authentication still apply.

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

Multiplayer retains up to 32 live/replay connections per workspace. Disconnected
slots are reclaimed when someone joins; they no longer impose a lifetime visitor
limit. Rejoining keeps saved editor state and terminal ownership. If a replay was
reclaimed, the tab needs a fresh snapshot rather than replaying old edits.

The dashboard, onboarding, and loading screens share Kintsugi Dark colors and
Purdue Hackers typography. Departure Mono is bundled under the SIL Open Font
License; its notice is in `apps/web/public/fonts/departure-mono/OFL.txt`.

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

## Local development

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
It does not need cloud credentials. Do not expose this local process backend
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
