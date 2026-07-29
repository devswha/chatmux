import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('external agent and shared API-key gates stay removed', () => {
  const serverIndex = read('server/index.js');
  const authMiddleware = read('server/middleware/auth.js');
  const settingsRoutes = read('server/routes/settings.js');

  assert.doesNotMatch(serverIndex, /routes\/agent|\/api\/agent|validateApiKey/);
  assert.doesNotMatch(authMiddleware, /process\.env\.API_KEY|validateApiKey/);
  assert.doesNotMatch(settingsRoutes, /api-keys|\/credentials|apiKeysDb|credentialsDb/);
});

test('external agent credentials and documentation stay absent', () => {
  for (const path of [
    'server/routes/agent.js',
    'server/modules/database/repositories/api-keys.ts',
    'server/modules/database/repositories/credentials.ts',
    'server/modules/database/repositories/github-tokens.ts',
    'src/components/settings/hooks/useCredentialsSettings.ts',
    'src/components/settings/view/tabs/api-settings',
    'public/api-docs.html',
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }

  const schema = read('server/modules/database/schema.ts');
  const packageManifest = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    files?: string[];
  };
  assert.doesNotMatch(schema, /api_keys|user_credentials/);
  assert.equal(packageManifest.dependencies?.['@octokit/rest'], undefined);
  assert.equal(packageManifest.files?.includes('public/api-docs.html'), false);
});
