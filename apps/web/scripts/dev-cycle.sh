#!/usr/bin/env bash
# Dev cycle: rebuild the browser bundle, publish it under its real build id, restart the local
# stack on that id, recreate the demo workspace, and trace the boot. Usage: scripts/dev-cycle.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"; ZED="$REPO/zed"; WEB="$REPO/apps/web"; B=http://127.0.0.1:3100
SP="${ZS_SCRATCH:-/private/tmp/claude-501/-Users-ray-Projects-play-wed/ffb0e201-ed0a-4878-93e1-57e8d0039312/scratchpad}"
# ZS_BUILD_WEB_ARGS passes extra build-web flags (e.g. `--names` for readable panic stacks).
echo "== build $(date)"; (cd "$ZED" && ./script/build-web ${ZS_BUILD_WEB_ARGS:-} 2>&1 | tail -3)
ID=$(python3 -c "import json,glob,os; fs=sorted(glob.glob('$ZED/target/web-bundle/*/build.json'), key=os.path.getmtime); print(json.load(open(fs[-1]))['build_id'])")
echo "== publish $ID"; S="$ZED/target/web-bundle/$ID"; D="$WEB/public/editor/$ID"; mkdir -p "$D"; cp "$S/zed_web_bg.wasm" "$S/zed_web.js" "$S/zed-assets.tar" "$S/build.json" "$D/"
python3 - "$ID" "$WEB/public/editor/manifest.json" <<'PY'
import json,sys; p=sys.argv[2]; m=json.load(open(p)); b=[sys.argv[1]]+[x for x in m.get('builds',[]) if x!=sys.argv[1]]; json.dump({'builds':b[:5]}, open(p,'w'), indent=2); print('manifest', b[:5])
PY
echo "== restart stack on $ID"; (cd "$WEB" && ./scripts/dev-local.sh stop >/dev/null 2>&1 || true); sleep 4
(cd "$WEB" && ZS_SKIP_BUILD=1 ZS_CLIENT_BUILD_ID="$ID" ./scripts/dev-local.sh >> "$REPO/.zs-logs/dev-local-cycle.log" 2>&1 &)
until curl -s -o /dev/null -w '%{http_code}' $B/api/workspaces -H "origin: $B" 2>/dev/null | grep -qE '^200'; do sleep 2; done
for w in $(curl -s $B/api/workspaces -H "origin: $B" | python3 -c 'import sys,json; [print(w["id"]) for w in json.load(sys.stdin)["workspaces"]]'); do curl -s -X POST $B/api/workspaces/$w/stop -H "origin: $B" -H 'content-type: application/json' -d '{}' >/dev/null || true; sleep 4; curl -s -X DELETE $B/api/workspaces/$w -H "origin: $B" >/dev/null || true; done; sleep 3
CREATE=$(curl -s -X POST $B/api/workspaces -H 'content-type: application/json' -H "origin: $B" -d '{"repo":{"installationId":1,"owner":"local","name":"demo"},"ref":{"branch":"main"},"machine":"vcpu2"}')
WS=$(echo "$CREATE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("workspace",{}).get("id",""))'); [ -n "$WS" ] || { echo "create failed: $CREATE"; exit 1; }
echo "$WS" > "$SP/ws_id"
until curl -s $B/api/workspaces/$WS -H "origin: $B" | python3 -c 'import sys,json; w=json.load(sys.stdin)["workspace"]; sys.exit(0 if w["state"] in ("running","error","failed") else 1)' 2>/dev/null; do sleep 3; done
echo "== workspace $WS: $(curl -s $B/api/workspaces/$WS -H "origin: $B" | python3 -c 'import sys,json; w=json.load(sys.stdin)["workspace"]; print(w["state"], w.get("clientBuild"))')"
echo "== URL: $B/w/$WS"
echo "== trace $(date)"; (cd "$WEB" && node .zs-dev/trace-long.mjs "$WS" 2>&1 | grep -E 'boot progress|dispatcher|panicked|probe' | cut -c1-200 | head -40)
echo "== done $(date)"
