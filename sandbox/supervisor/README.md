# zs-agent

The supervisor that runs inside every Zed Codespaces workspace sandbox. Plan of record:
`docs/briefs/b8-supervisor-image.md`, amended by `docs/briefs/DECISIONS.md` (Decisions v2, D21-D34,
override the brief where they conflict) and `docs/briefs/CONTRACTS.md` §7.

This is a standalone Cargo workspace (`sandbox/supervisor`), independent of the Zed checkout under
`zed/`. It builds to one static `linux/amd64` musl binary, `/usr/local/bin/zs-agent`, in the sandbox
image (`sandbox/image`).

## Status

Complete implementation of the brief as amended by D21-D34: boot orchestration (`start` /
`resume` / `prebuild`), both listeners, the private-port proxy, the server spawn loop with crash
handling, the activity relay, clone/restore, the lifecycle commands, the credential helper and the
headless warm-up client. No `ZS-TODO` markers remain in `src/`.

Test coverage: unit tests in every module; integration tests under `tests/` (`api.rs`,
`log_shipper.rs`, `proxy_roundtrip.rs`, `warm_client.rs`, `port_watcher_live.rs` on Linux,
`proto_tags.rs` when `../../zed` is checked out, `start_against_fake_server.rs` under
`ZS_RUN_START_INTEGRATION=1` – it drives the real binary against
`sandbox/image/test/fake-zed-remote-server.py` and an in-process control plane – and
`warm_against_serve.rs` under `ZS_RUN_WARM_INTEGRATION=1` against a locally built
`remote_server serve`). What only the image job exercises: the real `zed-remote-server`, the
`/proc`-based port watcher and stale-server sweep inside the container, and the D9 restore of a
tarball produced by a live container (`sandbox/image/test/run-local.sh`).

## Layout

```
sandbox/supervisor/
  Cargo.toml            standalone workspace; lib `zs_agent` + bin `zs-agent`
  rust-toolchain.toml   1.97.1, x86_64-unknown-linux-musl
  build.rs              compiles proto/zs_warm.proto with protox + prost-build
  proto/zs_warm.proto   minimal Zed envelope schema for the warm-up client (same tag numbers)
  src/lib.rs            module map (see the crate docs)
  src/main.rs           clap CLI
  src/config.rs         environment contract and port map
  src/manifest.rs       SandboxManifest + devcontainer.json subset
  src/control_plane.rs  sandbox-facing control-plane client
  src/logs.rs           log batching, scrubbing, shipping
  src/ports.rs          /proc/net/tcp parsing, port watcher
  src/state.rs          health state, health bodies, forwards
  src/server.rs         zed-remote-server spawn/supervision/control client
  src/port_auth.rs      HMAC bootstrap tokens and proxy cookies
  src/proxy.rs          private-port reverse proxy (one listener per slot)
  src/api.rs            health listener + loopback API
  src/credential.rs     git credential helper
  src/bootstrap.rs      clone/restore, dotfiles, settings, lifecycle commands
  src/activity.rs       activity ping relay, notice policy, CPU sampler
  src/start.rs          start / resume / prebuild orchestration, exit codes
  src/warm.rs           headless LSP warm-up client (D14)
  src/proto.rs          generated prost types
```

Shared contract fixture (D19): `docs/contracts/fixtures/manifest.example.json`, loaded by this
crate's `manifest::tests::example_manifest_parses` and by the control plane's tests.

## Port map (D21)

| Port | Bind | Owner | Declared to Vercel | Purpose |
|---|---|---|---|---|
| 8443 | `0.0.0.0` | `zed-remote-server serve --listen` | yes | `/rpc`, `/files`, `/extensions/*`, public `/health` |
| 8444, 8445, 8446, 8447 | `0.0.0.0` | `zs-agent` proxy slots 0-3 | yes | private-port proxy, `zs_port_session` cookie-gated |
| 8448 | `0.0.0.0` | `zs-agent` health listener | yes | `GET /health` → `{ ok, phase, build, serverUp, uptimeSec }` only |
| 8449 | – | reserved | no | part of the infra set, unbound |
| 8450 | `127.0.0.1` | `zs-agent` local API | no | `/ports`, `/extensions`, `/git-token`, `/lifecycle`, `/health` detail (`ZS_SUPERVISOR_URL`) |
| 8451 | `127.0.0.1` | `zed-remote-server serve --control-listen` | no | `/control/lifecycle`, `/control/ports`, `/control/extensions` |
| 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888 | – | user processes | yes | forward pool |

