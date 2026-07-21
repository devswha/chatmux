import type { ShellIncomingMessage, ShellOutgoingMessage } from '../types/types';

export function getShellWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  // No client-side token pre-check: a WebSocket handshake cannot carry custom
  // headers, so authentication happens server-side (auth cookie, or the
  // implicit owner when CHATMUX_AUTH=none). Gating on the localStorage token
  // here silently broke every terminal attach in no-login mode — the socket
  // was never even attempted (외부 CLI/Shell 검은 화면).
  return `${protocol}//${window.location.host}/shell`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}