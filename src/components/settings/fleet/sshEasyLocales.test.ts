import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const languages = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'] as const;
const requiredKeys = [
  'title', 'description', 'target', 'targetPlaceholder', 'password', 'passwordHelp', 'keyDisclosure',
  'submit', 'success', 'stepConnect', 'stepKey', 'stepToken', 'stepEnroll',
  'errors.INVALID_SSH_TARGET', 'errors.SSH_PASSWORD_REQUIRED', 'errors.SSH_AUTH_FAILED',
  'errors.SSH_UNREACHABLE', 'errors.HOSTKEY_REJECTED', 'errors.REMOTE_CLI_FAILED',
  'errors.TOKEN_PARSE_FAILED', 'errors.ENROLL_FAILED', 'errors.PEER_LIMIT_REACHED', 'errors.TUNNEL_FAILED',
] as const;
const root = new URL('../../../../', import.meta.url);

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => (
    current !== null && typeof current === 'object'
      ? (current as Readonly<Record<string, unknown>>)[segment]
      : undefined
  ), value);
}

test('Given every supported locale, when SSH easy copy is loaded, then every consumed key is nonempty', () => {
  for (const language of languages) {
    const settings: unknown = JSON.parse(readFileSync(
      new URL(`src/i18n/locales/${language}/settings.json`, root),
      'utf8',
    ));
    for (const key of requiredKeys) {
      const value = readPath(settings, `fleet.sshEasy.${key}`);
      assert.equal(typeof value, 'string', `${language}: settings.fleet.sshEasy.${key}`);
      assert.notEqual(value, '', `${language}: settings.fleet.sshEasy.${key}`);
    }
  }
});
