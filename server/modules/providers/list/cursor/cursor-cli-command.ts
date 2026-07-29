import spawn from 'cross-spawn';

export const CURSOR_CLI_COMMAND_CANDIDATES = ['agent', 'cursor-agent'] as const;
export type CursorCliCommand = (typeof CURSOR_CLI_COMMAND_CANDIDATES)[number];

type CursorCliProbe = typeof spawn.sync;
type ProcessIdentity = Pick<{ comm: string; args?: string }, 'comm' | 'args'>;

const CURSOR_HELP_MARKER = /(?:Start the Cursor Agent|CURSOR_API_KEY|Cursor Agent CLI)/i;
const CURSOR_INSTALL_PATH_MARKER = /(?:^|[\\/])cursor-agent(?:[\\/]|$)/i;

const outputText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return '';
};

const successfulProbe = (result: ReturnType<CursorCliProbe>): boolean => (
  !result.error && result.status === 0
);

/**
 * Resolves the documented Cursor CLI command while retaining the legacy alias.
 * The generic `agent` name is accepted only when its help identifies Cursor.
 */
export function resolveCursorCliCommand(
  runProbe: CursorCliProbe = spawn.sync,
): CursorCliCommand | null {
  for (const command of CURSOR_CLI_COMMAND_CANDIDATES) {
    try {
      const version = runProbe(command, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (!successfulProbe(version)) continue;

      if (command === 'agent') {
        const help = runProbe(command, ['--help'], {
          encoding: 'utf8',
          timeout: 5000,
        });
        if (
          !successfulProbe(help)
          || !CURSOR_HELP_MARKER.test(`${outputText(help.stdout)}\n${outputText(help.stderr)}`)
        ) {
          continue;
        }
      }

      return command;
    } catch {
      // Probe the compatibility alias before reporting Cursor as unavailable.
    }
  }

  return null;
}

export function cursorCliCommandOrDefault(runProbe: CursorCliProbe = spawn.sync): CursorCliCommand {
  return resolveCursorCliCommand(runProbe) ?? CURSOR_CLI_COMMAND_CANDIDATES[0];
}

const executableToken = (args: string, command: string): boolean => new RegExp(
  `(?:^|\\s)(?:\\S*[\\\\/])?${command.replace('-', '\\-')}(?:\\.exe)?(?=\\s|$)`,
  'i',
).test(args);

/** Recognizes official and legacy Cursor CLI process shapes without treating every generic `agent` process as Cursor. */
export function isCursorCliProcess(proc: ProcessIdentity): boolean {
  const comm = proc.comm.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase() ?? '';
  const args = proc.args ?? '';

  if (comm === 'cursor-agent' || executableToken(args, 'cursor-agent')) return true;
  if (comm !== 'agent' && !executableToken(args, 'agent')) return false;

  return CURSOR_INSTALL_PATH_MARKER.test(args);
}
