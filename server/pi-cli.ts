import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import type { AnyRecord, NormalizedMessage } from './shared/types.js';

/**
 * Shared non-interactive runtime for the pi-derived CLIs.
 *
 * Oh My Pi and omo accept the same flags (`--mode json --print`, `--resume`,
 * `--model`, `--thinking`, `@<image>`) and emit the same JSON event stream
 * (`session`, `message_update`, `tool_execution_start|end`, `error`), so one
 * runtime serves both and a third pi CLI needs only a new descriptor.
 *
 * Both write human-readable log lines to stdout alongside the JSON, so every
 * line that fails to parse is skipped rather than treated as a protocol error.
 */
export type PiCliProvider = 'omp' | 'omo';

export type PiCliDescriptor = {
  provider: PiCliProvider;
  /** Executable resolved from PATH. */
  binary: string;
  /** Human-readable name used in error text surfaced to the client. */
  label: string;
};

export type PiCliWriter = {
  send(value: unknown): void;
  setSessionId?(id: string): void;
  getAppSessionId?(): string | undefined;
};

export type PiCliRunOptions = {
  sessionId?: string;
  cwd?: string;
  projectPath?: string;
  model?: string;
  effort?: string;
  images?: Array<{ path?: unknown }>;
};

type ActivePiProcess = ReturnType<typeof spawn> & { aborted?: boolean };

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

export function buildPiCliArgs(command: string, options: PiCliRunOptions): string[] {
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

export function normalizePiCliEvent(
  eventValue: unknown,
  sessionId: string | null,
  descriptor: PiCliDescriptor,
): { providerSessionId?: string; messages: NormalizedMessage[] } {
  const event = readRecord(eventValue);
  if (!event) return { messages: [] };
  const provider = descriptor.provider;

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
          provider,
        })],
      };
    }
    if (update?.type === 'thinking_delta' && typeof update.delta === 'string' && update.delta) {
      return {
        messages: [createNormalizedMessage({
          kind: 'thinking',
          content: update.delta,
          sessionId,
          provider,
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
        provider,
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
        provider,
      })],
    };
  }

  if (event.type === 'error') {
    const error = readRecord(event.error);
    const content = typeof event.message === 'string'
      ? event.message
      : typeof error?.message === 'string'
        ? error.message
        : `${descriptor.label} failed.`;
    return {
      messages: [createNormalizedMessage({
        kind: 'error',
        content,
        sessionId,
        provider,
      })],
    };
  }

  return { messages: [] };
}

export type PiCliRuntime = {
  spawn(command: string, options: PiCliRunOptions | undefined, writer: PiCliWriter): Promise<void>;
  abort(sessionId: string): boolean;
};

export function createPiCliRuntime(descriptor: PiCliDescriptor): PiCliRuntime {
  const activeProcesses = new Map<string, ActivePiProcess>();
  const { provider, binary, label } = descriptor;

  const spawnRun = (
    command: string,
    options: PiCliRunOptions = {},
    writer: PiCliWriter,
  ): Promise<void> => {
    const workingDir = options.cwd || options.projectPath || process.cwd();
    const processKey = writer.getAppSessionId?.() || options.sessionId || randomUUID();
    let capturedSessionId = options.sessionId ?? null;
    let child: ActivePiProcess | null = null;
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
          activeProcesses.set(providerSessionId, child);
          if (previousId) activeProcesses.delete(previousId);
        }
        if (!options.sessionId) {
          writer.send(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: providerSessionId,
            sessionId: providerSessionId,
            provider,
          }));
        }
      };

      try {
        // stdin must be closed: with an inherited stdin these CLIs wait for
        // interactive input and never emit their first event.
        child = spawn(binary, buildPiCliArgs(command, options), {
          cwd: workingDir,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }) as ActivePiProcess;
        if (!child.stdout || !child.stderr) {
          throw new Error(`${label} did not expose its output streams.`);
        }
        const { stdout, stderr } = child;
        activeProcesses.set(processKey, child);
        if (capturedSessionId) activeProcesses.set(capturedSessionId, child);

        const lines = createInterface({ input: stdout });
        lines.on('line', (line) => {
          if (!line.trim()) return;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          const normalized = normalizePiCliEvent(event, capturedSessionId, descriptor);
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
            provider,
          }));
        });

        child.on('error', (error) => {
          activeProcesses.delete(processKey);
          if (capturedSessionId) activeProcesses.delete(capturedSessionId);
          writer.send(createNormalizedMessage({
            kind: 'error',
            content: error.message,
            sessionId: capturedSessionId,
            provider,
          }));
          if (!child?.aborted) {
            writer.send(createCompleteMessage({ provider, sessionId: capturedSessionId, exitCode: 1 }));
          }
          finish(error);
        });

        child.on('close', (code) => {
          activeProcesses.delete(processKey);
          if (capturedSessionId) activeProcesses.delete(capturedSessionId);
          if (!child?.aborted) {
            writer.send(createCompleteMessage({ provider, sessionId: capturedSessionId, exitCode: code }));
          }
          if (code === 0 || child?.aborted) finish();
          else finish(new Error(`${label} exited with code ${code ?? 'unknown'}`));
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    Object.assign(run, { abortHandle: processKey });
    return run;
  };

  const abort = (sessionId: string): boolean => {
    const child = activeProcesses.get(sessionId);
    if (!child) return false;
    child.aborted = true;
    child.kill('SIGTERM');
    for (const [key, value] of activeProcesses.entries()) {
      if (value === child) activeProcesses.delete(key);
    }
    return true;
  };

  return { spawn: spawnRun, abort };
}
