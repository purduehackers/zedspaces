#!/usr/bin/env bash
# Exercise `zs-agent start` inside the workspace image against the mock control plane, using
# plain `docker run` (brief b8 §3.24).
#
# Usage: sandbox/image/test/run-local.sh [options]
#   --image <ref>     image to run (default: zs-workspace:dev)
#   --fake-server     run test/fake-zed-remote-server.py instead of the real zed-remote-server
#   --linger-child    with --fake-server: spawn an orphan child to prove the group kill (the
#                     container's entry script reports every `sleep 3600` that survives the agent)
#   --with-restore    also run the rebuild/restore pass (step 13)
#   --with-services   the manifest carries the b10 devcontainer block (source "manifest",
#                     services ["dockerd"], D38/D40): the container runs --privileged, `docker info`
#                     must succeed inside it within 30 s and the dockerd output must reach the
#                     control plane under log source `services` (b10 §6.5)
#   --only-image      run the static image assertions and stop (no control plane, no boot)
#   --keep            leave the container and the mock running for inspection
#   --mock-port <n>   host port for the mock control plane (default: 9977)
#
# Requires: docker, node >= 20, openssl, jq, git, curl.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
image_dir="$(cd "$here/.." && pwd)"
work="$image_dir/dist/test"

image="zs-workspace:dev"
fake_server=""
linger_child=""
with_restore=""
with_services=""
only_image=""
keep=""
mock_port=9977
container="zs-local"

while [ $# -gt 0 ]; do
  case "$1" in
    --image) image="${2:?--image needs a value}"; shift ;;
    --fake-server) fake_server=1 ;;
    --linger-child) linger_child=1 ;;
    --with-restore) with_restore=1 ;;
    --with-services) with_services=1 ;;
    --only-image) only_image=1 ;;
    --keep) keep=1 ;;
    --mock-port) mock_port="${2:?--mock-port needs a value}"; shift ;;
    --container) container="${2:?--container needs a value}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

failures=0
mock_pid=""

say()  { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok    %s\n' "$1"; }
bad()  { printf '   FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

# check <description> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi
}

# contains <description> <haystack> <needle>
contains() {
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1 ('$3' not in '$2')" ;;
  esac
}

# truthy <description> <value>  — non-empty and not "null"/"false"/"0"
truthy() {
  case "$2" in
    ""|null|false|0) bad "$1 (got '$2')" ;;
    *) ok "$1" ;;
  esac
}

dexec() { docker exec "$container" "$@"; }
dsh()   { docker exec "$container" sh -lc "$1"; }

cleanup() {
  local status=$?
  if [ -z "$keep" ]; then
    if [ -n "${mock_pid}" ] && kill -0 "$mock_pid" 2>/dev/null; then kill "$mock_pid" 2>/dev/null; fi
    docker rm -f "$container" >/dev/null 2>&1 || true
  else
    echo "--keep: container '$container' and mock pid ${mock_pid:-none} left running"
  fi
  exit "$status"
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 2; }; }
need docker
need openssl
need jq
need git
need curl
[ -n "$only_image" ] || need node

docker image inspect "$image" >/dev/null 2>&1 || {
  echo "image '$image' is not present locally; build it with sandbox/image/build.sh" >&2
  exit 2
}

# ---------------------------------------------------------------- image checks
say "image assertions"
binaries="rust-analyzer gopls clangd vtsls pyright-langserver ruff bash-language-server \
yaml-language-server vscode-json-language-server vscode-css-language-server \
vscode-html-language-server taplo lua-language-server docker-langserver \
typescript-language-server prettier eslint gemini claude codex pnpm node python3 git \
zs-agent zed-remote-server"
missing="$(docker run --rm --entrypoint sh "$image" -lc "
  for b in $binaries; do command -v \$b >/dev/null 2>&1 || echo \$b; done" 2>/dev/null)"
check "every language server and tool resolves on PATH" "$missing" ""

probe="$(docker run --rm --entrypoint sh "$image" -lc '
  printf "%s;%s;%s;%s;%s;%s" \
    "$(id -u)" "$HOME" "$SHELL" \
    "$(git config --system --get credential.helper)" \
    "$(git config --system --get credential.useHttpPath)" \
    "$(sudo -n true >/dev/null 2>&1 && echo sudo-ok || echo sudo-missing)"')"
