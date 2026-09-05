import { open } from 'node:fs/promises';
import { posix } from 'node:path';

const MAX_CONFIG_BYTES = 8_192;
const MAX_RECORD_BYTES = 8_192;
const COMMAND_TOKEN = /^[A-Za-z0-9_./+-]+$/;
const ARGUMENT_TOKEN = /^[A-Za-z0-9_./:@=,%+-]+$/;
const WRAPPERS = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'fish', 'nu', 'csh', 'tcsh',
  'env', 'sudo', 'su', 'doas', 'nice', 'nohup', 'timeout', 'setsid',
  'tmux', 'screen', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'uv', 'uvx',
]);
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?|ruby|perl|php)$/;
const INTERACTIVE_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'nu']);
const BASH_STARTUP_OPTIONS = new Set(['--login', '--noprofile', '--norc']);

export type CustomTerminalAgentRule = Readonly<{ command: string; argv: readonly string[] }>;
export type CustomProcessRecordReader = (pid: number, record: 'stat' | 'cmdline') => Promise<string | null>;
export type CustomTerminalAgentDetectionOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readProcessRecord?: CustomProcessRecordReader;
}>;

function commandToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256 || !COMMAND_TOKEN.test(value)) return false;
  if (value.includes('/') && !value.startsWith('/')) return false;
  return (value.startsWith('/') ? value.slice(1) : value).split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Owner-local configuration. Invalid input disables only this optional detector. */
export function readCustomTerminalAgents(env: NodeJS.ProcessEnv = process.env): readonly CustomTerminalAgentRule[] {
  const raw = env.CHATMUX_CUSTOM_TERMINAL_AGENTS;
  if (!raw || raw.length > MAX_CONFIG_BYTES || Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 16) return [];
    const rules: CustomTerminalAgentRule[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      if (Object.keys(entry).sort().join(',') !== 'argv,command') return [];
      const { command, argv } = entry;
      if (!commandToken(command) || WRAPPERS.has(posix.basename(command))) return [];
      if (!Array.isArray(argv) || argv.length > 16 || !argv.every((token: unknown) => (
        typeof token === 'string' && token.length <= 256 && ARGUMENT_TOKEN.test(token)
      ))) return [];
      if (INTERPRETERS.test(posix.basename(command)) && !(commandToken(argv[0]) && argv[0].startsWith('/'))) return [];
      const key = JSON.stringify([command, argv]);
      if (seen.has(key)) return [];
      seen.add(key);
      rules.push(Object.freeze({ command, argv: Object.freeze([...argv]) }));
    }
    return Object.freeze(rules);
  } catch {
    return [];
  }
}

/** Linux comm may be truncated to 15 bytes; argv[0] must still match in full. */
export function couldMatchCustomCommand(comm: string, rules: readonly CustomTerminalAgentRule[]): boolean {
  const name = posix.basename(comm);
  return rules.some(({ command }) => name === posix.basename(command) || name === posix.basename(command).slice(0, 15));
}

export function matchesCustomTerminalAgent(argv: readonly string[], rules: readonly CustomTerminalAgentRule[]): boolean {
  if (!argv.length || !commandToken(argv[0])) return false;
  return rules.some((rule) => (
    (rule.command.startsWith('/') ? argv[0] === rule.command : posix.basename(argv[0]) === rule.command)
    && argv.length === rule.argv.length + 1
    && rule.argv.every((token, index) => token === argv[index + 1])
  ));
}

/** A bounded, exact option allowlist for live pane-shell argv; never unwrap commands. */
export function isCustomTerminalShellInvocation(comm: string, argv: readonly string[]): boolean {
  if (!INTERACTIVE_SHELLS.has(comm) || !argv.length || argv.length > 17) return false;
  const executable = argv[0].startsWith('-') ? argv[0].slice(1) : argv[0];
  if (!commandToken(executable) || posix.basename(executable) !== comm) return false;
  let sawShortOption = false;
  for (const option of argv.slice(1)) {
    if (option.length > 256) return false;
    if (comm === 'bash' && !sawShortOption && BASH_STARTUP_OPTIONS.has(option)) continue;
    // No operands or options that consume a command/script are supported, even
    // when -i is also present. Nu's short options are accepted separately.
    if (!(comm === 'nu' ? /^-[il]$/ : /^-[il]+$/).test(option)) return false;
    sawShortOption = true;
  }
  return true;
}

type CustomProcessIdentity = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  tty: number;
  foregroundPgid: number;
  startTicks: number;
}>;
export type CustomProcessEvidence = CustomProcessIdentity & Readonly<{ argv: readonly string[] }>;

function parseIdentity(value: string | null, pid: number): CustomProcessIdentity | null {
  if (!value || value.length > MAX_RECORD_BYTES || !value.endsWith('\n') || !value.startsWith(`${pid} (`)) return null;
  const close = value.lastIndexOf(')');
  if (close < 0) return null;
  const fields = value.slice(close + 1).trim().split(/\s+/);
  if (!['R', 'S', 'D', 'I'].includes(fields[0])) return null;
  const [ppid, pgid, sid, tty, foregroundPgid, startTicks] = [1, 2, 3, 4, 5, 19].map((index) => (
    /^\d+$/.test(fields[index] ?? '') ? Number(fields[index]) : NaN
  ));
  if (![ppid, pgid, sid, tty, foregroundPgid, startTicks].every((field) => Number.isSafeInteger(field) && field > 0)) return null;
  return { pid, ppid, pgid, sid, tty, foregroundPgid, startTicks };
}

async function readProcessRecord(pid: number, record: 'stat' | 'cmdline'): Promise<string | null> {
  // Exact snapshot PID only. Read one extra byte to reject truncated evidence.
  const file = await open(`/proc/${pid}/${record}`, 'r');
  try {
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length <= MAX_RECORD_BYTES ? new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) : null;
  } finally {
    await file.close();
  }
}

/** Reject PID reuse, reparenting and foreground changes around the exact argv read. */
export async function readCustomProcessEvidence(
  pid: number,
  read: CustomProcessRecordReader = readProcessRecord,
): Promise<CustomProcessEvidence | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const before = parseIdentity(await read(pid, 'stat'), pid);
    if (!before) return null;
    const commandLine = await read(pid, 'cmdline');
    if (!commandLine || commandLine.length > MAX_RECORD_BYTES || Buffer.byteLength(commandLine, 'utf8') > MAX_RECORD_BYTES || !commandLine.endsWith('\0')) return null;
    const argv = commandLine.slice(0, -1).split('\0');
    if (argv.length > 17 || argv.some((token) => !token || token.length > 256)) return null;
    const after = parseIdentity(await read(pid, 'stat'), pid);
    if (!after || JSON.stringify(before) !== JSON.stringify(after)) return null;
    return { ...after, argv };
  } catch {
    return null;
  }
}
