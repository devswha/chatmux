# ChatMux CUA validation harness

This harness creates a disposable HOME and tmux socket, seeds seven fake coding
agents, and runs the web UI on port 4310 with dynamically allocated backend ports.
It never attaches to or deletes the
operator's existing tmux sessions. Fake agent executables live under the
fixture HOME's `.local/bin`, so UI-created sessions cannot accidentally launch
the operator's real Claude, Codex, Cursor, OpenCode, OMO, OMP, or GJC binary.

## Run

1. Start the fixture and leave it running:

   ```sh
   CUA_VITE_PORT=4310 CUA_SERVER_PORT=4311 \
   CUA_PEER_A_PORT=4312 CUA_PEER_B_PORT=4313 \
   TSX_TSCONFIG_PATH=server/tsconfig.json \
     node --import tsx scripts/cua/run-fixture.ts
   ```

   Await `CUA_FIXTURE_READY` on stdout before opening the browser. Invoke Node
   directly rather than the tsx CLI wrapper so SIGINT/SIGTERM reaches the fixture
   cleanup handler. Choose disjoint explicit ports if these are occupied. Build
   the native core first with `npm run build:core:dev` if it is absent. In a
   worktree with a dependency symlink, use an owned dependency copy/cache whose
   real path is inside that worktree and still ends in `node_modules`; sharing
   Vite's optimizer cache across running worktrees can load duplicate Reacts.

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
   interaction scenarios. The interaction script deliberately creates a disposable
   session, reorders the sidebar, interrupts a fake turn, and injects a synthetic
   provider error inside the fixture.

   ```sh
   npm run cua:improvements
   npm run cua:ui:evidence
   npm run cua:ui:interactions
   npm run cua:mobile
   ```

   `cua:mobile` uses fresh touch-enabled Chrome contexts at 320px and 390px,
   including landscape rotation and a short viewport. It checks menus, long
   input, drag resizing, chat/terminal switching, and delivery to the exact
   fixture pane. Set `CUA_MOBILE_WEBKIT=1` to repeat the supported interactions
   in WebKit after installing its Playwright browser. Browser emulation does
   not prove behavior on physical iOS/Android keyboards or devices.

   The operator-improvement matrix runs before fleet interaction scenarios.
   It checks conversation excerpts, host-qualified pins, owner diagnostics and
   recovery from denied/failed reads, local attention controls, discovery
   reconnect without write replay, and terminal accessibility controls. It uses
   desktop Chrome and 320px/390px touch contexts; `CUA_MOBILE_WEBKIT=1` adds both
   touch sizes in WebKit. Clipboard writes are captured inside the disposable
   page, and service workers are blocked for deterministic network-fault tests.
   Installed-PWA/service-worker behavior is verified separately below. Run this
   matrix first because later fleet recovery tests can replace pairing identities.

   Diagnostics coverage uses the actual Settings tab and `Refresh diagnostics`,
   with response and busy-to-idle DOM subscriptions armed before navigation or
   keyboard Enter. The Vite app's StrictMode mount starts and aborts an initial
   pair before remounting; each manual refresh must issue exactly one GET to each
   endpoint. It does not add polling, scan requests, or diagnostic actions.

   - **Real/unmocked:** aggregate and pane endpoints return 200 JSON/no-store;
     cards, coordinates, providers, and PIDs match the local fixture manifest,
     not the enrolled collision peers. Private fields are absent. A normal
     cached refresh and final recovery use the real endpoints.
   - **Synthetic presentation only:** browser route fulfillment supplies two
     sockets with equal coordinates, both lanes on one card, fresh/stale/unknown
     observations, a 32-PID chain, all source/coverage/budget fields, successful
     empty versus waiting/unavailable, and a private redaction sentinel. Each
     endpoint independently receives 404, 503, network, malformed JSON, and
     unsupported-schema faults; its successful peer remains. Either endpoint's
     401/403 removes both datasets. Every fault is followed by keyboard refresh
     recovery. These fulfilled faults do not prove server authorization.
   - **Layout/localization:** English and Korean at 1440x1000, 320x568, and
     390x844 check page overflow, PID wrapping, last-card reachability, a single
     shared refresh control (excluding Settings navigation), and no page errors.
     Korean uses the app's real `userLanguage` preference and shipped resources,
     not a translated mock shell. Physical-device, WebKit, PWA, and native
     desktop behavior require their separately documented runs.

   Use a unique `CUA_EVIDENCE_DIR` for every attempt, including mutation REDs.
   `improvement-interactions.json` preserves the English `cases` and boolean
   `checks`, adding separate `koreanDiagnosticsCases`. Existing required excerpt,
   pins, diagnostics, and terminal screenshot names are unchanged. New per-case
   `*-pane-real.json` stores only public real responses; `*-pane-actions.json`
   distinguishes real and synthetic refresh results. `*-pane-start.png`,
   `*-pane-first-card.png`, `*-pane-end.png`, and `*-pane-lineage.png` capture
   scroll positions; state/fault-named PNGs capture each failure presentation.
   Korean filenames append `-ko` to the case prefix. Synthetic private response
   properties are deliberately not persisted in response artifacts.

   For failure sensitivity, temporarily mutate only the owned UI checkout:
   misclassify successful empty as waiting, hide aggregate data on pane failure,
   or change an omission count. Run the same diagnostic assertions against each
   mutation and preserve its named assertion failure, actions, and screenshot.
   Restore exact committed UI bytes before the final full matrix and commit only
   harness/docs. A selector typo, setup failure, or changed assertion is not a
   mutation RED. Stop owned Chrome and the direct fixture process, await their
   exits and `stopped.json`, remove owned profiles/dependency copies/temp roots,
   and verify the dedicated ports are free before recording PASS. Never use the
   operator's port 3001, browser profile, or tmux server.

