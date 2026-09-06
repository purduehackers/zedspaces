#!/usr/bin/env bash
# Local control plane on this machine, no Vercel account (round 2, lane local-backend).
#
#   scripts/dev-local.sh            build everything, start `next dev` in local mode, keep running
#   scripts/dev-local.sh e2e        same, then run the native end-to-end test and shut everything down
#   scripts/dev-local.sh browser [playwright args…]
#                                   same, with the test-hooks wasm bundle (built when missing), the
#                                   test-only routes and the rpc proxy, then run the Playwright suite
#                                   (tests/e2e-browser) and shut everything down; e.g. --project=chromium
#   scripts/dev-local.sh build      only build zs-agent, zed-remote-server and the native test binary
#   scripts/dev-local.sh stop       stop every workspace through the API when the dev server answers,
#                                   then every local sandbox process and the dev server, then mark any
#                                   row still live `stopped` in the database (scripts/dev-local-db.ts)
#   scripts/dev-local.sh clean      stop, then remove every stopped sandbox directory and the e2e fixture repos
#
# Local mode uses a shared login-free viewer, a libSQL file, and the real local
# supervisor/server on 127.0.0.1. No Docker, database service, or external auth.
# Dev ES256 keys live in apps/web/.zs-dev/ (mode 0600), generated once.
#
# The local-mode environment is only ever *exported* by this script (and mirrored to
# .zs-dev/env.local for inspection); it is never written to apps/web/.env.local, so a plain
# `pnpm dev` (which binds every interface) never serves the unauthenticated dev mode. `next dev`
# is started with -H 127.0.0.1 here. `pnpm dev:local [mode]` is the same as running this script.
#
# Environment knobs: ZS_DEV_PORT (3100; 3110 in browser mode so it never collides with a running
# `dev`), ZS_DEV_DB (sqlite), ZS_LOCAL_ROOT ($TMPDIR/zs-local;
# $TMPDIR/zs-local-browser in browser mode; must be a dedicated directory), ZS_SKIP_BUILD=1,
# ZS_KEEP_E2E=1 (keep the e2e run's database/libSQL directory and, with the test's own
# ZS_E2E_KEEP=1, its workspace and sandbox directory). Browser mode: ZS_BROWSER_BUILD_ID pins the
# test-hooks bundle id (skips the dirty-tree hash, so an existing bundle is reused across source
# edits), ZS_BROWSER_BUILD_ARGS adds build-web flags to that bundle (`--names` for symbolised panic
# stacks), ZS_KEEP_TEST_BUNDLES=1 keeps the earlier `-test` bundles under public/editor (they are
# pruned before a run otherwise), ZS_SKIP_LSP_TOOLS=1 skips fixture language-server installation
# (LSP cases then require tools already on PATH), ZS_SKIP_PLAYWRIGHT_INSTALL=1 (or Playwright's own
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) never runs `playwright install`, ZS_E2E_BOOT_BUDGET_MS bounds
# the Chromium navigation-to-editable boot (default 15000 here, see run_browser_suite),
# ZS_E2E_CI=1 selects the CI reporters/retries of the Playwright config.
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
if [ "$MODE" = browser ]; then
  # Its own port and sandbox root, so a `dev` session on 3100 keeps running (and keeps its
  # sandboxes) while the browser suite starts and stops its own.
  PORT="${ZS_DEV_PORT:-3110}"
  LOCAL_ROOT="${ZS_LOCAL_ROOT:-$TMP_BASE/zs-local-browser}"
else
  PORT="${ZS_DEV_PORT:-3100}"
  LOCAL_ROOT="${ZS_LOCAL_ROOT:-$TMP_BASE/zs-local}"
