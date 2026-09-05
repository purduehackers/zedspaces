# zs-workspace image

The `linux/amd64` image every workspace sandbox runs (BUILD-SPEC §6.1, brief
`docs/briefs/b8-supervisor-image.md` §3.19-§3.25, port map per `DECISIONS.md` D21).

```
sandbox/image/
  Dockerfile                    base + toolchains + language servers + zed-remote-server + zs-agent
  base.lock                     the digest-pinned vercel/sandbox/universal ref
  build.sh                      builds (and optionally pushes) the image
  build-server.sh               builds zed-remote-server from the fork with Zed's musl recipe
  dist/                         build outputs: zed-remote-server, image.json, test fixtures
  test/mock-control-plane.mjs   the sandbox-facing control-plane routes, in Node
  test/fake-zed-remote-server.py a stand-in for `zed-remote-server serve`
  test/run-local.sh             boots the image against the mock with `docker run` and asserts
```

## Build

```sh
# 1. the server binary (needs the zed/ checkout and a musl toolchain)
ZS_BUILD_ID="$(git -C zed rev-parse --short HEAD)-1" sandbox/image/build-server.sh

# 2. the image; --push needs VERCEL_TEAM_SLUG and VERCEL_PROJECT_SLUG
ZS_BUILD_ID="$(git -C zed rev-parse --short HEAD)-1" sandbox/image/build.sh --tag zs-workspace:dev
```

`build.sh` prefers `vercel vcr build docker` and falls back to `docker buildx build`
(`--engine docker` forces the fallback, `--engine vcr` the other way). Without a server binary in
`dist/`, pass `--source release` to pull the published `zed-remote-server` from
`cloud.zed.dev` — that binary has no `serve` subcommand, so it is only good for image smoke tests.

The build context is the repository root: the Dockerfile needs `sandbox/supervisor/` (the zs-agent
sources, cross-compiled to `x86_64-unknown-linux-musl` in the `agent-builder` stage) and
`sandbox/image/dist/`. The root `.dockerignore` keeps `zed/`, `apps/` and build outputs out.

## Layers

1. toolchains — build-essential, clang/clangd, cmake, JDK 21, Ruby, PHP, Docker CLI + daemon,
   Rust (with rust-analyzer) and Go, split across `RUN`s so no layer approaches VCR's 500 MB limit;
2. language servers — gopls, the npm set (vtsls, typescript, pyright, vscode-langservers-extracted,
   bash, yaml, dockerfile, prettier, eslint), ruff, taplo, lua-language-server;
3. agents — claude-code, codex, opencode and pi come from the base, gemini-cli is added here;
4. `zed-remote-server` and `zs-agent`;
5. users, `/workspaces`, the system git config that registers `zs-agent credential`.

Node 24, pnpm, Bun, Python 3.14 + uv, git, gh, jq, ripgrep and friends come from
`vercel/sandbox/universal`. Cuts from BUILD-SPEC §6.1, each deliberate: .NET (no verified
Ubuntu 26.04 package), the Node LTS matrix (one Node; dotfiles can add `fnm`), and
jdtls/omnisharp/solargraph/intelephense (their Zed adapters are extensions that install into the
data dir on demand).

Vercel Sandbox does not run `ENTRYPOINT`/`CMD`; the control plane invokes `zs-agent start`
explicitly. The `CMD` in the Dockerfile exists only for `docker run` in the local test.

## Local test

```sh
sandbox/image/test/run-local.sh --image zs-workspace:dev --fake-server
sandbox/image/test/run-local.sh --image zs-workspace:dev --only-image   # static checks only
```

`run-local.sh` builds a fixture repository with a `devcontainer.json`, generates an ES256 key pair
and a port-session secret, starts `mock-control-plane.mjs`, runs `zs-agent start` in a container
and asserts the boot: health on `:8448` (the D21 minimal body) and the full report on the loopback
API, the clone and `postCreateCommand`, the server's environment, the port watcher and the
control-plane forward, the cookie-gated proxy on slot `8444`, the git credential helper, the
lifecycle notices and a clean `SIGTERM` shutdown inside b9's 25 s budget.

The mock speaks the sandbox-facing routes of `docs/briefs/CONTRACTS.md` §7.4 and mints
`zs_port_token` values with b9's `signPortSession` algorithm (cross-checked against
`zs-agent port-token`).

## Ports (D21)

| Port | Bind | Owner |
|---|---|---|
| 8443 | `0.0.0.0` | `zed-remote-server serve` (`/rpc`, `/files`, `/extensions`, `/health`) |
| 8444-8447 | `0.0.0.0` | `zs-agent` private-port proxy slots |
| 8448 | `0.0.0.0` | `zs-agent` health (`{ ok, phase, build, serverUp, uptimeSec }`) |
| 8450 | `127.0.0.1` | `zs-agent` supervisor API (`ZS_SUPERVISOR_URL`) |
| 8451 | `127.0.0.1` | `serve --control-listen` |
| 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888 | — | user forward pool |
