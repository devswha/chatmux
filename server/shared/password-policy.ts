/**
 * Minimum length for the owner password. The account grants a shell on the
 * host, so the floor is a passphrase length, not a form-field length. Shared
 * by the registration route and the `chatmux access password` command so the
 * two cannot drift.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function isAcceptablePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH;
}
