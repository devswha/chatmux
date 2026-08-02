import assert from 'node:assert/strict';
import test from 'node:test';

import { HerdrTargetRegistry } from '../herdr-target-registry.service.js';
import type { HerdrResolvedTerminal, HerdrTargetId } from '../herdr-internal.types.js';

const sourceId = 'hsrc_jtP2rWhblZ6tcCJRjhr3bA' as const;
function terminal(targetClass: 'local-agent' | 'attach-only'): HerdrResolvedTerminal {
  return {
    source: { sourceId, alias: 'alpha', binary: '/opt/herdr/herdr', selector: 'work', canonicalSocketPath: '/run/user/1000/herdr.sock', socketStat: { uid: 1000, mode: 0o140600, device: 1, inode: 2 }, serverIncarnation: '1:2:10:100', probeFingerprint: 'fingerprint', internalGeneration: 1, transport: 'herdr terminal session control' },
    hierarchy: { workspaceId: 'workspace-1', tabId: 'tab-1', paneId: 'pane-1' }, terminalId: 'terminal-1', terminalIncarnation: 'incarnation-1', terminalRevision: 1,
    agent: targetClass === 'local-agent' ? { agentId: 'agent-1', agentKind: 'claude' } : null,
    process: targetClass === 'local-agent' ? { pid: 42, startedAtMs: 100, foregroundProcessGroupId: 42, executableName: 'claude' } : null,
    targetClass,
  };
}

test('target registry emits opaque, redacted public identities and rejects incomplete local agents', () => {
  const registry = new HerdrTargetRegistry();
  const local = registry.mint(terminal('local-agent'), 1);
  assert.ok(local && local.runtime === 'herdr');
  assert.equal(local.targetClass, 'local-agent');
  assert.match(local.targetId, /^htgt_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(Object.keys(local).sort(), ['process', 'runtime', 'sourceId', 'targetClass', 'targetId']);
  assert.equal(JSON.stringify(local).includes('pane-1'), false);
  const incomplete = terminal('local-agent');
  incomplete.process = null;
  assert.equal(registry.mint(incomplete, 1), null);
});

test('attach-only targets require explicit generic admission and never expose internal hierarchy', () => {
  const registry = new HerdrTargetRegistry();
  assert.equal(registry.mint(terminal('attach-only'), 1), null);
  const target = registry.mint(terminal('attach-only'), 1, 'admission-capability-1234');
  assert.ok(target && target.runtime === 'herdr' && target.targetClass === 'attach-only');
  assert.deepEqual({ runtime: target.runtime, sourceId: target.sourceId, targetClass: target.targetClass, admissionCapability: target.admissionCapability }, {
    runtime: 'herdr', sourceId, targetClass: 'attach-only', admissionCapability: 'admission-capability-1234',
  });
  assert.equal(JSON.stringify(target).includes('workspace-1'), false);
});

test('attach-only freshness ignores foreground replacement but local-agent freshness does not', () => {
  const registry = new HerdrTargetRegistry();
  const attach = terminal('attach-only');
  attach.process = { pid: 41, startedAtMs: 100, foregroundProcessGroupId: 41, executableName: 'bash' };
  const publicAttach = registry.mint(attach, 1, 'admission-capability-1234');
  assert.ok(publicAttach?.runtime === 'herdr');

  const replacedAttach = terminal('attach-only');
  replacedAttach.process = { pid: 42, startedAtMs: 200, foregroundProcessGroupId: 42, executableName: 'vim' };
  assert.ok(registry.resolve(sourceId, publicAttach.targetId as HerdrTargetId, replacedAttach, 1));

  const local = terminal('local-agent');
  const publicLocal = registry.mint(local, 1);
  assert.ok(publicLocal?.runtime === 'herdr');
  const replacedLocal = terminal('local-agent');
  replacedLocal.process = { ...replacedLocal.process!, pid: 43, startedAtMs: 300 };
  assert.equal(registry.resolve(sourceId, publicLocal.targetId as HerdrTargetId, replacedLocal, 1), null);
});