IFS=';' read -r uid home shell helper usehttppath sudo_state <<EOF
$probe
EOF
check "uid is 1000 (ubuntu)" "$uid" "1000"
check "HOME is /vercel" "$home" "/vercel"
check "SHELL is /bin/bash" "$shell" "/bin/bash"
check "git credential.helper" "$helper" "!zs-agent credential"
check "git credential.useHttpPath" "$usehttppath" "true"
check "passwordless sudo" "$sudo_state" "sudo-ok"

env_probe="$(docker run --rm --entrypoint sh "$image" -lc '
  printf "%s;%s;%s;%s" "$ZS_WORKSPACES_DIR" "$ZS_SUPERVISOR_URL" "$ZS_PROXY_SLOTS" "$ZS_HEALTH_PORT"')"
check "image environment (D21)" "$env_probe" "/workspaces;http://127.0.0.1:8450;8444,8445,8446,8447;8448"

version_out="$(docker run --rm --entrypoint zs-agent "$image" version 2>&1 || true)"
truthy "zs-agent version prints something" "$version_out"
image_build_id="$(docker run --rm --entrypoint sh "$image" -lc 'printf %s "$ZS_BUILD_ID"')"
truthy "the image carries ZS_BUILD_ID" "$image_build_id"
contains "zs-agent version prints ZS_BUILD_ID" "$version_out" "build $image_build_id"

if [ -n "$only_image" ]; then
  say "summary"
  if [ "$failures" -eq 0 ]; then echo "all image assertions passed"; else echo "$failures failed"; fi
  [ "$failures" -eq 0 ] || exit 1
  exit 0
fi

# ------------------------------------------------------------------- fixtures
say "fixtures"
rm -rf "$work"
mkdir -p "$work"
seed="$work/seed"
mkdir -p "$seed/.devcontainer"
cat > "$seed/.devcontainer/devcontainer.json" <<'JSON'
{
  "postCreateCommand": "echo post-create > /workspaces/fixture/.post-create",
  "postStartCommand": "echo post-start > /workspaces/fixture/.post-start",
  "forwardPorts": [3000],
  "portsAttributes": { "3000": { "label": "web", "visibility": "private" } },
  "remoteEnv": { "ZS_FIXTURE": "1" },
  "customizations": { "zed": { "extensions": ["toml"] } }
}
JSON
printf 'fn main() { println!("hello"); }\n' > "$seed/main.rs"
printf 'export const hello = (): string => "hello";\n' > "$seed/index.ts"
printf 'def hello() -> str:\n    return "hello"\n' > "$seed/app.py"
# Hermetic git: ignore the developer's global config (commit signing, hooks, templates).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git_fixture() {
  git -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false "$@"
}
(
  cd "$seed" || exit 1
  git init -q -b main .
  git_fixture add -A
  git_fixture commit -qm "fixture"
)
git clone -q --bare "$seed" "$work/fixture.git"
fixture_sha="$(git -C "$seed" rev-parse HEAD)"
cp "$here/fake-zed-remote-server.py" "$work/fake-zed-remote-server.py"
chmod 0755 "$work/fake-zed-remote-server.py"

# The container's PID 1 is this wrapper, not the agent: it forwards SIGTERM, propagates the agent's
# exit status and – after the agent is gone – lists every `sleep 3600` that survived the group
# kill (the only way to observe the process table of a container that is about to exit).
cat > "$work/entry.sh" <<'SH'
#!/bin/sh
zs-agent start &
agent=$!
trap 'kill -TERM "$agent" 2>/dev/null' TERM INT
wait "$agent"
status=$?
# A trapped SIGTERM interrupts `wait` (status > 128) while the agent is still stopping: wait again
# until it is really gone, so `status` is the agent's own exit code.
while kill -0 "$agent" 2>/dev/null; do
  wait "$agent"
  status=$?
done
sleep 1
survivors="$(pgrep -f '^sleep 3600' 2>/dev/null | tr '\n' ' ')"
echo "ZS_TEST_SURVIVORS=[${survivors}]"
echo "ZS_TEST_AGENT_EXIT=${status}"
exit "$status"
SH
chmod 0755 "$work/entry.sh"

openssl ecparam -name prime256v1 -genkey -noout -out "$work/es256_private.pem" 2>/dev/null
openssl ec -in "$work/es256_private.pem" -pubout -out "$work/es256_public.pem" 2>/dev/null
openssl rand -base64 32 > "$work/port.secret"
port_secret="$(cat "$work/port.secret")"
ok "fixture repo at $fixture_sha, keys and port secret generated"

