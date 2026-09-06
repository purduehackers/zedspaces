# zs-workspace image

The `linux/amd64` image every workspace sandbox runs (BUILD-SPEC §6.1, brief
`docs/briefs/b8-supervisor-image.md` §3.19-§3.25, port map per `DECISIONS.md` D21).

```
sandbox/image/
  Dockerfile                    base + toolchains + language servers + zed-remote-server + zs-agent
  base.lock                     the digest-pinned vercel/sandbox/universal ref
  build.sh                      builds (and optionally pushes) the image
  build-server.sh               builds zed-remote-server from the fork with Zed's musl recipe
  dist/                         build outputs: zed-remote-server, image.json
```

## Build

```sh
# 1. the server binary (needs the zed/ checkout and a musl toolchain)
ZS_BUILD_ID="$(git -C zed rev-parse --short HEAD)-1" sandbox/image/build-server.sh

# 2. the image; --push needs VERCEL_TEAM_SLUG and VERCEL_PROJECT_SLUG
ZS_BUILD_ID="$(git -C zed rev-parse --short HEAD)-1" sandbox/image/build.sh --tag zs-workspace:dev
```

`build.sh` prefers `vercel vcr build docker` and falls back to `docker buildx build`
(`--engine docker` forces the fallback, `--engine vcr` the other way). A patched server binary
in `dist/` is required; stock Zed releases do not have the `serve` subcommand.

The build context is the repository root: the Dockerfile needs `sandbox/supervisor/` (the zs-agent
sources, cross-compiled to `x86_64-unknown-linux-musl` in the `agent-builder` stage) and
`sandbox/image/dist/`. The root `.dockerignore` keeps `zed/`, `apps/` and build outputs out.

## Layers

1. toolchains — build-essential, clang/clangd, cmake, JDK 21, Ruby, PHP, Docker CLI + daemon,
   Rust (with rust-analyzer) and Go, split across `RUN`s so no layer approaches VCR's 500 MB limit;
2. language servers — gopls, the npm set (vtsls, typescript, pyright, vscode-langservers-extracted,
   bash, yaml, dockerfile, tailwindcss, prettier, eslint), ruff, taplo, lua-language-server;
3. agents — claude-code, codex, opencode and pi come from the base, gemini-cli is added here;
4. `zed-remote-server` and `zs-agent`;
5. users, `/workspaces`, the system git config that registers `zs-agent credential`.

Node 24, pnpm, Bun, Python 3.14 + uv, git, gh, jq, ripgrep and friends come from
`vercel/sandbox/universal`. Cuts from BUILD-SPEC §6.1, each deliberate: .NET (no verified
Ubuntu 26.04 package), the Node LTS matrix (one Node; dotfiles can add `fnm`), and
jdtls/omnisharp/solargraph/intelephense (their Zed adapters are extensions that install into the
data dir on demand).

Vercel Sandbox does not run `ENTRYPOINT`/`CMD`; the control plane invokes `zs-agent start`
explicitly. CI checks the Dockerfile and builds the supervisor; image test fixtures have been removed.

## Ports (D21)

| Port | Bind | Owner |
|---|---|---|
| 8443 | `0.0.0.0` | `zed-remote-server serve` (`/rpc`, `/files`, `/extensions`, `/health`) |
| 8444-8447 | `0.0.0.0` | `zs-agent` private-port proxy slots |
| 8448 | `0.0.0.0` | `zs-agent` health (`{ ok, phase, build, serverUp, uptimeSec }`) |
| 8450 | `127.0.0.1` | `zs-agent` supervisor API (`ZS_SUPERVISOR_URL`) |
| 8451 | `127.0.0.1` | `serve --control-listen` |
| 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888 | — | user forward pool |
