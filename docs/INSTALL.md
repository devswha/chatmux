# Install ChatMux

## Quick install

Run one command on a Linux x86_64 server:

```sh
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash
```

The bootstrap:

1. checks the operating system and architecture;
2. installs a private Node.js 22 runtime when the host does not have a
   compatible version;
3. downloads the latest GitHub Release archive and its SHA-256 checksum;
4. verifies the archive before extracting it below `~/.chatmux/releases`;
5. installs and starts `chatmux.service` with password login on every
   interface, creating the owner account and printing its one-time password;
6. verifies the running ChatMux version through `/health`.

Installation always produces the same result: a password-protected service
any browser on your network can sign in to — no access-mode flags, no
interactive prompts, nothing to install on the phone. No root-owned ChatMux
service or package-registry install is used.

A successful run ends with a block like this:

```text
ChatMux installation complete
  Local:  http://127.0.0.1:3001
  Phone:  http://192.168.0.7:3001 — sign in from any browser, no app needed
  Login:  owner / dQw4w9WgXcQtQzNb
          (shown only this once — change it with: chatmux access password)
  Access: password — sessions renew on use; alternatives: chatmux access enable tailscale | enable vpn <address>
  Manage: chatmux status | chatmux access password | journalctl --user -u chatmux.service
```

When `qrencode` is installed the `Phone` address is also printed as a
terminal QR code — scan it, sign in once with the printed password, and the
session then renews itself on every visit. Reinstalling keeps the existing
account, and a previous Tailscale/VPN mode is replaced by the password
default with a note showing the exact restore command.

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

The only install option is the backend port:

```sh
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh \
  | bash -s -- --port 3010
```

Without `--port`, the installer uses the first free loopback port from `3001`
through `3100`. Passing `--port` requests that exact port and fails if another
application owns it.

## Change the access mode (optional)

Password access is on from the moment the install finishes. Everything below
is optional tuning, and can be changed or re-run at any time:

```sh
# Rotate (or recover) the owner password; signs out every session
chatmux access password
chatmux access password my-chosen-secret

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
notifications need HTTPS anyway.

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

The quick command follows GitHub's `latest` release redirect and trusts the
attached `install.sh` over HTTPS. The downloaded ChatMux and Node.js payloads
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