# --------------------------------------------------------------- mock control plane
say "mock control plane on :$mock_port"
node "$here/mock-control-plane.mjs" \
  --port "$mock_port" \
  --bind 0.0.0.0 \
  --clone-url "file:///fixtures/fixture.git" \
  --workspace-dir /workspaces/fixture \
  --pubkey "$work/es256_public.pem" \
  --port-secret "$port_secret" \
  --token test-token \
  --workspace-id ws_local \
  --sandbox-name sb-local \
  --activity-interval 10 \
  --extensions toml \
  ${with_services:+--services dockerd} \
  --log-out "$work/logs.jsonl" \
  > "$work/mock.out" 2> "$work/mock.err" &
mock_pid=$!
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$mock_port/__test/state" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$mock_port/__test/state" >/dev/null || {
  echo "mock control plane did not start:" >&2; cat "$work/mock.err" >&2; exit 1
}
ok "mock is answering (/__test/state)"

# ------------------------------------------------------------------- container
say "zs-agent start"
docker rm -f "$container" >/dev/null 2>&1 || true
run_args=(
  -d --name "$container"
  --add-host host.docker.internal:host-gateway
  -p 8443:8443 -p 8444:8444 -p 8445:8445 -p 8446:8446 -p 8447:8447 -p 8448:8448
  -e "ZS_CONTROL_URL=http://host.docker.internal:$mock_port/api"
  -e ZS_SANDBOX_TOKEN=test-token
  -e ZS_SANDBOX_NAME=sb-local
  -e ZS_WORKSPACE_ID=ws_local
  -e ZS_REGION=local
  -e ZS_INSECURE_COOKIES=1
  -e RUST_LOG=info
  -v "$work:/fixtures:ro"
)
# A manifest-driven dockerd needs the container to be privileged (rootful Docker inside Docker).
if [ -n "$with_services" ]; then run_args+=(--privileged); fi
if [ -n "$fake_server" ]; then
  # The supervisor builds the server command line itself, so extra flags travel in a wrapper: the
  # state file lets the harness read the fake's timeline after the container has exited.
  fake_flags="--state-file /tmp/zs-fake-state.json"
  if [ -n "$linger_child" ]; then fake_flags="$fake_flags --linger-child"; fi
  cat > "$work/fake-server.sh" <<SH
#!/bin/sh
exec /fixtures/fake-zed-remote-server.py "\$@" $fake_flags
SH
  chmod 0755 "$work/fake-server.sh"
  run_args+=(-e "ZS_SERVER_BIN=/fixtures/fake-server.sh")
fi
docker run "${run_args[@]}" "$image" sh /fixtures/entry.sh >/dev/null

health=""
for _ in $(seq 1 150); do
  health="$(curl -fsS "http://127.0.0.1:8448/health" 2>/dev/null || true)"
  if [ "$(printf '%s' "$health" | jq -r '.phase // empty' 2>/dev/null)" = "ready" ]; then break; fi
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    echo "container exited early:" >&2
    docker logs "$container" 2>&1 | tail -40 >&2
    break
  fi
  sleep 2
done
if [ -z "$health" ]; then
  bad "supervisor health on :8448 never answered"
  docker logs "$container" 2>&1 | tail -40 >&2
else
  check "public health phase" "$(printf '%s' "$health" | jq -r '.phase')" "ready"
  check "public health ok" "$(printf '%s' "$health" | jq -r '.ok')" "true"
  check "public health serverUp" "$(printf '%s' "$health" | jq -r '.serverUp')" "true"
  truthy "public health build" "$(printf '%s' "$health" | jq -r '.build')"
  check "public health hides forwards (D21 minimal body)" \
    "$(printf '%s' "$health" | jq -r 'has("forwards")')" "false"
fi

local_health="$(dsh 'curl -fsS 127.0.0.1:8450/health' 2>/dev/null || true)"
check "loopback health carries forwards" "$(printf '%s' "$local_health" | jq -r 'has("forwards")')" "true"
check "loopback health server.running" "$(printf '%s' "$local_health" | jq -r '.server.running')" "true"
truthy "loopback health server.health.build" "$(printf '%s' "$local_health" | jq -r '.server.health.build')"

