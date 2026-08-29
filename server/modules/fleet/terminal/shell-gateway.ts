import type { RawData } from 'ws';

import { parseFleetReference, type JsonValue } from '../../../../shared/fleet.js';
import { parseIncomingJsonObject } from '../../../shared/utils.js';

import { RemoteTerminalClient, RemoteTerminalClientError, type RemoteTerminalAttachment, type RemoteTerminalSink } from './client.js';
import { REMOTE_TERMINAL_INPUT_LIMIT, type RemoteTerminalResume } from './contracts.js';

const SHELL_PROTOCOL_VERSION = 2;
const REQUEST_DEADLINE_MS = 10_000;
type Principal = Readonly<{ readonly id: string; readonly owner: boolean }>;
type QueuedOutput = Readonly<{ readonly data: string; readonly seq: number; readonly replay: boolean }>;
export interface RemoteTerminalShellSocket {
  readonly bufferedAmount: number;
  readonly open: boolean;
  send(payload: string): void;
  close(): void;
  onMessage(listener: (raw: RawData) => void): void;
  onClose(listener: () => void): void;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RemoteTerminalClientError(`${name} is invalid`);
  return value;
}
function resume(value: unknown): RemoteTerminalResume | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new RemoteTerminalClientError('terminal resume identity is invalid');
  const fields = Object.entries(value);
  const field = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  const peerProcessEpoch = field('peerProcessEpoch'); const terminalSessionId = field('terminalSessionId'); const streamEpoch = field('streamEpoch');
  if (typeof peerProcessEpoch !== 'string' || typeof terminalSessionId !== 'string' || typeof streamEpoch !== 'string') throw new RemoteTerminalClientError('terminal resume identity is invalid');
  return { peerProcessEpoch, terminalSessionId, streamEpoch, lastSeq: integer(field('lastSeq'), 'last sequence') };
}
function send(ws: RemoteTerminalShellSocket, body: JsonValue): void { if (ws.open) ws.send(JSON.stringify(body)); }
function rawBytes(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, item) => total + item.byteLength, 0);
  return raw.byteLength;
}

export class RemoteTerminalShellGateway {
  private client: RemoteTerminalClient | undefined;
  bind(client: RemoteTerminalClient): void { this.client = client; }
  unbind(client: RemoteTerminalClient): void { if (this.client === client) this.client = undefined; }

  handle(ws: RemoteTerminalShellSocket, principal: Principal): void {
    let attachment: RemoteTerminalAttachment | undefined;
    let initializing = false;
    let ready = false;
    let queueBytes = 0;
    let incoming = Promise.resolve();
    let incomingBytes = 0;
    const queued: QueuedOutput[] = [];
    const sink: RemoteTerminalSink = {
      get bufferedAmount() { return ws.bufferedAmount + queueBytes; },
      output: (data, seq, replayOutput) => {
        if (!ready) { queued.push({ data, seq, replay: replayOutput }); queueBytes += Buffer.byteLength(data); return; }
        send(ws, { type: 'output', data, seq, replay: replayOutput });
      },
      close: (reason) => { send(ws, { type: 'remote_closed', reason }); ws.close(); },
    };
    const fail = (error: unknown): void => {
      if (error instanceof RemoteTerminalClientError) { send(ws, { type: 'error', message: error.message }); ws.close(); return; }
      throw error;
    };
    const handle = async (raw: RawData): Promise<void> => {
      const message = parseIncomingJsonObject(raw);
      if (message === null || typeof message.type !== 'string') throw new RemoteTerminalClientError('remote terminal frame is invalid');
      if (message.type === 'init') {
        if (attachment !== undefined || initializing) throw new RemoteTerminalClientError('remote terminal is already initialized');
        if (message.shellProtocolVersion !== SHELL_PROTOCOL_VERSION || message.mode !== 'remote-attach') throw new RemoteTerminalClientError('remote terminal protocol is outdated');
        const target = parseFleetReference(message.target);
        if (target.kind !== 'pane') throw new RemoteTerminalClientError('remote terminal pane target is required');
        const client = this.client;
        if (client === undefined) throw new RemoteTerminalClientError('remote terminal service is unavailable');
        initializing = true;
        try {
          attachment = await client.attach({
            principal: principal.id, owner: principal.owner, target,
            cols: integer(message.cols, 'columns'), rows: integer(message.rows, 'rows'),
            deadlineAtMs: Date.now() + REQUEST_DEADLINE_MS, resume: resume(message.resume), sink,
          });
          send(ws, { type: 'replay_start', mode: attachment.replay, resume: attachment.resume });
          ready = true;
          for (const output of queued) send(ws, { type: 'output', data: output.data, seq: output.seq, replay: output.replay });
          queued.length = 0; queueBytes = 0;
        } finally { initializing = false; }
        return;
      }
      if (attachment === undefined) throw new RemoteTerminalClientError('remote terminal is not initialized');
      const deadlineAtMs = Date.now() + REQUEST_DEADLINE_MS;
      switch (message.type) {
        case 'input':
          if (typeof message.data !== 'string') throw new RemoteTerminalClientError('terminal input is invalid');
          await attachment.input(message.data, deadlineAtMs); return;
        case 'resize': await attachment.resize(integer(message.cols, 'columns'), integer(message.rows, 'rows'), deadlineAtMs); return;
        case 'close': await attachment.close(deadlineAtMs); attachment = undefined; return;
        default: throw new RemoteTerminalClientError('remote terminal operation is invalid');
      }
    };
    ws.onMessage((raw) => {
      const bytes = rawBytes(raw);
      if (incomingBytes + bytes > REMOTE_TERMINAL_INPUT_LIMIT) { fail(new RemoteTerminalClientError('remote terminal input buffer is full')); return; }
      incomingBytes += bytes;
      incoming = incoming.then(() => handle(raw)).catch(fail).finally(() => { incomingBytes -= bytes; });
    });
    ws.onClose(() => { attachment?.detach(); attachment = undefined; });
  }
}

export const remoteTerminalShellGateway = new RemoteTerminalShellGateway();
