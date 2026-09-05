#!/usr/bin/env bash
# Build the workspace image (linux/amd64) from sandbox/image/Dockerfile.
#
# Usage: ZS_BUILD_ID=<zed-commit>-<n> sandbox/image/build.sh [options] [-- <extra container args>]
#
#   --push                    push to vcr.vercel.com/<team>/<project>/<tag> (needs VERCEL_TEAM_SLUG
#                             and VERCEL_PROJECT_SLUG) and wait for VCR to prepare the image
#   --source context|release  where zed-remote-server comes from (default: context, i.e.
#                             sandbox/image/dist/zed-remote-server from build-server.sh)
#   --tag <repo:tag>          image name (default: zs-workspace:$ZS_BUILD_ID)
#   --engine auto|vcr|docker  builder (default: auto — `vercel vcr build docker` when the Vercel
#                             CLI is on PATH, plain `docker buildx build` otherwise)
#   --update-base             resolve base.lock's ref to a digest and rewrite the file
#   --attest                  build with BuildKit provenance (mode=max) and an SBOM attached to
#                             the image index (default off: VCR's acceptance of OCI attestation
#                             manifests is unverified; generate them out of band otherwise)
#   --no-layer-check          skip the per-layer size guard on local builds
#
# A --push always requires a digest-pinned base.lock (BUILD-SPEC §10 item 6); there is no
# escape hatch. Run --update-base once (after `vercel vcr login docker`) and commit the result.
#
# The build context is the repository root, because the Dockerfile copies both
# sandbox/supervisor/ (zs-agent sources) and sandbox/image/dist/ (zed-remote-server). The root
# .dockerignore keeps zed/, apps/ and the build outputs out of the context.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

build_id="${ZS_BUILD_ID:-}"
if [ -z "$build_id" ]; then
  echo "ZS_BUILD_ID required (e.g. ZS_BUILD_ID=\"\$(git -C zed rev-parse --short HEAD)-1\")" >&2
  exit 2
fi

push=""
source_mode="context"
tag="zs-workspace:${build_id}"
engine="auto"
update_base=""
attest=""
layer_check="1"
extra=()

while [ $# -gt 0 ]; do
  case "$1" in
    --push) push=1 ;;
    --source) source_mode="${2:?--source needs a value}"; shift ;;
    --tag) tag="${2:?--tag needs a value}"; shift ;;
    --engine) engine="${2:?--engine needs a value}"; shift ;;
    --update-base) update_base=1 ;;
    --attest) attest=1 ;;
    --no-layer-check) layer_check="" ;;
    --) shift; extra=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$source_mode" in
  context|release) ;;
  *) echo "--source must be 'context' or 'release'" >&2; exit 2 ;;
esac

# The Dockerfile COPYs sandbox/image/dist/ in both modes.
mkdir -p "$here/dist"
if [ "$source_mode" = "context" ] && [ ! -f "$here/dist/zed-remote-server" ]; then
  echo "sandbox/image/dist/zed-remote-server missing; run sandbox/image/build-server.sh first" >&2
  echo "(or pass --source release to pull the published asset from cloud.zed.dev)" >&2
  exit 1
fi

have_vercel() { command -v vercel >/dev/null 2>&1; }

if [ "$engine" = "auto" ]; then
  if have_vercel; then engine="vcr"; else engine="docker"; fi
fi
case "$engine" in
  vcr)
    have_vercel || { echo "--engine vcr needs the Vercel CLI on PATH (npm i -g vercel)" >&2; exit 2; }
    ;;
  docker) ;;
  *) echo "--engine must be 'auto', 'vcr' or 'docker'" >&2; exit 2 ;;
esac

base_ref="$(awk 'NF && $0 !~ /^[[:space:]]*#/ { gsub(/[[:space:]]/, "", $0); print; exit }' "$here/base.lock")"
test -n "$base_ref" || { echo "sandbox/image/base.lock has no image ref" >&2; exit 1; }