check "loopback API refuses an unauthenticated /ports" \
  "$(dsh 'curl -s -o /dev/null -w "%{http_code}" -X POST 127.0.0.1:8450/ports -d "{}"' || true)" "401"
if curl -fsS --max-time 3 "http://127.0.0.1:8450/health" >/dev/null 2>&1; then
  bad "the loopback API is reachable from the host (it must bind 127.0.0.1 only)"
else
  ok "the loopback API is not reachable from the host"
fi

if dexec zs-agent wait-ready --timeout-secs 5 >/dev/null 2>&1; then
  ok "zs-agent wait-ready exits 0"
else
  bad "zs-agent wait-ready did not report ready"
fi

agent_pid="$(dsh 'cat /vercel/.zs/run/zs-agent.pid' 2>/dev/null | tr -cd '0-9')"
truthy "agent pid file" "$agent_pid"
# zs-agent sets PR_SET_DUMPABLE=0, so its /proc/<pid>/environ (ZS_SANDBOX_TOKEN, ZS_BYPASS_SECRET)
# is readable by root only: assert the protection, then read it through sudo for the D18 check.
environ_access="$(dsh "cat /proc/${agent_pid}/environ >/dev/null 2>&1 && echo readable || echo protected" || true)"
check "agent environ is not readable by the sandbox user (PR_SET_DUMPABLE=0)" "$environ_access" "protected"
secret_env_count="$(dsh "sudo -n cat /proc/${agent_pid}/environ | tr '\\0' '\\n' | grep -c '^ZS_CONTROL_SECRET=' || true" || true)"
check "no ZS_CONTROL_SECRET in the agent environment (D18)" "${secret_env_count//[!0-9]/}" "0"
check "control secret file mode" "$(dsh 'stat -c %a /vercel/.zs/run/control.secret' || true)" "600"

# ------------------------------------------------------------------ workspace
say "workspace bootstrap"
check "clone landed at the fixture revision" \
  "$(dsh 'git -C /workspaces/fixture rev-parse HEAD' 2>/dev/null || true)" "$fixture_sha"
check "postCreateCommand ran" \
  "$(dsh 'cat /workspaces/fixture/.post-create 2>/dev/null' || true)" "post-create"
# shellcheck disable=SC2016 # expanded inside the container, not here
check "HOME inside the container" "$(dsh 'echo $HOME')" "/vercel"

# The supervisor knows its child's pid; a `pgrep -f "serve --listen"` through `docker exec sh -c`
# can match the wrapper shell whose argv carries the pattern.
server_pid="$(printf '%s' "$local_health" | jq -r '.server.pid // empty' 2>/dev/null || true)"
if [ -z "$server_pid" ] || ! dsh "test -d /proc/$server_pid" 2>/dev/null; then
  bad "no 'zed-remote-server serve' process is running (health server.pid='$server_pid')"
else
  server_env="$(dsh "tr '\\0' '\\n' < /proc/$server_pid/environ" 2>/dev/null || true)"
  contains "server environment exports SHELL (b3 §7.10, D28)" "$server_env" "SHELL=/bin/bash"
  contains "server environment exports ZS_SUPERVISOR_URL" "$server_env" "ZS_SUPERVISOR_URL=http://127.0.0.1:8450"
  contains "server environment exports ZS_CONTROL_SECRET_FILE" "$server_env" "ZS_CONTROL_SECRET_FILE="
  case "$server_env" in
    *ZS_SANDBOX_TOKEN=*|*ZS_CONTROL_URL=*|*ZS_CONTROL_SECRET=*)
      bad "the server environment carries a control-plane credential" ;;
    *) ok "no control-plane credentials in the server environment" ;;
  esac
fi
if [ -n "$linger_child" ]; then
  check "the fake server's linger child is running" \
    "$(dsh "pgrep -f '^sleep 3600' >/dev/null && echo yes || echo no" || true)" "yes"
fi

