#!/usr/bin/env bash
# Explicit local publication/repointing; never writes an old Postgres database.
# Usage: scripts/dev-repoint.sh <build-id> [stopped-workspace-id ...]
# With workspace IDs, export ZS_DB_URL=file:/absolute/path/to/control.db.
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WEB_DIR"
exec pnpm exec tsx scripts/dev-repoint.ts "$@"
