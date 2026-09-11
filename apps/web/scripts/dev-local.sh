#!/usr/bin/env bash
# Local SQLite control plane and sandbox processes; no cloud credentials.
# Usage: scripts/dev-local.sh [dev|build|stop|clean]
# ZS_DEV_PORT (3100), ZS_LOCAL_ROOT, ZS_LOCAL_REPOS_DIR and ZS_SERVE_BIN override local paths.
# ZS_SKIP_BUILD=1 explicitly reuses existing binaries. Never shares state with Vercel.
set -euo pipefail
# Also explicitly reap this run's flusher on shutdown: the disabled flag alone does not
# prevent every detached telemetry helper (and its esbuild child) from surviving next dev.
export NEXT_TELEMETRY_DISABLED=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"
ZED_DIR="$REPO_ROOT/zed"
SUPERVISOR_DIR="$REPO_ROOT/sandbox/supervisor"
DEV_DIR="$WEB_DIR/.zs-dev"
MODE="${1:-dev}"
[ $# -gt 0 ] && shift

TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
PORT="${ZS_DEV_PORT:-3100}"
LOCAL_ROOT="${ZS_LOCAL_ROOT:-$TMP_BASE/zs-local}"
LOCAL_ROOT="${LOCAL_ROOT%/}"
REPOS_DIR="${ZS_LOCAL_REPOS_DIR:-$LOCAL_ROOT/repos}"
AGENT_BIN="$SUPERVISOR_DIR/target/debug/zs-agent"
BASE_URL="http://127.0.0.1:$PORT"

log() { printf '[dev-local] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# LOCAL_ROOT names the directories whose processes `stop` terminates and that the backend
# `rm -rf`s on delete; refuse anything that is not a dedicated directory at least two levels
# below `/` (never `/`, `/tmp`, $HOME or the temp base itself).
check_local_root() {
  case "$LOCAL_ROOT" in
    /*) ;;
    *) die "ZS_LOCAL_ROOT must be an absolute path (got '$LOCAL_ROOT')" ;;
  esac
  case "${LOCAL_ROOT#/}" in
    */*) ;;
    *) die "ZS_LOCAL_ROOT must be a dedicated directory at least two levels deep, e.g. /tmp/zs-local (got '$LOCAL_ROOT')" ;;
  esac
  if [ "$LOCAL_ROOT" = "${HOME%/}" ] || [ "$LOCAL_ROOT" = "$TMP_BASE" ]; then
    die "ZS_LOCAL_ROOT must be a dedicated directory, not $LOCAL_ROOT"
  fi
}
check_local_root

# A literal string as an extended-regex pattern (pgrep -f).
regex_escape() { printf '%s' "$1" | sed 's/[][\\.*^$+?(){}|]/\\&/g'; }

# The server binary: a copy under zed/target/zs-local that `cargo test` cannot clobber, else the
# workspace's debug binary. `cargo test -p remote_server` links the same bin target with the
# dev-dependencies' features (util/test-support hard-codes HOME to /Users/zed), and writes it to
# target/debug/remote_server too; such a binary cannot serve on a developer machine, so
# `check_serve_bin` refuses it. The copy stays inside the zed checkout on purpose: a debug build
# finds its assets (settings/default.json, …) by walking up from the executable to the nearest
# `.git` (util::dev_repo_root), so a copy outside zed/ would look for them in the wrong checkout.
SERVE_STASH="$ZED_DIR/target/zs-local/zed-remote-server"
# An explicitly selected prebuilt server can be used with ZS_SKIP_BUILD=1.
SERVE_STASH="${ZS_SERVE_BIN:-$SERVE_STASH}"
serve_bin() {
  if [ -x "$SERVE_STASH" ]; then
    echo "$SERVE_STASH"
  elif [ -x "$ZED_DIR/target/debug/zed-remote-server" ]; then
    echo "$ZED_DIR/target/debug/zed-remote-server"
  else
    echo "$ZED_DIR/target/debug/remote_server"
  fi
}