# ------------------------------------------------------------------- services
if [ -n "$with_services" ]; then
  say "services from the manifest (b10 §3.16, D40)"
  # The manifest block is authoritative (D38): the seed's devcontainer.json in the checkout is
  # ignored, so the lifecycle files above came from the block, and its `services: ["dockerd"]`
  # started `sudo -n dockerd` beside the server. Phase `ready` already waited for `docker info`
  # (≤ 30 s, non-fatal), so the daemon answers at once or never.
  docker_ok=""
  for _ in $(seq 1 30); do
    if dsh 'docker info >/dev/null 2>&1'; then docker_ok=1; break; fi
    sleep 1
  done
  if [ -n "$docker_ok" ]; then
    ok "docker info succeeds inside the container within 30 s"
  else
    bad "docker info did not succeed inside the container within 30 s"
    dsh 'sudo -n cat /var/log/dockerd.log 2>/dev/null | tail -20' >&2 || true
  fi
  check "dockerd runs as root in its own process group (kill on stop)" \
    "$(dsh "ps -o user= -p \$(pgrep -x dockerd | head -1) 2>/dev/null | tr -d ' '" || true)" "root"
  services_logged=""
  for _ in $(seq 1 15); do
    services_logged="$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" | jq -r '[.logs[] | select(.source == "services")] | length' 2>/dev/null || echo 0)"
    [ "${services_logged:-0}" -gt 0 ] && break
    sleep 1
  done
  truthy "the dockerd output reached the control plane under log source services" "$services_logged"
  check "the server's environment carries the block's remoteEnv (source manifest wins over the checkout)" \
    "$(dsh "tr '\\0' '\\n' < /proc/$server_pid/environ | grep -c '^MOCK_REMOTE_ENV=1\$'" 2>/dev/null || true)" "1"
  check "a ZS_* remoteEnv key from the block never reaches the server (D18 key filter)" \
    "$(dsh "tr '\\0' '\\n' < /proc/$server_pid/environ | grep -c '^ZS_MOCK_REMOTE_ENV='" 2>/dev/null || echo 0)" "0"
fi

if [ -z "$fake_server" ]; then
  installs="$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" | jq -r '.extensions[]?.installed[]?' | sort -u | tr '\n' ' ')"
  contains "the real server reported installed extensions" "$installs" "toml"
fi

# --------------------------------------------------------------- port watcher
say "port watcher and forwards"
docker exec -d "$container" python3 -m http.server 3000 --directory /workspaces/fixture
forward=""
for _ in $(seq 1 20); do
  forward="$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" | jq -c '.forwards[]? | select(.port == 3000)')"
  if [ -n "$forward" ]; then break; fi
  sleep 1
done
if [ -z "$forward" ]; then
  bad "port 3000 was never forwarded through the control plane"
else
  check "forward 3000 is private" "$(printf '%s' "$forward" | jq -r '.visibility')" "private"
  check "forward 3000 took the first slot" "$(printf '%s' "$forward" | jq -r '.slot')" "8444"
fi
listening="$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" | jq -r '[.pings[].report.listening[]?.port] | unique | join(",")')"
contains "the activity ping reports the listening port" "$listening" "3000"

# ------------------------------------------------------------- private proxy
say "private-port proxy"
open_headers="$(curl -sS -i --max-redirs 0 "http://127.0.0.1:$mock_port/api/workspaces/ws_local/ports/3000/open" || true)"
contains "/open redirects to the slot's bootstrap URL" "$open_headers" "/__zs/auth?zs_port_token="
location="$(printf '%s' "$open_headers" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
if [ -z "$location" ]; then
  bad "/open returned no Location header"
else
  auth_headers="$(curl -sS -i --max-redirs 0 "$location" || true)"
  contains "the proxy sets zs_port_session" "$auth_headers" "zs_port_session="
  cookie="$(printf '%s' "$auth_headers" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(zs_port_session=[^;]*\).*/\1/p' | head -1)"
  check "the proxy serves the upstream with the cookie" \
    "$(curl -sS -b "$cookie" "http://127.0.0.1:8444/.post-create" || true)" "post-create"
  check "the proxy refuses a request without the cookie" \
    "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:8444/" || true)" "401"
fi

# a token minted for another port must not open this slot
stale_token="$(dexec zs-agent port-token --secret-file /fixtures/port.secret --workspace-id ws_local --port 3001 2>/dev/null || true)"
if [ -n "$stale_token" ]; then
  stale_response="$(curl -sS -i "http://127.0.0.1:8444/__zs/auth?zs_port_token=$stale_token&next=/" || true)"
  contains "a token for another port is refused by this slot" "$stale_response" " 401 "
  contains "the refusal names port_session_stale" "$stale_response" "port_session_stale"
fi

