# syntax=docker/dockerfile:1.7
#
# The Zed Codespaces workspace image (linux/amd64), brief b8 §3.19 with the D21 port map.
#
# Build context is the repository root (`sandbox/image/build.sh` passes it), because this file
# copies both `sandbox/supervisor/` (the zs-agent sources) and `sandbox/image/dist/` (the
# `zed-remote-server` built by `sandbox/image/build-server.sh`).
#
# BASE_IMAGE is passed by build.sh from sandbox/image/base.lock (a digest-pinned ref,
# BUILD-SPEC §10 item 6); the default here is only for `docker build` by hand.
ARG BASE_IMAGE=vcr.vercel.com/vercel/sandbox/universal:latest
ARG RUST_TOOLCHAIN=1.97.1
# Build-stage bases are pinned by digest (BUILD-SPEC §10 item 6: reproducible from pinned
# inputs). The tag before `@` is documentation only – Docker resolves the digest. Refresh with
# `docker buildx imagetools inspect <image>:<tag> --format '{{json .Manifest.Digest}}'`.
ARG RUST_BUILDER_IMAGE=rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
ARG SERVER_FETCH_IMAGE=ubuntu:26.04@sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b

# ---- zs-agent (static musl) --------------------------------------------------
FROM ${RUST_BUILDER_IMAGE} AS agent-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends musl-tools \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /src
COPY sandbox/supervisor/ ./
ENV CC_x86_64_unknown_linux_musl=musl-gcc \
    RUSTFLAGS="-C target-feature=+crt-static"
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --target x86_64-unknown-linux-musl \
 && install -m 0755 target/x86_64-unknown-linux-musl/release/zs-agent /out-zs-agent

# ---- zed-remote-server: from the build context (default) or the public release ----
# `context` takes sandbox/image/dist/zed-remote-server (the fork's `serve` build,
# sandbox/image/build-server.sh). `release` downloads the published asset from
# cloud.zed.dev; that binary has no `serve` subcommand and is only good for image smoke tests.
FROM ${SERVER_FETCH_IMAGE} AS server-fetch
ARG ZED_SERVER_SOURCE=context
# Latest published stable at the time of writing; resolve a newer one with
# `curl -s "https://cloud.zed.dev/releases/stable/latest/asset?asset=zed&os=linux&arch=x86_64" | jq -r .version`.
ARG ZED_SERVER_VERSION=1.18.0
ARG ZED_RELEASE_CHANNEL=stable
ARG ZED_SERVER_SHA256=
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY sandbox/image/dist/ /dist/
RUN set -eu; \
    if [ "$ZED_SERVER_SOURCE" = "context" ]; then \
      test -f /dist/zed-remote-server || { \
        echo "sandbox/image/dist/zed-remote-server missing (build it with sandbox/image/build-server.sh, or pass --build-arg ZED_SERVER_SOURCE=release)" >&2; \
        exit 1; \
      }; \
      install -m 0755 /dist/zed-remote-server /out-zed-remote-server; \
    elif [ "$ZED_SERVER_SOURCE" = "release" ]; then \
      curl -fsSL "https://cloud.zed.dev/releases/${ZED_RELEASE_CHANNEL}/${ZED_SERVER_VERSION}/download?asset=zed-remote-server&os=linux&arch=x86_64" \
        | gunzip > /out-zed-remote-server; \
      chmod 0755 /out-zed-remote-server; \
    else \
      echo "ZED_SERVER_SOURCE must be 'context' or 'release' (got '${ZED_SERVER_SOURCE}')" >&2; \
      exit 1; \
    fi; \
    if [ -n "$ZED_SERVER_SHA256" ]; then \
      echo "${ZED_SERVER_SHA256}  /out-zed-remote-server" | sha256sum -c -; \
    fi

# ---- workspace image ---------------------------------------------------------
FROM ${BASE_IMAGE}
ARG ZS_BUILD_ID
ARG RUST_TOOLCHAIN
# Every download below is pinned by version *and* verified against a committed sha256
# (BUILD-SPEC §10 item 6). Refresh a pin by downloading the new asset once and recording
# `sha256sum` (go.dev publishes its sums at https://go.dev/dl/?mode=json&include=all,
# rust-lang next to each rustup-init at static.rust-lang.org/rustup/archive/<ver>/…).
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_INIT_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG GO_VERSION=1.25.1
ARG GO_SHA256=7716a0d940a0f6ae8e1f3b3f4f36299dc53e31b16840dbd171254312c41ca12e
ARG GOPLS_VERSION=v0.20.0
ARG TAPLO_VERSION=0.10.0
ARG TAPLO_SHA256=8fe196b894ccf9072f98d4e1013a180306e17d244830b03986ee5e8eabeb6156
ARG LUA_LS_VERSION=3.15.0
ARG LUA_LS_SHA256=4877b874c52fb7587707898da9026cc3a6c854d9bbab115ef49ac4e6a1b88007
ARG RUFF_VERSION=0.13.1
# Exact versions (no floating majors), resolved 2026-09-03 with `npm view <pkg>@<range> version`.
ARG NPM_LS_PACKAGES="typescript@5.9.3 typescript-language-server@4.4.1 @vtsls/language-server@0.2.9 pyright@1.1.413 vscode-langservers-extracted@4.10.0 bash-language-server@5.6.0 yaml-language-server@1.24.0 dockerfile-language-server-nodejs@0.14.1 prettier@3.9.6 eslint@9.39.5 @google/gemini-cli@0.58.0"
USER root
# The base persists ENV HOME=/vercel and /vercel/.npmrc (prefix ~/.global/npm); Docker's USER does
# not touch HOME, so pin it for the root steps and restore it at the end.
ENV HOME=/root
# Build-only settings as ARGs: visible to RUN in this stage, never persisted into the image config.
ARG DEBIAN_FRONTEND=noninteractive
ARG NPM_CONFIG_PREFIX=/usr/local
ARG GOCACHE=/tmp/go-cache
ARG GOPATH=/tmp/go