fi
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
# A browser run must not replace the binary a developer's local workspaces resume with.
[ "$MODE" != browser ] || SERVE_STASH="$ZED_DIR/target/zs-browser/zed-remote-server"
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
  (cd "$SUPERVISOR_DIR" && cargo build 2>&1 | grep -v '^\s*Compiling' >&2 || true)
  [ -x "$AGENT_BIN" ] || die "zs-agent did not build at $AGENT_BIN"
  # The zed workspace is shared with other running rounds and serializes on cargo's lock; wait.
  log "building zed-remote-server (cargo build -p remote_server; waits for the shared lock)"
  # A local server must be a dev build (ZS_BUILD_ID starting with "dev"): the client requires
  # an exact build match otherwise, and the local bundle id changes with every dirty-tree
  # rebuild. Without the variable the binary reports the raw commit hash and every browser
  # session stalls after HelloAck with an incompatible-build exit.
  if (cd "$ZED_DIR" && ZS_BUILD_ID="${ZS_SERVER_BUILD_ID:-dev-0}" cargo build -p remote_server 2>&1 | grep -v '^\s*Compiling\|Blocking waiting' >&2; exit "${PIPESTATUS[0]}"); then
    if ! serve_bin_is_test_build "$ZED_DIR/target/debug/remote_server"; then
      mkdir -p "$(dirname "$SERVE_STASH")"
      # Never overwrite the stash in place: macOS keeps the code signature of a cached
      # executable's vnode, and a binary written over it is SIGKILLed at launch ("Killed: 9").
      # A fresh file (and an ad-hoc re-sign on Darwin) is what makes the copy runnable.
      rm -f "$SERVE_STASH"
      cp "$ZED_DIR/target/debug/remote_server" "$SERVE_STASH"
      if [ "$(uname -s)" = Darwin ] && command -v codesign >/dev/null 2>&1; then
        codesign --force --sign - "$SERVE_STASH" >/dev/null 2>&1 || log "warning: codesign of $SERVE_STASH failed"
      fi
      log "copied the fresh remote_server binary to $SERVE_STASH"
    fi
  else
    log "warning: cargo build -p remote_server failed; using the existing binary $(serve_bin)"
  fi
  check_serve_bin
  log "building the native end-to-end test (cargo test -p remote --test native_e2e --no-run)"
  (cd "$ZED_DIR" && cargo test -p remote --test native_e2e --no-run 2>&1 | grep -v '^\s*Compiling\|Blocking waiting' >&2 || true)
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resolve_dev_db() {
  case "${ZS_DEV_DB:-sqlite}" in sqlite|auto) ;; *) die "ZS_DEV_DB now uses sqlite; Postgres is no longer used" ;; esac
  log "database: local libSQL file"
}

E2E_DIR_PREFIX="round5-e2e-"
[ "$MODE" != browser ] || E2E_DIR_PREFIX="round5-browser-"

# The libSQL directories of earlier e2e runs (and the stray empty ones of docker runs).
# Earlier runs belong to the developer; never silently prune their databases.
drop_stale_e2e_dirs() { return 0; }

drop_e2e_dir() {
  [ -n "${E2E_DIR:-}" ] || return 0
  if [ "${ZS_KEEP_E2E:-0}" = "1" ]; then
    log "ZS_KEEP_E2E=1: keeping $E2E_DIR"
    return 0
  fi
  rm -rf "$E2E_DIR"
}

# ---------------------------------------------------------------------------
# Keys and environment
# ---------------------------------------------------------------------------

