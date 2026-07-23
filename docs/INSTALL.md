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
5. installs and starts the loopback-only `chatmux.service`;
6. uses Tailscale when it is already running, otherwise stays local-only;
7. verifies the running ChatMux version through `/health`.

No root-owned ChatMux service or package-registry install is used.

## Requirements

- Linux x86_64 with glibc 2.35 or newer
- user-level systemd
- tmux
- `curl`, `tar`, and `sha256sum`
- Tailscale installed and logged in only when private remote access is wanted

If Node.js `22.22.2+` on the 22.x line is not available, the bootstrap downloads
the official Node.js `22.22.2` Linux binary, verifies it against the official
`SHASUMS256.txt`, and installs it below `~/.chatmux/runtime`. It does not modify
the system Node.js installation.

## Choose the access mode

The default command automatically enables Tailscale only when it is already
running and logged in. To choose explicitly:

```sh
# Keep ChatMux on this computer only
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh \
  | bash -s -- --local

# Enable private Tailscale HTTPS access
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh \
  | bash -s -- --tailscale --owner user@example.com
```

Optional backend and Tailscale Serve ports can be passed through the same
command:

```sh
curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh \
  | bash -s -- --port 3010 --https-port 8451
```

The backend always remains on `127.0.0.1`. Tailscale mode reuses an existing
ChatMux root front or selects a free HTTPS port from `8443` through `8499`. It
does not enable Funnel or reset unrelated Serve configuration.

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

If Tailscale is installed later:

```sh
tailscale up
chatmux access enable tailscale
```

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

```sh
systemctl --user --no-pager --full status chatmux.service
journalctl --user -u chatmux.service
curl --fail http://127.0.0.1:3001/health
```

Do not delete `~/.chatmux/data` while recovering. See
[SELF-HOST.md](SELF-HOST.md) for release cutover, rollback, backup, and removal.