serve_bin_is_test_build() {
  grep -c -a -q "/Users/zed" "$1" 2>/dev/null
}

check_serve_bin() {
  local bin
  bin="$(serve_bin)"
  [ -x "$bin" ] || die "no zed-remote-server binary at $bin (run: scripts/dev-local.sh build)"
  if serve_bin_is_test_build "$bin"; then
    die "$bin was linked by 'cargo test' with util/test-support (HOME is hard-coded to /Users/zed); \
run 'cd $ZED_DIR && cargo build -p remote_server' (or scripts/dev-local.sh build) to get a servable binary"
  fi
  # A binary that cannot even print its version (a stale copy, a missing dylib, the wrong
  # architecture) fails here, not as a 60 s crash loop inside the supervisor.
  mkdir -p "$DEV_DIR"
  if ! "$bin" version >"$DEV_DIR/serve-version.out" 2>&1; then
    die "$bin version failed: $(tail -3 "$DEV_DIR/serve-version.out" | tr '\n' ' ')"
  fi
  log "zed-remote-server: $bin ($(head -1 "$DEV_DIR/serve-version.out"))"
}

# ---------------------------------------------------------------------------
# Builds
# ---------------------------------------------------------------------------

build_all() {
  if [ "${ZS_SKIP_BUILD:-0}" = "1" ]; then
    log "ZS_SKIP_BUILD=1: not building"
    check_serve_bin
    return
  fi
  log "building zs-agent (sandbox/supervisor)"
  (cd "$SUPERVISOR_DIR" && cargo build --locked) || die "zs-agent build failed"
  [ -x "$AGENT_BIN" ] || die "zs-agent did not build at $AGENT_BIN"
  # The zed workspace is shared with other running rounds and serializes on cargo's lock; wait.
  log "building zed-remote-server (cargo build -p remote_server; waits for the shared lock)"
  # A local server must be a dev build (ZS_BUILD_ID starting with "dev"): the client requires
  # an exact build match otherwise, and the local bundle id changes with every dirty-tree
  # rebuild. Without the variable the binary reports the raw commit hash and every browser
  # session stalls after HelloAck with an incompatible-build exit.
  (cd "$ZED_DIR" && ZS_BUILD_ID="${ZS_SERVER_BUILD_ID:-dev-0}" cargo build --locked -p remote_server --features serve) ||
    die "zed-remote-server build failed"
  if serve_bin_is_test_build "$ZED_DIR/target/debug/remote_server"; then
    die "cargo produced a test-only remote_server binary"
  fi
  mkdir -p "$(dirname "$SERVE_STASH")"
  # Never overwrite the stash in place: macOS keeps the code signature of a cached
  # executable's vnode, and a binary written over it is SIGKILLed at launch ("Killed: 9").
  # A fresh file (and an ad-hoc re-sign on Darwin) is what makes the copy runnable.
  rm -f "$SERVE_STASH"
  cp "$ZED_DIR/target/debug/remote_server" "$SERVE_STASH"
  if [ "$(uname -s)" = Darwin ] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$SERVE_STASH" >/dev/null 2>&1 || die "codesign of $SERVE_STASH failed"
  fi
  log "copied the fresh remote_server binary to $SERVE_STASH"
  check_serve_bin
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resolve_dev_db() {
  case "${ZS_DEV_DB:-sqlite}" in sqlite|auto) ;; *) die "ZS_DEV_DB now uses sqlite; Postgres is no longer used" ;; esac
  log "database: local libSQL file"
}

# ---------------------------------------------------------------------------
# Keys and environment
# ---------------------------------------------------------------------------