# 1. toolchains, split by family so no single layer approaches VCR's 500 MB compressed limit
#    (build.sh asserts the uncompressed sizes).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang clangd lld pkg-config cmake gdb shellcheck unzip zstd \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-21-jdk-headless \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
      ruby-full php-cli php-xml composer \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
      docker.io docker-buildx docker-compose-v2 \
 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:$PATH
# rustup-init is a pinned release binary with a published checksum (never `curl | sh` of the
# rolling installer script); the toolchain components it fetches are checksummed by rustup
# against the signed channel manifest.
RUN curl -fsSLo /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_INIT_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod 0755 /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal \
      --default-toolchain ${RUST_TOOLCHAIN} --component rust-analyzer,clippy,rustfmt,rust-src \
 && rm -f /tmp/rustup-init \
 && chmod -R a+rwX /usr/local/rustup /usr/local/cargo
RUN curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar -xzf /tmp/go.tgz -C /usr/local \
 && rm -f /tmp/go.tgz

# 2. language servers (changes weekly). npm globals go to /usr/local (NPM_CONFIG_PREFIX), not to
#    the base's per-user /vercel/.global/npm prefix.
RUN GOBIN=/usr/local/bin GOFLAGS=-mod=mod go install golang.org/x/tools/gopls@${GOPLS_VERSION} \
 && rm -rf /tmp/go /tmp/go-cache
RUN npm install -g --no-fund --no-audit ${NPM_LS_PACKAGES} \
 && npm cache clean --force \
 && rm -rf /root/.npm
RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install ruff==${RUFF_VERSION} \
 && chmod -R a+rX /opt/uv-tools
RUN curl -fsSLo /tmp/taplo.gz \
      "https://github.com/tamasfe/taplo/releases/download/${TAPLO_VERSION}/taplo-linux-x86_64.gz" \
 && echo "${TAPLO_SHA256}  /tmp/taplo.gz" | sha256sum -c - \
 && gunzip -c /tmp/taplo.gz > /usr/local/bin/taplo \
 && chmod 0755 /usr/local/bin/taplo \
 && rm -f /tmp/taplo.gz
RUN mkdir -p /opt/lua-language-server \
 && curl -fsSLo /tmp/lua-ls.tgz \
      "https://github.com/LuaLS/lua-language-server/releases/download/${LUA_LS_VERSION}/lua-language-server-${LUA_LS_VERSION}-linux-x64.tar.gz" \
 && echo "${LUA_LS_SHA256}  /tmp/lua-ls.tgz" | sha256sum -c - \
 && tar -xzf /tmp/lua-ls.tgz -C /opt/lua-language-server \
 && rm -f /tmp/lua-ls.tgz \
 && printf '#!/bin/sh\nexec /opt/lua-language-server/bin/lua-language-server "$@"\n' > /usr/local/bin/lua-language-server \
 && chmod 0755 /usr/local/bin/lua-language-server

# 3. agents: claude-code, codex, opencode and pi come from the base image; gemini-cli is added
#    above through NPM_LS_PACKAGES.

# 4. zed-remote-server + zs-agent (change on every build, so they sit above the slow layers).
COPY --from=server-fetch /out-zed-remote-server /usr/local/bin/zed-remote-server
COPY --from=agent-builder /out-zs-agent /usr/local/bin/zs-agent

# 5. users, paths, git. Nothing above wrote under /vercel; hand the tree back to ubuntu anyway.
RUN mkdir -p /workspaces && chown ubuntu:ubuntu /workspaces \
 && chown -R ubuntu:ubuntu /vercel \
 && git config --system credential.helper '!zs-agent credential' \
 && git config --system credential.useHttpPath true \
 && git config --system safe.directory '*' \
 && git config --system init.defaultBranch main

# The runtime environment (D21 port map; b3 §7.10 asks for SHELL; D28 for SHELL/HOME/USER).
ENV HOME=/vercel \
    SHELL=/bin/bash \
    ZS_BUILD_ID=${ZS_BUILD_ID} \
    ZS_WORKSPACES_DIR=/workspaces \
    ZS_SERVER_BIN=/usr/local/bin/zed-remote-server \
    ZS_SUPERVISOR_URL=http://127.0.0.1:8450 \
    ZS_CONTROL_SECRET_FILE=/vercel/.zs/run/control.secret \
    ZS_PROXY_SLOTS=8444,8445,8446,8447 \
    ZS_HEALTH_PORT=8448
USER ubuntu
WORKDIR /workspaces
# Vercel Sandbox does not run ENTRYPOINT or CMD for custom images; this CMD exists only for
# `docker run` in sandbox/image/test/run-local.sh.
CMD ["/usr/local/bin/zs-agent", "start"]
