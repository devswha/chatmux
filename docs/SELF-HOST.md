# Self-hosting ChatMux

ChatMux is self-hosted from the **GitHub Releases** server artifact only:

<https://github.com/devswha/chatmux/releases>

The canonical artifact is
`chatmux-server-<version>-linux-x64-node22.tar.gz`, accompanied by an
artifact with the same name plus `.sha256`. Do not substitute a package
registry, container image, desktop delivery, or an unverified source build.

## Supported target and filesystem layout

The first supported artifact target is Linux on x86_64 with glibc 2.35 or
newer. The bootstrap installer self-provisions Node.js 22.22.2; manual runtime
operation requires Node.js 22.22.2 or newer within the 22.x line. It is a server
artifact only.

| Path | Purpose |
|---|---|
| `~/.local/share/chatmux` | Canonical Git checkout for source review and manual upstream intake. It is not a release payload. |
| `~/.chatmux/releases/<version>` | Immutable unpacked server artifacts. |
| `~/.chatmux/current` | Symlink to the release used by the service. |
| `~/.chatmux/data` | Persistent application data, including user-managed database, assets, and cache paths. |
| `~/.config/systemd/user/chatmux.service` | Per-user systemd service. |

A release deployment must never create, replace, or delete the checkout.
Likewise, replacing a release must not delete `~/.chatmux/data`.

Before the first deployment, confirm the host contract:

```sh
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
getconf GNU_LIBC_VERSION    # requires glibc 2.35 or newer
node --version              # manual runtime requires v22.22.2 or newer
```

Use the release-install procedure in [INSTALL.md](INSTALL.md) to verify the
checksum, unpack a versioned release, install `chatmux.service`, and activate
the initial `current` link.

## Mobile screen refresh and owner updates

The mobile UI deliberately separates two actions:

- **`새 화면 적용`** means the installed PWA has an older frontend than
  `/health.version`. It activates the already-downloaded service worker and reloads
  the screen once. It never deploys, restarts, or changes the server.
- **`서버 업데이트`** means the server has discovered a newer canonical release
  (or, for a source install, that its configured `origin/main` deployment can
  advance). It is shown only to the trusted owner. The browser cannot choose a
  version, URL, asset, command, path, or rollback target.

A server update is started by a bodyless `POST /api/system/update` and its current
capability/state is available from `GET /api/system/update/status`. The returned
opaque job ID can be read by its owner at `GET /api/system/update/jobs/:jobId`.
Jobs report durable phases and terminal `succeeded`, `failed`,
`failed_rolled_back`, `failed_rollback`, or `manual_required` states. Terminal
unlocked jobs are retained for 30 days, up to 32 records; active, locked, and
manual-recovery records are retained for operator recovery.

Every update path is owner-only: the Tailscale owner, the authenticated
password-mode installation account, or a verified immediate-loopback local owner.
Allowed Tailscale users are not update owners, and remote auth-none/VPN callers
cannot update. Tailscale users can use the app but must ask the owner to deploy.
On success, the server proves the new boot and exact target version through its
health response, then automatically applies the new screen. A server updated by
another operator instead leaves `새 화면 적용` available to a stale PWA.

For a release installation, the router—not the phone—resolves the sole canonical
GitHub Release assets: `chatmux-server-<version>-linux-x64-node22.tar.gz`, its
same-basename `.sha256`, and the separately published root `install.sh`. The
detached worker downloads and validates only the archive and checksum; it never
downloads or executes `install.sh`. It runs as the installing user's transient
user-systemd worker from the immutable old release, stages and verifies the new
payload outside live releases, then atomically changes `~/.chatmux/current` and
restarts the fixed `chatmux.service`.

Before cutover the worker requires the exact release version and database
compatibility metadata. Automatic rollback is allowed only when the target's
`database.rollbackCompatibleFrom` names the exact running version and release CI
has proven the migration, old-version health, and representative I/O. There is no
automatic database backup or restore. An ineligible database jump is
`manual_required` before cutover. For an eligible post-cutover failure, the worker
atomically restores the prior link and verifies its health (`failed_rolled_back`);
a failed restoration is `failed_rollback` and requires manual recovery. Inspect
the job status and `journalctl --user -u chatmux.service` before acting; preserve
both release directories and the durable job record.

