/** Hub-local, owner-only SSH setup contracts; these are not fleet wire descriptors. */
export const FLEET_SSH_ENROLLMENT_ERROR_CODES = [
  'INVALID_SSH_TARGET', 'MALFORMED_REQUEST', 'SSH_PASSWORD_REQUIRED', 'SSH_AUTH_FAILED',
  'SSH_UNREACHABLE', 'HOSTKEY_REJECTED', 'REMOTE_PLATFORM_UNSUPPORTED', 'REMOTE_CLI_MISSING',
  'REMOTE_INSTALL_FAILED', 'REMOTE_CLI_FAILED', 'TOKEN_PARSE_FAILED', 'ENROLL_FAILED',
  'PEER_LIMIT_REACHED', 'TUNNEL_FAILED',
] as const;
export type FleetSshEnrollmentErrorCode = (typeof FLEET_SSH_ENROLLMENT_ERROR_CODES)[number];
export type FleetSshEnrollmentInput = Readonly<{
  sshTarget: string; password?: string; label?: string; installCli?: boolean;
}>;
export type FleetSshEnrollmentResult = Readonly<{ peerId: string; port: number }>;
export type FleetSshEnrollmentErrorDetails = Readonly<{ os?: string; arch?: string }>;
export type FleetSshCandidate = Readonly<{
  hostName: string; address: string; os: string; online: boolean;
  /** OS hint only. Architecture and SSH reachability remain unverified. */
  supported: boolean;
}>;
export type FleetSshCandidatesPayload = Readonly<{
  available: boolean; defaultUser: string; candidates: readonly FleetSshCandidate[];
}>;
export const FLEET_SSH_CANDIDATE_LIMIT = 128;
export const FLEET_SSH_HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const FLEET_SSH_USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FLEET_SSH_OS_HINTS = ['linux', 'macOS', 'windows', 'iOS', 'android', 'freebsd', 'openbsd', 'unknown'] as const;

export function isTailnetIpv4(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || !/^100\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  return parts[1] >= 64 && parts[1] <= 127 && parts[2] <= 255 && parts[3] <= 255;
}

export function parseFleetSshCandidate(value: unknown): FleetSshCandidate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const hostName = Reflect.get(value, 'hostName'); const address = Reflect.get(value, 'address');
  const os = Reflect.get(value, 'os'); const online = Reflect.get(value, 'online'); const supported = Reflect.get(value, 'supported');
  if (typeof hostName !== 'string' || hostName.trim() !== hostName || !FLEET_SSH_HOST_NAME.test(hostName) || !isTailnetIpv4(address)
    || !FLEET_SSH_OS_HINTS.some((hint) => hint === os) || typeof online !== 'boolean' || supported !== (os === 'linux')) return undefined;
  return { hostName, address, os, online, supported };
}

/** Never forward arbitrary remote diagnostic strings as platform details. */
export function fleetSshErrorDetails(value: unknown): FleetSshEnrollmentErrorDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: { os?: string; arch?: string } = {};
  const os = Reflect.get(value, 'os'); const arch = Reflect.get(value, 'arch');
  if (typeof os === 'string') result.os = ['Linux', 'Darwin', 'FreeBSD', 'OpenBSD', 'NetBSD', 'Windows_NT'].includes(os) ? os : 'unknown';
  if (typeof arch === 'string') result.arch = ['x86_64', 'aarch64', 'arm64', 'armv7l', 'i386', 'i686', 'riscv64', 'ppc64le'].includes(arch) ? arch : 'unknown';
  return result;
}