gen_keys() {
  mkdir -p "$DEV_DIR"
  if [ -f "$DEV_DIR/keys.env" ] && [ -f "$DEV_DIR/jwt-private.pem" ] && grep -q BETTER_AUTH_SECRET "$DEV_DIR/keys.env"; then
    return
  fi
  log "generating dev ES256 keys into $DEV_DIR"
  (cd "$WEB_DIR" && node - "$DEV_DIR" <<'NODE'
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
fs.writeFileSync(path.join(dir, "jwt-private.pem"), privatePem + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(dir, "jwt-public.pem"), publicPem + "\n", { mode: 0o644 });
// Shell-quoted `export` lines; PEM newlines become `\n`, which lib/tokens.ts normalizePem expands.
const quote = (value) => "'" + value.replace(/'/g, "'\\''").replace(/\n/g, "\\n") + "'";
const lines = [
  `export ZS_JWT_PRIVATE_KEY=${quote(privatePem)}`,
  `export ZS_JWT_KID='k1'`,
  `export ZS_JWT_ISSUER='zs'`,
  `export BETTER_AUTH_SECRET=${quote(randomBytes(32).toString("base64"))}`,
  `export CRON_SECRET=${quote(randomBytes(24).toString("base64url"))}`,
  "",
];
fs.writeFileSync(path.join(dir, "keys.env"), lines.join("\n"), { mode: 0o600 });
NODE
  )
}

# Exports the local-mode environment. `next dev` reads .env.local too, but a variable that is
# already in the process environment always wins, so this is authoritative. `$1` names the
# database: a local SQLite file.
export_env() {
  local db_target="$1"
  # shellcheck disable=SC1091
  source "$DEV_DIR/keys.env"
  export TURSO_DATABASE_URL="" TURSO_AUTH_TOKEN="" VERCEL_ENV="" VERCEL_URL=""
  export ZS_DB_URL="file:$db_target"
  mkdir -p "$(dirname "$db_target")"
  export ZS_SANDBOX_BACKEND=local
  export ZS_LOCAL_ROOT="$LOCAL_ROOT"
  export ZS_LOCAL_REPOS_DIR="$REPOS_DIR"
  export ZS_AGENT_BIN="$AGENT_BIN"
  ZS_SERVE_BIN="$(serve_bin)"
  export ZS_SERVE_BIN
  export ZS_CONTROL_URL="$BASE_URL/api"
  export ZS_CLIENT_BUILD_ID="${ZS_CLIENT_BUILD_ID:-dev-local}"
  export ZS_SERVER_BUILD_ID="${ZS_SERVER_BUILD_ID:-dev-0}"
  export ZS_IMAGE_REF="${ZS_IMAGE_REF:-zs-workspace:dev-0}"
  export ZS_CSP_UNSAFE_EVAL="${ZS_CSP_UNSAFE_EVAL:-1}"
  mkdir -p "$LOCAL_ROOT" "$REPOS_DIR"
  ENV_EXPORTED=1
}
ENV_EXPORTED=0

ENV_MARKER="# generated by scripts/dev-local.sh (local mode); safe to delete"

# Mirrors the exported variables to .zs-dev/env.local (mode 0600: it carries the signing key and
# every control-plane secret) for inspection and for tooling that wants a dotenv file. It is NOT
# copied to apps/web/.env.local: that file is read by a plain `pnpm dev`, which binds every
# interface, and would turn it into an unauthenticated control plane spawning processes on this
# machine. A copy an earlier version of this script left there is removed.
write_env_files() {
  local dotenv="$DEV_DIR/env.local"
  (
    umask 077
    {
      echo "$ENV_MARKER"
      for name in ZS_SANDBOX_BACKEND \
        ZS_LOCAL_ROOT ZS_LOCAL_REPOS_DIR ZS_AGENT_BIN ZS_SERVE_BIN ZS_DB_URL \
        ZS_CONTROL_URL ZS_CLIENT_BUILD_ID ZS_SERVER_BUILD_ID ZS_IMAGE_REF ZS_CSP_UNSAFE_EVAL \
        ZS_JWT_PRIVATE_KEY ZS_JWT_KID ZS_JWT_ISSUER BETTER_AUTH_SECRET CRON_SECRET; do
        printf '%s="%s"\n' "$name" "${!name:-}"
      done
    } > "$dotenv.tmp"
    mv -f "$dotenv.tmp" "$dotenv"
  )
  chmod 600 "$dotenv"
  if [ -f "$WEB_DIR/.env.local" ] && head -1 "$WEB_DIR/.env.local" | grep -q "generated by scripts/dev-local.sh"; then
    rm -f "$WEB_DIR/.env.local"
    log "removed the generated $WEB_DIR/.env.local: local mode is only exported by this script (see $dotenv)"
  fi
}

# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

NEXT_PID=""
# shellcheck source=dev-local-telemetry.sh
source "$SCRIPT_DIR/dev-local-telemetry.sh"

# Every live process of one sandbox directory: the supervisor from its pid file (its argv is
# `<zs-agent> start`; the directory is only in its environment, invisible to `pgrep -f`), the
# recorded detached commands without an exit code, and whatever names the directory on its
# command line provided it is one of our programs (the server: `--workspace-root <dir>/…`;
# git/tar/sh helpers) — never a developer's editor or a `tail -f` on the logs.
sandbox_pids() {
  local dir="$1" pid comm
  {
    if [ -f "$dir/state/run/zs-agent.pid" ]; then cat "$dir/state/run/zs-agent.pid"; echo; fi
    node -e '
      const record = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const command of Object.values(record.commands || {})) if (command.exitCode === null) console.log(command.pid);
    ' "$dir/sandbox.json" 2>/dev/null
    pgrep -f -- "$(regex_escape "$dir")/" 2>/dev/null
    true
  } | grep -E '^[0-9]+$' | sort -un | while read -r pid; do
    { [ "$pid" -gt 1 ] && [ "$pid" != "$$" ] && kill -0 "$pid" 2>/dev/null; } || continue
    comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    case "$(basename "${comm:-/}")" in
      zs-agent|zed-remote-server|remote_server|sh|bash|git|tar) echo "$pid" ;;
    esac
  done || true
}