gen_keys() {
  mkdir -p "$DEV_DIR"
  if [ -f "$DEV_DIR/keys.env" ] && [ -f "$DEV_DIR/jwt-private.pem" ]; then
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
  `export ZS_EDITOR_COOKIE_SECRET=${quote(randomBytes(32).toString("base64"))}`,
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
  unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN VERCEL_ENV VERCEL_URL
  export ZS_DB_URL="file:$db_target"
  if [ "$MODE" = browser ] || [ "$MODE" = e2e ]; then
    # Workflow's Next plugin otherwise hard-codes .next/workflow-data even
    # with a separate distDir. Keep each test run's durable state beside its DB.
    export WORKFLOW_TARGET_WORLD=local
    export WORKFLOW_LOCAL_DATA_DIR="${db_target%/*}/workflow-data"
  fi
  mkdir -p "$(dirname "$db_target")"
  export ZS_SANDBOX_DRIVER=real
  export ZS_SANDBOX_BACKEND=local
  export ZS_LOCAL_ROOT="$LOCAL_ROOT"
  export ZS_LOCAL_REPOS_DIR="$REPOS_DIR"
  export ZS_AGENT_BIN="$AGENT_BIN"
  ZS_SERVE_BIN="$(serve_bin)"
  export ZS_SERVE_BIN
  export ZS_KV=sql
  export ZS_CONTROL_URL="$BASE_URL/api"
  export ZS_CLIENT_BUILD_ID="${ZS_CLIENT_BUILD_ID:-dev-0}"
  export ZS_SERVER_BUILD_ID="${ZS_SERVER_BUILD_ID:-dev-0}"
  export ZS_IMAGE_REF="${ZS_IMAGE_REF:-zs-workspace:dev-0}"
  export ZS_CSP_UNSAFE_EVAL="${ZS_CSP_UNSAFE_EVAL:-1}"
  # Browser mode only: the test-only routes (`POST /api/workspaces/{id}/test-local` kills the
  # sandbox, severs sockets and reads files out of the checkout) and the rpc proxy the Playwright
  # suite drives. Set from the mode, never from the caller's environment: `${VAR:-0}` would keep a
  # `1` a developer exported once - or that `.zs-dev/env.local` carries - and mount those routes
  # on the plain `dev` stack, where nothing expects or cleans up after them.
  if [ "$MODE" = browser ]; then
    export ZS_TEST_ROUTES=1
    export ZS_LOCAL_RPC_PROXY=1
  else
    export ZS_TEST_ROUTES=0
    export ZS_LOCAL_RPC_PROXY=0
  fi
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
      for name in ZS_SANDBOX_DRIVER ZS_SANDBOX_BACKEND \
        ZS_LOCAL_ROOT ZS_LOCAL_REPOS_DIR ZS_AGENT_BIN ZS_SERVE_BIN ZS_DB_URL ZS_KV \
        ZS_CONTROL_URL ZS_CLIENT_BUILD_ID ZS_SERVER_BUILD_ID ZS_IMAGE_REF ZS_CSP_UNSAFE_EVAL \
        ZS_TEST_ROUTES ZS_LOCAL_RPC_PROXY \
        ZS_JWT_PRIVATE_KEY ZS_JWT_KID ZS_JWT_ISSUER ZS_EDITOR_COOKIE_SECRET CRON_SECRET; do
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
# left (workspaces, snapshots, logs), and the e2e fixture repositories (`repos/e2e-*`, which a
# failed run leaves behind). The dev keys in .zs-dev stay.
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
  for dir in "$REPOS_DIR"/e2e-*; do
    [ -d "$dir" ] || continue
    rm -rf "$dir"
    log "removed fixture repository $(basename "$dir")"
    removed=$((removed + 1))
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

e2e_shutdown() {
  shutdown_all
  drop_e2e_dir
}

start_next() {
  local log_file="$DEV_DIR/next.log"
  if [ "$MODE" = browser ]; then
    # Beside a running `dev`: its own log and, through ZS_NEXT_DIST_DIR (next.config.ts), its own
    # distDir, since Next allows one dev server per distDir (`.next/dev/lock`).
    log_file="$DEV_DIR/next-browser.log"
    export ZS_NEXT_DIST_DIR="${ZS_NEXT_DIST_DIR:-.next-browser}"
  elif [ "$MODE" = e2e ]; then
    # Native validation can also run beside the developer's stack without truncating its log
    # or contending for its Next dev-server lock (use ZS_DEV_PORT for a distinct listener).
    log_file="$DEV_DIR/next-native.log"
    export ZS_NEXT_DIST_DIR="${ZS_NEXT_DIST_DIR:-.next-native}"
  fi
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

run_e2e() {
  log "running the native end-to-end test"
  (
    cd "$WEB_DIR" &&
      ZS_E2E_BASE_URL="$BASE_URL" \
      ZS_E2E_ZED_DIR="$ZED_DIR" \
      ZS_E2E_LOCAL_ROOT="$LOCAL_ROOT" \
      ZS_E2E_REPOS_DIR="$REPOS_DIR" \
      pnpm exec vitest run -c tests/e2e-native/vitest.config.mts
  )
}

# ---------------------------------------------------------------------------
# Browser mode (the Playwright suite)
# ---------------------------------------------------------------------------

BUNDLE_DIR="$WEB_DIR/public/editor"
LSP_TOOLS_DIR="$WEB_DIR/tests/e2e-browser/fixtures/lsp-tools"
BROWSER_BUILD_ID=""

# The test-hooks bundle (`script/build-web --test-hooks`: window.__zs_test, a `-test` build id)
# under public/editor/<id>/. ZS_BROWSER_BUILD_ID pins the id; otherwise it is the one build-web
# derives from the tree (its dirty hash included), so an edited tree gets a fresh build. A bundle
# without `"test_hooks": true` in its build.json is refused: a production bundle must never be
# served under a test id.
ensure_browser_bundle() {
  # ZS_BROWSER_BUILD_ARGS adds build-web flags, e.g. `--names` to keep the wasm name section so a
  # panic in the suite names Rust functions (docs/status/round3c.md); the id then ends in
  # `-test-names`.
  # shellcheck disable=SC2206
  local build_args=(--test-hooks ${ZS_BROWSER_BUILD_ARGS:-})
  if [ -n "${ZS_BROWSER_BUILD_ID:-}" ]; then
    BROWSER_BUILD_ID="$ZS_BROWSER_BUILD_ID"
  else
    BROWSER_BUILD_ID="$(cd "$ZED_DIR" && ./script/build-web "${build_args[@]}" --print-build-id)" ||
      die "script/build-web ${build_args[*]} --print-build-id failed"
  fi
  case "$BROWSER_BUILD_ID" in
    *-test|*-test-names) ;;
    *) die "the browser suite needs a test-hooks bundle id ending in -test or -test-names (got $BROWSER_BUILD_ID)" ;;
  esac
  local dir="$BUNDLE_DIR/$BROWSER_BUILD_ID"
  if [ -f "$dir/build.json" ] && [ -f "$dir/zed_web_bg.wasm" ] && [ -f "$dir/zed_web.js" ] && [ -f "$dir/zed-assets.tar" ]; then
    if ! grep -q '"test_hooks": true' "$dir/build.json"; then
      die "$dir/build.json does not say test_hooks: true; remove the directory (it is not a test bundle)"
    fi
    log "test-hooks bundle: $dir (present)"
    return
  fi
  [ "${ZS_SKIP_BUILD:-0}" = "1" ] && die "ZS_SKIP_BUILD=1 but the test-hooks bundle $dir is missing"
  mkdir -p "$DEV_DIR"
  log "building the test-hooks bundle $BROWSER_BUILD_ID (script/build-web ${build_args[*]}; slow, log: $DEV_DIR/build-web.log)"
  if (cd "$ZED_DIR" && ./script/build-web "${build_args[@]}" --out-dir "$BUNDLE_DIR" --build-id "$BROWSER_BUILD_ID" 2>&1 |
    tee "$DEV_DIR/build-web.log" | grep -v '^\s*Compiling\|Blocking waiting\|^warning\|^ *|\|^ *=\|^ *-->\|^$' >&2; exit "${PIPESTATUS[0]}"); then
    log "test-hooks bundle: $dir"
  else
    die "script/build-web --test-hooks failed (log: $DEV_DIR/build-web.log)"
  fi
  [ -f "$dir/build.json" ] || die "build-web did not write $dir/build.json"
}

