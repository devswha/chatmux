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
| `~/.chatmux/data` | Installer-configured database (`auth.db`), installation identity, and fleet SSH keys. Custom database paths may place these elsewhere. |
| `~/.chatmux/assets` | Uploaded image assets; separate from the database directory. |
| `~/.chatmux/update` | Durable release-update jobs, progress, and completion ordering. |
| `~/.chatmux/chatmux.env` | Managed service configuration, including `DATABASE_PATH`. |
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
Easy SSH setup may also run the canonical installer for an explicitly requested
first installation of a missing peer (see the fleet section below).
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
  app. Its default bind is `0.0.0.0` (all IPv4 interfaces). Sessions renew on use (sliding window, 1–365 days): active devices never
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
**Easy SSH setup** action. Easy setup requires a reachable SSH account and uses
`127.0.0.1:3001`. The owner may explicitly enable **Install ChatMux if missing**
(off by default) for a new Linux x86_64 installation of the hub's exact published
version. Existing or broken installations require manual recovery; this is not a
fleet update path. A timeout may leave a partial installation that the owner must
inspect. Enrollment cleanup never uninstalls ChatMux or removes its data.
Easy setup installs a dedicated key,
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
5. Follow the [backup and recovery runbook](#owner-managed-backup-and-recovery) on
   each PC independently, including any custom database location and the separate
   assets and update directories. Fleet enrollment does not back up or synchronize
   peer data.

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

## Owner-managed backup and recovery

ChatMux does not automatically back up or restore its database. This runbook uses
owner-operated filesystem copies while ChatMux writers are stopped; it does not
change the updater's rollback contract. Repeat it independently on the hub and
each peer before a migration or recovery cutover.

### Record the recovery set

Run `chatmux status` and inspect the installed service configuration locally before
stopping it. Record the exact release version, `current` target, configured port,
access mode, database path, and public installation ID/fingerprint. Keep this
inventory private with the backup; do not paste environment files, database rows,
keys, or unredacted service journals into issues or release assets.

| Include | Location and reason |
|---|---|
| SQLite database and existing sidecars | The effective `DATABASE_PATH`, including any `-wal`, `-shm`, and `-journal` files. The installer uses `~/.chatmux/data/auth.db`; the unconfigured source runtime defaults to `~/.chatmux/auth.db`. This includes configuration/auth secrets, revocations, push keys/subscriptions, fleet grants, and migration history as well as indexes. |
| Complete installation identity and SSH state | `installation-identity/` and, when present, `fleet-ssh/` beside the configured database. Keep the installation ID and key pair together, plus the dedicated SSH keys and `known_hosts`. |
| Uploaded assets | `~/.chatmux/assets`, which does not move with `DATABASE_PATH`. Include other explicitly configured external data locations or symlink targets in the owner's inventory. |
| Configuration and deployment evidence | `~/.chatmux/chatmux.env`, the installed `chatmux.service` and its drop-ins, any additional environment files referenced by the unit, and the management CLI at `~/.local/bin/chatmux`. Preserve exact release metadata/checksums and the current/prior release selections. |
| Updater records and service journals | The complete `~/.chatmux/update` directory, plus relevant user-systemd journal exports. For a retained source deployment, also preserve its deployment records, environment file, and `~/.chatmux/self-update.log` if present. These are private recovery evidence, not instructions to replay. |

ChatMux's SQLite database is not a backup of running processes, project files, or
provider-native session stores. Protect those separately using the provider's and
owner's existing procedures. Do not stop tmux or agent processes to snapshot
ChatMux; a ChatMux restore does not recreate or rewind their work.

### Quiesce and copy

1. Arrange a maintenance window with other owners. Stop new browser mutations,
   updates, installer runs, access/fleet CLI changes, and other scheduled writers
   against this installation. Let an active update finish before taking a routine
   backup. Check detached units as well as the app:

   ```sh
   systemctl --user list-units --all --type=service \
     'chatmux-release-update-*' 'chatmux-self-update-*'
   ```

   A detached worker can restart `chatmux.service`; stopping the app alone is
   insufficient. If an update is stuck, inspect its exact unit and durable phase
   first. Stop only that identified worker if incident recovery requires it, then
   retain its records and both releases. Never kill unrelated user units, tmux, or
   agents, or remove an updater lock to force progress.
2. Stop this app and verify it is inactive. Confirm again that no detached worker,
   manual installer, source deployment process, or other process can write these
   paths or restart the app. If that cannot be established, do not copy yet.

   ```sh
   systemctl --user stop chatmux.service
   systemctl --user is-active chatmux.service
   ```

   `inactive` with a nonzero exit status is expected. Keep writers stopped through
   the copy. Do not delete or separate SQLite journals from their database, even
   after a crash; recovery may need them.
3. As the installation owner, create a private snapshot outside the managed root.
   The example copies the entire managed root, including existing release/runtime
   files; allow enough disk space. Use a real, owner-owned backup directory with
   mode `0700`, not a symlink, and a filesystem that preserves Unix permissions.

   ```sh
   set -eu
   umask 077
   CHATMUX_BACKUP_PARENT="$HOME/chatmux-backups"
   test ! -L "$CHATMUX_BACKUP_PARENT" || exit 1
   mkdir -p "$CHATMUX_BACKUP_PARENT"
   test "$(stat -c %u "$CHATMUX_BACKUP_PARENT")" = "$(id -u)" || exit 1
   chmod 700 "$CHATMUX_BACKUP_PARENT"
   CHATMUX_BACKUP="$(mktemp -d "$CHATMUX_BACKUP_PARENT/snapshot.XXXXXX")"
   tar -cf "$CHATMUX_BACKUP/chatmux.tar" -C "$HOME" .chatmux
   tar -cf "$CHATMUX_BACKUP/cli.tar" -C "$HOME/.local/bin" chatmux
   cp -p "$HOME/.config/systemd/user/chatmux.service" "$CHATMUX_BACKUP/chatmux.service"
   journalctl --user -u chatmux.service --no-pager > "$CHATMUX_BACKUP/chatmux-service.log"
   chmod 600 "$CHATMUX_BACKUP"/*
   ```

   Stop on any copy/export error. This archive does not follow symlinks or include
   external paths. **Before resuming**, add the configured database and its
   sidecars, identity/SSH directories if outside `~/.chatmux`, unit drop-ins,
   external environment/data files, and the relevant exact updater-unit journal
   export. Keep all copies within this same stopped-writer interval. For a
   dedicated custom database directory, for example:

   ```sh
   tar -cf "$CHATMUX_BACKUP/custom-data.tar" -C /absolute/dedicated-db-directory .
   ```

   If that directory is shared with other applications, archive only the
   inventoried database family and ChatMux identity/SSH directories. Do not
   blindly archive or restore the whole shared parent.
4. Save the inventory with the snapshot and hash all its files after the last
   export. Do not change the snapshot after creating this manifest:

   ```sh
   (cd "$CHATMUX_BACKUP" && sha256sum -- * > SHA256SUMS)
   chmod 600 "$CHATMUX_BACKUP/SHA256SUMS"
   ```

   Keep an encrypted copy on separate owner-controlled storage and test recovery
   before relying on it. A hash detects accidental changes; it does not make an
   untrusted backup safe. Once the copy is complete, a routine backup can end by
   starting only `chatmux.service` and checking its configured health endpoint.
   During incident recovery, keep it stopped until the steps below are complete.

### Restore a snapshot

1. Quiesce the same writers. Fence the old installation before restoring its
   identity onto a replacement host: **never run two live copies of the same
   installation ID/key pair**. Keep a restored host isolated from browser and
   fleet traffic until configuration and revocations are reviewed. Use the direct
   local owner terminal; do not reroute pending hub actions to another peer.
2. Verify `SHA256SUMS`, then extract into a new owner-only staging directory,
   preserving modes. Do not unpack over the live root. Inspect the inventory and
   symlinks; restore only known, owner-controlled files. Make a disposable copy of
   the staged database **with its sidecars** for SQLite verification. With Python
   3 available, the following checks that copy without starting ChatMux; replace
   the argument with its actual staged path:

   ```sh
   python3 - /absolute/disposable-copy/auth.db <<'PY'
   import pathlib
   import sqlite3
   import sys

   database = pathlib.Path(sys.argv[1]).resolve()
   # mode=rw refuses a missing DB but permits journal recovery on this copy.
   with sqlite3.connect(database.as_uri() + "?mode=rw", uri=True) as connection:
       if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
           raise SystemExit("SQLite integrity check failed")
       if connection.execute("PRAGMA foreign_key_check").fetchall():
           raise SystemExit("SQLite foreign-key check failed")
   print("SQLite recovery checks passed")
   PY
   ```

   Stop if verification fails. Check the recorded release/schema migration history
   and representative data/assets too; SQLite integrity alone does not prove
   application compatibility. Do not open the original backup to repair it.
3. Preserve the failed installation's data, configuration, and current updater
   journal in a private quarantine. Restore the matching database family,
   complete identity/SSH directories, assets, and reviewed configuration from one
   snapshot. Replace dedicated data directories as a set; never overlay an older
   `auth.db` onto newer `-wal`/`-shm`/`-journal` files or mix individual identity keys.
   For a shared custom database parent, replace only the inventoried ChatMux
   files. Keep the configured paths consistent with the restored configuration.
   Restore the reviewed service unit/drop-ins and management CLI at their recorded
   paths, preserving the CLI's executable bit and checking its target release.
   The managed root and identity directories must be owner-owned `0700`; identity
   files, database/sidecars, keys, and private environment files must be `0600`.
4. Select the verified release recorded with that snapshot, or a release with
   explicit compatibility evidence. Confirm its entry point and metadata before
   the manual cutover below. Retain the live updater's incident records; do not
   overwrite them with an older snapshot to clear an active/failed job. After total
   storage loss, preserve recovered updater records for inspection and allow the
   existing inactive-worker reconciliation to report recovery needs. Do not edit
   job phases, clear locks, launch saved worker commands, or replay update jobs.
5. Before reconnecting, review grants, allowed accounts, and password revocations
   made since the snapshot: restoring SQLite can roll those changes back. Reapply
   known revocations through the existing owner CLI (`chatmux fleet revoke`,
   `chatmux access revoke`); in password mode use `chatmux access password` to
   invalidate restored browser sessions. Run these commands with the effective
   restored `DATABASE_PATH` explicitly set (for example,
   `DATABASE_PATH=/absolute/restored/auth.db chatmux fleet revoke <installation-id>`);
   a service-only environment override is not inherited by a terminal CLI. Use the
   CLI/runtime from the selected compatible release. Do not reuse saved pairing codes. If
   trust changes cannot be reconciled, revoke the old identity on counterparts
   and follow [installation-key replacement](#installation-key-replacement).
6. Run `systemctl --user daemon-reload` after restoring the unit/drop-ins, then
   start `chatmux.service`, verify its exact health version, compare the public
   installation ID/fingerprint, and inspect the direct UI. Check known sessions
   and assets by reading them; tmux/provider state remains authoritative. Reconnect
   peers and wait for a fresh snapshot and **Online** before new input. Never replay
   queued sends, approvals, terminations, or uncertain mutations from before the
   outage. Reopen the session so exact pane, process generation, provider binding,
   and live prompt checks run again at the next action boundary. Keep the failed
   data and backup until recovery is accepted.

## Manual recovery cutover

Use this terminal procedure only after a bootstrap/recovery decision or a durable
`manual_required`/`failed_rollback` job. Ordinary compatible release updates use
the owner-only mobile action; do not turn this into a parallel routine deployment
path. A recovery cutover changes only the `current` symlink and then restarts the
service. First quiesce the application and updater writers and preserve a complete
[recovery snapshot](#owner-managed-backup-and-recovery). Check the target's exact
database rollback declaration before starting it: a newer release may migrate the
database on first boot. Download and checksum-verify the approved artifact exactly as described
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

If the service or health check fails, stop the failed service and inspect the
recorded version and update phase. Use the rollback below only when its database
compatibility precondition holds; otherwise keep it stopped and recover the
matching pre-upgrade data snapshot and release together.

## Rollback

`previous-release` contains the release path captured by the cutover commands.
Validate it is an installed release before atomically restoring it. **Do not run
the commands below against a database that the prior release cannot read.** The
release that migrated the database must explicitly list the exact prior version
in `database.rollbackCompatibleFrom` in its verified `release-update-metadata.json`,
with the release CI compatibility proof. A matching schema number or an existing
release directory alone is not that proof. If the declaration is missing or the
database's migration history is uncertain, use the [data recovery procedure](#restore-a-snapshot)
with its matching release instead. Quiesce all application/updater writers before
either path; do not race a detached rollback worker.

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
