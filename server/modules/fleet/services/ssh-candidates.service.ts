import { userInfo } from 'node:os';

import {
  FLEET_SSH_CANDIDATE_LIMIT, FLEET_SSH_HOST_NAME, FLEET_SSH_USER_NAME, FLEET_SSH_OS_HINTS,
  isTailnetIpv4, type FleetSshCandidate, type FleetSshCandidatesPayload,
} from '../../../../shared/fleet-ssh.js';
import { runTailscale, type CommandRunner } from '../../../tailscale-access.js';

export type SshCandidate = FleetSshCandidate;
export type SshCandidatesPayload = FleetSshCandidatesPayload;

function peerFrom(value: unknown): SshCandidate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const hostName = Reflect.get(value, 'HostName');
  const os = Reflect.get(value, 'OS');
  const ips = Reflect.get(value, 'TailscaleIPs');
  const address = Array.isArray(ips) ? ips.find(isTailnetIpv4) : undefined;
  if (typeof hostName !== 'string' || hostName.trim() !== hostName || !FLEET_SSH_HOST_NAME.test(hostName) || address === undefined) return undefined;
  const osName = FLEET_SSH_OS_HINTS.find((hint) => typeof os === 'string' && hint.toLowerCase() === os.toLowerCase()) ?? 'unknown';
  return { hostName, address, os: osName, online: Reflect.get(value, 'Online') === true, supported: osName === 'linux' };
}

function peersFrom(statusJson: string): Record<string, unknown> | undefined {
  if (statusJson.length > 256 * 1024) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(statusJson); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null || Reflect.get(parsed, 'BackendState') !== 'Running') return undefined;
  const peers = Reflect.get(parsed, 'Peer');
  return typeof peers === 'object' && peers !== null && !Array.isArray(peers) ? peers : undefined;
}

/** Suggestions only: no SSH probe, setup, or authority is inferred from the tailnet. */
export function parseSshCandidates(statusJson: string): readonly SshCandidate[] {
  const peers = peersFrom(statusJson);
  if (peers === undefined) return [];
  const rank = (candidate: SshCandidate): number => (candidate.supported ? 0 : 2) + (candidate.online ? 0 : 1);
  const sorted = Object.values(peers).map(peerFrom).filter((peer): peer is SshCandidate => peer !== undefined)
    .sort((a, b) => rank(a) - rank(b) || a.hostName.localeCompare(b.hostName) || a.address.localeCompare(b.address));
  const seen = new Set<string>();
  return sorted.filter(({ address }) => { if (seen.has(address)) return false; seen.add(address); return true; }).slice(0, FLEET_SSH_CANDIDATE_LIMIT);
}

export async function listSshCandidates(run: CommandRunner = runTailscale, user: () => string = () => userInfo().username): Promise<SshCandidatesPayload> {
  let defaultUser = '';
  try { const name = user(); if (typeof name === 'string' && name.trim() === name && FLEET_SSH_USER_NAME.test(name)) defaultUser = name; } catch { /* Manual username entry remains available. */ }
  let statusJson: string;
  try { statusJson = await run(['status', '--json']); }
  catch { return { available: false, defaultUser, candidates: [] }; }
  return { available: peersFrom(statusJson) !== undefined, defaultUser, candidates: parseSshCandidates(statusJson) };
}
