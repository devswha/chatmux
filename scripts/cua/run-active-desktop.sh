#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
EVIDENCE=${CUA_EVIDENCE_DIR:-$ROOT/.cua-release-evidence}
UPSTREAM_PORT=${CUA_ACTIVE_VITE_PORT:-14330}
PROXY_PORT=${CUA_ACTIVE_PROXY_PORT:-14331}
CDP_PORT=${CUA_ACTIVE_CDP_PORT:-19331}
ACTIVE_DISPLAY=${CUA_ACTIVE_DISPLAY:-:1}
ACTIVE_XAUTHORITY=${CUA_ACTIVE_XAUTHORITY:-/run/user/$(id -u)/gdm/Xauthority}
ACTIVE_RUNTIME=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
ACTIVE_BUS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$ACTIVE_RUNTIME/bus}
CHROME=${CUA_CHROME_PATH:-/opt/google/chrome/chrome}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/chatmux-task24-active.XXXXXX")
PROFILE_HOME=$WORK/home
PROFILE=$WORK/profile
TOOL_DIR=$WORK/tool
mkdir -p "$EVIDENCE" "$PROFILE_HOME/.local/share/applications" "$PROFILE/Default" "$TOOL_DIR"
PIDS=()

stop_group() {
  local pid=$1
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || return 0
  timeout 15 tail --pid="$pid" -f /dev/null 2>/dev/null \
    || kill -KILL -- "-$pid" 2>/dev/null \
    || kill -KILL "$pid" 2>/dev/null \
    || true
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local result=$?
  for ((index=${#PIDS[@]}-1; index>=0; index--)); do stop_group "${PIDS[$index]}"; done
  find "$WORK" -depth -delete
  trap - EXIT INT TERM
  exit "$result"
}
trap cleanup EXIT INT TERM

export DISPLAY=$ACTIVE_DISPLAY XAUTHORITY=$ACTIVE_XAUTHORITY XDG_RUNTIME_DIR=$ACTIVE_RUNTIME
export DBUS_SESSION_BUS_ADDRESS=$ACTIVE_BUS XDG_SESSION_TYPE=x11
xwininfo -root >/dev/null

CUA_TOOL_DIR=$TOOL_DIR CUA_EVIDENCE_DIR=$EVIDENCE \
  node "$ROOT/scripts/cua/provision-computer-use.mjs" >"$WORK/tool-path"
DRIVER=$(tail -1 "$WORK/tool-path")

mkfifo "$WORK/bridge"
exec {BRIDGE_OUTPUT}<>"$WORK/bridge"
setsid python3 "$ROOT/scripts/cua/window-control-bridge.py" >&$BRIDGE_OUTPUT 2>"$WORK/bridge.err" &
BRIDGE_PID=$!
PIDS+=("$BRIDGE_PID")
timeout 30 grep -m1 WINDOW_CONTROL_BRIDGE_READY <&$BRIDGE_OUTPUT

mkfifo "$WORK/vite"
exec {VITE_OUTPUT}<>"$WORK/vite"
setsid node "$ROOT/node_modules/vite/bin/vite.js" preview --host 127.0.0.1 --port "$UPSTREAM_PORT" >&$VITE_OUTPUT 2>&1 &
VITE_PID=$!
PIDS+=("$VITE_PID")
timeout 30 grep -m1 'Local:' <&$VITE_OUTPUT

mkfifo "$WORK/proxy"
exec {PROXY_OUTPUT}<>"$WORK/proxy"
CUA_PROXY_PORT=$PROXY_PORT CUA_UPSTREAM_PORT=$UPSTREAM_PORT \
  setsid node "$ROOT/scripts/cua/request-signal-proxy.mjs" >&$PROXY_OUTPUT 2>"$WORK/proxy.err" &
PROXY_PID=$!
PIDS+=("$PROXY_PID")
timeout 30 grep -m1 REQUEST_PROXY_READY <&$PROXY_OUTPUT

BASE_URL=http://127.0.0.1:$PROXY_PORT
ORIGIN_PATTERN="$BASE_URL,*"
python3 - "$PROFILE/Default/Preferences" "$ORIGIN_PATTERN" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "profile": {"content_settings": {"exceptions": {
        "notifications": {sys.argv[2]: {"setting": 1}},
    }}},
}))
PY
python3 - "$PROFILE_HOME/.local/share/applications/chatmux-task24.desktop" "$PROFILE" "$BASE_URL" <<'PY'
import pathlib, sys
pathlib.Path(sys.argv[1]).write_text(f"""[Desktop Entry]
Type=Application
Name=ChatMux Todo 24
Exec=google-chrome --user-data-dir={sys.argv[2]} --app={sys.argv[3]}
StartupWMClass=Google-chrome
Terminal=false
""")
PY

