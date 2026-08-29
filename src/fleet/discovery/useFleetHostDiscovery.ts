/**
 * Host availability and remote catalog material for the browser.
 *
 * The roster arrives over REST so the sidebar can render host groups on first
 * paint and after every reconnect; ordered snapshots and deltas arrive over the
 * existing browser websocket. A server without the fleet surface answers 404,
 * the catalog stays empty, and the sidebar renders exactly its pre-fleet self.
 *
 * The local host's own sessions are NOT read from here — they keep their existing
 * discovery stream with REST fallback. This hook only adds the host dimension.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { FLEET_PROTOCOL_VERSION } from '../../../shared/fleet';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { authenticatedFetch } from '../../utils/api';
import { adoptLocalHostIdentity } from '../useFleetIdentity';

import {
  applyHostFrame,
  EMPTY_FLEET_HOST_CATALOG,
  type FleetHostCatalog,
} from './hostCatalog';
import {
  FLEET_HOSTS_ENDPOINT,
  FLEET_RESYNC_MESSAGE,
  FLEET_SUBSCRIBE_MESSAGE,
  parseHostFrame,
  parseHostRoster,
} from './hostFrames';

export type FleetHostDiscovery = {
  readonly catalog: FleetHostCatalog;
  /** True once at least one host other than this installation is enrolled. */
  readonly hasRemoteHosts: boolean;
  readonly refresh: () => void;
};

export function useFleetHostDiscovery(): FleetHostDiscovery {
  const { isConnected, sendMessage, subscribe } = useWebSocket();
  const [catalog, setCatalog] = useState<FleetHostCatalog>(EMPTY_FLEET_HOST_CATALOG);
  // The frame handler runs outside React's render cycle and must read and write
  // the newest catalog synchronously, so the ref is the working copy.
  const catalogRef = useRef(catalog);
  const rosterGenerationRef = useRef(0);
  const rosterControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const publish = useCallback((next: FleetHostCatalog) => {
    catalogRef.current = next;
    setCatalog(next);
  }, []);

  const loadRoster = useCallback(async () => {
    const generation = ++rosterGenerationRef.current;
    rosterControllerRef.current?.abort();
    const controller = new AbortController();
    rosterControllerRef.current = controller;
    const usable = () => (
      mountedRef.current
      && !controller.signal.aborted
      && generation === rosterGenerationRef.current
    );
    try {
      const response = await authenticatedFetch(FLEET_HOSTS_ENDPOINT, { signal: controller.signal });
      // A deployment without peers, or without the fleet surface at all, is a
      // supported deployment: leave the catalog empty instead of guessing hosts.
      if (!response.ok || !usable()) return;
      const roster = parseHostRoster(await response.json());
      if (roster === null || !usable()) return;
      // The owner roster is the authoritative source for this installation's own
      // host id, so adopting it here is what lets host-qualified routing engage
      // (and legacy browser state migrate) without a second identity endpoint.
      if (roster.localHostId !== null) adoptLocalHostIdentity(roster.localHostId);
      publish(applyHostFrame(catalogRef.current, { kind: 'roster', ...roster }).catalog);
    } catch {
      // Offline hub, aborted request or unparsable body: the previously known
      // roster stays on screen rather than collapsing every host group.
    }
  }, [publish]);

  const applyFrame = useCallback((frame: unknown) => {
    const parsed = parseHostFrame(frame);
    if (parsed === null) return;
    const outcome = applyHostFrame(catalogRef.current, parsed);
    if (outcome.catalog !== catalogRef.current) publish(outcome.catalog);
    if (outcome.resyncHostId !== null) {
      sendMessage({
        type: FLEET_RESYNC_MESSAGE,
        hostId: outcome.resyncHostId,
        reason: 'gap',
      });
    }
  }, [publish, sendMessage]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // `mountedRef` alone fences publication; aborting only stops the request
      // that is already in flight.
      mountedRef.current = false;
      rosterControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'websocket_reconnected') {
        void loadRoster();
        sendMessage({ type: FLEET_SUBSCRIBE_MESSAGE, protocolVersion: FLEET_PROTOCOL_VERSION });
        return;
      }
      applyFrame(event);
    });
    return unsubscribe;
  }, [applyFrame, loadRoster, sendMessage, subscribe]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    if (!isConnected) return;
    sendMessage({ type: FLEET_SUBSCRIBE_MESSAGE, protocolVersion: FLEET_PROTOCOL_VERSION });
  }, [isConnected, sendMessage]);

  const refresh = useCallback(() => {
    void loadRoster();
    sendMessage({ type: FLEET_SUBSCRIBE_MESSAGE, protocolVersion: FLEET_PROTOCOL_VERSION });
  }, [loadRoster, sendMessage]);

  return {
    catalog,
    hasRemoteHosts: [...catalog.hosts.keys()].some((hostId) => hostId !== catalog.localHostId),
    refresh,
  };
}