Source and release semantics remain distinct. A source installation continues its
configured moving `origin/main` plus `deploy.sh` flow and never claims an exact
release target. The first updater-capable release still needs the manual bootstrap
below; later compatible releases can be updated from the owner’s mobile UI.
Terminal/SSH use of `install.sh` is a manual bootstrap or recovery fallback, not
the ordinary mobile update experience.

## Managed-root safety

`~/.chatmux` is a security boundary. It must be a real directory owned by the
installing user with mode `0700`; the installer and detached update worker refuse
a symlink, non-directory, wrong owner, unsafe mode, or identity replacement
before their network, database, service, or link effects. The update router first
records update state, creates its state directory, and discovers releases before
the worker applies this managed-root check. Do not “fix” this through the mobile
UI.
An operator must stop, inspect the path and ownership, remove or relocate an
unexpected symlink only after confirming its target is safe, then recreate or
repair the managed root as the intended user with `0700` before manual recovery.
## Service operations

ChatMux runs as the per-user `chatmux.service`; root privileges and a
system-wide unit are not required.

```sh
systemctl --user status chatmux.service
systemctl --user restart chatmux.service
journalctl --user -u chatmux.service -f
curl --fail http://127.0.0.1:3001/health
```

The examples use port `3001`; each install may select a different loopback
port. `chatmux status` reports the configured address.

Use `loginctl enable-linger "$USER"` only when the host policy permits the
service to continue after logout.

Installation automatically selects the access path:

- **Tailscale** is selected when the daemon is running and logged in. The
  installer keeps the backend on `127.0.0.1`, configures a private HTTPS Serve
  front on an unused port, and applies the same account allowlist to HTTP and
  WebSocket requests. No ChatMux username or password is required. On a phone,
  turn on Tailscale before scanning the QR and keep it connected while using
  ChatMux.
- **Password** is the fallback when Tailscale is unavailable
  (`chatmux access enable password [address] [--session-days <n>]`, rotate with
  `chatmux access password`). It serves a browser login so phones need no VPN
  app. Sessions renew on use (sliding window, 1–365 days): active devices never
  re-login, idle ones expire, and logout or rotation revokes immediately.
  Restrict the bind with `chatmux access enable password 127.0.0.1`, and put a
  TLS proxy in front before any public exposure.
- **VPN** (`chatmux access enable vpn <address>`) binds
  the backend to an existing WireGuard-style tunnel address with no
  application login. Access control is the tunnel itself — every VPN peer has
  full access, so only use it for tunnels whose peers you all trust. The
  address must be a private IPv4 already present on a local interface.

```sh
chatmux access users
chatmux access allow family@example.com
chatmux access revoke family@example.com
```

An SSH tunnel remains the local-only fallback when Tailscale is unavailable:

```sh
ssh -N -L 3001:127.0.0.1:3001 user@server
```

## Multi-PC operations

A fleet has one hub and at most nine full peer installations. There is no separate
peer binary or daemon: every PC uses the same artifact and keeps its own service,
data, tmux/provider processes, installation identity, updater, and direct UI. The
hub dials peers directly; ChatMux provides no relay, database replication, cloud
sync, failover, or fleet updater.

