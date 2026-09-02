import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, relative, sep, delimiter, dirname } from 'node:path';
import { realpath, stat, access } from 'node:fs/promises';

import { CURSOR_CLI_COMMAND_CANDIDATES } from '@/modules/providers/list/cursor/cursor-cli-command.js';

import type { TmuxPaneIdentity } from '../../../../../shared/tmux.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';
import { resolveTmuxSpawnLaunch } from '../tmux-spawn-scope.service.js';

import type { ExternalCliSession, ExternalLocalCliKind, ExternalPane, ProcessTreeEntry } from './contracts-and-resume.js';
import type { ExternalProviderSessionInference } from './provider-runtime-inference.js';
import { applyInferredProviderSessionIds, inferClaudeSessionIds, inferIndexedProviderSessionIds, inferOpenPiSessionIds } from './provider-runtime-inference.js';
import { inferFreshCodexThreadIds, inferOpenCodexThreadIds } from './codex-runtime-inference.js';
import { runCommand } from './process-classification.js';


export async function inferExternalProviderSessionIds(args: {
  sessions: ExternalCliSession[];
  attemptableSessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<ExternalProviderSessionInference> {
  const safeSessions = args.sessions.filter((session) => !session.connectionIssue);
  const attemptableTargetKeys = new Set(
    args.attemptableSessions.map((session) => tmuxPaneIdentityKey(session.tmux)),
  );

  const [observedCodex, inferredClaude, inferredOmp, freshCodex] = await Promise.all([
    inferOpenCodexThreadIds({
      sessions: safeSessions,
      panes: args.panes,
      procs: args.procs,
    }),
    inferClaudeSessionIds({
      sessions: safeSessions,
      panes: args.panes,
      procs: args.procs,
    }),
    inferOpenPiSessionIds(safeSessions),
    args.attemptableSessions.some((session) => session.kind === 'codex')
      ? inferFreshCodexThreadIds({
        sessions: args.attemptableSessions,
        panes: args.panes,
        procs: args.procs,
      })
      : Promise.resolve(new Map<string, string>()),
  ]);
  const inferredFreshCodex = new Map(
    [...freshCodex].filter(([targetKey]) => attemptableTargetKeys.has(targetKey)),
  );
  const authoritativeTargetKeys = new Set([
    ...observedCodex.keys(),
    ...inferredClaude.keys(),
    ...inferredOmp.keys(),
  ]);
  const directIds = new Map([
    ...inferredFreshCodex,
    ...inferredClaude,
    ...inferredOmp,
    ...observedCodex,
  ]);
  const withDirectIds = applyInferredProviderSessionIds(
    safeSessions,
    directIds,
    authoritativeTargetKeys,
  );
  const inferredIndexed = args.attemptableSessions.some((session) => (
    session.kind === 'cursor' || session.kind === 'opencode' || session.kind === 'omp' || session.kind === 'omo'
  ))
    ? await inferIndexedProviderSessionIds(withDirectIds, attemptableTargetKeys)
    : new Map<string, string>();
  return {
    ids: new Map([...directIds, ...inferredIndexed]),
    authoritativeTargetKeys,
  };
}

export function normalizeExternalPaneOutput(output: string, maxChars = 32_768): string {
  const plain = output
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '')
    .trimEnd();
  return plain.length > maxChars ? plain.slice(-maxChars) : plain;
}

/** Resolves a web spawn cwd and rejects traversal/symlink escape outside HOME. */
export async function resolveExternalCliCwd(input: string): Promise<string | null> {
  const home = await realpath(homedir()).catch(() => null);
  if (!home || input.includes('\0')) return null;
  const trimmed = input.trim();
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/')
      ? join(homedir(), trimmed.slice(2))
      : isAbsolute(trimmed)
        ? trimmed
        : join(homedir(), trimmed);
  try {
    const resolved = await realpath(expanded);
    const rel = relative(home, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export type ExternalSpawnCli = ExternalLocalCliKind;

export const EXTERNAL_CLI_COMMANDS: Record<ExternalSpawnCli, readonly string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: CURSOR_CLI_COMMAND_CANDIDATES,
  opencode: ['opencode'],
  omp: ['omp'],
  omo: ['omo'],
};

export type ExternalCliExecutableResolverOptions = {
  path?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => Promise<boolean>;
};

export function withoutNodeModulesBins(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !(dirname(entry).endsWith(`${sep}node_modules`) && entry.endsWith(`${sep}.bin`)))
    .join(delimiter);
}

export function buildExternalCliRuntimePath(
  pathValue = process.env.PATH ?? '',
  home = homedir(),
  nodeExecutable = process.execPath,
  executable?: string,
): string {
  const preferred = [
    executable ? dirname(executable) : null,
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin'),
    dirname(nodeExecutable),
  ].filter((entry): entry is string => Boolean(entry));
  const inherited = withoutNodeModulesBins(pathValue).split(delimiter).filter(Boolean);
  return [...new Set([...preferred, ...inherited])].join(delimiter);
}

/** Resolves user-installed agents without letting ChatMux's npm scripts shadow them. */
export async function resolveExternalCliExecutable(
  cli: ExternalSpawnCli,
  options: ExternalCliExecutableResolverOptions = {},
): Promise<string> {
  const commands = EXTERNAL_CLI_COMMANDS[cli];
  const platform = options.platform ?? process.platform;
  const searchPath = options.path === undefined
    ? buildExternalCliRuntimePath()
    : withoutNodeModulesBins(options.path);
  const extensions = platform === 'win32'
    ? (options.pathExt ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const isExecutable = options.isExecutable ?? (async (candidate: string) => {
    try {
      await access(candidate, fsConstants.X_OK);
      return (await stat(candidate)).isFile();
    } catch {
      return false;
    }
  });

  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const command of commands) {
      for (const extension of extensions) {
        const candidate = join(directory, `${command}${extension}`);
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  return commands[0];
}

export function buildExternalCliTmuxSpawnArgs(
  executable: string,
  tmuxName: string,
  cwd: string,
  runtimePath = buildExternalCliRuntimePath(process.env.PATH ?? '', homedir(), process.execPath, executable),
): string[] {
  // Codex and OMP terminate during detached startup without an initial grid.
  // The explicit PATH also preserves user-installed Node/Bun launchers when
  // ChatMux itself runs under systemd's intentionally minimal environment.
  return [
    'new-session', '-d',
    '-x', '120', '-y', '40',
    '-e', `PATH=${runtimePath}`,
    '-s', tmuxName,
    '-c', cwd,
    '/usr/bin/env', `PATH=${runtimePath}`, executable,
  ];
}

/**
 * Boots and tags a native CLI in a fresh detached tmux session. Session
 * creation may fork the tmux server, so under systemd it runs in a transient
 * scope instead of chatmux.service's cgroup (see tmux-spawn-scope.service).
 */
export async function spawnExternalCliSession(
  cli: ExternalSpawnCli,
  tmuxName: string,
  cwd: string,
  deps: { launch?: typeof resolveTmuxSpawnLaunch; run?: typeof runCommand } = {},
): Promise<void> {
  const run = deps.run ?? runCommand;
  const executable = await resolveExternalCliExecutable(cli);
  const launch = await (deps.launch ?? resolveTmuxSpawnLaunch)();
  await run(launch.command, [...launch.prefixArgs, ...buildExternalCliTmuxSpawnArgs(executable, tmuxName, cwd)]);
  try {
    await run('tmux', ['set-option', '-t', tmuxName, '@chatmux_cli_kind', cli]);
  } catch (error) {
    await run('tmux', ['kill-session', '-t', `=${tmuxName}`]).catch(() => undefined);
    throw error;
  }
}

export type CurrentTmuxPaneIdentity =
  | Readonly<{ state: 'hosted'; tmux: TmuxPaneIdentity }>
  | Readonly<{ state: 'not-hosted' }>
  | Readonly<{ state: 'unavailable' }>;
