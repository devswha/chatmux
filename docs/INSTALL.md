# Install the ChatMux server release

ChatMux is installed from a verified GitHub Release artifact. The only
supported artifact source is:

<https://github.com/devswha/chatmux/releases>

The first supported target is the Linux x86_64 server artifact for Node.js 22
and glibc 2.35 or newer. Do not use a package registry, container image,
desktop delivery, source build, or a mutable download URL for a production
installation.

## Paths and prerequisites

```sh
CHECKOUT="$HOME/.local/share/chatmux"
RUNTIME="$HOME/.chatmux"
REPOSITORY="https://github.com/devswha/chatmux"
RELEASES="https://github.com/devswha/chatmux/releases"

# Required platform contract:
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
getconf GNU_LIBC_VERSION    # requires glibc 2.35 or newer
node --version              # requires v22
```

`$CHECKOUT` is the canonical Git checkout for source review and selective
upstream intake. It is separate from release payloads and must not be created,
replaced, or deleted by a release deployment. Create it only when the source
review or [upstream intake](UPSTREAM.md) process needs it:

```sh
git clone "$REPOSITORY" "$CHECKOUT"
```

Release state belongs below `$RUNTIME`:

- `$RUNTIME/releases/<version>` holds one unpacked, immutable release.
- `$RUNTIME/current` is the symlink selected by `chatmux.service`.
- `$RUNTIME/data` holds persistent user data and must survive cutovers.

## Install a pinned release

Set `VERSION` to the reviewed release version without a leading `v`. The
commands fetch the archive and checksum from the same immutable release tag,
verify the checksum before extraction, then install the new version without
activating an unverified payload.

```sh
set -eu

VERSION=<approved-version>
TAG="v$VERSION"
ARTIFACT="chatmux-server-$VERSION-linux-x64-node22.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
RELEASE_DIR="$RUNTIME/releases/$VERSION"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p "$RUNTIME/releases" "$RUNTIME/data"
test ! -e "$RELEASE_DIR"

curl --fail --location --output "$TEMP_DIR/$ARTIFACT" \
  "$RELEASES/download/$TAG/$ARTIFACT"
curl --fail --location --output "$TEMP_DIR/$CHECKSUM" \
  "$RELEASES/download/$TAG/$CHECKSUM"
(
  cd "$TEMP_DIR"
  sha256sum --check "$CHECKSUM"
)

mkdir "$RELEASE_DIR"
tar --extract --gzip --file "$TEMP_DIR/$ARTIFACT" --directory "$RELEASE_DIR"
test -f "$RELEASE_DIR/dist-server/server/index.js"
```

Do not use a `latest` asset. A checksum mismatch, an existing version
directory, or a missing server entry point is a failed install; remove only the
newly created release directory after inspecting the failure.

## Install, secure, and start ChatMux

Run the installer from the verified release directory:

```sh
node "$RELEASE_DIR/scripts/chatmux-runtime.mjs" install
```

The installer performs the service setup that previously required manually
rendering the systemd unit:

- selects the verified release through `~/.chatmux/current`;
- writes the loopback-only user service and managed environment file;
- creates `~/.local/bin/chatmux`;
- initializes persistent data below `~/.chatmux/data`;
- enables and starts `chatmux.service`, then checks `/health`;
- detects Tailscale and offers private passwordless access.

When Tailscale is installed, running, and logged in, accept the remote-access
prompt. ChatMux registers the local node's Tailscale account as the owner,
enables the `tailscale` authentication mode, and creates one HTTPS Serve front.
It reuses an existing root front for ChatMux or selects a free port from
`8443`–`8499`; it never resets or replaces another Serve configuration.

The backend remains bound to `127.0.0.1`. Remote HTTP and WebSocket requests
are accepted only when they arrive through Tailscale Serve with an allowed
`Tailscale-User-Login` identity. Funnel is not enabled. Tagged devices and
unapproved tailnet users fail closed. Direct loopback access remains available
for recovery by an operator who can log in to the server.

For a non-interactive install:

```sh
node "$RELEASE_DIR/scripts/chatmux-runtime.mjs" install --yes

# Explicit choices:
node "$RELEASE_DIR/scripts/chatmux-runtime.mjs" install \
  --yes --tailscale --owner user@example.com
node "$RELEASE_DIR/scripts/chatmux-runtime.mjs" install --yes --local
```

`--yes` selects Tailscale when it is already running; otherwise it installs in
local-only mode. Use `--port` to change the backend port or `--https-port` to
request an unused Serve port.

After installation, ensure `~/.local/bin` is on `PATH`, then use:

```sh
chatmux status
chatmux access users
chatmux access allow family@example.com
chatmux access revoke family@example.com
chatmux access owner new-owner@example.com
journalctl --user -u chatmux.service -f
```

Only the owner (or a local server operator) can change the allowlist. The owner
cannot be revoked; replace it explicitly with `chatmux access owner <login>`.
The Settings **Access** tab shows the active private HTTPS address and provides
the same allow/revoke controls. The installer prints the address and, when
`qrencode` is installed, a terminal QR code containing only that private
tailnet URL—never a password or bearer token.

If Tailscale is installed later, log in with `tailscale up`, then run:

```sh
chatmux access enable tailscale
```

If installation or the health check fails, inspect:

```sh
systemctl --user --no-pager --full status chatmux.service
journalctl --user -u chatmux.service
curl --fail http://127.0.0.1:3001/health
```

Do not delete `~/.chatmux/data` while recovering. For release cutover and
rollback after the first install, use [SELF-HOST.md](SELF-HOST.md).