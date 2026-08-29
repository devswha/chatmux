import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FakeAgentEvent, FakeTmuxAgent } from './tmux-e2e-types.js';

const EVENT_TIMEOUT_MS = 8_000;

export class TmuxFixtureTimeoutError extends Error {
  constructor(readonly description: string) {
    super(`Timed out waiting for ${description}`);
    this.name = 'TmuxFixtureTimeoutError';
  }
}

function parseEvent(value: unknown): FakeAgentEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new TypeError('Invalid fake-agent event');
  }
  const type = value.type;
  if (type === 'ready' && 'pid' in value && typeof value.pid === 'number') return { type, pid: value.pid };
  if (type === 'input' && 'value' in value && typeof value.value === 'string') return { type, value: value.value };
  if (type === 'transcript' && 'path' in value && 'sessionId' in value
    && typeof value.path === 'string' && typeof value.sessionId === 'string') {
    return { type, path: value.path, sessionId: value.sessionId };
  }
  if (type === 'approval_requested') return { type };
  if (type === 'approval' && 'decision' in value && typeof value.decision === 'string') return { type, decision: value.decision };
  if (type === 'interrupt' || type === 'turn_started' || type === 'turn_interrupted' || type === 'turn_completed') {
    return { type };
  }
  throw new TypeError(`Unknown fake-agent event type: ${String(type)}`);
}

export class TmuxEventLog {
  readonly #logPath: string;
  readonly #watcher: FSWatcher;
  readonly #subscribers = new Set<() => void>();
  #events: readonly FakeAgentEvent[] = [];
  #refreshing: Promise<void> = Promise.resolve();

  private constructor(logPath: string, watcher: FSWatcher) {
    this.#logPath = logPath;
    this.#watcher = watcher;
    watcher.on('change', (_event, filename) => {
      if (filename === null || filename.toString() === path.basename(logPath)) this.#queueRefresh();
    });
  }

  static async create(logPath: string): Promise<TmuxEventLog> {
    await mkdir(path.dirname(logPath), { recursive: true });
    const watcher = watch(path.dirname(logPath), { persistent: false });
    return new TmuxEventLog(logPath, watcher);
  }

  close(): void {
    this.#watcher.close();
    this.#subscribers.clear();
  }

  async events(): Promise<FakeAgentEvent[]> {
    await this.#refresh();
    return [...this.#events];
  }

  async waitFor(predicate: (events: readonly FakeAgentEvent[]) => boolean, description: string): Promise<void> {
    await this.#refresh();
    if (predicate(this.#events)) return;
    await new Promise<void>((resolve, reject) => {
      const onChange = (): void => {
        if (!predicate(this.#events)) return;
        clearTimeout(timeout);
        this.#subscribers.delete(onChange);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.#subscribers.delete(onChange);
        reject(new TmuxFixtureTimeoutError(description));
      }, EVENT_TIMEOUT_MS);
      this.#subscribers.add(onChange);
    });
  }

  #queueRefresh(): void {
    this.#refreshing = this.#refreshing.then(() => this.#read()).catch((error: unknown) => {
      queueMicrotask(() => { throw error; });
    });
  }

  async #refresh(): Promise<void> {
    await this.#refreshing;
    await this.#read();
  }

  async #read(): Promise<void> {
    let content = '';
    try {
      content = await readFile(this.#logPath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    this.#events = content.split('\n').filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line);
      return parseEvent(parsed);
    });
    for (const subscriber of this.#subscribers) subscriber();
  }
}

export function agentFromEventLog(sessionName: string, logPath: string, eventLog: TmuxEventLog): FakeTmuxAgent {
  return {
    sessionName,
    logPath,
    events: () => eventLog.events(),
    waitUntilReady: () => eventLog.waitFor((events) => events.some(({ type }) => type === 'ready'), `${sessionName} readiness`),
    waitForInput: (value) => eventLog.waitFor(
      (events) => events.some((event) => event.type === 'input' && event.value === value),
      `${sessionName} input ${JSON.stringify(value)}`,
    ),
    waitForInterrupt: (count = 1) => eventLog.waitFor(
      (events) => events.filter(({ type }) => type === 'interrupt').length >= count,
      `${sessionName} SIGINT x${count}`,
    ),
    waitForTurnStarted: () => eventLog.waitFor((events) => events.some(({ type }) => type === 'turn_started'), `${sessionName} turn start`),
    waitForTurnInterrupted: () => eventLog.waitFor((events) => events.some(({ type }) => type === 'turn_interrupted'), `${sessionName} turn interruption`),
    waitForApproval: (decision) => eventLog.waitFor(
      (events) => events.some((event) => event.type === 'approval' && event.decision === decision),
      `${sessionName} approval ${decision}`,
    ),
  };
}
