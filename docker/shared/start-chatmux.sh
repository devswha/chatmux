#!/bin/bash

# This script is sourced from ~/.bashrc whenever an agent shell opens.
# The application code is immutable at /opt/chatmux; sandbox state and
# logs belong to the agent's canonical data root.
CHATMUX_ROOT="${CHATMUX_ROOT:-/opt/chatmux}"
CHATMUX_DATA_ROOT="${CHATMUX_DATA_ROOT:-$HOME/.chatmux}"
CHATMUX_LOG_FILE="${CHATMUX_LOG_FILE:-$CHATMUX_DATA_ROOT/logs/sandbox.log}"
CHATMUX_PORT="${SERVER_PORT:-3001}"

if ! command -v chatmux >/dev/null 2>&1; then
  printf 'ChatMux sandbox is not installed. Rebuild the local chatmux-sandbox image from prepared repository source.\n' >&2
  return 1 2>/dev/null || exit 1
fi

if [ ! -f "$CHATMUX_ROOT/dist-server/server/cli.js" ]; then
  printf 'ChatMux sandbox source is missing at %s. Rebuild the local image from prepared repository source.\n' "$CHATMUX_ROOT" >&2
  return 1 2>/dev/null || exit 1
fi

mkdir -p "$(dirname "$CHATMUX_LOG_FILE")"
# The canonical log stays under ~/.chatmux. This link keeps the CLI's
# sandbox log command compatible with existing running sandboxes.
ln -sfn "$CHATMUX_LOG_FILE" /tmp/chatmux-ui.log

if ! pgrep -f "$CHATMUX_ROOT/dist-server/server/cli.js" >/dev/null 2>&1; then
  nohup chatmux start --host 0.0.0.0 --port "$CHATMUX_PORT" >> "$CHATMUX_LOG_FILE" 2>&1 &
  disown || true

  printf '\n  ChatMux is starting on port %s.\n\n' "$CHATMUX_PORT"
  printf '  Forward the port from another terminal:\n'
  printf '    sbx ports <sandbox-name> --publish %s:%s\n\n' "$CHATMUX_PORT" "$CHATMUX_PORT"
  printf '  Then open: http://localhost:%s\n\n' "$CHATMUX_PORT"
fi
