# Install ChatMux

## Manual bootstrap and recovery

The supported first installation target is Linux x86_64. Run this command from a
server terminal or SSH session only for the first bootstrap, manual recovery, or
the first updater-capable release. It is not the ordinary mobile update UX:

```sh
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash
```

After bootstrap, the trusted owner uses **`서버 업데이트`** in the mobile app for
compatible updates. **`새 화면 적용`** is separate: it only refreshes a stale PWA
screen and never deploys the server.

The root `install.sh` is a separate published GitHub Release asset. It downloads
the canonical Linux x64/Node 22 archive
`chatmux-server-<version>-linux-x64-node22.tar.gz` and the artifact with the same
basename plus `.sha256`, verifies the archive, then starts the per-user service.
It does not use a package registry, container image, or source checkout as a
release payload. A release updater also never downloads or executes `install.sh`.

The bootstrap installs a private Node.js 22 runtime when needed, extracts verified
releases below `~/.chatmux/releases`, and verifies the running service’s exact
version through `/health`. It selects Tailscale Serve when Tailscale is running
and logged in; otherwise it creates the password-protected LAN fallback and
one-time owner password. No root-owned ChatMux service is used.

On a Tailscale-backed install, the phone’s Tailscale account must be the owner or
be explicitly allowed for ordinary access. Turn Tailscale on before scanning the
QR and keep it connected while using ChatMux. Non-owner allowed users can use the
app but cannot run `서버 업데이트`; the owner alone can do so.

For the mobile flow from finding the PC link through browser use, Android/iOS PWA
installation, notifications, and troubleshooting, see the [mobile usage guide](mobile_eng.md)
or its [Korean translation](mobile_kr.md).

## Requirements

- Linux x86_64 with glibc 2.35 or newer
- user-level systemd
- tmux
- `curl`, `tar`, and `sha256sum`
- Tailscale (logged in) or a WireGuard-style VPN interface only when private
  remote access is wanted

If Node.js `22.22.2+` on the 22.x line is not available, the bootstrap downloads
the official Node.js `22.22.2` Linux binary, verifies it against the official
`SHASUMS256.txt`, and installs it below `~/.chatmux/runtime`. It does not modify
the system Node.js installation.

The terminal bootstrap also accepts only the backend-port option for manual
bootstrap or recovery:

```sh
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh \
  | bash -s -- --port 3010
```

Without `--port`, the installer uses the first free loopback port from `3001`
through `3100`. Passing `--port` requests that exact port and fails if another
application owns it.

## Change the access mode (optional)

Installation selects Tailscale when it is ready and otherwise selects password
access. Either mode can be changed or re-run at any time:

```sh
# Rotate (or recover) the owner password; signs out every session
chatmux access password                                  # generates and prints a new one
printf '%s' 'my-chosen-passphrase' | chatmux access password --stdin   # never on the command line

# Rebind or tune password mode: restrict to one address, extend the session
chatmux access enable password 127.0.0.1
chatmux access enable password --session-days 90

# Switch to private Tailscale HTTPS access (identity allowlist, loopback bind)
chatmux access enable tailscale

# Or bind to an existing WireGuard-style VPN interface (no app login)
chatmux access enable vpn 10.0.0.1
```

