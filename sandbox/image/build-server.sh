#!/usr/bin/env bash
# Build `zed-remote-server` (the fork's `serve` build) with Zed's own musl recipe
# (zed/script/bundle-linux:86-94,128) and drop it at sandbox/image/dist/zed-remote-server, where
# the Dockerfile's `server-fetch` stage picks it up.
#
# Usage: ZS_BUILD_ID=<matching-client-id> sandbox/image/build-server.sh [--docker]
# --docker builds the actual local fork on Linux/amd64, even on a Mac. No login or push.
#
# Prerequisites (what zed/script/linux installs): a musl-capable toolchain (`musl-tools`), the
# x86_64-unknown-linux-musl rust target and llvm tools for `llvm-objcopy`.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

test -e "$root/zed/.git" || {
  echo "zed/ checkout missing at $root/zed; run git submodule update --init --recursive" >&2
  exit 1
}

build_id="${ZS_BUILD_ID:-}"
if [ -z "$build_id" ]; then
  echo "ZS_BUILD_ID required, e.g. ZS_BUILD_ID=\"\$(git -C $root/zed rev-parse --short HEAD)-1\"" >&2
  exit 2
fi

if [ "${1:-}" = "--docker" ]; then
  mkdir -p "$here/dist"
  docker buildx build --platform linux/amd64 --progress plain \
    --file "$here/Dockerfile.server" \
    --build-arg "ZS_BUILD_ID=$build_id" \
    --build-arg "ZED_COMMIT_SHA=$(git -C "$root/zed" rev-parse HEAD)" \
    --output "type=local,dest=$here/dist" "$root"
  exit
fi
if [ "$#" -gt 0 ]; then echo "unknown argument: $1" >&2; exit 2; fi

# b2 §3.13: remote_server/build.rs turns ZS_BUILD_ID into the `serve` build id.
export ZS_BUILD_ID="$build_id"
export ZED_BUILD_ID="$build_id"
ZED_COMMIT_SHA="$(git -C "$root/zed" rev-parse HEAD)"
export ZED_COMMIT_SHA
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+crt-static"
export CC_x86_64_unknown_linux_musl="${CC_x86_64_unknown_linux_musl:-musl-gcc}"

(
  cd "$root/zed"
  cargo --config .cargo/bundle-config.toml build \
    --release \
    --target x86_64-unknown-linux-musl \
    --package remote_server \
    --features serve
)

bin="$root/zed/target/x86_64-unknown-linux-musl/release/remote_server"
test -f "$bin" || { echo "cargo produced no $bin" >&2; exit 1; }

# The release profile is debug = "limited" with no strip (zed/Cargo.toml), so strip here.
if command -v llvm-objcopy >/dev/null 2>&1; then
  llvm-objcopy --strip-debug "$bin"
elif command -v objcopy >/dev/null 2>&1; then
  objcopy --strip-debug "$bin"
else
  echo "warning: neither llvm-objcopy nor objcopy found; shipping an unstripped binary" >&2
fi

mkdir -p "$here/dist"
install -m 0755 "$bin" "$here/dist/zed-remote-server"

# bundle-linux hard-fails when the "static" binary picked up OpenSSL; so do we.
if ldd "$here/dist/zed-remote-server" 2>/dev/null | grep -q 'libcrypto\|libssl'; then
  echo "remote_server links libssl/libcrypto; the musl build is not static" >&2
  exit 1
fi

# Only runnable when the host is linux/amd64 (CI is); skip elsewhere.
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
  "$here/dist/zed-remote-server" version
fi
du -h "$here/dist/zed-remote-server"
