import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import {
  CodexSessionsProvider,
  normalizeCodexToolName,
} from '@/modules/providers/list/codex/codex-sessions.provider.js';

test('Codex request_user_input uses the shared question renderer', () => {
  assert.equal(normalizeCodexToolName('request_user_input'), 'AskUserQuestion');
  assert.equal(normalizeCodexToolName('exec_command'), 'exec_command');
});

test('Codex SDK stays pinned to the CLI version required by synchronized models', () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
  const sdkVersion = packageLock.packages['node_modules/@openai/codex-sdk'].version;
  const cliVersion = packageLock.packages['node_modules/@openai/codex'].version;

  assert.equal(packageJson.dependencies['@openai/codex-sdk'], '0.144.6');
  assert.equal(sdkVersion, '0.144.6');
  assert.equal(cliVersion, sdkVersion);
});

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one Codex rollout transcript. `firstUserMessage` mirrors the
 * `event_msg`/`user_message` payload the runtime records for the prompt the
 * user typed; omitting it produces a transcript with no user turn.
 */
const writeCodexTranscript = async (
  homeDir: string,
  codexSessionId: string,
  workspacePath: string,
  firstUserMessage?: string,
): Promise<string> => {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: workspacePath } }),
  ];
  if (firstUserMessage !== undefined) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: firstUserMessage } }));
  }

  const filePath = path.join(sessionsDir, `rollout-${codexSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer titles app-created sessions from the first user message', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-app-1', workspacePath, 'Fix the login redirect bug');
    await withIsolatedDatabase(async () => {
      // The app allocates its own id and later maps the provider id onto it,
      // exactly as a message sent from ChatMux does.
      sessionsDb.createAppSession('app-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-1', 'codex', 'codex-app-1');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the login redirect bug');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer leaves indexed sessions untitled when no name is available', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A CLI-created session has no app row; its first user message must NOT be
    // used as the title, preserving the existing indexing behavior.
    await writeCodexTranscript(tempRoot, 'codex-indexed-1', workspacePath, 'This prompt should be ignored');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-indexed-1')?.custom_name, 'Untitled Codex Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer finds the last completed title without loading a large tail at once', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-tail-title-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const transcriptPath = await writeCodexTranscript(
      tempRoot,
      'codex-indexed-tail-title',
      workspacePath,
    );
    await appendFile(transcriptPath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          last_agent_message: 'Recovered from the completed turn',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'large-tail',
          output: 'x'.repeat(300 * 1024),
        },
      }),
      '',
    ].join('\n'), 'utf8');

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(
        sessionsDb.getSessionById('codex-indexed-tail-title')?.custom_name,
        'Recovered from the completed turn',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('CodexSessionsProvider.normalizeMessage surfaces a top-level SDK error as an error message', () => {
  const provider = new CodexSessionsProvider();
  const out = provider.normalizeMessage({ type: 'error', message: 'stream disconnected' }, 's1');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'error');
  assert.equal(out[0].content, 'stream disconnected');
});

test('CodexSessionsProvider.normalizeMessage still maps turn_failed to an error', () => {
  const provider = new CodexSessionsProvider();
  const out = provider.normalizeMessage({ type: 'turn_failed', error: { message: 'boom' } }, 's1');
  assert.equal(out[0]?.kind, 'error');
  assert.equal(out[0]?.content, 'boom');
});

test('Codex history incrementally appends complete JSONL records', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-incremental-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-incremental-history';
    const transcriptPath = await writeCodexTranscript(
      tempRoot,
      sessionId,
      workspacePath,
      'First prompt',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        sessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        transcriptPath,
      );
      const provider = new CodexSessionsProvider();

      const initial = await provider.fetchHistory(sessionId);
      assert.deepEqual(initial.messages.map((message) => message.content), ['First prompt']);

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-31T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'First answer' }],
        },
      })}\n`, 'utf8');

      const appended = await provider.fetchHistory(sessionId);
      assert.deepEqual(
        appended.messages.map((message) => message.content),
        ['First prompt', 'First answer'],
      );

      const partialLine = JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-31T00:00:02.000Z',
        payload: { type: 'user_message', message: 'Second prompt' },
      });
      const splitAt = Math.floor(partialLine.length / 2);
      await appendFile(transcriptPath, partialLine.slice(0, splitAt), 'utf8');

      const incomplete = await provider.fetchHistory(sessionId);
      assert.deepEqual(
        incomplete.messages.map((message) => message.content),
        ['First prompt', 'First answer'],
      );

      await appendFile(transcriptPath, `${partialLine.slice(splitAt)}\n`, 'utf8');
      const completed = await provider.fetchHistory(sessionId);
      assert.deepEqual(
        completed.messages.map((message) => message.content),
        ['First prompt', 'First answer', 'Second prompt'],
      );

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-31T00:00:02.500Z',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200000,
            total_token_usage: {
              input_tokens: 120,
              output_tokens: 30,
              total_tokens: 150,
            },
          },
        },
      })}\n`, 'utf8');
      const withUsage = await provider.fetchHistory(sessionId);
      assert.deepEqual(withUsage.tokenUsage, {
        used: 150,
        total: 200000,
        inputTokens: 120,
        outputTokens: 30,
        breakdown: {
          input: 120,
          output: 30,
        },
      });

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-31T00:00:03.000Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'pwd' }),
          call_id: 'call-incremental',
        },
      })}\n`, 'utf8');
      const toolStarted = await provider.fetchHistory(sessionId);
      const toolUse = toolStarted.messages.find((message) => message.kind === 'tool_use');
      assert.equal(toolUse?.toolName, 'exec_command');
      assert.equal(toolUse?.toolResult, undefined);

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-31T00:00:04.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-incremental',
          output: '/workspace',
        },
      })}\n`, 'utf8');
      const toolFinished = await provider.fetchHistory(sessionId);
      const completedToolUse = toolFinished.messages.find((message) => message.kind === 'tool_use');
      assert.deepEqual(completedToolUse?.toolResult, {
        content: '/workspace',
        isError: false,
      });
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history drops rollouts that exceed the retained cache bound', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-cache-bound-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-cache-bound-history';
    const transcriptPath = await writeCodexTranscript(tempRoot, sessionId, workspacePath);
    const firstContent = `first-${'x'.repeat(8 * 1024 * 1024)}`;
    const replacementContent = `next-${'x'.repeat(8 * 1024 * 1024)}`;
    await appendFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: firstContent },
    })}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        sessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        transcriptPath,
      );
      const provider = new CodexSessionsProvider();
      assert.equal((await provider.fetchHistory(sessionId)).messages[0]?.content, firstContent);

      const beforeReplacement = await stat(transcriptPath);
      const replacement = [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspacePath } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: replacementContent },
        }),
        '',
      ].join('\n');
      await writeFile(transcriptPath, replacement, 'utf8');
      await utimes(transcriptPath, beforeReplacement.atime, beforeReplacement.mtime);

      assert.equal((await provider.fetchHistory(sessionId)).messages[0]?.content, replacementContent);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history reports a missing transcript source', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-missing-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        'codex-missing-history',
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        path.join(tempRoot, 'missing.jsonl'),
      );

      const history = await new CodexSessionsProvider().fetchHistory('codex-missing-history');
      assert.equal(history.sourceStatus, 'missing');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history reports malformed transcript sources as unreadable', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-malformed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const transcriptPath = path.join(tempRoot, 'malformed.jsonl');
  await mkdir(workspacePath, { recursive: true });
  await writeFile(transcriptPath, '{not-json}\n', 'utf8');

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        'codex-malformed-history',
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        transcriptPath,
      );

      const history = await new CodexSessionsProvider().fetchHistory('codex-malformed-history');
      assert.equal(history.sourceStatus, 'unreadable');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history cache resets when a rollout file is truncated', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-truncate-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-truncated-history';
    const transcriptPath = await writeCodexTranscript(
      tempRoot,
      sessionId,
      workspacePath,
      'A deliberately long original prompt that makes the replacement file smaller.',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        sessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        transcriptPath,
      );
      const provider = new CodexSessionsProvider();
      const initial = await provider.fetchHistory(sessionId);
      assert.equal(initial.messages[0]?.content, 'A deliberately long original prompt that makes the replacement file smaller.');

      await writeFile(transcriptPath, `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-31T00:00:03.000Z',
        payload: { type: 'user_message', message: 'Replacement' },
      })}\n`, 'utf8');

      const replaced = await provider.fetchHistory(sessionId);
      assert.deepEqual(replaced.messages.map((message) => message.content), ['Replacement']);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