4. Build the client, then capture native Computer Use and installed-PWA evidence
   in a private Xvfb, DBus, GNOME, HOME, runtime directory, and Chrome profile.
   The command downloads the pinned upstream Computer Use release from GitHub,
   verifies its published asset checksum, and never reads the operator's plugin
   cache, desktop session, browser profile, or notification settings.

   ```sh
   npm run build:client
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:isolated:desktop
   ```

   The disposable Chrome profile uses the basic password store because the
   private GNOME session has no unlocked keyring. It contains no operator
   credentials. Native focus verification explicitly activates the window
   belonging to that owned Chrome PID before checking its focus.

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
   performs this complete sequence when run explicitly, including the manual CI
   workflow-dispatch evidence job.

   ```sh
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:regressions
   CUA_EVIDENCE_DIR=/absolute/evidence/run npm run cua:summary
   ```

For the same headless release surface used by CI, run `npm run cua:release`. It
starts an enrolled hub plus two full peers with duplicate labels and session IDs,
launches an accessibility-enabled disposable Chrome, runs desktop/mobile and
destructive scenarios, and closes every owned process. CI runs this only on
`workflow_dispatch`, after both Node 22/24 verification and the canonical bundle
job. Ordinary pull-request and push CI skip it. Its evidence directory is uploaded
even when a browser assertion fails; this manual evidence does not gate publication.

The UI scripts require Python Playwright and a Chrome instance reachable at
`CUA_CDP_URL` (default `http://127.0.0.1:9333`). `mcp-evidence.mjs` requires an
explicit `CUA_DRIVER_PATH`; `cua:tool:provision` supplies the repository-pinned
upstream binary and checksum receipt. The report keeps browser/CDP functional
evidence distinct from isolated native window-targeting evidence.

`pwa-evidence.mjs` stores only the matching desktop-entry name and notification
permission value. It never records the Chrome profile's unrelated settings,
push subscription keys, cookies, or credentials.

## Multi-PC release walkthroughs

Fleet release evidence uses **one hub and two independent disposable full peers**.
Give each process a unique HOME, data root,
loopback port, tmux socket, Chrome profile, and evidence directory. The hub and peer
must both expose their own direct UI. The hermetic CI fixture uses only its owned
loopback listeners. Product deployments still use documented direct WSS by default;
`ssh-loopback` remains limited to an owner-managed or explicitly requested
hub-managed local forward saved as exactly `ws://127.0.0.1:<port>/fleet-ws`
(or literal `[::1]`), under Fleet RFC revision 4.

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