# a second private forward lands on the next slot and 502s with nothing behind it
curl -fsS -X POST "http://127.0.0.1:$mock_port/__test/forward" \
  -H 'content-type: application/json' -d '{"port":3001,"visibility":"private"}' >/dev/null || true
slot2_open="$(curl -sS -i --max-redirs 0 "http://127.0.0.1:$mock_port/api/workspaces/ws_local/ports/3001/open" || true)"
slot2_location="$(printf '%s' "$slot2_open" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
if [ -n "$slot2_location" ]; then
  slot2_headers="$(curl -sS -i --max-redirs 0 "$slot2_location" || true)"
  slot2_cookie="$(printf '%s' "$slot2_headers" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(zs_port_session=[^;]*\).*/\1/p' | head -1)"
  if [ -n "$slot2_cookie" ]; then
    check "an empty upstream answers 502" \
      "$(curl -sS -o /dev/null -w '%{http_code}' -b "$slot2_cookie" "http://127.0.0.1:8445/" || true)" "502"
  else
    bad "slot 8445 did not set a session cookie"
  fi
fi

# --------------------------------------------------------- credential helper
say "git credential helper"
cred="$(printf 'protocol=https\nhost=github.com\npath=acme/fixture.git\n\n' \
  | docker exec -i "$container" zs-agent credential get 2>/dev/null || true)"
contains "credential helper returns the username" "$cred" "username=x-access-token"
contains "credential helper returns the token" "$cred" "password=ghs_mock"
contains "credential helper returns an expiry" "$cred" "password_expiry_utc="
denied="$(printf 'protocol=https\nhost=github.com\npath=other/repo.git\n\n' \
  | docker exec -i "$container" zs-agent credential get 2>/dev/null || true)"
check "a repo outside the workspace gets no credentials" "$denied" ""
# git itself resolves the helper through the image's system config (`!zs-agent credential`).
filled="$(printf 'protocol=https\nhost=github.com\npath=acme/fixture.git\n\n' \
  | docker exec -i "$container" git -C /workspaces/fixture credential fill 2>/dev/null || true)"
contains "git credential fill goes through the helper" "$filled" "password=ghs_mock"

# --------------------------------------------------------------- toolchains
say "toolchains as ubuntu"
tool_state="$(dsh 'npm i -g cowsay >/dev/null 2>&1 && cd /tmp && go mod init x >/dev/null 2>&1 && echo ok' || true)"
check "npm -g and go work as ubuntu (no root-owned files under /vercel)" "$tool_state" "ok"

# ------------------------------------------------------- lifecycle directives
say "lifecycle notices"
idle_at=$(( $(date +%s) * 1000 + 240000 ))
curl -fsS -X POST "http://127.0.0.1:$mock_port/__test/directive" \
  -H 'content-type: application/json' -d "{\"idleStopAt\": $idle_at}" >/dev/null
if [ -n "$fake_server" ]; then
  # Only the fake server records what it was told; the real one is asserted through its own tests.
  notice=""
  for _ in $(seq 1 20); do
    notice="$(dsh 'curl -fsS 127.0.0.1:8443/__fake/state' 2>/dev/null \
      | jq -r '[.recorded.lifecycle[]?.kind] | join(",")' 2>/dev/null || true)"
    case "$notice" in *idle_stop_in*) break ;; esac
    sleep 1
  done
  contains "the server received an idle_stop_in notice" "$notice" "idle_stop_in"
  count="$(dsh 'curl -fsS 127.0.0.1:8443/__fake/state' 2>/dev/null \
    | jq '[.recorded.lifecycle[]? | select(.kind == "idle_stop_in")] | length' 2>/dev/null || echo 0)"
  check "the notice is sent once per deadline" "$count" "1"
  cap_at=$(( $(date +%s) * 1000 + 1200000 ))
  curl -fsS -X POST "http://127.0.0.1:$mock_port/__test/directive" \
    -H 'content-type: application/json' -d "{\"sessionCapAt\": $cap_at}" >/dev/null
  cap_notice=""
  for _ in $(seq 1 20); do
    cap_notice="$(dsh 'curl -fsS 127.0.0.1:8443/__fake/state' 2>/dev/null \
      | jq -r '[.recorded.lifecycle[]? | select(.kind == "session_cap_in") | .seconds] | join(",")' 2>/dev/null || true)"
    [ -n "$cap_notice" ] && break
    sleep 1
  done
  truthy "the server received a session_cap_in notice" "$cap_notice"
  case "$cap_notice" in
    11[0-9][0-9]|1200) ok "session_cap_in counts down from ≈ 1200 s ($cap_notice)" ;;
    *) bad "session_cap_in seconds unexpected: '$cap_notice'" ;;
  esac
  # The idle deadline is unchanged, so nothing is re-sent alongside the cap notice.
  count="$(dsh 'curl -fsS 127.0.0.1:8443/__fake/state' 2>/dev/null \
    | jq '[.recorded.lifecycle[]? | select(.kind == "idle_stop_in")] | length' 2>/dev/null || echo 0)"
  check "idle_stop_in is still sent exactly once" "$count" "1"
