import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { providerRegistry } from '../provider.registry.js';
import { providerCapabilitiesService } from '../services/provider-capabilities.service.js';

test('provider README ids match the registered providers', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.match(/Current provider ids accepted by the registry and `parseProvider` are:\n([\s\S]*?)\n\nThose ids/);
  assert.ok(section, 'README provider-id section is present');

  const documented = [...section[1].matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]).sort();
  const registered = providerRegistry.listProviders().map((provider) => provider.id).sort();
  assert.deepEqual(documented, registered);
});

test('GJC and OMP capability flags remain behavior-neutral', () => {
  const gjc = providerCapabilitiesService.getProviderCapabilities('gjc');
  const omp = providerCapabilitiesService.getProviderCapabilities('omp');

  assert.deepEqual(
    {
      supportsImages: gjc.supportsImages,
      supportsAbort: gjc.supportsAbort,
      supportsPermissionRequests: gjc.supportsPermissionRequests,
      supportsTokenUsage: gjc.supportsTokenUsage,
      supportsEffort: gjc.supportsEffort,
    },
    {
      supportsImages: false,
      supportsAbort: true,
      supportsPermissionRequests: true,
      supportsTokenUsage: true,
      supportsEffort: false,
    },
  );
  assert.deepEqual(
    {
      supportsImages: omp.supportsImages,
      supportsAbort: omp.supportsAbort,
      supportsPermissionRequests: omp.supportsPermissionRequests,
      supportsTokenUsage: omp.supportsTokenUsage,
      supportsEffort: omp.supportsEffort,
    },
    {
      supportsImages: false,
      supportsAbort: false,
      supportsPermissionRequests: false,
      supportsTokenUsage: false,
      supportsEffort: false,
    },
  );
});