The infrastructure set `8443-8451` (`config::INFRA_PORTS`) is excluded from user forwards.

## CLI

| Subcommand | Flags | Behaviour | Reads `Config` |
|---|---|---|---|
| `start` | `--resumed`, `--no-server` (hidden) | full boot; refuses (exit 2) when `ZS_PREBUILD=1` | yes |
| `resume` | – | `start --resumed`; what the control plane's `onResume` runs | yes |
| `prebuild` | – | requires `ZS_PREBUILD=1`; clone + postCreate + LSP warm-up + `ZS_PREBUILD_WARM_CMD`; exit 0 | yes |
| `credential <get\|store\|erase>` | `--supervisor-url` (env `ZS_SUPERVISOR_URL`, default `http://127.0.0.1:8450`), `--control-secret-file` (env `ZS_CONTROL_SECRET_FILE`) | git credential helper (`credential.helper = !zs-agent credential`, `credential.useHttpPath = true`) | no |
| `proxy` | `--bind-ip`, `--slot…`, `--secret-file`, `--workspace-id`, `--bind <slot>=<port>…`, `--insecure-cookies` | private-port proxy only | no |
| `stop` | `--timeout-secs 30` | SIGTERM the pid-file process and wait | yes |
| `wait-ready` | `--timeout-secs 120`, `--allow-degraded` | poll the health listener | yes |
| `port-token` (hidden) | `--secret-b64\|--secret-file`, `--workspace-id`, `--port`, `--ttl-secs 3600`, `--sub local` | mint an HMAC bootstrap token | no |
| `warm` (hidden) | `--private-key`, `--workspace-id`, `--audience`, `--issuer zs`, `--workspace-root`, `--server-url http://127.0.0.1:8443`, `--budget-secs 300` | LSP warm-up against a running server | no |
| `version` | – | prints the package version, `ZS_BUILD_ID` and the server's `version` output | no (env only) |

Exit codes: `0` ok, `1` generic, `2` config error (incl. `start` under `ZS_PREBUILD=1`), `3` manifest
unavailable, `4` repository materialisation failed.

## Environment read by `zs-agent`

