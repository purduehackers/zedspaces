#!/usr/bin/env bash
# Sourced by dev-local.sh. Only reap the detached flusher of its own recorded Next PID;
# do not adopt flushers from another run, infer ownership from a port, or remove event files.

next_telemetry_matches() {
  local pid="$1" next_pid="$2" web_dir="$3" command comm
  case "$pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  [ "$pid" != "$$" ] || return 1
  comm="$(ps -p "$pid" -o comm= 2>/dev/null)" || return 1
  [ "${comm##*/}" = node ] || return 1
  command="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
  case "$command" in
    *"/next/dist/telemetry/detached-flush.js dev $web_dir _events_${next_pid}.json") return 0 ;;
    *) return 1 ;;
  esac
}

stop_next_telemetry() {
  local next_pid="$1" web_dir="$2" pid command pids="" signal
  case "$next_pid" in ''|0|1|*[!0-9]*) return 0 ;; esac
  # ps is read-only discovery. Each candidate's executable and full command are checked
  # again immediately before signaling, including after the TERM grace period.
  while read -r pid command; do
    case "$command" in
      *"/next/dist/telemetry/detached-flush.js dev $web_dir _events_${next_pid}.json")
        if next_telemetry_matches "$pid" "$next_pid" "$web_dir"; then pids="$pids $pid"; fi
        ;;
    esac
  done < <(ps -axww -o pid=,command= 2>/dev/null || true)
  [ -n "$pids" ] || return 0
  for signal in TERM KILL; do
    for pid in $pids; do
      if next_telemetry_matches "$pid" "$next_pid" "$web_dir"; then
        log "stopping next telemetry flusher (pid $pid, next pid $next_pid, SIG$signal)"
        kill -s "$signal" "$pid" 2>/dev/null || true
      fi
    done
    if [ "$signal" = TERM ]; then sleep 1; fi
  done
}
