#!/bin/sh
set -eu

REPOSITORY="${CHATMUX_REPOSITORY:-https://github.com/devswha/chatmux}"
INSTALL_ROOT="${CHATMUX_INSTALL_ROOT:-$HOME/.chatmux}"
NODE_VERSION="22.22.2"

log() {
  printf '%s\n' "[chatmux] $*" >&2
}

fail() {
  printf '%s\n' "[chatmux] ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

valid_version() {
  value=$1
  case "$value" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  old_ifs=$IFS
  IFS=.
  set -- $value
  IFS=$old_ifs
  [ "$#" -eq 3 ] && [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ]
}

node_is_supported() {
  candidate=$1
  version=$($candidate -p "process.versions.node" 2>/dev/null) || return 1
  old_ifs=$IFS
  IFS=.
  set -- $version
  IFS=$old_ifs
  [ "${1:-}" = 22 ] || return 1
  minor=${2:-0}
  patch=${3:-0}
  [ "$minor" -gt 22 ] || { [ "$minor" -eq 22 ] && [ "$patch" -ge 2 ]; }
}

verify_checksum() {
  checksum_file=$1
  payload=$2
  expected=''
  while read -r digest filename; do
    filename=${filename#\*}
    if [ "$filename" = "$(basename "$payload")" ]; then
      expected=$digest
      break
    fi
  done < "$checksum_file"
  [ "${#expected}" -eq 64 ] || fail "invalid checksum file for $(basename "$payload")"
  case "$expected" in *[!0-9a-fA-F]*) fail "invalid SHA-256 digest" ;; esac
  actual=$(sha256sum "$payload")
  actual=${actual%% *}
  [ "$actual" = "$expected" ] || fail "checksum verification failed for $(basename "$payload")"
}

install_node() {
  node_root="$INSTALL_ROOT/runtime/node-v$NODE_VERSION"
  if [ -x "$node_root/bin/node" ]; then
    printf '%s\n' "$node_root/bin/node"
    return
  fi

  node_archive="node-v$NODE_VERSION-linux-x64.tar.xz"
  node_base="${CHATMUX_NODE_BASE_URL:-https://nodejs.org/dist/v$NODE_VERSION}"
  node_stage="$TEMP_DIR/node"
  mkdir -p "$node_stage" "$INSTALL_ROOT/runtime"
  log "Node.js 22 was not found; installing a private runtime"
  curl -fsSL "$node_base/$node_archive" -o "$TEMP_DIR/$node_archive"
  curl -fsSL "$node_base/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
  verify_checksum "$TEMP_DIR/SHASUMS256.txt" "$TEMP_DIR/$node_archive"
  tar -xJf "$TEMP_DIR/$node_archive" -C "$node_stage"
  [ -x "$node_stage/node-v$NODE_VERSION-linux-x64/bin/node" ] || fail "downloaded Node.js runtime is incomplete"
  mv "$node_stage/node-v$NODE_VERSION-linux-x64" "$node_root"
  printf '%s\n' "$node_root/bin/node"
}

require_command curl
require_command tar
require_command sha256sum

[ "$(uname -s)" = Linux ] || fail "only Linux is supported"
[ "$(uname -m)" = x86_64 ] || fail "only Linux x86_64 is supported"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/chatmux-install.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

if [ -n "${CHATMUX_VERSION:-}" ]; then
  VERSION=${CHATMUX_VERSION#v}
else
  log "Resolving the latest ChatMux release"
  latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$REPOSITORY/releases/latest")
  tag=${latest_url%/}
  tag=${tag##*/}
  VERSION=${tag#v}
fi
valid_version "$VERSION" || fail "could not resolve a valid ChatMux release version"

if [ -n "${CHATMUX_NODE:-}" ]; then
  NODE_BIN=$CHATMUX_NODE
elif command -v node >/dev/null 2>&1 && node_is_supported "$(command -v node)"; then
  NODE_BIN=$(command -v node)
else
  NODE_BIN=$(install_node)
fi
[ -x "$NODE_BIN" ] || fail "Node.js runtime is not executable: $NODE_BIN"

RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION"
if [ -f "$RELEASE_DIR/scripts/chatmux-runtime.mjs" ]; then
  log "Reusing verified ChatMux $VERSION payload"
else
  [ ! -e "$RELEASE_DIR" ] || fail "$RELEASE_DIR exists but is not a complete release"
  artifact="chatmux-server-$VERSION-linux-x64-node22.tar.gz"
  release_base="${CHATMUX_RELEASE_BASE_URL:-$REPOSITORY/releases/download}/v$VERSION"
  archive="$TEMP_DIR/$artifact"
  checksum="$archive.sha256"
  stage="$INSTALL_ROOT/releases/.install-$VERSION-$$"

  log "Downloading ChatMux $VERSION"
  curl -fsSL "$release_base/$artifact" -o "$archive"
  curl -fsSL "$release_base/$artifact.sha256" -o "$checksum"
  verify_checksum "$checksum" "$archive"

  mkdir -p "$INSTALL_ROOT/releases" "$stage"
  tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions
  [ -f "$stage/scripts/chatmux-runtime.mjs" ] || fail "release archive is missing the runtime entry point"
  mv "$stage" "$RELEASE_DIR"
fi

log "Starting the ChatMux installer"
"$NODE_BIN" "$RELEASE_DIR/scripts/chatmux-runtime.mjs" install --yes "$@"
