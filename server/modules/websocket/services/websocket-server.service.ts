import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { createDiscoveryStream } from '@/modules/websocket/services/discovery-stream.service.js';
import type { DiscoveryCollector } from '@/modules/providers/index.js';
import { createPaneOutputStream } from '@/modules/providers/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { spawnHerdrController, type HerdrControlBridge } from '@/modules/terminal-runtimes/index.js';
import type { HerdrControllerProcess } from '@/modules/websocket/services/shell-websocket.service.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  discovery?: DiscoveryCollector;
  panes?: ReturnType<typeof createPaneOutputStream>;
  herdrControl?: HerdrControlBridge;
  spawnHerdrController?: (command: string, args: string[]) => HerdrControllerProcess;
  /** Identity announced to every chat client so stale bundles can self-refresh. */
  serverInfo?: { version: string | null; bootId: string };
};
function sendPaneProtocolError(ws: WebSocket, error: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  const reloadRequired = error instanceof Error && error.message === 'CLIENT_RELOAD_REQUIRED';
  ws.send(JSON.stringify({
    kind: 'protocol_error',
    code: reloadRequired ? 'CLIENT_RELOAD_REQUIRED' : 'INVALID_PANE_SUBSCRIPTION',
    error: reloadRequired ? 'CLIENT_RELOAD_REQUIRED' : error instanceof Error ? error.message : 'Invalid pane subscription.',
    ...(reloadRequired ? { reloadRequired: true } : {}),
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
    let isAlive = true;
    ws.on('pong', () => { isAlive = true; });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      // A peer that missed an entire ping cycle is gone (phone lost signal,
      // proxy dropped the link): terminate now so PTY/chat bindings detach
      // promptly instead of waiting for the OS TCP timeout.
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      try {
        ws.ping();
      } catch {
        // socket may have been closed concurrently — interval will be cleared below
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
      handleShellConnection(ws, {
        ...dependencies.shell,
        herdrControl: dependencies.herdrControl ?? dependencies.shell.herdrControl,
        spawnHerdrController: dependencies.spawnHerdrController ?? dependencies.shell.spawnHerdrController ?? spawnHerdrController,
      }, principal === undefined ? undefined : String(principal));
      return;
    }

    if (pathname === '/ws') {
      // First frame on the app socket: lets a client that survived a server
      // update detect the version skew immediately on (re)connect instead of
      // waiting for the next /health poll.
      if (dependencies.serverInfo && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          kind: 'server_hello',
          serverVersion: dependencies.serverInfo.version,
          bootId: dependencies.serverInfo.bootId,
          timestamp: new Date().toISOString(),
        }));
      }
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

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
