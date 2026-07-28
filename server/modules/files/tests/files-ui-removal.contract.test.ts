import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('FileTree and FilesPanel stay absent', () => {
  assert.equal(existsSync(new URL('../../../../src/components/file-tree', import.meta.url)), false);
  assert.equal(
    existsSync(new URL('../../../../src/components/main-content/view/subcomponents/FilesPanel.tsx', import.meta.url)),
    false,
  );
});

test('file mutation routes and client helpers stay absent', () => {
  const routes = read('../files.routes.js');
  const api = read('../../../../src/utils/api.js');

  assert.doesNotMatch(routes, /\/files\/(?:create|rename|upload)/);
  assert.doesNotMatch(routes, /router\.delete\('\/api\/projects\/:projectId\/files'/);
  assert.doesNotMatch(api, /createFile:|renameFile:|deleteFile:|uploadFiles:/);
});

test('file read, blob, save, and containment routes remain', () => {
  const routes = read('../files.routes.js');
  const api = read('../../../../src/utils/api.js');

  assert.match(routes, /\/api\/projects\/:projectId\/files/);
  assert.match(routes, /\/api\/projects\/:projectId\/files\/content/);
  assert.match(routes, /\/api\/projects\/:projectId\/file/);
  assert.match(api, /getFiles:/);
  assert.match(api, /readFileBlob:/);
  assert.match(api, /saveFile:/);
});