Password sessions renew on every visit (a sliding window of 1–365 days,
default 7), so a device that keeps using ChatMux never sees the login screen
again, while an idle or lost device expires after the window; logout and
password rotation revoke immediately. The same Wi-Fi works out of the box;
to reach the server from anywhere, forward the backend TCP port on the
router and put a TLS proxy in front first (see the
[Nginx template](nginx-subpath-template.conf)) — credentials must never
cross the public internet as plain HTTP, and PWA install plus push
notifications need HTTPS anyway. If you own a domain and cannot port
forward (CGNAT), a named tunnel — or a reverse proxy on a public VPS —
in front of password mode is the no-app alternative; see
[REMOTE-ACCESS.md §4.3](REMOTE-ACCESS.md#43-사용자가-가진-것에-따른-경로).

Tailscale mode reuses an existing ChatMux root front or selects a free HTTPS
port from `8443` through `8499`. It does not enable Funnel or reset unrelated
Serve configuration.

VPN mode binds the backend to the given tunnel address and disables the
application login entirely (`CHATMUX_AUTH=none` with
`CHATMUX_ALLOW_UNAUTH_REMOTE=1`): every device inside the VPN gets full
access, with no session expiry or re-authentication. It therefore only
accepts a private IPv4 address (10/8, 100.64/10, 172.16/12, 192.168/16) that
is already present on a local interface — bring the tunnel up first, for
example with `wg-quick up wg0`. Never forward this port outside the tunnel.
Switching back with `chatmux access enable tailscale` restores the loopback
bind and identity checks.

Switching between the three modes at any time is safe: each `enable` command
rewrites the managed environment and bind address atomically and restarts
the service.

### Setting up WireGuard from scratch

If no VPN exists yet, this minimal WireGuard setup is enough for VPN mode.
It needs root once, and one UDP port forwarded on the router.

```sh
# On the server
sudo apt install wireguard qrencode
wg genkey | sudo tee /etc/wireguard/server.key | wg pubkey | sudo tee /etc/wireguard/server.pub
wg genkey | tee phone.key | wg pubkey > phone.pub

sudo tee /etc/wireguard/wg0.conf > /dev/null <<EOF
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = $(sudo cat /etc/wireguard/server.key)

[Peer]
PublicKey = $(cat phone.pub)
AllowedIPs = 10.0.0.2/32
EOF

sudo systemctl enable --now wg-quick@wg0
```

Create the phone profile and show it as a QR code for the official
WireGuard app (replace `<public-ip-or-ddns>` with the router's address and
forward UDP `51820` to this server):

```sh
cat > phone.conf <<EOF
[Interface]
Address = 10.0.0.2/32
PrivateKey = $(cat phone.key)

[Peer]
PublicKey = $(sudo cat /etc/wireguard/server.pub)
Endpoint = <public-ip-or-ddns>:51820
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = 25
EOF
qrencode -t ANSIUTF8 < phone.conf
```

Then bind ChatMux to the tunnel:

```sh
chatmux access enable vpn 10.0.0.1
```

Delete `phone.key`, `phone.pub`, and `phone.conf` after the phone has
scanned the QR code; the private key must not stay on disk.

If the router cannot forward a port (carrier-grade NAT is common on mobile
and some fiber ISPs), plain WireGuard cannot reach the server from outside —
use the Tailscale mode instead, which traverses NAT automatically.

## Pin and inspect the installer

The manual bootstrap command follows GitHub's `latest` release redirect and trusts
the attached `install.sh` over HTTPS. The downloaded ChatMux and Node.js payloads
are checksum-verified.

For a fully reviewable installation, pin and inspect one release:

```sh
VERSION=<approved-version-without-v>

curl -fsSLo /tmp/chatmux-install.sh \
  "https://github.com/devswha/chatmux/releases/download/v$VERSION/install.sh"
less /tmp/chatmux-install.sh
CHATMUX_VERSION="$VERSION" bash /tmp/chatmux-install.sh
```

The bootstrap downloads only the matching immutable GitHub Release assets and
rejects a checksum mismatch or incomplete archive.

## After installation

Ensure `~/.local/bin` is on `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then use:

```sh
chatmux status
systemctl --user status chatmux.service
journalctl --user -u chatmux.service -f

chatmux access users
chatmux access allow family@example.com
chatmux access revoke family@example.com
chatmux access owner new-owner@example.com
```

An allowlisted login is not a guest: it receives the owner's identity for almost every route, including the terminal, so it is host shell access for that person. Allow only people you would hand an SSH key to.

Only the Tailscale owner or a local server operator can change the allowlist.
The owner cannot be revoked; transfer ownership explicitly with
`chatmux access owner <login>`.

If Tailscale or a VPN is set up later:

```sh
tailscale up
chatmux access enable tailscale

# or bind to an existing WireGuard interface instead
chatmux access enable vpn 10.0.0.1
```

Switching back to `enable tailscale` restores the loopback bind and re-enables
identity checks.

The Settings **Access** tab shows the private HTTPS address, current identity,
owner, and allowed accounts.

## Create a multi-PC fleet

Install ChatMux normally on every PC. A fleet is one browser-facing **hub** plus
as many as nine enrolled **full peer installations** (ten PCs total). A peer is
not an agent or satellite package: it keeps its own service, tmux sessions,
SQLite database, installation key, updater, and direct UI.

Only the owner can see **Settings → Hosts**, issue codes, enroll, reconnect,
revoke, or remove peers. On the PC that will become a peer, open its direct UI
and choose **Settings → Hosts → Generate pairing code**, or run locally:

```sh
chatmux fleet token
```

The code is single-use and expires after ten minutes. On the hub, open
**Settings → Hosts → Add a PC**, enter a label, the peer endpoint, and the code.
The default endpoint is the peer's Tailscale Serve address converted to WSS and
ending in `/fleet-ws`, for example:

```text
wss://peer-name.tailnet-name.ts.net:8443/fleet-ws
```

Use the actual HTTPS host and port printed by `chatmux status`; do not assume
`8443`. Both PCs must be able to reach that Tailscale Serve address. ChatMux
never downgrades WSS to plaintext and does not provide a relay.

If direct WSS is unavailable, the owner must first create this local forward on
the **hub PC** and keep that SSH process running:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8022:127.0.0.1:<peer-backend-port> user@peer
```

Select **SSH loopback forward** and enter exactly
`ws://127.0.0.1:8022/fleet-ws`. The only other accepted host spelling is
`ws://[::1]:<port>/fleet-ws` for an explicitly IPv6-bound local forward.
Non-loopback `ws://`, alternate loopback spellings, credentials, query strings,
and paths other than `/fleet-ws` are rejected. ChatMux does not create, store,
or restart the SSH forward.

After enrollment, **Online** is usable. **Syncing** means the hub is obtaining a
fresh peer snapshot and remote writes are suspended. **Offline** means the peer
is unreachable; use **Reconnect** after fixing its direct endpoint or SSH
forward. There is no failover or rerouting to another PC. The peer's own printed
ChatMux address remains the recovery surface.

See [REMOTE-ACCESS.md §8](REMOTE-ACCESS.md#8-multi-pc-fleet-one-hub-and-full-peers)
for revoke, key-loss, update, and scope boundaries.

## Owner update operation

`GET /api/system/update/status` exposes whether the current user can update and
the server-authoritative availability state. Only an owner can start the bodyless
`POST /api/system/update`; the server selects the source deployment or canonical
release itself. The opaque job ID is read at
`GET /api/system/update/jobs/:jobId`. Jobs persist their phases across restarts
and finish as `succeeded`, `failed`, `failed_rolled_back`, `failed_rollback`, or
`manual_required`.

For release installs, the unprivileged detached user-systemd worker verifies the
checksum, archive layout, embedded version, and staged health before atomic
`current`-link cutover. It then requires HTTP 200, the expected ChatMux
product/status health fields, a
changed boot ID, and the exact target version. The previous release remains
available. Automatic rollback is only for a target whose
`database.rollbackCompatibleFrom` explicitly names the exact prior version and
whose release CI proves rollback compatibility; ChatMux does not create or restore
database backups. `manual_required` means do not retry from the phone: inspect the
job and service logs and recover manually.

Before any manual bootstrap or recovery, ensure `~/.chatmux` is an owner-owned,
non-symlink directory with mode `0700`. A wrong owner, symlink, non-directory, or
replaced path is a hard stop; inspect and correct it as the intended server user,
rather than following the link or running the installer as another user.
## Managed paths

| Path | Purpose |
|---|---|
| `~/.chatmux/releases/<version>` | Immutable verified release payload |
| `~/.chatmux/current` | Release selected by `chatmux.service` |
| `~/.chatmux/runtime` | Private Node.js 22 runtime when needed |
| `~/.chatmux/data` | Persistent database, assets, and application data |
| `~/.chatmux/chatmux.env` | Managed service environment |
| `~/.local/bin/chatmux` | Management CLI |
| `~/.config/systemd/user/chatmux.service` | User-level service |

## Troubleshooting

Start with `chatmux status`; it reports the configured local and Tailscale
addresses. For service logs:

```sh
systemctl --user --no-pager --full status chatmux.service
journalctl --user -u chatmux.service
```

Do not delete `~/.chatmux/data` while recovering. See
[SELF-HOST.md](SELF-HOST.md) for release cutover, rollback, backup, and removal.
