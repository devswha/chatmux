/** Native CLIs that ChatMux can start in a local tmux session. */
export const EXTERNAL_SPAWN_CLIS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'omp',
  'omo',
] as const;

export type ExternalSpawnCli = typeof EXTERNAL_SPAWN_CLIS[number];

/**
 * CLIs whose interactive startup contract has a verified full-access mode.
 * Keep this list narrow: a non-interactive `run` flag is not sufficient.
 */
export const FULL_ACCESS_EXTERNAL_SPAWN_CLIS = ['claude', 'codex'] as const;

export type FullAccessExternalSpawnCli = typeof FULL_ACCESS_EXTERNAL_SPAWN_CLIS[number];

export function supportsExternalCliFullAccess(cli: string): cli is FullAccessExternalSpawnCli {
  return (FULL_ACCESS_EXTERNAL_SPAWN_CLIS as readonly string[]).includes(cli);
}
