#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
EVIDENCE=${CUA_EVIDENCE_DIR:-$ROOT/.cua-release-evidence}
VITE_PORT=${CUA_ISOLATED_VITE_PORT:-14324}
CDP_PORT=${CUA_ISOLATED_CDP_PORT:-19324}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/chatmux-task24-desktop.XXXXXX")
HOME_DIR=$WORK/home
RUNTIME_DIR=$WORK/runtime
TOOL_DIR=$WORK/tool
PROFILE=$WORK/chrome
CHROME=${CUA_CHROME_PATH:-/opt/google/chrome/chrome}
mkdir -p "$EVIDENCE" "$HOME_DIR" "$RUNTIME_DIR" "$TOOL_DIR" "$PROFILE/Default" "$HOME_DIR/.local/share/applications"
chmod 700 "$RUNTIME_DIR"
PIDS=()

stop_pid() {
  local pid=$1
  kill -TERM "$pid" 2>/dev/null || return 0
  timeout 15 tail --pid="$pid" -f /dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local status=$?
  if [[ ${CUA_KEEP_FAILURE:-0} == 1 && $status != 0 ]]; then
    printf '%s\n' "$WORK" >"$EVIDENCE/isolated-failure-root.txt"
    trap - EXIT INT TERM
    exit "$status"
  fi
  for ((index=${#PIDS[@]}-1; index>=0; index--)); do stop_pid "${PIDS[$index]}"; done
  if (( status != 0 )); then
    mkdir -p "$EVIDENCE/isolated-desktop-failure"
    cp -f "$WORK"/*.log "$EVIDENCE/isolated-desktop-failure/" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  trap - EXIT INT TERM
  exit "$status"
}
trap cleanup EXIT INT TERM

export HOME=$HOME_DIR XDG_DATA_HOME=$HOME_DIR/.local/share XDG_CONFIG_HOME=$HOME_DIR/.config
export XDG_CACHE_HOME=$HOME_DIR/.cache XDG_RUNTIME_DIR=$RUNTIME_DIR
export XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=GNOME GNOME_SHELL_SESSION_MODE=gnome
export GDK_BACKEND=x11 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge

mkfifo "$WORK/xvfb-display"
exec {XVFB_DISPLAY}<>"$WORK/xvfb-display"
Xvfb -screen 0 1920x1080x24 -displayfd 3 3>"$WORK/xvfb-display" 2>"$WORK/xvfb.log" &
XVFB_PID=$!
PIDS+=("$XVFB_PID")
read -r DISPLAY_NUMBER <&"$XVFB_DISPLAY"
export DISPLAY=:$DISPLAY_NUMBER

mapfile -t DBUS_INFO < <(dbus-daemon --session --fork --print-address=1 --print-pid=1)
export DBUS_SESSION_BUS_ADDRESS=${DBUS_INFO[0]}
DBUS_PID=${DBUS_INFO[1]}
PIDS+=("$DBUS_PID")

gsettings set org.gnome.desktop.interface toolkit-accessibility true
CUA_TOOL_DIR=$TOOL_DIR CUA_EVIDENCE_DIR=$EVIDENCE node "$ROOT/scripts/cua/provision-computer-use.mjs" >"$WORK/tool-path"
DRIVER=$(<"$WORK/tool-path")
"$DRIVER" setup-window-targeting >"$EVIDENCE/window-targeting-setup.txt"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['computer-use-linux@avifenesh.dev']"

gnome-shell >"$WORK/gnome-shell.log" 2>&1 &
SHELL_PID=$!
PIDS+=("$SHELL_PID")
gdbus wait --session --timeout 30 org.gnome.Shell
gdbus wait --session --timeout 30 dev.avifenesh.ComputerUseLinux.WindowControl

mkfifo "$WORK/vite-output"
exec {VITE_OUTPUT}<>"$WORK/vite-output"
node "$ROOT/node_modules/vite/bin/vite.js" preview --host localhost --port "$VITE_PORT" >"$WORK/vite-output" 2>&1 &
VITE_PID=$!
PIDS+=("$VITE_PID")
timeout 30 grep -m1 'Local:' <&"$VITE_OUTPUT" >"$WORK/vite.log"
cat <&"$VITE_OUTPUT" >>"$WORK/vite.log" &
BASE_URL=http://localhost:$VITE_PORT
curl --fail --silent --show-error --max-time 10 "$BASE_URL" >/dev/null
ORIGIN_PATTERN="$BASE_URL,*"
python3 - "$PROFILE/Default/Preferences" "$ORIGIN_PATTERN" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
allowed = {sys.argv[2]: {"setting": 1}}
path.write_text(json.dumps({"profile":{"content_settings":{"exceptions":{
    "notifications": allowed,
    "local_network": allowed,
    "loopback_network": allowed,
}}}}))
PY
cat >"$HOME_DIR/.local/share/applications/chatmux-task24.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ChatMux Todo 24
Exec=google-chrome --user-data-dir=$PROFILE --app=$BASE_URL
StartupWMClass=Google-chrome
Terminal=false
EOF

mkfifo "$WORK/chrome-output"
exec {CHROME_OUTPUT}<>"$WORK/chrome-output"
env -u GTK_MODULES -u GDK_BACKEND -u NO_AT_BRIDGE "$CHROME" --no-sandbox --disable-gpu --enable-logging=stderr --v=1 --force-renderer-accessibility --no-first-run \
  --no-default-browser-check --no-proxy-server --disable-background-networking --disable-component-update \
  --disable-default-apps --disable-extensions --disable-sync \
  --disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC,LocalNetworkAccessChecksWarnings \
  --ip-address-space-overrides=127.0.0.0/8=public \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" --window-size=1600,1000 "--app=$BASE_URL" >"$WORK/chrome-output" 2>&1 &
CHROME_PID=$!
PIDS+=("$CHROME_PID")
timeout 30 grep -m1 'DevTools listening on' <&"$CHROME_OUTPUT" >"$WORK/chrome.log"
cat <&"$CHROME_OUTPUT" >>"$WORK/chrome.log" &

mkfifo "$WORK/notify-output"
exec {NOTIFY_OUTPUT}<>"$WORK/notify-output"
dbus-monitor "interface='org.freedesktop.Notifications',member='Notify'" >"$WORK/notify-output" &
NOTIFY_PID=$!
PIDS+=("$NOTIFY_PID")
read -r _ <&"$NOTIFY_OUTPUT"
export CUA_EVIDENCE_DIR=$EVIDENCE CUA_PWA_BASE_URL=$BASE_URL CUA_CDP_URL=http://127.0.0.1:$CDP_PORT
node "$ROOT/scripts/cua/isolated-pwa-evidence.mjs"
timeout 20 grep -m1 'member=Notify' <&"$NOTIFY_OUTPUT" >"$WORK/notify-line"
node --input-type=module - "$EVIDENCE/pwa-notification-browser.json" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const file = process.argv[2];
const value = JSON.parse(await readFile(file, 'utf8'));
value.notificationApiCreated = true;
value.osNotifyDbusObserved = true;
await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
stop_pid "$NOTIFY_PID"

CUA_DRIVER_PATH=$DRIVER CUA_TOOLS=get_app_state,doctor,list_apps,list_windows,focused_window,screenshot \
  node "$ROOT/scripts/cua/mcp-evidence.mjs"
CUA_CHROME_USER_DATA_DIR=$PROFILE CUA_CHROME_PROFILE=Default node "$ROOT/scripts/cua/pwa-evidence.mjs"
node --input-type=module - "$EVIDENCE/computer-use-mcp.json" "$EVIDENCE/isolated-desktop.json" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const [source, output] = process.argv.slice(2);
const evidence = JSON.parse(await readFile(source, 'utf8'));
const call = (name) => evidence.calls.find((entry) => entry.name === name)?.result?.structuredContent;
const doctor = call('doctor'); const windows = call('list_windows'); const focused = call('focused_window');
const report = {
  isolated: true,
  display: process.env.DISPLAY,
  privateHome: true,
  privateRuntime: true,
  checks: {
    atSpi: call('get_app_state')?.accessibility_tree_raw_count > 0,
    canQueryWindows: doctor?.readiness?.can_query_windows === true,
    canFocusWindows: doctor?.readiness?.can_focus_windows === true,
    chatMuxWindow: windows?.windows?.some((window) => window.title?.includes('ChatMux')) === true,
    chatMuxFocused: focused?.focused_window?.title?.includes('ChatMux') === true,
  },
};
report.ok = Object.values(report.checks).every(Boolean);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
NODE
