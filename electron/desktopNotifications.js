import { Notification } from 'electron';
import WebSocket from 'ws';

import { getTargetOrigin, getTargetPartition } from './targetSessions.js';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TARGET_NOTIFICATION_TIMEOUT_MS = 3000;

function toNotificationsWsUrl(target) {
  try {
    const parsed = new URL(getTargetOrigin(target));
    parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
    parsed.pathname = '/desktop-notifications';
    return parsed.toString();
  } catch {
    return null;
  }
}

function readJsonMessage(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function getTargetFromRegistryEntry(entry) {
  return {
    kind: 'remote',
    id: entry?.id,
    name: entry?.name,
    url: entry?.url,
  };
}

export class DesktopNotificationsController {
  constructor({ getRemoteTargets, getTargetSession, getActiveTargetId }) {
    this.getRemoteTargets = getRemoteTargets;
    this.getTargetSession = getTargetSession;
    this.getActiveTargetId = getActiveTargetId;
    this.connections = new Map();
    this.lastEvent = null;
    this.lastError = null;
  }

  getState() {
    const connectedTargetIds = [];
    for (const [targetId, connection] of this.connections.entries()) {
      if (connection.ws?.readyState === WebSocket.OPEN) {
        connectedTargetIds.push(targetId);
      }
    }

    return {
      supported: Notification.isSupported(),
      targetCount: this.connections.size,
      connectedCount: connectedTargetIds.length,
      connectedTargetIds,
      activeTargetId: this.getActiveTargetId?.() || null,
      lastEvent: this.lastEvent,
      lastError: this.lastError,
    };
  }

  async sync() {
    if (!Notification.isSupported()) {
      this.stop();
      this.lastEvent = 'unsupported';
      this.lastError = 'Native notifications are not supported on this system.';
      return;
    }

    const activeTargetId = this.getActiveTargetId?.();
    const activeTarget = (this.getRemoteTargets?.() || [])
      .map(getTargetFromRegistryEntry)
      .find((target) => target.id === activeTargetId);
    const targets = [];

    if (activeTarget) {
      const wsUrl = toNotificationsWsUrl(activeTarget);
      try {
        getTargetPartition(activeTarget);
        const targetSession = await Promise.resolve(this.getTargetSession?.(activeTarget.id, activeTarget));
        if (!targetSession) {
          throw new Error('Missing dedicated target session.');
        }
        if (!wsUrl) {
          throw new Error('Invalid target notification origin.');
        }
        targets.push({ target: activeTarget, wsUrl });
      } catch {
        this.lastEvent = 'invalid-target';
        this.lastError = `Refusing notifications for target ${String(activeTarget.id || '')}.`;
      }
    }

    const nextTargetIds = new Set(targets.map(({ target }) => target.id));
    for (const [targetId, connection] of this.connections.entries()) {
      if (!nextTargetIds.has(targetId)
        || connection.target.url !== targets.find(({ target }) => target.id === targetId)?.target.url) {
        this.closeConnection(connection);
        this.connections.delete(targetId);
      }
    }

    for (const connectionTarget of targets) {
      if (!this.connections.has(connectionTarget.target.id)) {
        void this.connect(connectionTarget).catch((error) => {
          this.lastEvent = 'connect-error';
          this.lastError = error instanceof Error ? error.message : String(error);
        });
      }
    }

    this.lastEvent = targets.length ? 'sync' : 'no-targets';
    if (targets.length) this.lastError = null;
  }


  async connect({ target, wsUrl }, attempt = 0) {
    const existing = this.connections.get(target.id);
    if (existing?.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(existing.ws.readyState)) {
      return;
    }

    const connection = {
      target,
      wsUrl,
      ws: null,
      reconnectTimer: null,
      closed: false,
      attempt,
    };
    this.connections.set(target.id, connection);
    const targetSession = await Promise.resolve(this.getTargetSession?.(target.id, target));
    if (!targetSession) {
      throw new Error(`Target ${target.id} does not have a dedicated session.`);
    }

    if (connection.closed || this.connections.get(target.id) !== connection) return;

    const ws = new WebSocket(wsUrl, { handshakeTimeout: TARGET_NOTIFICATION_TIMEOUT_MS });
    connection.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', targetId: target.id }));
      connection.attempt = 0;
      this.lastEvent = 'connected';
      this.lastError = null;
    });
    ws.on('message', (raw) => this.handleMessage(target, ws, raw));
    ws.on('close', () => this.scheduleReconnect(target.id));
    ws.on('error', (error) => {
      this.lastEvent = 'socket-error';
      this.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  handleMessage(target, ws, raw) {
    const message = readJsonMessage(raw);
    if (!message || message.type !== 'notification' || !message.payload) return;

    const notificationTargetId = message.targetId || message.payload?.data?.targetId;
    if (notificationTargetId !== target.id) {
      this.lastEvent = 'rejected-target-mismatch';
      return;
    }

    const shown = this.showNativeNotification(target, message.payload);
    if (shown && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'notification_ack',
        targetId: target.id,
        id: message.id || message.payload?.data?.tag || null,
        action: 'shown',
      }));
    }
  }

  showNativeNotification(target, payload) {
    if (!Notification.isSupported()) return false;

    const notification = new Notification({
      title: payload.title || target.name || 'ChatMux',
      body: payload.body || '',
      silent: false,
    });
    notification.on('click', () => {
      this.lastEvent = `clicked:${target.id}`;
    });
    notification.show();
    this.lastEvent = 'notification-shown';
    this.lastError = null;
    return true;
  }

  scheduleReconnect(targetId) {
    const connection = this.connections.get(targetId);
    if (!connection || connection.closed) return;

    const attempt = connection.attempt + 1;
    connection.attempt = attempt;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * (2 ** Math.min(attempt, 5)));
    connection.reconnectTimer = setTimeout(() => {
      if (!this.connections.has(targetId)) return;
      void this.connect({
        target: connection.target,
        wsUrl: connection.wsUrl,
      }, attempt).catch((error) => {
        this.lastEvent = 'connect-error';
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, delay);
    this.lastEvent = 'reconnecting';
  }

  closeConnection(connection) {
    connection.closed = true;
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    try {
      connection.ws?.close();
    } catch {
      // Best-effort shutdown; the socket may already be closed or destroyed.
    }
  }

  stop() {
    for (const connection of this.connections.values()) {
      this.closeConnection(connection);
    }
    this.connections.clear();
  }
}