mkfifo "$WORK/chrome"
exec {CHROME_OUTPUT}<>"$WORK/chrome"
setsid env HOME="$PROFILE_HOME" XDG_DATA_HOME="$PROFILE_HOME/.local/share" \
  "$CHROME" --no-sandbox --force-renderer-accessibility --no-first-run \
  --no-default-browser-check --disable-background-networking --disable-component-update \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" --window-size=1600,1000 "--app=$BASE_URL" >&$CHROME_OUTPUT 2>&1 &
CHROME_PID=$!
PIDS+=("$CHROME_PID")
timeout 30 grep -m1 'DevTools listening on' <&$CHROME_OUTPUT

mkfifo "$WORK/notify"
exec {NOTIFY_OUTPUT}<>"$WORK/notify"
setsid dbus-monitor "interface='org.freedesktop.Notifications',member='Notify'" >&$NOTIFY_OUTPUT 2>"$WORK/notify.err" &
NOTIFY_PID=$!
PIDS+=("$NOTIFY_PID")
read -r _ <&$NOTIFY_OUTPUT

HOME=$PROFILE_HOME XDG_DATA_HOME=$PROFILE_HOME/.local/share \
  CUA_EVIDENCE_DIR=$EVIDENCE CUA_PWA_BASE_URL=$BASE_URL CUA_CDP_URL=http://127.0.0.1:$CDP_PORT \
  node "$ROOT/scripts/cua/active-pwa-evidence.mjs"
timeout 30 grep -m1 'member=Notify' <&$NOTIFY_OUTPUT >"$EVIDENCE/os-notification-dbus.txt"

CUA_DRIVER_PATH=$DRIVER CUA_TOOLS=list_windows CUA_EVIDENCE_DIR=$WORK/mcp-bootstrap \
  node "$ROOT/scripts/cua/mcp-evidence.mjs" >/dev/null
WINDOW_ID=$(node -e "const d=require('$WORK/mcp-bootstrap/computer-use-mcp.json'); const w=d.calls[0].result.structuredContent.windows.find((entry)=>entry.pid===$CHROME_PID||entry.title==='ChatMux'); if(!w)process.exit(2); process.stdout.write(String(w.window_id));")
CUA_DRIVER_PATH=$DRIVER \
  CUA_TOOLS=get_app_state,doctor,list_apps,list_windows,activate_window,focused_window,screenshot \
  CUA_TOOL_ARGUMENTS="{\"get_app_state\":{\"pid\":$CHROME_PID,\"include_screenshot\":false},\"activate_window\":{\"window_id\":$WINDOW_ID}}" \
  CUA_EVIDENCE_DIR=$EVIDENCE node "$ROOT/scripts/cua/mcp-evidence.mjs"
CUA_ACTIVE_CHROME_PID=$CHROME_PID CUA_EVIDENCE_DIR=$EVIDENCE \
  node "$ROOT/scripts/cua/finalize-active-desktop.mjs"
HOME=$PROFILE_HOME XDG_DATA_HOME=$PROFILE_HOME/.local/share \
  CUA_CHROME_USER_DATA_DIR=$PROFILE CUA_CHROME_PROFILE=Default \
  CUA_PWA_BASE_URL=$BASE_URL CUA_EVIDENCE_DIR=$EVIDENCE \
  node "$ROOT/scripts/cua/pwa-evidence.mjs"
