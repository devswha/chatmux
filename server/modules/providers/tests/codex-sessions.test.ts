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
  isCodexHistoryCacheable,
  normalizeCodexToolName,
} from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

test('Codex request_user_input uses the shared question renderer', () => {
  assert.equal(normalizeCodexToolName('request_user_input'), 'AskUserQuestion');
  assert.equal(normalizeCodexToolName('exec_command'), 'exec_command');
});

test('Codex history cache budget includes normalized messages, partial tails, and boundaries', () => {
  assert.equal(isCodexHistoryCacheable(4, 3, 1, 8), true);
  assert.equal(isCodexHistoryCacheable(9, 0, 0, 8), false);
  assert.equal(isCodexHistoryCacheable(0, 9, 0, 8), false);
  assert.equal(isCodexHistoryCacheable(0, 0, 9, 8), false);
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
      assert.equal(
        toolFinished.messages.some((message) => message.kind === 'tool_result'),
        false,
        'tool results are carried by their tool-use card, not duplicated as standalone rows',
      );
      assert.equal(toolFinished.total, toolFinished.messages.length);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history renders structured custom tool output without leaking transport blocks', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-custom-tool-output-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-structured-custom-tool-output';
    const transcriptPath = await writeCodexTranscript(tempRoot, sessionId, workspacePath);
    const header = 'Script completed\nWall time 0.0 seconds\nOutput:\n';
    await appendFile(transcriptPath, [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-03T00:00:00.000Z',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Update File: example.ts\n*** End Patch',
          call_id: 'empty-result',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-03T00:00:01.000Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'empty-result',
          output: [
            { type: 'input_text', text: header },
            { type: 'input_text', text: '{}' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-03T00:00:02.000Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          input: '{}',
          call_id: 'successful-result',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-03T00:00:03.000Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'successful-result',
          output: [
            { type: 'input_text', text: header },
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: 'chunk-success',
                wall_time_seconds: 0.1,
                exit_code: 0,
                output: 'rendered output\n',
              }),
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-03T00:00:04.000Z',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          input: '{}',
          call_id: 'failed-result',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-03T00:00:05.000Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'failed-result',
          output: [
            { type: 'input_text', text: header },
            {
              type: 'input_text',
              text: JSON.stringify({
                wall_time_seconds: 0.1,
                exit_code: 2,
                output: 'command failed\n',
              }),
            },
          ],
        },
      }),
      '',
    ].join('\n'), 'utf8');

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

      const history = await new CodexSessionsProvider().fetchHistory(sessionId);
      const toolUses = history.messages.filter((message) => message.kind === 'tool_use');
      assert.equal(toolUses.length, 3);
      assert.deepEqual(toolUses[0].toolResult, {
        content: 'Script completed\nWall time 0.0 seconds',
        isError: false,
      });
      assert.deepEqual(toolUses[1].toolResult, {
        content: `${header}rendered output\n`,
        isError: false,
      });
      assert.deepEqual(toolUses[2].toolResult, {
        content: `${header}command failed\n`,
        isError: true,
      });
      assert.equal(JSON.stringify(toolUses).includes('input_text'), false);
      assert.equal(history.messages.some((message) => message.kind === 'tool_result'), false);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history reads response-item-only user prompts without exposing injected context', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-response-user-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-response-user-history';
    const transcriptPath = await writeCodexTranscript(tempRoot, sessionId, workspacePath);
    const pairedImagePath = path.join(workspacePath, 'paired.png');
    await appendFile(transcriptPath, [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-14T00:00:00.000Z',
        payload: {
          type: 'message',
          id: 'synthetic-context',
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\ninternal\n</INSTRUCTIONS>' },
            { type: 'input_text', text: '<environment_context>\ninternal\n</environment_context>' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-14T00:00:01.000Z',
        payload: {
          type: 'message',
          id: 'response-user-only',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Visible new-format prompt' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-14T00:00:02.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Visible answer' }],
        },
      }),
      // Older Codex versions persist both forms for one prompt. The later
      // event record must replace, not duplicate, the response item.
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-14T00:00:03.000Z',
        payload: {
          type: 'message',
          id: 'paired-response-user',
          role: 'user',
          content: [
            { type: 'input_text', text: 'One paired prompt' },
            { type: 'input_image', image_url: 'data:image/png;base64,REVG' },
          ],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-14T00:00:03.000Z',
        payload: {
          type: 'user_message',
          message: 'One paired prompt',
          local_images: [pairedImagePath],
        },
      }),
      '',
    ].join('\n'), 'utf8');

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

      const history = await new CodexSessionsProvider().fetchHistory(sessionId);
      assert.deepEqual(
        history.messages.map((message) => message.content),
        ['Visible new-format prompt', 'Visible answer', 'One paired prompt'],
      );
      assert.deepEqual(history.messages[0]?.images, [{ data: 'data:image/png;base64,QUJD' }]);
      assert.deepEqual(history.messages[2]?.images, [{ path: pairedImagePath }]);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history detects same-size rewrites beyond the former raw cache bound', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-cache-bound-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-cache-bound-history';
    const transcriptPath = await writeCodexTranscript(tempRoot, sessionId, workspacePath);
    const firstContent = `first-${'x'.repeat(8 * 1024 * 1024)}`;
    const replacementContent = `later-${'x'.repeat(8 * 1024 * 1024)}`;
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
      assert.equal(Buffer.byteLength(replacement), beforeReplacement.size);
      await writeFile(transcriptPath, replacement, 'utf8');
      await utimes(transcriptPath, beforeReplacement.atime, beforeReplacement.mtime);

      assert.equal((await provider.fetchHistory(sessionId)).messages[0]?.content, replacementContent);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history sends bounded tool previews and loads the full result on demand', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-tool-preview-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  try {
    const sessionId = 'codex-tool-preview-history';
    const transcriptPath = await writeCodexTranscript(tempRoot, sessionId, workspacePath);
    // The 7-byte Korean prefix deliberately makes the fixed 48 KiB head cut
    // land inside a three-byte UTF-8 character.
    const output = `시작-${'한'.repeat(40 * 1024)}-끝`;
    await appendFile(transcriptPath, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-10T00:00:00.000Z',
        payload: {
          type: 'user_message',
          message: 'Run the diagnostic',
          images: ['data:image/png;base64,QUJD'],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-10T00:00:01.000Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'diagnostic' }),
          call_id: 'large-result',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-10T00:00:02.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'large-result',
          output,
        },
      }),
      '',
    ].join('\n'), 'utf8');

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

      const history = await sessionsService.fetchHistory(sessionId, {
        limit: 20,
        offset: 0,
        includeImages: false,
      });
      const userMessage = history.messages.find((message) => message.role === 'user');
      const toolUse = history.messages.find((message) => message.kind === 'tool_use');
      assert.equal(userMessage?.images, undefined);
      assert.equal(toolUse?.toolResultTruncated, true);
      assert.equal(toolUse?.toolResultBytes, Buffer.byteLength(output));
      assert.ok(String(toolUse?.toolResult?.content).length < output.length);
      assert.equal(String(toolUse?.toolResult?.content).includes('\uFFFD'), false);
      assert.equal(String(toolUse?.toolResult?.content).startsWith('시작-'), true);
      assert.equal(String(toolUse?.toolResult?.content).endsWith('-끝'), true);
      assert.equal(history.messages.some((message) => message.kind === 'tool_result'), false);

      const full = await sessionsService.fetchToolResult(sessionId, 'large-result');
      assert.equal(full.toolResult.content, output);
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