| Variable | Set by | Meaning / default |
|---|---|---|
| `ZS_CONTROL_URL` | control plane `runCommand` env | **required**; API base including `/api`, e.g. `https://zs.example.com/api`; trailing slash stripped. Canonical per D29 (`ZS_CONTROL_PLANE_URL` is not accepted). |
| `ZS_BYPASS_SECRET` | control plane (preview deployments) | sent as `x-vercel-protection-bypass` on every control-plane call (D18) |
| `ZS_SANDBOX_TOKEN` | control plane `runCommand` env, fresh per start | **required**; bearer `zsb_…` for every control-plane call |
| `ZS_SANDBOX_NAME` | `Sandbox.create({ env })` and `runCommand` env | **required**; `sb-…` workspace, `pb-…` prebuild; cross-checked against the manifest |
| `ZS_WORKSPACE_ID` | idem | **required**; cross-checked against the manifest (the prebuild id for `pb-` principals) |
| `ZS_REGION` | `Sandbox.create({ env })` | informational (logged, echoed in health) |
| `ZS_BUILD_ID` | image `ENV` | build id; `--client-build`; `dev` when absent |
| `ZS_PREBUILD` | control plane (prebuild workflow) | `1` ⇒ only `zs-agent prebuild` may run |
| `ZS_PREBUILD_WARM_CMD` | control plane | shell command run after the LSP warm-up with the remaining budget |
| `ZS_WORKSPACES_DIR` | image `ENV` | parent of workspace dirs; default `/workspaces` |
| `ZS_STATE_DIR` | optional | default `$HOME/.zs` |
| `ZS_DATA_DIR` | optional | default `$XDG_DATA_HOME/zed` or `$HOME/.local/share/zed` (Zed's data dir; tarball restore target) |
| `ZS_SERVER_BIN` | image `ENV` | default `/usr/local/bin/zed-remote-server` |
| `ZS_SUPERVISOR_URL` | image `ENV`; re-exported to every child; passed as `--supervisor-url` | `http://127.0.0.1:8450` |
| `ZS_CONTROL_SECRET_FILE` | image `ENV`; re-exported to every child | path of the per-boot control secret (`$ZS_STATE_DIR/run/control.secret`); the server gets it as `--control-secret-file`. No `ZS_CONTROL_SECRET` variable exists anywhere (D18). |
| `ZS_HEALTH_LISTEN` / `ZS_HEALTH_PORT` | tests | default `0.0.0.0:8448` (D21) |
| `ZS_LOCAL_API_LISTEN` | tests | default `127.0.0.1:8450`; must be loopback |
| `ZS_PROXY_BIND_IP` | tests | default `0.0.0.0` |
| `ZS_PROXY_SLOTS` | tests | default `8444,8445,8446,8447` (D21); unique; disjoint from the other bound ports |
| `ZS_RPC_LISTEN` | tests | default `0.0.0.0:8443` |
| `ZS_SERVER_CONTROL_LISTEN` | tests | default `127.0.0.1:8451` (D21); must be loopback |
| `ZS_INSECURE_COOKIES` | tests | `1` ⇒ omit `Secure` on the proxy cookie; allow `http://` tarball URLs |
| `ZS_LOCAL` | control plane local backend (`apps/web/lib/sandbox-local.ts`); or `zs-agent start --local` | `1` ⇒ the supervisor runs on a developer machine: `manifest.workspaceDir` (`/workspaces/<name>`) is relocated under `ZS_WORKSPACES_DIR`, `file://` clone URLs are accepted, the port watcher falls back to `lsof` where `/proc/net/tcp` does not exist, and a port held by a process that is not the server is reported (`port_held_by_foreign_process`) instead of killed |
| `HOME` | image `ENV` (`/vercel`) | **required** |
| `SHELL`, `USER`, `PATH`, `LANG` | image `ENV` | filled for children when missing (`/bin/bash`, `ubuntu`, the image `PATH`, `C.UTF-8`; D28) |
| `RUST_LOG` | optional | log filter, default `info` |
| user/org/repo secrets | control plane `runCommand` env | inherited untouched by the server and children; `manifest.secretNames` lists names only |

### Child environment (server, lifecycle commands)

Process environment ∪ filtered `manifest.env` ∪ filtered expanded `remoteEnv` ∪
`{ ZS_SUPERVISOR_URL, ZS_CONTROL_SECRET_FILE }`, minus `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_URL`,
`ZS_BYPASS_SECRET`, `ZS_CONTROL_SECRET`; `SHELL`, `USER`, `HOME`, `PATH`, `LANG` filled when
missing (D28). `manifest.env`/`remoteEnv` keys starting with `ZS_` (other than `ZS_WORKSPACE_ID`,
`ZS_SANDBOX_NAME`, `ZS_REGION`) and the reserved names `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`,
`ENV`, `PROMPT_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_CONFIG_PARAMETERS`, `HOME`, `PATH`,
`USER`, `SHELL` are dropped with a warning. No secret is ever added by the supervisor.

### State directory (`$ZS_STATE_DIR`, default `/vercel/.zs`)

| Path | Contents |
|---|---|
| `run/zs-agent.pid`, `run/server.port`, `run/control.secret` (0600) | per boot; cleared on every start |
| `markers/{clone.done, post-create.done, dotfiles.done, first-boot.done, settings.sha256, keymap.sha256}` | boot markers (`first-boot.done` ⇒ resume) |
| `jwt/key-<i>.pem` (+ `key-warm.pem` during prebuild, removed before the process exits) | `--jwt-public-key` files (0600) |
| `restore.partial/` | rebuild tarball staging |

## Build and test

```sh
cd sandbox/supervisor
cargo check
cargo test
# The real binary against sandbox/image/test/fake-zed-remote-server.py (needs python3, git, tar):
ZS_RUN_START_INTEGRATION=1 cargo test --test start_against_fake_server
# The warm-up client against a locally built `remote_server serve` (../../zed/target/debug):
ZS_RUN_WARM_INTEGRATION=1 cargo test --test warm_against_serve
cargo build --release --target x86_64-unknown-linux-musl   # via sandbox/image/build.sh in CI
```

The crate pins the same toolchain as the Zed fork (`1.97.1`) and shares every major it has in
common with `zed/Cargo.toml` (`clap 4`, `nix 0.29`, `rand 0.9`, `sha2 0.10`, `prost 0.14`,
`jsonwebtoken 10`, `base64 0.22`, `serde_json_lenient 0.2`, …). `reqwest` uses rustls with the
`ring` provider and native roots so the sandbox's proxy CA (`SSL_CERT_FILE`) is honoured and no
`aws-lc-sys` enters the static build.