any_alive() {
  local pid
  for pid in "$@"; do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

# A record whose processes are all gone says so (`status: stopped`, exit codes filled in), so
# the next boot of that sandbox resumes it instead of adopting a dead session.
mark_sandboxes_stopped() {
  local record
  for record in "$LOCAL_ROOT"/*/sandbox.json; do
    [ -f "$record" ] || continue
    node - "$record" <<'NODE' || true
const fs = require("node:fs");
const file = process.argv[2];
const record = JSON.parse(fs.readFileSync(file, "utf8"));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
};
let changed = false;
for (const command of Object.values(record.commands || {})) {
  if (command.exitCode === null && !alive(command.pid)) { command.exitCode = -1; changed = true; }
}
const running = Object.values(record.commands || {}).some((command) => command.exitCode === null);
if (!running && record.status !== "stopped") {
  record.status = "stopped"; record.sessionId = null; record.startedAt = null; record.expiresAt = null; changed = true;
}
if (changed) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
  console.error(`[dev-local] ${record.name}: record marked stopped`);
}
NODE
  done
}

# After `stop`: removes every sandbox directory whose record says stopped and no process is
# left (workspaces, snapshots, logs). The dev keys in .zs-dev stay.
clean_local_root() {
  local record dir status removed=0
  for record in "$LOCAL_ROOT"/*/sandbox.json; do
    [ -f "$record" ] || continue
    dir="$(dirname "$record")"
    status="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status)' "$record" 2>/dev/null || echo unknown)"
    if [ "$status" = stopped ] && [ -z "$(sandbox_pids "$dir")" ]; then
      rm -rf "$dir"
      log "removed $(basename "$dir")"
      removed=$((removed + 1))
    else
      log "keeping $(basename "$dir") (status $status)"
    fi
  done
  log "clean: $removed directories removed under $LOCAL_ROOT"
}

# SIGTERM to every sandbox's process groups (the supervisor's own stop path runs), up to 25 s,
# then SIGKILL what is left; by recorded pids, never by an argv pattern over LOCAL_ROOT.
stop_local_sandboxes() {
  local record dir pids pid all=""
  for record in "$LOCAL_ROOT"/*/sandbox.json; do
    [ -f "$record" ] || continue
    dir="$(dirname "$record")"
    pids="$(sandbox_pids "$dir")"
    [ -n "$pids" ] || continue
    # shellcheck disable=SC2086
    log "stopping $(basename "$dir") (pids: $(printf '%s ' $pids))"
    for pid in $pids; do
      kill -s TERM -- "-$pid" 2>/dev/null || kill -s TERM "$pid" 2>/dev/null || true
    done
    all="$all $pids"
  done
  if [ -n "$all" ]; then
    local waited=0
    # shellcheck disable=SC2086
    while [ "$waited" -lt 25 ] && any_alive $all; do
      sleep 1
      waited=$((waited + 1))
    done
    for pid in $all; do
      if kill -0 "$pid" 2>/dev/null; then
        log "pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null || echo '?')) ignored SIGTERM for 25 s; SIGKILL"
        kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null || true
      fi
    done
  fi
  mark_sandboxes_stopped
}

stop_next() {
  if [ -n "$NEXT_PID" ] && kill -0 "$NEXT_PID" 2>/dev/null; then
    log "stopping next dev (pid $NEXT_PID)"
    kill -TERM "$NEXT_PID" 2>/dev/null || true
    local waited=0
    while [ "$waited" -lt 15 ] && kill -0 "$NEXT_PID" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    kill -KILL "$NEXT_PID" 2>/dev/null || true
  fi
  # Whatever still holds the port (the dev server's own child processes).
  local holders
  holders="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$holders" ]; then
    # shellcheck disable=SC2086
    kill -TERM $holders 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -KILL $holders 2>/dev/null || true
  fi
  stop_next_telemetry "$NEXT_PID" "$WEB_DIR"
  NEXT_PID=""
}

# Stops every live workspace through the API while the dev server answers, so the ordinary
# `stopWorkspace` run does the work (STOPPING notice, client-state flush, snapshot, `stopped`
# row). Bounded: a run that does not finish within 90 s is left to the process kill below and
# the database fallback.
stop_workspaces_via_api() {
  local listing="$DEV_DIR/workspaces.json"
  mkdir -p "$DEV_DIR"
  if ! curl -fsS -o "$listing" "$BASE_URL/api/workspaces" 2>/dev/null; then
    log "no control plane answering on $BASE_URL; skipping the API stop"
    return 0
  fi
  local ids id
  ids="$(node -e '
    const listing = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const w of listing.workspaces || []) if (["creating", "running", "stopping", "rebuilding"].includes(w.state)) console.log(w.id);
  ' "$listing" 2>/dev/null || true)"
  [ -n "$ids" ] || { log "no live workspace to stop through the API"; return 0; }
  for id in $ids; do
    log "stopping workspace $id through the API (POST /stop)"
    curl -fsS -X POST -o /dev/null "$BASE_URL/api/workspaces/$id/stop" 2>/dev/null ||
      log "warning: POST /api/workspaces/$id/stop failed (a run may be in flight)"
  done
  local waited=0 live
  while [ "$waited" -lt 90 ]; do
    live=""
    for id in $ids; do
      if curl -fsS -o "$listing" "$BASE_URL/api/workspaces/$id" 2>/dev/null &&
        node -e '
          const w = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).workspace;
          process.exit(w && w.state === "stopped" && !w.workflowRunId ? 0 : 1);
        ' "$listing" 2>/dev/null; then
        continue
      fi
      live="$live $id"
    done
    [ -n "$live" ] || { log "every workspace stopped through the API"; return 0; }
    sleep 2
    waited=$((waited + 2))
  done
  log "warning: still not stopped after 90 s:$live (their processes are killed next; rows are marked in the database)"
}

# With the dev server down, a row left live over a dead sandbox is marked `stopped` directly
# (scripts/dev-local-db.ts against the dev database); `/connect` would reconcile it on the next
# start anyway, this keeps the next `dev` honest from its first request.
mark_workspaces_stopped_in_db() {
  if [ "$ENV_EXPORTED" != 1 ]; then
    gen_keys
    resolve_dev_db
    export_env "$LOCAL_ROOT/control.db"
  fi
  log "marking live workspace rows stopped in the database"
  (cd "$WEB_DIR" && pnpm exec tsx scripts/dev-local-db.ts mark-stopped 2>&1 | grep -v '^\s*$' >&2) ||
    log "warning: could not mark the workspaces stopped in the database"
}

# Sandboxes first: the supervisors' stop paths still reach the control plane, and `next dev`
# never sees a half-stopped sandbox.
shutdown_all() {
  stop_local_sandboxes
  stop_next
}

# Ctrl-C on `dev`: the sandboxes and the dev server, then the rows they leave live (the
# environment is already exported, so the database step needs no re-export).
dev_shutdown() {
  shutdown_all
  mark_workspaces_stopped_in_db
}

# `stop`/`clean`: the API while it answers, the processes, the dev server, then the database.
stop_everything() {
  stop_workspaces_via_api
  stop_local_sandboxes
  stop_next
  mark_workspaces_stopped_in_db
}

start_next() {
  local log_file="$DEV_DIR/next.log"
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $PORT is in use (set ZS_DEV_PORT, or run: scripts/dev-local.sh stop)"
  fi
  log "starting next dev on $BASE_URL (log: $log_file)"
  (cd "$WEB_DIR" && exec node node_modules/next/dist/bin/next dev -p "$PORT" -H 127.0.0.1) > "$log_file" 2>&1 &
  NEXT_PID=$!
  local waited=0
  # The first request compiles the route; give the dev server up to 5 minutes.
  while [ "$waited" -lt 300 ]; do
    if ! kill -0 "$NEXT_PID" 2>/dev/null; then
      tail -40 "$log_file" >&2
      die "next dev exited early"
    fi
    if curl -fsS -o /dev/null "$BASE_URL/api/workspaces" 2>/dev/null; then
      log "control plane ready as the dev user (GET /api/workspaces → 200)"
      return
    fi
    sleep 2
    waited=$((waited + 2))
  done
  tail -40 "$log_file" >&2
  die "next dev did not answer GET /api/workspaces within 5 minutes"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "$MODE" in
  build)
    build_all
    ;;
  stop)
    stop_everything
    ;;
  clean)
    stop_everything
    clean_local_root
    ;;
  dev)
    build="${ZS_CLIENT_BUILD_ID:-dev-local}"
    [[ "$build" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || die "invalid ZS_CLIENT_BUILD_ID"
    [ -f "$WEB_DIR/public/editor/$build/zed_web.js" ] && \
      [ -f "$WEB_DIR/public/editor/$build/zed_web_bg.wasm" ] || \
      die "editor bundle $build missing; run zed/script/build-web --build-id $build --out-dir ../apps/web/public/editor from the repository root"
    build_all
    gen_keys
    resolve_dev_db
    export_env "$LOCAL_ROOT/control.db"
    write_env_files
    trap dev_shutdown EXIT INT TERM
    start_next
    log "shared public space; local repositories: $REPOS_DIR (owner 'local', installation 1)"
    log "example: curl -X POST $BASE_URL/api/workspaces -H 'content-type: application/json' -d '{\"repo\":{\"installationId\":1,\"owner\":\"local\",\"name\":\"<dir under repos>\"}}'"
    log "press Ctrl-C to stop"
    wait "$NEXT_PID"
    ;;
  *)
    die "usage: $0 [dev|build|stop|clean]"
    ;;
esac
