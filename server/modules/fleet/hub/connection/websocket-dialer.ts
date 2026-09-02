import { WebSocket, type RawData } from 'ws';

import { FLEET_MAX_FRAME_BYTES } from '../../protocol/codec.js';

import type { HubPeerSocket } from './types.js';

const MAX_BUFFERED_BYTES = 64 * 1024;

export function dialFleetWebSocket(target: URL): HubPeerSocket {
  const socket = new WebSocket(target, { followRedirects: false, perMessageDeflate: false, maxPayload: FLEET_MAX_FRAME_BYTES });
  return {
    onOpen: (listener) => { socket.on('open', listener); },
    onMessage: (listener) => {
      socket.on('message', (raw: RawData) => {
        const bytes = raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw;
        listener(bytes);
      });
    },
    onClose: (listener) => { socket.on('close', listener); },
    onError: (listener) => { socket.on('error', listener); },
    send: (payload) => {
      if (socket.bufferedAmount + Buffer.byteLength(payload) > MAX_BUFFERED_BYTES) {
        socket.close(4008, 'fleet writer capacity exceeded');
        return;
      }
      socket.send(payload);
    },
    close: (code, reason) => { socket.close(code, reason); },
  };
}