else
  ok "skipped (needs --fake-server to observe the control calls)"
fi

# ------------------------------------------------------- rebuild tarball (1/2)
archive="$work/restore.tgz"
if [ -n "$with_restore" ]; then
  say "rebuild tarball"
  # Deliberately the pre-D9 three-path shape (b8 §3.24 step 13): production archives carry D9's
  # two paths, and the third one exercises restore_tarball's tolerant `vercel/.config/zed` mapping
  # (the manifest's settings must win over the archived copy).
  dsh 'mkdir -p /vercel/.config/zed && printf "{ \"archived\": true }" > /vercel/.config/zed/settings.json'
  dexec tar czf - -C / workspaces vercel/.local/share/zed vercel/.config/zed > "$archive" 2>/dev/null || true
  if [ -s "$archive" ]; then
    ok "archive built from the live container ($(wc -c < "$archive") bytes)"
    contains "the archive carries the workspace tree" \
      "$(tar tzf "$archive" 2>/dev/null | head -200 | tr '\n' ' ')" "workspaces/fixture/"
  else
    bad "could not build the restore archive"
  fi
fi

# ------------------------------------------------------------------ shutdown
say "shutdown"
started="$(date +%s)"
docker kill -s TERM "$container" >/dev/null
exit_code=""
for _ in $(seq 1 30); do
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$container" 2>/dev/null)"
    break
  fi
  sleep 1
done
elapsed=$(( $(date +%s) - started ))
check "the container exits 0 on SIGTERM" "${exit_code:-timeout}" "0"
if [ "$elapsed" -le 25 ]; then ok "exit within b9's 25 s budget (${elapsed}s)"; else bad "exit took ${elapsed}s (> 25 s)"; fi
container_out="$(docker logs "$container" 2>/dev/null || true)"
contains "the entry script saw the agent exit 0" "$container_out" "ZS_TEST_AGENT_EXIT=0"
if [ -n "$linger_child" ]; then
  # brief §3.24 step 12: no `sleep 3600` survives the group kill.
  survivors="$(printf '%s\n' "$container_out" | sed -n 's/^ZS_TEST_SURVIVORS=\[\(.*\)\]$/\1/p' | tail -1 | tr -d ' ')"
  check "no sleep 3600 survives the agent (group kill)" "${survivors:-unobserved}" ""
fi

if [ -f "$work/logs.jsonl" ]; then
  sources="$(jq -r '.source' < "$work/logs.jsonl" 2>/dev/null | sort -u | tr '\n' ' ')"
  contains "agent logs reached the control plane" "$sources" "agent"
  contains "server logs reached the control plane" "$sources" "server"
  final_msg="$(jq -r 'select(.source == "agent" and .msg == "shutdown complete") | .msg' < "$work/logs.jsonl" 2>/dev/null | tail -1)"
  check "the final log batch carries 'shutdown complete'" "$final_msg" "shutdown complete"
  if [ -n "$fake_server" ]; then
    fake_source="$(jq -r 'select(.source == "server:fake_zed_remote_server") | .source' < "$work/logs.jsonl" 2>/dev/null | head -1)"
    check "the fake's JSON log lines are mapped to server:<module_path>" "$fake_source" "server:fake_zed_remote_server"
  fi
else
  bad "no log batch reached the control plane"
fi

