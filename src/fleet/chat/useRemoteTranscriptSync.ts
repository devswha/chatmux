/**
 * Keeps a peer session's transcript current while it is on screen.
 *
 * A local run streams its own events over the app websocket. A session owned by
 * a peer cannot: its run happens on that installation, and the hub only learns
 * about it through the peer's ordered catalog stream. The session row's activity
 * stamp is that signal, so every advance of it re-reads the host-qualified
 * transcript window — event-driven, never polled.
 *
 * An epoch change means the peer restarted or the stream gapped: continuity
 * cannot be assumed, so the window is re-read in full rather than trusted.
 */

import { useEffect, useRef } from 'react';

import type { FleetHostCatalog } from '../discovery/hostCatalog';
import { isLocalHostScope, type HostScope } from '../hostApi/urls';

export type RemoteTranscriptSyncInput = {
  readonly scope: HostScope;
  readonly sessionId: string | null;
  readonly catalog: FleetHostCatalog;
  readonly refresh: (sessionId: string) => Promise<unknown>;
};

type SyncMark = { readonly seen: boolean; readonly epoch: string | null; readonly activityMs: number };

const UNSEEN: SyncMark = { seen: false, epoch: null, activityMs: 0 };

export function useRemoteTranscriptSync(input: RemoteTranscriptSyncInput): void {
  const { scope, sessionId, catalog, refresh } = input;
  const markRef = useRef<SyncMark>(UNSEEN);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const isRemote = !isLocalHostScope(scope);
  const entry = scope.hostId === null ? undefined : catalog.hosts.get(scope.hostId);
  const row = entry?.rows.sessions.find((candidate) => candidate.localId === sessionId);
  const epoch = entry?.epoch ?? null;
  const activityMs = row?.lastActivityMs ?? 0;

  useEffect(() => {
    markRef.current = UNSEEN;
  }, [scope.hostId, sessionId]);

  useEffect(() => {
    if (!isRemote || sessionId === null || row === undefined) return;
    const previous = markRef.current;
    markRef.current = { seen: true, epoch, activityMs };
    // The first observation only records where this session already was: the
    // transcript on screen was fetched for exactly that state.
    if (!previous.seen) return;
    if (activityMs <= previous.activityMs && previous.epoch === epoch) return;
    void refreshRef.current(sessionId);
  }, [activityMs, epoch, isRemote, row, sessionId]);
}
