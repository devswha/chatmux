import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPOSITORY_URL } from '../../../../shared/productIdentity.js';
import { findAppRoot, getModuleDir } from '../../../utils/runtime-paths.js';

const INSTALL_PRESENT = 'command -v chatmux >/dev/null 2>&1 || [ -e "$HOME/.chatmux" ] || [ -L "$HOME/.chatmux" ]'
  + ' || [ -e "$HOME/.local/bin/chatmux" ] || [ -L "$HOME/.local/bin/chatmux" ]';
export const SSH_CLI_MISSING_MARKER = 'chatmux-fleet-cli-missing';
export const SSH_MINT_TOKEN_COMMAND = 'if command -v chatmux >/dev/null 2>&1; then chatmux fleet token;'
  + ' elif [ -x "$HOME/.local/bin/chatmux" ]; then "$HOME/.local/bin/chatmux" fleet token;'
  + ' elif [ -x "$HOME/.chatmux/current/dist-server/server/cli.js" ]; then "$HOME/.chatmux/current/dist-server/server/cli.js" fleet token;'
  + ` elif ${INSTALL_PRESENT}; then exit 126;`
  + ` else printf '${SSH_CLI_MISSING_MARKER} %s %s\\n' "$(uname -s)" "$(uname -m)" >&2; exit 127; fi`;

export async function sshBootstrapVersion(): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(findAppRoot(getModuleDir(import.meta.url)), 'package.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) return undefined;
    const version = Reflect.get(manifest, 'version');
    return typeof version === 'string' ? version : undefined;
  } catch { return undefined; }
}

/** Fixed first-install operation; none of these arguments come from the browser. */
export function sshBootstrapCommand(version: string | undefined): string | undefined {
  if (version === undefined || version.trim() !== version || !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(version)) return undefined;
  return 'set -eu; umask 077; '
    + `installation_absent() { if ${INSTALL_PRESENT}; then return 1; fi; }; `
    + 'installation_absent || exit 70; '
    + '[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || exit 70; '
    + 'command -v curl >/dev/null 2>&1 || exit 70; tmp=$(mktemp) || exit 70; '
    + 'override_tmp=; trap \'rm -f -- "$tmp" "$override_tmp"\' EXIT; trap \'exit 70\' HUP INT TERM; '
    + `curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 ${REPOSITORY_URL}/releases/download/v${version}/install.sh -o "$tmp" || exit 70; `
    + 'installation_absent || exit 70; '
    + 'mkdir -m 700 "$HOME/.chatmux" || exit 70; '
    // Published peers default to direct-wss and bind that mode into the signed
    // challenge. Configure only a newly claimed installation, before its first
    // service start; keep the SSH-only listener off non-loopback interfaces.
    + 'override="$HOME/.config/systemd/user/chatmux.service.d/90-chatmux-fleet-ssh.conf"; '
    + 'mkdir -p "${override%/*}" || exit 70; '
    // Noclobber can follow a systemd mask into /dev/null. Publish a complete
    // regular inode exclusively; GNU ln -T rejects every existing entry,
    // including directories and symlinks, without following or replacing it.
    + 'override_tmp=$(mktemp "${override%/*}/.chatmux-fleet-ssh.XXXXXX") || exit 70; '
    + 'printf \'%s\\n\' \'[Service]\' \'Environment=HOST=127.0.0.1\' \'Environment=CHATMUX_FLEET_TRANSPORT_MODE=ssh-loopback\' > "$override_tmp" || exit 70; '
    + 'ln -T -- "$override_tmp" "$override" || exit 70; '
    + 'rm -f -- "$override_tmp" || exit 70; override_tmp=; '
    + 'unset CHATMUX_NODE CHATMUX_NODE_BASE_URL CHATMUX_RELEASE_BASE_URL; '
    + `CHATMUX_REPOSITORY=${REPOSITORY_URL} CHATMUX_VERSION=${version} CHATMUX_INSTALL_ROOT="$HOME/.chatmux" sh "$tmp" --port 3001`;
}
