import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import type { AnyRecord, NormalizedMessage } from './shared/types.js';

type OmpWriter = {
  send(value: unknown): void;
  setSessionId?(id: string): void;
  getAppSessionId?(): string | undefined;
};

type OmpRunOptions = {
  sessionId?: string;
  cwd?: string;
  projectPath?: string;
  model?: string;
  effort?: string;
  images?: Array<{ path?: unknown }>;
};

type ActiveOmpProcess = ReturnType<typeof spawn> & { aborted?: boolean };

const activeOmpProcesses = new Map<string, ActiveOmpProcess>();

function readRecord(value: unknown): AnyRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null;
}

function readContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value
    .map((part) => {
      const record = readRecord(part);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildOmpArgs(command: string, options: OmpRunOptions): string[] {
  const args = ['--mode', 'json', '--print'];
  if (options.sessionId) args.push('--resume', options.sessionId);
  if (options.model && options.model !== 'default') args.push('--model', options.model);
  if (options.effort && options.effort !== 'default') args.push('--thinking', options.effort);

  for (const image of options.images ?? []) {
    if (typeof image.path === 'string' && image.path.trim()) {
      args.push(`@${image.path}`);
    }
  }
  args.push(command);
  return args;
}

export function normalizeOmpEvent(
  eventValue: unknown,
  sessionId: string | null,
): { providerSessionId?: string; messages: NormalizedMessage[] } {
  const event = readRecord(eventValue);
  if (!event) return { messages: [] };

  if (event.type === 'session' && typeof event.id === 'string' && event.id.trim()) {
    return { providerSessionId: event.id, messages: [] };
  }

  if (event.type === 'message_update') {
    const update = readRecord(event.assistantMessageEvent);
    if (update?.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
      return {
        messages: [createNormalizedMessage({
          kind: 'stream_delta',
          content: update.delta,
          sessionId,
          provider: 'omp',
        })],
      };
    }
    if (update?.type === 'thinking_delta' && typeof update.delta === 'string' && update.delta) {
      return {
        messages: [createNormalizedMessage({
          kind: 'thinking',
          content: update.delta,
          sessionId,
          provider: 'omp',
        })],
      };
    }
  }

  if (event.type === 'tool_execution_start') {
    return {
      messages: [createNormalizedMessage({
        kind: 'tool_use',
        toolName: typeof event.toolName === 'string' ? event.toolName : 'Unknown',
        toolInput: readRecord(event.args) ?? {},
        toolId: typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID(),
        sessionId,
        provider: 'omp',
      })],
    };
  }

  if (event.type === 'tool_execution_end') {
    const result = readRecord(event.result);
    return {
      messages: [createNormalizedMessage({
        kind: 'tool_result',
        toolId: typeof event.toolCallId === 'string' ? event.toolCallId : '',
        content: readContentText(result?.content),
        isError: Boolean(event.isError),
        sessionId,
        provider: 'omp',
      })],
    };
  }

  if (event.type === 'error') {
    const error = readRecord(event.error);
    const content = typeof event.message === 'string'
      ? event.message
      : typeof error?.message === 'string'
        ? error.message
        : 'Oh My Pi failed.';
    return {
      messages: [createNormalizedMessage({
        kind: 'error',
        content,
        sessionId,
        provider: 'omp',
      })],
    };
  }

  return { messages: [] };
}

export function spawnOmp(command: string, options: OmpRunOptions = {}, writer: OmpWriter): Promise<void> {
  const workingDir = options.cwd || options.projectPath || process.cwd();
  const processKey = writer.getAppSessionId?.() || options.sessionId || randomUUID();
  let capturedSessionId = options.sessionId ?? null;
  let child: ActiveOmpProcess | null = null;
  let settled = false;

  const run = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const registerSession = (providerSessionId: string): void => {
      if (!providerSessionId || capturedSessionId === providerSessionId) return;
      const previousId = capturedSessionId;
      capturedSessionId = providerSessionId;
      writer.setSessionId?.(providerSessionId);
      if (child) {
        activeOmpProcesses.set(providerSessionId, child);
        if (previousId) activeOmpProcesses.delete(previousId);
      }
      if (!options.sessionId) {
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: providerSessionId,
          sessionId: providerSessionId,
          provider: 'omp',
        }));
      }
    };

    try {
      child = spawn('omp', buildOmpArgs(command, options), {
        cwd: workingDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ActiveOmpProcess;
      if (!child.stdout || !child.stderr) {
        throw new Error('Oh My Pi did not expose its output streams.');
      }
      const { stdout, stderr } = child;
      activeOmpProcesses.set(processKey, child);
      if (capturedSessionId) activeOmpProcesses.set(capturedSessionId, child);

      const lines = createInterface({ input: stdout });
      lines.on('line', (line) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const normalized = normalizeOmpEvent(event, capturedSessionId);
        if (normalized.providerSessionId) registerSession(normalized.providerSessionId);
        for (const message of normalized.messages) writer.send(message);
      });

      stderr.on('data', (chunk) => {
        const content = String(chunk).trim();
        if (!content) return;
        writer.send(createNormalizedMessage({
          kind: 'error',
          content,
          sessionId: capturedSessionId,
          provider: 'omp',
        }));
      });

      child.on('error', (error) => {
        activeOmpProcesses.delete(processKey);
        if (capturedSessionId) activeOmpProcesses.delete(capturedSessionId);
        writer.send(createNormalizedMessage({
          kind: 'error',
          content: error.message,
          sessionId: capturedSessionId,
          provider: 'omp',
        }));
        if (!child?.aborted) {
          writer.send(createCompleteMessage({ provider: 'omp', sessionId: capturedSessionId, exitCode: 1 }));
        }
        finish(error);
      });

      child.on('close', (code) => {
        activeOmpProcesses.delete(processKey);
        if (capturedSessionId) activeOmpProcesses.delete(capturedSessionId);
        if (!child?.aborted) {
          writer.send(createCompleteMessage({ provider: 'omp', sessionId: capturedSessionId, exitCode: code }));
        }
        if (code === 0 || child?.aborted) finish();
        else finish(new Error(`Oh My Pi exited with code ${code ?? 'unknown'}`));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  Object.assign(run, { abortHandle: processKey });
  return run;
}

export function abortOmpSession(sessionId: string): boolean {
  const child = activeOmpProcesses.get(sessionId);
  if (!child) return false;
  child.aborted = true;
  child.kill('SIGTERM');
  for (const [key, value] of activeOmpProcesses.entries()) {
    if (value === child) activeOmpProcesses.delete(key);
  }
  return true;
}
