import { isIP } from 'node:net';

export type SshTarget = Readonly<{
  user: string;
  host: string;
  destination: string;
  sshTarget: string;
  sshPort?: number;
}>;

export class InvalidSshTargetError extends Error {
  readonly name = 'InvalidSshTargetError';
  constructor() { super('SSH target must be user@host or user@host:port'); }
}

const USER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const PORT = /^[0-9]{1,5}$/;

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!PORT.test(value)) throw new InvalidSshTargetError();
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new InvalidSshTargetError();
  return port;
}

export function parseSshTarget(value: string): SshTarget {
  if (value.length === 0 || value.length > 320 || value.trim() !== value || /[\0-\x20\x7f;&|`$<>\\'"(){}]/.test(value)) {
    throw new InvalidSshTargetError();
  }
  const separator = value.indexOf('@');
  if (separator < 1 || separator !== value.lastIndexOf('@')) throw new InvalidSshTargetError();
  const user = value.slice(0, separator);
  const address = value.slice(separator + 1);
  if (!USER.test(user)) throw new InvalidSshTargetError();

  let host: string;
  let portText: string | undefined;
  let hostForDestination: string;
  if (address.startsWith('[')) {
    const match = /^\[([0-9A-Fa-f:]+)\](?::([0-9]+))?$/.exec(address);
    if (match === null || match[1] === undefined || isIP(match[1]) !== 6) throw new InvalidSshTargetError();
    host = match[1]; portText = match[2]; hostForDestination = `[${host}]`;
  } else {
    if ((address.match(/:/g) ?? []).length > 1) throw new InvalidSshTargetError();
    const separatorIndex = address.lastIndexOf(':');
    const hasPort = separatorIndex > 0;
    host = hasPort ? address.slice(0, separatorIndex) : address;
    portText = hasPort ? address.slice(separatorIndex + 1) : undefined;
    if (isIP(host) !== 4 && !HOSTNAME.test(host)) throw new InvalidSshTargetError();
    hostForDestination = host;
  }
  const sshPort = parsePort(portText);
  return {
    user,
    host,
    destination: `${user}@${hostForDestination}`,
    sshTarget: `${user}@${hostForDestination}${sshPort === undefined ? '' : `:${sshPort}`}`,
    ...(sshPort === undefined ? {} : { sshPort }),
  };
}
