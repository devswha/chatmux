import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { abortGjcProcess, buildPromptArg, registerGjcProcessAlias } from './gjc-cli.js';

type TestGjcProcess = {
  aborted?: boolean;
  abortPending?: boolean;
  gjcAbortEscalationTimer?: NodeJS.Timeout;
  gjcAbortPromise?: Promise<boolean> | null;
  gjcSdkBridge?: { abort(): Promise<boolean> };
  kill(signal?: string): boolean;
};

test('buildPromptArg: every prompt is a private temp file reference', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gjc-args-test-'));
  try {
    const message = 'Reply with exactly one word: PONG';
    const result = buildPromptArg(message, dir);

    assert.ok(result.tempFile, 'tempFile must be set for every prompt');
    assert.equal(result.arg, `@${result.tempFile}`);
    assert.ok(result.tempFile.startsWith(dir), 'temp file lives in the given dir');
    assert.ok(existsSync(result.tempFile), 'temp file is created on disk');
    assert.equal(readFileSync(result.tempFile, 'utf8'), message, 'file content is the verbatim prompt');
    assert.equal(statSync(result.tempFile).mode & 0o777, 0o600, 'temp file is owner-readable only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPromptArg: nullish and empty prompts are private temp file references', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gjc-args-test-'));
  try {
    for (const message of [undefined, '']) {
      const result = buildPromptArg(message, dir);

      assert.ok(result.tempFile, 'tempFile must be set for every prompt');
      assert.equal(result.arg, `@${result.tempFile}`);
      assert.equal(readFileSync(result.tempFile, 'utf8'), '');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPromptArg: rejects prompts over 10 MB', () => {
  const oversizedPrompt = 'x'.repeat((10 * 1024 * 1024) + 1);

  assert.throws(
    () => buildPromptArg(oversizedPrompt),
    /gjc prompt exceeds the 10485760-byte limit/,
  );
});

test('registerGjcProcessAlias: spawn handle remains abortable after provider header alias', () => {
  const processes = new Map();
  const child = {};

  registerGjcProcessAlias(processes, 'run-handle', child);
  registerGjcProcessAlias(processes, 'provider-session-id', child);

  assert.equal(processes.get('run-handle'), child, 'abort can still use the pre-header run handle');
  assert.equal(processes.get('provider-session-id'), child, 'abort can use the provider session id');
});

test('abortGjcProcess prefers SDK turn.abort without sending a legacy signal', async () => {
  const signals: string[] = [];
  let sdkAbortCalls = 0;
  const child: TestGjcProcess = {
    gjcSdkBridge: {
      async abort() {
        sdkAbortCalls += 1;
        return true;
      },
    },
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  };

  assert.equal(await abortGjcProcess(child), true);
  assert.equal(sdkAbortCalls, 1);
  assert.deepEqual(signals, []);
  assert.equal(child.aborted, true);
  clearTimeout(child.gjcAbortEscalationTimer);
});

test('abortGjcProcess preserves SIGTERM fallback when SDK abort is unavailable', async () => {
  const signals: string[] = [];
  const child: TestGjcProcess = {
    gjcSdkBridge: {
      async abort() {
        return false;
      },
    },
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  };

  assert.equal(await abortGjcProcess(child), true);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(child.aborted, true);
  clearTimeout(child.gjcAbortEscalationTimer);
});

test('abortGjcProcess keeps the legacy signal path when no SDK bridge attached', async () => {
  const signals: string[] = [];
  const child: TestGjcProcess = {
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  };

  assert.equal(await abortGjcProcess(child), true);
  assert.deepEqual(signals, ['SIGTERM']);
  clearTimeout(child.gjcAbortEscalationTimer);
});

test('abortGjcProcess resets pending state when both SDK and signal abort fail', async () => {
  const child: TestGjcProcess = {
    gjcSdkBridge: {
      async abort() {
        return false;
      },
    },
    kill() {
      return false;
    },
  };

  assert.equal(await abortGjcProcess(child), false);
  assert.equal(child.abortPending, false);
  assert.equal(child.aborted, undefined);
});

test('abortGjcProcess shares one pending SDK abort result across concurrent callers', async () => {
  let resolveAbort!: (value: boolean) => void;
  const sdkResult = new Promise<boolean>((resolve) => {
    resolveAbort = resolve;
  });
  let sdkAbortCalls = 0;
  const child: TestGjcProcess = {
    gjcSdkBridge: {
      abort() {
        sdkAbortCalls += 1;
        return sdkResult;
      },
    },
    kill() {
      return false;
    },
  };

  const first = abortGjcProcess(child);
  const second = abortGjcProcess(child);
  assert.equal(first, second);
  assert.equal(sdkAbortCalls, 1);

  resolveAbort(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(child.abortPending, false);
  assert.equal(child.gjcAbortPromise, null);
});