# The fixture's TypeScript, Dockerfile, HTML and Tailwind servers, installed once and put on PATH
# for the dev server, supervisor and `zed-remote-server` beneath it.
ensure_lsp_tools() {
  [ "${ZS_SKIP_LSP_TOOLS:-0}" = "1" ] && { log "ZS_SKIP_LSP_TOOLS=1: not installing language servers; LSP checks require tools on PATH"; return 0; }
  local bin="$LSP_TOOLS_DIR/node_modules/.bin"
  if [ ! -x "$bin/typescript-language-server" ] || [ ! -x "$bin/vtsls" ] || [ ! -x "$bin/docker-langserver" ] || [ ! -x "$bin/vscode-html-language-server" ] || [ ! -x "$bin/tailwindcss-language-server" ]; then
    mkdir -p "$DEV_DIR"
    log "installing fixture language servers into $LSP_TOOLS_DIR (pnpm install; log: $DEV_DIR/lsp-tools-install.log)"
    # These are JS tools; dependency postinstalls (e.g. core-js's funding notice)
    # are unnecessary. Explicitly skip them under pnpm's strict build policy.
    if ! (cd "$LSP_TOOLS_DIR" && pnpm install --ignore-workspace --ignore-scripts --config.confirmModulesPurge=false > "$DEV_DIR/lsp-tools-install.log" 2>&1); then
      die "fixture language-server installation failed (log: $DEV_DIR/lsp-tools-install.log)"
    fi
  fi
  export PATH="$bin:$PATH"
  export ZS_E2E_LSP_TOOLS_BIN="$bin"
  log "typescript-language-server: $(command -v typescript-language-server) ($(typescript-language-server --version 2>/dev/null | head -1))"
}

