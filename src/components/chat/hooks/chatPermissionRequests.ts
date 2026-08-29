/**
 * Pending-permission list transitions for the chat realtime handlers.
 *
 * The ack (`chat_subscribed`) carries the authoritative list; a live
 * `permission_request` appends once per request id; `permission_cancelled`
 * drops it. `ExitPlanMode` is terminal, not actionable, so it never re-arms
 * the notification sound. Split from the former `useChatRealtimeHandlers.ts`.
 */

import type { PendingPermissionRequest } from '../types/types';

export const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

export const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

export type PendingPermissionTransition = {
  requests: PendingPermissionRequest[];
  /** A newly actionable request appeared; the notification sound should re-arm. */
  notify: boolean;
};

/** Replaces the pending list with the ack's authoritative one. */
export function reconcilePendingPermissions(
  current: PendingPermissionRequest[],
  next: PendingPermissionRequest[],
): PendingPermissionTransition {
  return {
    requests: next,
    notify: hasActionablePermissionRequests(next) && !hasActionablePermissionRequests(current),
  };
}

/** Appends a live permission request at most once per request id. */
export function appendPendingPermission(
  current: PendingPermissionRequest[],
  request: PendingPermissionRequest,
): PendingPermissionTransition {
  if (current.some((candidate) => candidate.requestId === request.requestId)) {
    return { requests: current, notify: false };
  }
  return { requests: [...current, request], notify: false };
}

/** Drops a cancelled permission request. */
export function dropPendingPermission(
  current: PendingPermissionRequest[],
  requestId: unknown,
): PendingPermissionTransition {
  return {
    requests: current.filter((request) => request.requestId !== requestId),
    notify: false,
  };
}