if [ -n "$fake_server" ]; then
  # The fake dumps its timeline on exit; the stopped container's filesystem is still readable.
  if docker cp "$container:/tmp/zs-fake-state.json" "$work/fake-state.json" >/dev/null 2>&1; then
    stopping_at="$(jq -r '.timeline.stopping_at // empty' < "$work/fake-state.json")"
    sigterm_at="$(jq -r '.timeline.sigterm_at // empty' < "$work/fake-state.json")"
    truthy "the fake recorded the stopping notice" "$stopping_at"
    truthy "the fake recorded SIGTERM" "$sigterm_at"
    if [ -n "$stopping_at" ] && [ -n "$sigterm_at" ] && [ "$stopping_at" -le "$sigterm_at" ]; then
      ok "POST /control/lifecycle {stopping} arrived before SIGTERM"
    else
      bad "stopping ($stopping_at) did not precede SIGTERM ($sigterm_at)"
    fi
    fake_env_secret="$(jq -r '.env.ZS_CONTROL_SECRET // empty' < "$work/fake-state.json")"
    check "the fake's environment carries no ZS_CONTROL_SECRET" "$fake_env_secret" ""
    contains "the fake was started with --control-secret-file" "$(jq -r '.argv | join(" ")' < "$work/fake-state.json")" "--control-secret-file"
  else
    bad "could not copy the fake server's state file out of the container"
  fi
fi

# ------------------------------------------------------- rebuild tarball (2/2)
if [ -n "$with_restore" ] && [ -s "$archive" ]; then
  say "restore from the rebuild tarball"
  kill "$mock_pid" 2>/dev/null || true
  wait "$mock_pid" 2>/dev/null || true
  node "$here/mock-control-plane.mjs" \
    --port "$mock_port" \
    --bind 0.0.0.0 \
    --clone-url "file:///fixtures/fixture.git" \
    --workspace-dir /workspaces/fixture \
    --pubkey "$work/es256_public.pem" \
    --port-secret "$port_secret" \
    --token test-token \
    --workspace-id ws_local \
    --sandbox-name sb-local \
    --activity-interval 10 \
    --public-host host.docker.internal \
    ${with_services:+--services dockerd} \
    --restore-tarball "$archive" \
    --log-out "$work/logs.restore.jsonl" \
    > "$work/mock.restore.out" 2> "$work/mock.restore.err" &
  mock_pid=$!
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$mock_port/__test/state" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done

  docker rm -f "$container" >/dev/null 2>&1 || true
  docker run "${run_args[@]}" "$image" zs-agent start >/dev/null
  restored=""
  for _ in $(seq 1 150); do
    restored="$(curl -fsS "http://127.0.0.1:8448/health" 2>/dev/null || true)"
    if [ "$(printf '%s' "$restored" | jq -r '.phase // empty' 2>/dev/null)" = "ready" ]; then break; fi
    sleep 2
  done
  check "the restored boot reaches phase ready" \
    "$(printf '%s' "$restored" | jq -r '.phase // "none"')" "ready"
  check "the restored tree carries the postCreate marker" \
    "$(dsh 'cat /workspaces/fixture/.post-create 2>/dev/null' || true)" "post-create"
  check "the tarball was fetched without credentials" \
    "$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" | jq -r '[.restoreFetches[] | select(.authenticated)] | length')" "0"
  truthy "the tarball was fetched at all" \
    "$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" | jq -r '.restoreFetches | length')"
  # Markers live in ZS_STATE_DIR, which a fresh container does not carry, so postCreateCommand
  # runs exactly once more on the restored tree (b8 §6.2 case f; §7 item 4i).
  post_create_runs="$(curl -fsS "http://127.0.0.1:$mock_port/__test/state" \
    | jq '[.logs[] | select(.source == "agent" and .msg == "lifecycle command" and .fields.label == "post_create")] | length')"
  check "postCreateCommand ran exactly once on the restored tree" "$post_create_runs" "1"
  manifest_settings="$(curl -fsS -H 'authorization: Bearer test-token' "http://127.0.0.1:$mock_port/api/sandboxes/sb-local/manifest" | jq -r '.settings.settings')"
  check "settings.json equals the manifest's text (control plane wins over the archive)" \
    "$(dsh 'cat /vercel/.config/zed/settings.json' 2>/dev/null || true)" "$manifest_settings"
  docker kill -s TERM "$container" >/dev/null 2>&1 || true
fi

say "summary"
if [ "$failures" -ne 0 ]; then
  echo "--- last 40 lines of the container log ---" >&2
  docker logs "$container" 2>&1 | tail -40 >&2 || true
fi
if [ "$failures" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$failures check(s) failed" >&2
  exit 1
fi
