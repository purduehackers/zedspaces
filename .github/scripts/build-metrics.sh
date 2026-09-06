#!/usr/bin/env bash
# Emit resource evidence during long builds, including when a runner disappears mid-job.
set -euo pipefail

resources() {
  date -u
  df -h .
  free -h
}

resources | tee build-resources.log
(
  sleep_pid=""
  trap 'if [ -n "$sleep_pid" ]; then kill "$sleep_pid" 2>/dev/null || true; fi; exit 0' TERM INT
  while true; do
    sleep 60 &
    sleep_pid=$!
    wait "$sleep_pid"
    resources | tee -a build-resources.log
  done
) &
monitor_pid=$!
finish() {
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
  resources | tee -a build-resources.log
}
trap finish EXIT
"$@"
