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

4. Build the client, then capture native Computer Use and installed-PWA evidence
   in a private Xvfb, DBus, GNOME, HOME, runtime directory, and Chrome profile.
   The command downloads the pinned upstream Computer Use release from GitHub,
   verifies its published asset checksum, and never reads the operator's plugin
   cache, desktop session, browser profile, or notification settings.

   ```sh
   npm run build:client
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:isolated:desktop
   ```

   On a developer workstation where the nested GNOME/Chrome session cannot
   commit loopback documents, use the existing signed-in X11 desktop with a
   task-owned Chrome process, temporary HOME/profile, and the read-only Codex
   window-control bridge. This visibly opens and closes one verification window
   but does not read or change the operator's Chrome profile:

   ```sh
   CUA_ACTIVE_DISPLAY=:1 CUA_EVIDENCE_DIR=/absolute/evidence/run \
     npm run cua:active:desktop
   ```

   To use that same active-desktop proof as the final post-stage of the complete
   local release run, also set `CUA_DESKTOP_EVIDENCE_MODE=active`. CI leaves the
   default `isolated` mode unchanged.

5. Stop the fixture with Ctrl+C, then record regression exit codes, materialize
   the Node 22/24 and canonical-bundle receipts, run the integrity collector,
   and build the requirement-by-requirement summary. `npm run cua:release`
   performs this complete sequence in CI.

   ```sh
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:regressions
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:summary
   ```

For the same headless release surface used by CI, run `npm run cua:release`. It
starts an enrolled hub plus two full peers with duplicate labels and session IDs,
launches an accessibility-enabled disposable Chrome, runs desktop/mobile and
destructive scenarios, and closes every owned process. CI runs this after the
Node 24 verify gate while the unchanged full verify gate runs on both Node 22 and
Node 24; its evidence directory is uploaded even when a browser assertion fails.

The UI scripts require Python Playwright and a Chrome instance reachable at
`CUA_CDP_URL` (default `http://127.0.0.1:9333`). `mcp-evidence.mjs` requires an
explicit `CUA_DRIVER_PATH`; `cua:tool:provision` supplies the repository-pinned
upstream binary and checksum receipt. The report keeps browser/CDP functional
evidence distinct from isolated native window-targeting evidence.

`pwa-evidence.mjs` stores only the matching desktop-entry name and notification
permission value. It never records the Chrome profile's unrelated settings,
push subscription keys, cookies, or credentials.

## Multi-PC release walkthroughs

Fleet release evidence uses **two independent disposable full installations**, not a
mocked peer or second agent artifact. Give each process a unique HOME, data root,
loopback port, tmux socket, Chrome profile, and evidence directory. The hub and peer
must both expose their own direct UI. The hermetic CI fixture uses only its owned
loopback listeners. Product deployments still use documented direct WSS by default;
`ssh-loopback` remains limited to an owner-managed local forward saved as exactly
`ws://127.0.0.1:<port>/fleet-ws` (or literal `[::1]`).

Run and record two clean walkthroughs:

1. **Pair, reconnect, revoke, direct recovery:** arm the hub browser's exact
   `fleet.host_state`/DOM state signal before adding the peer; wait for Online; arm
   Offline before stopping the peer; arm Syncing then Online before restarting and
   selecting Reconnect; revoke from Hosts; finally open the peer's direct UI and
   prove its local surface remains usable.
2. **Installation-key loss:** pair a fresh disposable peer; stop it using its exact
   process-exit signal; preserve the damaged data as evidence, replace the disposable
   installation identity, and restart; prove the old pinned identity is refused;
   revoke the old installation ID, remove the revoked hub record, generate a new
   single-use code, re-pair, and wait for Online; open both direct UIs for recovery.

Every waiter must subscribe to the precise process exit, WebSocket frame, HTTP
response, browser navigation, or DOM mutation **before** triggering the action and
must have a bounded failure timeout. Fixed sleeps, delayed polling, and
wait-for-time progression are not evidence. Close every browser/context, WebSocket,
SSH forward, server process group, tmux server, file descriptor, and log stream;
remove only the unique disposable roots after preserving the requested evidence.
Never record pairing tokens, private keys, cookies, peer URLs, or transcript content.
