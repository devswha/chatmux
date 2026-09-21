export const FULL_ACCESS_DISABLE_ENV = 'CHATMUX_DISABLE_FULL_ACCESS';

/** A deployment-wide, server-authoritative kill switch for dangerous startup. */
export function isFullAccessSpawnDisabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[FULL_ACCESS_DISABLE_ENV] === '1';
}