# The projects a run asked for, in either spelling (`--project=X`, `--project X`), repeated or
# not; empty when it named none.
requested_projects() {
  local arg take_next=0 out=""
  for arg in "$@"; do
    if [ "$take_next" = 1 ]; then
      out="$out $arg"
      take_next=0
      continue
    fi
    case "$arg" in
      --project=*) out="$out ${arg#--project=}" ;;
      --project) take_next=1 ;;
    esac
  done
  printf '%s' "${out# }"
}

# What a run without `--project` executes. Round 4 validated all four projects together
# (docs/status/round4.md); the smaller local/nightly default remains Chromium plus smoke.
# Firefox and WebKit are opt-in and repeat the cases against their own fresh workspaces.
DEFAULT_PROJECTS="chromium smoke"

# `pnpm exec playwright install` when a browser the requested projects need is missing from
# Playwright's cache (~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux).
ensure_playwright_browsers() {
  local cache="${PLAYWRIGHT_BROWSERS_PATH:-}"
  if [ -z "$cache" ]; then
    case "$(uname -s)" in
      Darwin) cache="$HOME/Library/Caches/ms-playwright" ;;
      *) cache="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright" ;;
    esac
  fi
  if [ "${ZS_SKIP_PLAYWRIGHT_INSTALL:-0}" = "1" ] || [ -n "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" ]; then
    log "not checking the Playwright browsers (ZS_SKIP_PLAYWRIGHT_INSTALL / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)"
    return 0
  fi
  # The browsers the projects of this run need; `smoke` is Chromium too.
  local wanted name missing=""
  wanted="$(requested_projects "$@")"
  [ -n "$wanted" ] || wanted="$DEFAULT_PROJECTS"
  wanted="${wanted//smoke/chromium}"
  # shellcheck disable=SC2086
  wanted="$(printf '%s\n' $wanted | sort -u | tr '\n' ' ')"
  log "Playwright browsers wanted: $wanted (cache: $cache)"
  for name in $wanted; do
    case "$name" in
      chromium|firefox|webkit) ;;
      *) die "unknown Playwright project '$name' (chromium, firefox, webkit, smoke)" ;;
    esac
    if ! ls -d "$cache/$name"-* >/dev/null 2>&1; then missing="$missing $name"; fi
  done
  if [ -n "$missing" ]; then
    log "installing the Playwright browsers:$missing (pnpm exec playwright install)"
    # shellcheck disable=SC2086
    (cd "$WEB_DIR" && pnpm exec playwright install $missing) || die "playwright install failed"
  fi
}