Use Tailscale Serve HTTPS/WSS by default. The saved peer URL is the peer's actual
Serve host and port with `/fleet-ws`, for example
`wss://peer.example.ts.net:8443/fleet-ws`. Plain `ws://` is restricted to a
literal-loopback SSH local forward, created manually or through the hub owner's
**Easy SSH setup** action. Easy setup requires an already-installed remote ChatMux
backend on `127.0.0.1:3001` and a reachable SSH account. It installs a dedicated key,
obtains the pairing token, and manages the tunnel without saving the password.
Changed host keys fail closed; investigate the peer identity before reconnecting.
See [the SSH setup contract](REMOTE-ACCESS.md#82-default-transport-tailscale-httpswss).

For a manually managed tunnel or a different peer backend port, run on the hub:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8022:127.0.0.1:<peer-backend-port> user@peer
```

That mode accepts only `ws://127.0.0.1:8022/fleet-ws` or an explicitly bound
`ws://[::1]:<port>/fleet-ws`. There is no automatic transport downgrade. The owner
manages the process and keys in this manual mode.

Operational rules:

1. Enroll only from the hub owner's **Settings → Hosts** surface, using a single-use
   ten-minute token created on the peer. Easy SSH setup obtains that token over SSH.
2. Treat **Syncing** as read-only recovery and wait for **Online** before issuing a
   mutation. Treat **Offline** as a direct-path failure; repair reachability and use
   **Reconnect**. Never retry an uncertain mutation automatically.
3. For updates, update the hub first and verify its direct UI. Then update one peer
   at a time from that peer's own owner UI, waiting for Online after Syncing before
   continuing. There is no fleet-wide update action or protocol downgrade.
4. If the hub is unavailable, open each peer's own address from its local
   `chatmux status`. Local sessions and recovery remain usable without the hub.
5. Back up each PC's complete `~/.chatmux/data` independently. Fleet enrollment does
   not back up or synchronize peer data.

Revocation is local-first. The hub's **Revoke grant** blocks that peer locally before
attempting remote revocation; an unreachable peer is reported separately and remains
revoked on the hub. Inspect public grant state locally with:

```sh
chatmux fleet identity
chatmux fleet grants
chatmux fleet diagnose
chatmux fleet revoke <installation-id>
```

If an installation key is lost and no complete data backup can restore it, revoke
its old installation ID on every counterpart before rebuilding and pairing the new
identity. A lost peer key is revoked from the hub. A lost hub key is revoked locally
on every peer with `chatmux fleet revoke <old-hub-installation-id>`. Access those
peers through their direct UI/terminal; old trust is never transferred to the new
key.

### Installation-key replacement

Use this only after counterpart revocation and after confirming that no complete data
backup can restore the old identity. For a managed install, stop the service and move
the broken identity directory aside; never delete it or copy individual key files:

```sh
systemctl --user stop chatmux.service
QUARANTINE="$HOME/.chatmux/data/installation-identity.lost.$(date +%Y%m%dT%H%M%S)"
mv "$HOME/.chatmux/data/installation-identity" "$QUARANTINE"
systemctl --user start chatmux.service
chatmux fleet identity
```

The restart creates a new installation ID and key pair beside the database. Keep the
quarantine through incident review and backup retention. The existing database may
still contain revoked historical rows, but no old grant authorizes the new identity.
Generate a new token, enroll from the hub again, and compare the new public fingerprint
on both direct surfaces. Custom `DATABASE_PATH` deployments keep
`installation-identity` beside that database rather than at the managed path above.

See [REMOTE-ACCESS.md §8](REMOTE-ACCESS.md#8-multi-pc-fleet-one-hub-and-full-peers)
for the complete enrollment and recovery contract.

Remote desktop, remote IDE/file/Git/project mutation, cloud sync, arbitrary command
RPC, remote plain-shell creation, general-purpose VPN/SSH management, automatic
failover, and zero-configuration reachability are outside fleet scope. The
dedicated enrollment tunnel is governed by Fleet RFC revision 4.

## Manual recovery cutover

Use this terminal procedure only after a bootstrap/recovery decision or a durable
`manual_required`/`failed_rollback` job. Ordinary compatible release updates use
the owner-only mobile action; do not turn this into a parallel routine deployment
path. A recovery cutover changes only the `current` symlink and then restarts the
service. Download and checksum-verify the approved artifact exactly as described
in [INSTALL.md](INSTALL.md); do not use a moving `latest` URL.

1. Record the active release before touching `current`.
2. Unpack the verified artifact into its new
   `~/.chatmux/releases/<version>` directory.
3. Confirm that the expected server entry point is present.
4. Atomically replace `current`, restart the service, and check both systemd
   state and the health endpoint.
5. Keep the prior release directory until the new release is accepted.

```sh
RUNTIME="$HOME/.chatmux"
VERSION=<approved-version>
RELEASE_DIR="$RUNTIME/releases/$VERSION"
PREVIOUS="$(readlink -f "$RUNTIME/current")"

test -f "$RELEASE_DIR/dist-server/server/index.js"
printf '%s\n' "$PREVIOUS" > "$RUNTIME/previous-release"
ln -s "$RELEASE_DIR" "$RUNTIME/current.next"
mv -Tf "$RUNTIME/current.next" "$RUNTIME/current"

systemctl --user restart chatmux.service
systemctl --user --no-pager --full status chatmux.service
curl --fail http://127.0.0.1:3001/health
```

If the service or health check fails, perform the rollback immediately rather
than troubleshooting against a partially accepted release.

## Rollback

`previous-release` contains the release path captured by the cutover commands.
Validate it is an installed release before atomically restoring it.

```sh
RUNTIME="$HOME/.chatmux"
PREVIOUS="$(<"$RUNTIME/previous-release")"

case "$PREVIOUS" in
  "$RUNTIME"/releases/*) ;;
  *) printf '%s\n' "Refusing an unsafe rollback target: $PREVIOUS" >&2; exit 1 ;;
esac
test -f "$PREVIOUS/dist-server/server/index.js"

ln -s "$PREVIOUS" "$RUNTIME/current.rollback"
mv -Tf "$RUNTIME/current.rollback" "$RUNTIME/current"
systemctl --user restart chatmux.service
systemctl --user --no-pager --full status chatmux.service
curl --fail http://127.0.0.1:3001/health
```

Record the failed version and the rollback result in the deployment record.
Do not remove either release until the rollback health check succeeds.

## Removal boundary

To remove the service and release payload while preserving user data:

```sh
systemctl --user disable --now chatmux.service
rm -f "$HOME/.config/systemd/user/chatmux.service"
systemctl --user daemon-reload
rm -rf "$HOME/.chatmux/releases"
rm -f "$HOME/.chatmux/current" "$HOME/.chatmux/previous-release"
```

This intentionally leaves `~/.chatmux/data` and
`~/.local/share/chatmux` untouched. Back up or remove either path only
through an explicit, separately reviewed data-retention decision.

## Control refusal diagnostics

ChatMux logs a fixed set of counters when it refuses a tmux control request.
They exist to answer "is the deck refusing my input, and why" without
recording anything about the target.

| Code | Emitted when |
|---|---|
| `attach_refused_identity` | A terminal attach was rejected because the pane identity, process generation or attach capability did not verify |
| `attach_refused_protected` | A terminal attach targeted a protected session (a `company*` name or the pane hosting ChatMux itself) |
| `relay_key_sent` | An interrupt or escape key was delivered to a verified pane |
| `relay_key_refused_lineage` | A key was refused because the target did not prove agent lineage |
| `relay_key_refused_generation` | A key was refused because the pane or process generation had changed |

Each line carries only the code, the provider lane and an occurrence count, and
each code is emitted at most once per minute per lane. Pane coordinates, socket
paths, tmux session names and transcript contents are deliberately excluded, so
these counters stay safe to paste into a bug report.

Read them from the service journal:

```sh
journalctl --user -u chatmux -o cat | grep -E 'attach_refused_|relay_key_'
```

A burst of `*_refused_generation` after restarting an agent is expected: the
pane was reused and ChatMux is refusing to send input to the replacement. A
persistent `relay_key_refused_lineage` means the row is not an agent ChatMux can
prove it owns, so it stays read-only.

## Source and upstream boundaries

The checkout at `~/.local/share/chatmux` is for source review and deliberate
maintenance work. It is never the service working directory and is never
updated as part of a release cutover. Follow [UPSTREAM.md](UPSTREAM.md) for
manual, selective upstream intake; automated mirroring or synchronization is
not permitted.
