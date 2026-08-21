# ChatMux CUA validation harness

This harness creates a disposable HOME and tmux socket, seeds seven fake coding
agents, and runs ChatMux on ports 4310/4311. It never attaches to or deletes the
operator's existing tmux sessions. Fake agent executables live under the
fixture HOME's `.local/bin`, so UI-created sessions cannot accidentally launch
the operator's real Claude, Codex, Cursor, OpenCode, OMO, OMP, or GJC binary.

## Run

1. Start the fixture and leave it running:

   ```sh
   npm run cua:fixture
   ```

2. Start a dedicated Chrome with remote debugging enabled. Use a fresh profile
   outside the repository so Vite does not watch browser cache files:

   ```sh
   profile="$(mktemp -d /tmp/chatmux-cua-chrome.XXXXXX)"
   DISPLAY=:0 XAUTHORITY=/run/user/1000/gdm/Xauthority \
     /opt/google/chrome/chrome \
     --new-window \
     --force-renderer-accessibility \
     --remote-debugging-port=9333 \
     --user-data-dir="$profile" \
     --no-first-run \
     --no-default-browser-check \
     --disable-background-networking \
     --disable-component-update \
     http://127.0.0.1:4310
   ```

3. Capture the clean desktop/mobile conversation evidence, then the destructive
   interaction scenarios. The second command deliberately creates a disposable
   session, reorders the sidebar, interrupts a fake turn, and injects a synthetic
   provider error inside the fixture.

   ```sh
   npm run cua:ui:evidence
   npm run cua:ui:interactions
   ```

4. Capture official Computer Use MCP evidence. `CUA_EVIDENCE_DIR` should be the
   `evidenceRoot` printed by the fixture. Tool selection and arguments are
   controlled by `CUA_TOOLS` and `CUA_TOOL_ARGUMENTS`.

   ```sh
   CUA_TOOLS=get_app_state,doctor,list_apps,list_windows,focused_window,screenshot \
   CUA_TOOL_ARGUMENTS='{"get_app_state":{"pid":1234,"include_screenshot":false}}' \
   CUA_EVIDENCE_DIR=/absolute/evidence/run \
   npm run cua:mcp:evidence
   ```

5. Capture the actual host's Ubuntu upgrade gate, Tailscale HTTPS endpoints,
   PWA installability, installed-app state, and notification permission. These
   commands do not upgrade the OS or ask for notification permission.

   ```sh
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:os:preflight
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:tailscale:evidence
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:pwa:evidence
   ```

6. Stop the fixture with Ctrl+C, then record all regression exit codes and build
   a requirement-by-requirement summary:

   ```sh
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:regressions
   CUA_EVIDENCE_DIR=/absolute/evidence/run \
   CUA_DESKTOP_LOCKED=0 \
   npm run cua:summary
   ```

The UI scripts require Python Playwright and a Chrome instance reachable at
`CUA_CDP_URL` (default `http://127.0.0.1:9333`). `mcp-evidence.mjs` requires the
official Linux Computer Use plugin bundle in the Codex plugin cache. The report
keeps browser/CDP functional evidence distinct from native CUA window-targeting
evidence.

`pwa-evidence.mjs` stores only the matching desktop-entry name and notification
permission value. It never records the Chrome profile's unrelated settings,
push subscription keys, cookies, or credentials.
