import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ExternalCliSession } from '@/modules/providers/services/external-cli-sessions.service.js';

import { TmuxEventLog } from './tmux-event-log.js';
import type { FakeTmuxAgent, FakeTranscriptTmuxAgent } from './tmux-e2e-types.js';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const DISCOVERY_MARKER = '__CHATMUX_TMUX_E2E_SESSIONS__=';
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

export class TmuxHarnessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxHarnessContractError';
  }
}

export function assertSafeSessionName(sessionName: string): void {
  if (!SESSION_NAME_RE.test(sessionName)) throw new TmuxHarnessContractError(`Unsafe tmux test session name: ${sessionName}`);
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new TmuxHarnessContractError(`Invalid fake transcript session id: ${sessionId}`);
}

export async function runTmux(environment: NodeJS.ProcessEnv, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('tmux', [...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: 8_000,
  });
  return String(result.stdout);
}

export async function assertTmuxAvailable(): Promise<void> {
  try {
    await execFileAsync('tmux', ['-V'], { encoding: 'utf8', timeout: 5_000 });
  } catch (error) {
    throw new TmuxHarnessContractError(`The real-tmux E2E harness requires tmux on PATH: ${String(error)}`);
  }
}

export async function discoverFromFreshProcess(environment: NodeJS.ProcessEnv): Promise<ExternalCliSession[]> {
  const tsx = path.join(REPOSITORY_ROOT, 'node_modules', '.bin', 'tsx');
  const probe = path.join(REPOSITORY_ROOT, 'server/modules/providers/tests/support/discover-external-sessions.probe.ts');
  const result = await execFileAsync(tsx, ['--tsconfig', 'server/tsconfig.json', probe], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20_000,
  });
  const markerLine = String(result.stdout).split('\n').find((line) => line.startsWith(DISCOVERY_MARKER));
  if (!markerLine) throw new TmuxHarnessContractError(`Fresh discovery process produced no marker: ${String(result.stderr)}`);
  const parsed: unknown = JSON.parse(markerLine.slice(DISCOVERY_MARKER.length));
  if (!Array.isArray(parsed)) throw new TmuxHarnessContractError('Fresh discovery marker was not an array.');
  return parsed;
}

export async function createWatchedAgent(
  sessionName: string,
  logPath: string,
  eventLogs: Set<TmuxEventLog>,
): Promise<readonly [FakeTmuxAgent, TmuxEventLog]> {
  const eventLog = await TmuxEventLog.create(logPath);
  eventLogs.add(eventLog);
  const { agentFromEventLog } = await import('./tmux-event-log.js');
  return [agentFromEventLog(sessionName, logPath, eventLog), eventLog];
}

export function withTranscript(
  agent: FakeTmuxAgent,
  eventLog: TmuxEventLog,
  sessionId: string,
  transcriptPath: string,
): FakeTranscriptTmuxAgent {
  return {
    ...agent,
    sessionId,
    transcriptPath,
    waitForTranscript: (count = 1) => eventLog.waitFor(
      (events) => events.filter((event) => event.type === 'transcript' && event.sessionId === sessionId).length >= count,
      `${agent.sessionName} transcript creation x${count}`,
    ),
  };
}
