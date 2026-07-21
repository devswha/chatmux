// Fail-closed self-host exposure policy.
//
// This web UI can run shell commands as the server user, so an unauthenticated,
// network-reachable instance is remote code execution for anyone who can reach
// the port. Policy (self-host-first distribution, 2026-07-10; auth mode 'none'
// added for the v1 no-login MVP):
//   - loopback bind              → ok (a local user already owns the machine)
//   - auth mode 'none', non-loopback bind
//                                → BLOCK startup: there is no login at all, so
//                                  the port is shell access. Explicit
//                                  CHATMUX_ALLOW_UNAUTH_REMOTE=1 (trusted private
//                                  network such as a tailnet) downgrades this
//                                  to a loud warning.
//   - non-loopback bind, no user → BLOCK startup: the first-run /register
//                                  endpoint could be claimed by anyone on the
//                                  network. Explicit ALLOW_REMOTE_SETUP=1
//                                  downgrades this to a loud warning.
//   - non-loopback bind, user OK → allow, but print an exposure warning
//                                  (auth is enforced; tunnel/VPN still safer).
import { isLoopbackHost, isWildcardHost } from '../../shared/networkHosts.js';

/**
 * Decide whether the server may listen on `host`.
 *
 * Pure function — no process/env/db access — so the policy is unit-testable.
 *
 * @param {object} input
 * @param {string} input.host bind address (e.g. '127.0.0.1', '0.0.0.0')
 * @param {boolean} input.hasUsers at least one account exists in the auth DB
 * @param {boolean} [input.allowRemoteSetup] explicit ALLOW_REMOTE_SETUP=1 opt-in
 * @param {'none'|'password'} [input.authMode] resolved CHATMUX_AUTH mode
 * @param {boolean} [input.allowUnauthRemote] explicit CHATMUX_ALLOW_UNAUTH_REMOTE=1 opt-in
 * @returns {{level: 'ok'|'warn'|'block', reason: string, message?: string}}
 */
export function evaluateExposure({
    host,
    hasUsers,
    allowRemoteSetup = false,
    authMode = 'password',
    allowUnauthRemote = false,
}) {
    const scope = isWildcardHost(host)
        ? 'ALL network interfaces'
        : `network address ${host}`;

    if (isLoopbackHost(host)) {
        return { level: 'ok', reason: 'loopback' };
    }

    if (authMode === 'none') {
        if (!allowUnauthRemote) {
            return {
                level: 'block',
                reason: 'unauthenticated-remote',
                message:
                    `Refusing to listen on ${scope}: CHATMUX_AUTH=none disables login entirely, so ` +
                    'anyone who can reach this port can run commands as this user.\n' +
                    'Fix: keep the default loopback bind (leave HOST unset), or enable ' +
                    'authentication with CHATMUX_AUTH=password.\n' +
                    'Override for a trusted private network (VPN/tailnet) only: ' +
                    'CHATMUX_ALLOW_UNAUTH_REMOTE=1.',
            };
        }
        return {
            level: 'warn',
            reason: 'unauthenticated-remote-override',
            message:
                `CHATMUX_ALLOW_UNAUTH_REMOTE=1 — listening on ${scope} with NO authentication. ` +
                'Anyone who can reach this port can run commands as this user; make sure the ' +
                'address is only reachable through your private network.',
        };
    }

    if (!hasUsers) {
        if (!allowRemoteSetup) {
            return {
                level: 'block',
                reason: 'unconfigured-remote',
                message:
                    `Refusing to listen on ${scope}: no account exists yet, so anyone who can ` +
                    'reach this port could register the first account and gain shell access.\n' +
                    'Fix: start with the default loopback bind (leave HOST unset), create your ' +
                    'account at http://localhost:<port>, then restart with your desired HOST.\n' +
                    'Override for a trusted network only: ALLOW_REMOTE_SETUP=1.',
            };
        }
        return {
            level: 'warn',
            reason: 'remote-setup-override',
            message:
                `ALLOW_REMOTE_SETUP=1 — listening on ${scope} with NO account configured. ` +
                'Create the first account immediately: until then, anyone who can reach this ' +
                'port can register and gain shell access.',
        };
    }

    return {
        level: 'warn',
        reason: 'network-exposed',
        message:
            `Listening on ${scope}. Authentication is enforced, but this UI can run shell ` +
            'commands on this machine — prefer a VPN (e.g. tailscale serve) or an SSH tunnel ' +
            'over exposing the port directly.',
    };
}