# Earlier `-test`/`-test-names` bundles under public/editor (a dirty-tree rebuild leaves one per
# source state, 75 MB each) are removed before a run; the one this run serves, and a pinned
# ZS_BROWSER_BUILD_ID, stay. Production bundles (no suffix, `-names`) are never touched: the
# `dev` stack on 3100 may be serving them.
prune_stale_test_bundles() {
  [ "${ZS_KEEP_TEST_BUNDLES:-0}" = "1" ] && { log "ZS_KEEP_TEST_BUNDLES=1: keeping the earlier test bundles"; return 0; }
  local dir name
  for dir in "$BUNDLE_DIR"/*-test "$BUNDLE_DIR"/*-test-names; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    [ "$name" = "$BROWSER_BUILD_ID" ] && continue
    [ "$name" = "${ZS_BROWSER_BUILD_ID:-}" ] && continue
    if [ -f "$dir/build.json" ] && ! grep -q '"test_hooks": true' "$dir/build.json"; then
      log "keeping $name: its build.json does not say test_hooks: true"
      continue
    fi
    rm -rf "$dir"
    log "removed the earlier test bundle $name"
  done
  return 0
}

# shellcheck disable=SC2086   # $projects is a deliberate list of --project=<name> words
run_browser_suite() {
  # Without an explicit `--project` the run is pinned to DEFAULT_PROJECTS rather than every
  # project of the config (see there); `--project=firefox` still selects firefox.
  # A plain string, not an array: this script runs under bash 3.2 (macOS) with `set -u`, where
  # expanding an empty array is an error. The values are project names, so splitting is safe.
  local projects="" name
  if [ -z "$(requested_projects "$@")" ]; then
    for name in $DEFAULT_PROJECTS; do projects="$projects --project=$name"; done
  fi
  log "running the browser end-to-end suite (playwright test tests/e2e-browser; args:$projects $*)"
  # ZS_E2E_BOOT_BUDGET_MS bounds the Chromium navigation-to-editable boot the suite records. It is
  # an environment figure, not an editor one: the local `next dev` serves the 75 MB wasm
  # `no-store` on every navigation (next.config.ts) and delivers plus compiles it in most of the
  # 6-8 s measured on an M-series Mac with WebGPU on Metal, 12-13 s on SwiftShader
  # (test-results/e2e-browser-timings.json records every run's legs). 15 s is the lane's "boots
  # in under 15 s locally" bar, roughly twice what a warm local run measures; CI serves the same
  # bundle from a slower disk and sets its own (60 s, .github/workflows/web.yml). The editor's own
  # leg (hooks installed → editable) has its fixed budget inside editor.spec.ts. Firefox/WebKit
  # run on software WebGL2 and are recorded only (ZS_E2E_BOOT_BUDGET_MS_FIREFOX / _WEBKIT to
  # bound them).
  (
    cd "$WEB_DIR" &&
      ZS_E2E_BASE_URL="$BASE_URL" \
      ZS_E2E_ZED_DIR="$ZED_DIR" \
      ZS_E2E_LOCAL_ROOT="$LOCAL_ROOT" \
      ZS_E2E_REPOS_DIR="$REPOS_DIR" \
      ZS_E2E_BUILD_ID="$BROWSER_BUILD_ID" \
      ZS_E2E_RUN_ID="${E2E_STAMP:-$$}" \
      ZS_E2E_BOOT_BUDGET_MS="${ZS_E2E_BOOT_BUDGET_MS:-15000}" \
      ZS_SMOKE_SERVER_BIN="${ZS_SMOKE_SERVER_BIN:-$(serve_bin)}" \
      pnpm exec playwright test -c tests/e2e-browser/playwright.config.ts $projects "$@"
  )
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
  e2e)
    build_all
    gen_keys
    resolve_dev_db
    E2E_STAMP="$(date +%Y%m%d%H%M%S)"
    E2E_DIR=""
    # A fresh database per run: nothing from an earlier run can satisfy an assertion. Earlier
    # runs' databases and libSQL directories are dropped now, this run's on exit (ZS_KEEP_E2E=1
    # keeps them).
    E2E_DIR="$DEV_DIR/${E2E_DIR_PREFIX}$E2E_STAMP"
    mkdir -p "$E2E_DIR"
    export_env "$E2E_DIR/control.db"
    write_env_files
    trap e2e_shutdown EXIT INT TERM
    start_next
    status=0
    run_e2e || status=$?
    log "native end-to-end test exit status: $status (next log: $DEV_DIR/next-native.log)"
    exit "$status"
    ;;
  browser)
    build_all
    ensure_browser_bundle
    prune_stale_test_bundles
    ensure_lsp_tools
    ensure_playwright_browsers "$@"
    gen_keys
    resolve_dev_db
    E2E_STAMP="$(date +%Y%m%d%H%M%S)"
    E2E_DIR=""
    export ZS_CLIENT_BUILD_ID="$BROWSER_BUILD_ID"
    E2E_DIR="$DEV_DIR/${E2E_DIR_PREFIX}$E2E_STAMP"
    mkdir -p "$E2E_DIR"
    export_env "$E2E_DIR/control.db"
    write_env_files
    trap e2e_shutdown EXIT INT TERM
    start_next
    status=0
    run_browser_suite "$@" || status=$?
    log "browser end-to-end suite exit status: $status (next log: $DEV_DIR/next-browser.log; report: $WEB_DIR/test-results/e2e-browser-report/index.html)"
    exit "$status"
    ;;
  *)
    die "usage: $0 [dev|e2e|browser [playwright args…]|build|stop|clean]"
    ;;
esac
