import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GjcSdkBridge,
  extractGjcTokenBudget,
  getPendingGjcApprovalsForSession,
  resolveGjcToolApproval,
} from './gjc-sdk-bridge.js';
import type { GjcSdkFrame } from './gjc-sdk-client.js';

class FakeSdkClient {
  readonly replies: Array<{ id: string; answer: unknown }> = [];
  readonly controls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  readonly queries: string[] = [];
  readonly #listeners = new Set<(frame: GjcSdkFrame) => void>();
  contextResponse: unknown = { items: [{ usage: { tokens: 120, contextWindow: 1_000, source: 'provider_anchor' } }] };
  usageResponse: unknown = { items: [{ input: 80, output: 20, cacheRead: 15, cacheWrite: 5, cost: 0.01 }] };
  closed = false;

  onFrame(listener: (frame: GjcSdkFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async control(operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
    this.controls.push({ operation, input });
    return { accepted: true };
  }

  async query(query: string): Promise<unknown> {
    this.queries.push(query);
    return query === 'context.get' ? this.contextResponse : this.usageResponse;
  }

  reply(id: string, answer: unknown): void {
    this.replies.push({ id, answer });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(frame: GjcSdkFrame): void {
    for (const listener of this.#listeners) listener(frame);
  }
}

type Outbound = Record<string, unknown>;

function createWriter(): { messages: Outbound[]; send(value: unknown): void } {
  const messages: Outbound[] = [];
  return {
    messages,
    send(value: unknown) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      messages.push(value as Outbound);
    },
  };
}

test('GjcSdkBridge presents SDK asks through the existing question panel and resolves replies', async () => {
  const client = new FakeSdkClient();
  const writer = createWriter();
  const bridge = new GjcSdkBridge(client, 'session-one', writer);

  client.emit({
    type: 'action_needed',
    id: 'action-1',
    kind: 'ask',
    question: 'Choose a target',
    options: ['Alpha', 'Beta'],
  });

  const request = writer.messages.at(-1);
  assert.equal(request?.kind, 'permission_request');
  assert.equal(request?.toolName, 'AskUserQuestion');
  assert.equal(request?.sessionId, 'session-one');
  assert.deepEqual(request?.input, {
    questions: [{
      question: 'Choose a target',
      header: 'GJC',
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
      multiSelect: false,
    }],
  });

  const requestId = request?.requestId;
  assert.equal(typeof requestId, 'string');
  assert.equal(getPendingGjcApprovalsForSession('session-one').length, 1);
  assert.equal(resolveGjcToolApproval(requestId as string, {
    allow: true,
    updatedInput: { answers: { 'Choose a target': 'Beta' } },
  }), true);
  assert.deepEqual(client.replies, [{ id: 'action-1', answer: 'Beta' }]);

  client.emit({ type: 'action_resolved', id: 'action-1', resolvedBy: 'client' });
  assert.equal(writer.messages.at(-1)?.kind, 'permission_cancelled');
  assert.equal(getPendingGjcApprovalsForSession('session-one').length, 0);
  await bridge.close();
});

test('GjcSdkBridge deduplicates replayed asks and re-presents rejected replies', async () => {
  const client = new FakeSdkClient();
  const writer = createWriter();
  const bridge = new GjcSdkBridge(client, 'session-replay', writer);
  const action: GjcSdkFrame = {
    type: 'action_needed',
    id: 'action-replay',
    kind: 'ask',
    question: 'Proceed?',
    options: ['Yes', 'No'],
  };

  client.emit(action);
  const firstRequestId = writer.messages.at(-1)?.requestId;
  client.emit(action);
  assert.equal(writer.messages.at(-1)?.requestId, firstRequestId);
  assert.equal(getPendingGjcApprovalsForSession('session-replay').length, 1);

  assert.equal(resolveGjcToolApproval(firstRequestId as string, {
    allow: false,
    updatedInput: { answers: { 'Proceed?': 'Yes' } },
  }), true);
  assert.deepEqual(client.replies.at(-1), { id: 'action-replay', answer: 'No' });
  client.emit({
    type: 'reply_rejected',
    id: 'action-replay',
    reason: 'already_answered',
  });
  assert.equal(writer.messages.at(-1)?.kind, 'permission_request');
  assert.deepEqual(writer.messages.at(-1)?.context, {
    source: 'gjc-sdk',
    replyRejected: 'already_answered',
  });
  await bridge.close();
});

test('GjcSdkBridge uses SDK abort and emits normalized token-budget status', async () => {
  const client = new FakeSdkClient();
  const writer = createWriter();
  const bridge = new GjcSdkBridge(client, 'session-usage', writer);

  assert.equal(await bridge.abort(), true);
  assert.deepEqual(client.controls, [{ operation: 'turn.abort', input: {} }]);
  await bridge.emitTokenBudget();
  assert.deepEqual(client.queries, ['context.get', 'usage.get']);

  const status = writer.messages.at(-1);
  assert.equal(status?.kind, 'status');
  assert.equal(status?.text, 'token_budget');
  assert.deepEqual(status?.tokenBudget, {
    used: 120,
    total: 1_000,
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 15,
    cacheCreationTokens: 5,
    cacheTokens: 20,
    breakdown: { input: 80, output: 20 },
    cost: 0.01,
    source: 'provider_anchor',
  });
  await bridge.close();
  assert.equal(client.closed, true);
});

test('extractGjcTokenBudget returns null without observed usage', () => {
  assert.equal(extractGjcTokenBudget({ items: [{}] }, { items: [{}] }), null);
});

test('closing a bridge cancels and removes its pending asks', async () => {
  const client = new FakeSdkClient();
  const writer = createWriter();
  const bridge = new GjcSdkBridge(client, 'session-close', writer);
  client.emit({
    type: 'action_needed',
    id: 'action-close',
    kind: 'ask',
    question: 'Wait?',
    options: [],
  });

  await bridge.close();
  assert.equal(writer.messages.at(-1)?.kind, 'permission_cancelled');
  assert.equal(getPendingGjcApprovalsForSession('session-close').length, 0);
  assert.equal(client.closed, true);
});

test('transport closure cancels pending asks without waiting for process cleanup', () => {
  const client = new FakeSdkClient();
  const writer = createWriter();
  new GjcSdkBridge(client, 'session-transport-close', writer);
  client.emit({
    type: 'action_needed',
    id: 'action-transport-close',
    kind: 'ask',
    question: 'Still there?',
    options: ['Yes', 'No'],
  });

  client.emit({ type: 'transport_closed', reason: 'connection' });

  assert.equal(writer.messages.at(-1)?.kind, 'permission_cancelled');
  assert.equal(getPendingGjcApprovalsForSession('session-transport-close').length, 0);
});

test('throwing writers cannot block bridge cleanup or client close', async () => {
  const client = new FakeSdkClient();
  const bridge = new GjcSdkBridge(client, 'session-writer-throws', {
    send() {
      throw new Error('socket closed');
    },
  });
  client.emit({
    type: 'action_needed',
    id: 'action-writer-throws',
    kind: 'ask',
    question: 'Proceed?',
    options: [],
  });

  await bridge.close();

  assert.equal(client.closed, true);
  assert.equal(getPendingGjcApprovalsForSession('session-writer-throws').length, 0);
});
