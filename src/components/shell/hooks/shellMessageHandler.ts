import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

import type { RemoteTerminalResume } from '../types/types';
import { parseShellMessage } from '../utils/socket';

function parsedResume(value: unknown): RemoteTerminalResume | null {
  const fields = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value)
    : [];
  const field = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  const peerProcessEpoch = field('peerProcessEpoch');
  const terminalSessionId = field('terminalSessionId');
  const streamEpoch = field('streamEpoch');
  const lastSeq = field('lastSeq');
  return typeof peerProcessEpoch === 'string'
    && typeof terminalSessionId === 'string'
    && typeof streamEpoch === 'string'
    && typeof lastSeq === 'number'
    && Number.isSafeInteger(lastSeq)
    && lastSeq >= 0
    ? { peerProcessEpoch, terminalSessionId, streamEpoch, lastSeq }
    : null;
}

export type ShellMessageContext = Readonly<{
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly lastSeqRef: MutableRefObject<number | null>;
  readonly remoteResumeRef: MutableRefObject<RemoteTerminalResume | null>;
  readonly protocolOutdatedRef: MutableRefObject<boolean>;
  readonly suppressAutoConnectRef: MutableRefObject<boolean>;
  readonly clearTerminalScreen: () => void;
  readonly handleProcessCompletion: (output: string) => void;
  readonly notifyOutput: (() => void) | undefined;
  readonly setProtocolOutdated: (value: boolean) => void;
}>;

export function handleShellSocketPayload(rawPayload: string, context: ShellMessageContext): void {
  const message = parseShellMessage(rawPayload);
  if (!message) {
    console.error('[Shell] Error handling WebSocket message:', rawPayload);
    return;
  }
  if (message.type === 'output') {
    const output = typeof message.data === 'string' ? message.data : '';
    if (typeof message.seq === 'number') context.lastSeqRef.current = message.seq;
    context.handleProcessCompletion(output);
    context.terminalRef.current?.write(output);
    context.notifyOutput?.();
    return;
  }
  if (message.type === 'auth_url' && typeof message.url === 'string' && message.url) {
    context.terminalRef.current?.write(`\r\n[Authentication required] Open this URL in your browser:\r\n${message.url}\r\n`);
    context.notifyOutput?.();
    return;
  }
  if (message.type === 'replay_start') {
    context.remoteResumeRef.current = parsedResume(message.resume);
    if (message.mode !== 'resume') context.clearTerminalScreen();
    return;
  }
  if (message.type === 'error' && message.code === 'SHELL_PROTOCOL_OUTDATED' && message.reloadRequired === true) {
    context.protocolOutdatedRef.current = true;
    context.suppressAutoConnectRef.current = true;
    context.setProtocolOutdated(true);
  }
}