# Pulling (not only pushing) an image from vcr.vercel.com needs a team credential.
case "$base_ref" in vcr.vercel.com/*) base_on_vcr=1 ;; *) base_on_vcr="" ;; esac
if have_vercel && { [ -n "$push" ] || [ -n "$base_on_vcr" ]; }; then
  vercel vcr login docker
fi

if [ -n "$update_base" ]; then
  digest="$(docker buildx imagetools inspect vcr.vercel.com/vercel/sandbox/universal:latest \
    --format '{{json .Manifest.Digest}}' | tr -d '"')"
  test -n "$digest" || { echo "could not resolve the universal base digest" >&2; exit 1; }
  {
    grep '^[[:space:]]*#' "$here/base.lock" || true
    echo "vcr.vercel.com/vercel/sandbox/universal@${digest}"
  } > "$here/base.lock.new"
  mv "$here/base.lock.new" "$here/base.lock"
  base_ref="vcr.vercel.com/vercel/sandbox/universal@${digest}"
  echo "base.lock updated: $base_ref"
fi

case "$base_ref" in
  *@sha256:*) ;;
  *)
    # BUILD-SPEC §10 item 6: a pushed image must come from a pinned base. Local builds only warn.
    if [ -n "$push" ]; then
      echo "base.lock is not digest-pinned ($base_ref); run 'sandbox/image/build.sh --update-base' (after 'vercel vcr login docker') and commit it" >&2
      exit 1
    fi
    echo "warning: base.lock is not digest-pinned ($base_ref); run --update-base for a reproducible build" >&2
    ;;
esac

build_args=(
  --build-arg "BASE_IMAGE=$base_ref"
  --build-arg "ZS_BUILD_ID=$build_id"
  --build-arg "ZED_SERVER_SOURCE=$source_mode"
)

# Attestations ride along as extra manifests in the OCI index; off unless asked for, because it
# is not known whether VCR accepts them (BUILD-SPEC §10 item 6 wants them – generate them out of
# band in CI when the registry refuses).
if [ -n "$attest" ]; then
  attest_args=(--provenance=mode=max --sbom=true)
else
  attest_args=(--provenance=false --sbom=false)
fi

if [ -n "$push" ]; then
  team="${VERCEL_TEAM_SLUG:?VERCEL_TEAM_SLUG required for --push}"
  project="${VERCEL_PROJECT_SLUG:?VERCEL_PROJECT_SLUG required for --push}"
  full="vcr.vercel.com/${team}/${project}/${tag}"
else
  full="$tag"
fi

case "$engine" in
  vcr)
    # `vercel vcr build docker [path] [name]` forwards everything after `--` to the container tool.
    vcr_args=(vcr build docker "$root" "$tag" --platform linux/amd64)
    if [ -n "$push" ]; then vcr_args+=(--push); fi
    vercel "${vcr_args[@]}" -- \
      -f "$here/Dockerfile" "${attest_args[@]}" \
      "${build_args[@]}" "${extra[@]+"${extra[@]}"}"
    ;;
  docker)
    output=(--load)
    if [ -n "$push" ]; then output=(--push); fi
    docker buildx build --platform linux/amd64 \
      -f "$here/Dockerfile" \
      "${attest_args[@]}" \
      "${build_args[@]}" "${extra[@]+"${extra[@]}"}" \
      "${output[@]}" -t "$full" "$root"
    ;;
esac

# Layer-size guard on local builds (VCR allows 500 MB per compressed layer; 900 MB uncompressed is
# a conservative proxy). Pushed builds are not in the local store, so the guard only runs locally.
if [ -z "$push" ] && [ -n "$layer_check" ] && docker image inspect "$full" >/dev/null 2>&1; then
  if ! docker history --no-trunc --human=false --format '{{.Size}}	{{.CreatedBy}}' "$full" \
    | awk -F'\t' '$1 + 0 > 943718400 { printf "layer over 900MB (%s bytes): %s\n", $1, $2; bad = 1 } END { exit bad }'; then
    echo "at least one layer exceeds the size guard; split the RUN that produced it" >&2
    exit 1
  fi
fi

if [ -n "$push" ]; then
  digest="$(docker buildx imagetools inspect "$full" --format '{{json .Manifest.Digest}}' | tr -d '"')"
  printf '{"tag":"%s","digest":"%s","build":"%s","base":"%s"}\n' \
    "$full" "$digest" "$build_id" "$base_ref" > "$here/dist/image.json"
  echo "pushed $full ($digest)"

  # Wait for VCR to prepare the linux/amd64 snapshot; Sandbox.create returns image_not_ready until
  # then. `vercel vcr image ls --format json` is documented, its field names are not, so accept
  # either `manifestDigest` or `digest` and treat an unparsable answer as "keep polling".
  repo="${tag%%:*}"
  status=""
  json=""
  for _ in $(seq 1 120); do
    json="$(vercel vcr image ls "$repo" --format json 2>/dev/null || true)"
    status="$(printf '%s' "$json" | jq -r --arg d "$digest" \
      '(.images // .)[]? | select(.manifestDigest == $d or .digest == $d) | .status' 2>/dev/null | head -1)"
    if [ "$status" = "ready" ]; then break; fi
    sleep 10
  done
  if [ "$status" != "ready" ]; then
    echo "image not ready after 20 min (status='${status}'); raw: $(printf '%s' "$json" | head -c 400)" >&2
    exit 1
  fi
  echo "image ready in VCR"
fi
