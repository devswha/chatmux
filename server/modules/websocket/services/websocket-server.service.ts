import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { createDiscoveryStream } from '@/modules/websocket/services/discovery-stream.service.js';
import type { DiscoveryCollector } from '@/modules/providers/index.js';
import { createPaneOutputStream } from '@/modules/providers/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
  discovery?: DiscoveryCollector;
  panes?: ReturnType<typeof createPaneOutputStream>;
};
function sendPaneProtocolError(ws: WebSocket, error: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    kind: 'protocol_error',
    code: 'INVALID_PANE_SUBSCRIPTION',
    error: error instanceof Error ? error.message : 'Invalid pane subscription.',
    sessionId: null,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });
  const discovery = dependencies.discovery ? createDiscoveryStream(dependencies.discovery) : undefined;
  const panes = dependencies.panes ?? createPaneOutputStream();
  dependencies.discovery?.onSnapshot((snapshot) => panes.reconcile(snapshot));
  wss.on('connection', (ws, request) => {
    // Keep WebSocket alive across reverse-proxy idle timeouts (Cloudflare ~100s,
    // AWS ALB 60s, nginx 60s, etc.). Without app-level pings these connections
    // are silently torn down even when the UI is active, causing repeated
    // reconnect cycles. ws library heartbeat is opt-in.
    const HEARTBEAT_INTERVAL_MS = 30_000;
    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.ping();
        } catch {
          // socket may have been closed concurrently — interval will be cleared below
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    const stopHeartbeat = () => clearInterval(heartbeat);
    ws.on('close', stopHeartbeat);
    ws.on('error', stopHeartbeat);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      const principal = incomingRequest.user?.id ?? incomingRequest.user?.userId ?? incomingRequest.user?.username;
      handleShellConnection(ws, dependencies.shell, principal === undefined ? undefined : String(principal));
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, {
        ...dependencies.chat,
        handleDiscovery: (socket, data) => {
          if (discovery?.handle(socket, data)) return true;
          if (data.type === 'pane.subscribe') {
            try {
              panes.validateSubscription(data);
            } catch (error) {
              sendPaneProtocolError(socket, error);
              return true;
            }
            panes.start();
            void panes.subscribe(socket, data).catch((error: unknown) => sendPaneProtocolError(socket, error));
            return true;
          }
          if (data.type === 'pane.unsubscribe' && typeof data.subscriptionId === 'string') {
            panes.unsubscribe(socket, data.subscriptionId);
            return true;
          }
          return false;
        },
      });
      ws.on('close', () => {
        discovery?.close(ws);
        panes.close(ws);
      });
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
