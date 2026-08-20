import {
  createContext, type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef,
} from 'react';

import { api } from '../../../utils/api';
import type {
  CompletionNotificationDescriptor, CompletionNotificationDevice, CompletionNotificationMutationConflict,
  CompletionNotificationMutationSuccess, CompletionNotificationStatus, CompletionNotificationTarget,
} from '../../../../shared/completion-notifications';
import type { CompletionNotificationDescriptorStatus, CompletionNotificationReason, CompletionNotificationsHookApi } from '../types/types';
export type { CompletionNotificationReason } from '../types/types';

const STATUS_BATCH_LIMIT = 200;
const NETWORK_TIMEOUT_MS = 15_000;
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

export const COMPLETION_NOTIFICATION_REASONS = [
  'settings_changed',
  'permission_denied',
  'permission_not_granted',
  'secure_context_required',
  'ios_install_required',
  'unsupported',
  'invalid_subscription',
  'target_unavailable',
  'request_failed',
  'refresh_failed',
  'timeout',
] as const satisfies readonly CompletionNotificationReason[];

class CompletionNotificationError extends Error {
  constructor(readonly reason: CompletionNotificationReason) {
    super(reason);
  }
}

type StoredRecord = {
  item: CompletionNotificationDescriptorStatus['item'];
  target: CompletionNotificationTarget | null;
  pending: boolean;
  error: CompletionNotificationReason | null;
  deviceRepairRequired: boolean;
};
type State = { records: ReadonlyMap<string, StoredRecord>; globalPaused: boolean; device: CompletionNotificationDevice | null };
type Action =
  | { type: 'status'; records: ReadonlyMap<string, Pick<StoredRecord, 'item' | 'target'>>; globalPaused: boolean; device: CompletionNotificationDevice; reason: CompletionNotificationReason | null; clearPending?: boolean; deviceRepairRequired?: boolean }
  | { type: 'pending'; key: string; pending: boolean }
  | { type: 'error'; key: string; error: CompletionNotificationReason | null }
  | { type: 'remove'; key: string };

const initialState: State = { records: new Map(), globalPaused: false, device: null };

export function completionNotificationReducer(state: State, action: Action): State {
  const records = new Map(state.records);
  if (action.type === 'status') {
    for (const [key, record] of action.records) {
      const current = records.get(key);
      // A passively detected permission denial only matters to sessions the
      // user actually watches; unwatched rows stay quiet instead of painting
      // every sidebar row with the same environmental error.
      const error = action.reason === 'permission_denied' && record.target?.watched !== true
        ? null
        : action.reason;
      records.set(key, {
        ...record,
        pending: action.clearPending ? false : (current?.pending ?? false),
        error,
        deviceRepairRequired: action.deviceRepairRequired === undefined
          ? (current?.deviceRepairRequired ?? false)
          : action.deviceRepairRequired && record.target?.watched === true,
      });
    }
    return { records, globalPaused: action.globalPaused, device: action.device };
  }
  if (action.type === 'remove') {
    records.delete(action.key);
    return { ...state, records };
  }
  const current = records.get(action.key) ?? {
    item: null, target: null, pending: false, error: null, deviceRepairRequired: false,
  };
  records.set(action.key, action.type === 'pending'
    ? { ...current, pending: action.pending }
    : { ...current, error: action.error, pending: false });
  return { ...state, records };
}

/** Length-prefixed fixed fields mirror the server identity framing and cannot collide. */
function frame(fields: readonly string[]): string {
  return fields.map((field) => `${new TextEncoder().encode(field).length}:${field}`).join('');
}
function externalFields(session: Record<string, unknown>): string[] {
  const tmux = session.tmux as Record<string, unknown> | undefined;
  return [
    String(session.kind ?? ''), String(tmux?.socketPath ?? ''), String(tmux?.sessionId ?? ''),
    String(tmux?.windowId ?? ''), String(tmux?.paneId ?? ''), String(session.agentPid ?? ''),
    String(session.startedAtMs ?? ''),
  ];
}
export function completionNotificationDescriptorKey(descriptor: CompletionNotificationDescriptor): string {
  return descriptor.kind === 'app'
    ? `app:${frame([descriptor.provider, descriptor.sessionId])}`
    : `external_generation:${frame(externalFields(descriptor.session))}`;
}
function uniqueDescriptors(descriptors: Iterable<CompletionNotificationDescriptor>) {
  const result = new Map<string, CompletionNotificationDescriptor>();
  for (const descriptor of descriptors) result.set(completionNotificationDescriptorKey(descriptor), descriptor);
  return [...result.entries()];
}
async function errorFor(response: Response) {
  if (response.status !== 409) return new CompletionNotificationError('request_failed');
  let conflict: CompletionNotificationMutationConflict | null = null;
  try {
    conflict = await response.json() as CompletionNotificationMutationConflict;
  } catch {
    // A malformed conflict response remains a visible request error.
  }
  return new CompletionNotificationError(
    conflict?.error === 'revision_conflict' || conflict?.error === 'mutation_replay_conflict'
      ? 'settings_changed'
      : 'request_failed',
  );
}

function reasonFor(error: unknown, fallback: CompletionNotificationReason) {
  return error instanceof CompletionNotificationError ? error.reason : fallback;
}
export function canCommitPassiveCompletionNotificationStatus(
  versionCurrent: boolean,
  readCurrent: boolean,
  hasActiveOperation: boolean,
  snapshotCurrent = true,
) {
  return versionCurrent && readCurrent && !hasActiveOperation && snapshotCurrent;
}

async function json<T>(request: Promise<Response>) {
  const response = await request;
  if (!response.ok) throw await errorFor(response);
  return response.json() as Promise<T>;
}
function deadline<T>(request: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, timeoutMs = NETWORK_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  let rejectCancelled!: (reason?: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const abort = () => {
    const reason = parent?.reason ?? new DOMException('Aborted', 'AbortError');
    controller.abort(reason);
    rejectCancelled(reason);
  };
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  let timer: number;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      const error = new CompletionNotificationError('timeout');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([request(controller.signal), cancelled, timeout]).finally(() => {
    window.clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  });
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal, message: string, timeoutMs = NETWORK_TIMEOUT_MS): Promise<T> {
  return deadline(async (timeoutSignal) => {
    if (signal.aborted) throw signal.reason;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => timeoutSignal.addEventListener('abort', () => reject(
        timeoutSignal.reason ?? new DOMException(message, 'AbortError'),
      ), { once: true })),
    ]);
  }, signal, timeoutMs);
}
function isIosBrowserTab() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone;
  return ios && !standalone;
}
function requirePushEnvironment() {
  if (!window.isSecureContext) throw new CompletionNotificationError('secure_context_required');
  if (isIosBrowserTab()) throw new CompletionNotificationError('ios_install_required');
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) throw new CompletionNotificationError('unsupported');
}
function payload(subscription: PushSubscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new CompletionNotificationError('invalid_subscription');
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}
function vapidKey(value: string) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export function applicationServerKeysEqual(
  actual: BufferSource | null | undefined,
  expected: Uint8Array,
) {
  if (!actual) return false;
  const bytes = ArrayBuffer.isView(actual)
    ? new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength)
    : new Uint8Array(actual);
  return bytes.byteLength === expected.byteLength
    && bytes.every((value, index) => value === expected[index]);
}

function mutationId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
}
export type ClickGatedPreparation<T> = {
  consume: () => Promise<T>;
  abandon: () => void;
};

/**
 * Owns a click-gated operation from its synchronous start through abandonment.
 * The rejection observers are attached in the same turn as the factory call so
 * a later status failure cannot produce an unhandled browser-permission rejection.
 */
export function startClickGatedPreparation<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
): ClickGatedPreparation<T> {
  const controller = new AbortController();
  let rejectAbandoned!: (reason: unknown) => void;
  const abandoned = new Promise<never>((_, reject) => { rejectAbandoned = reject; });
  const abort = () => {
    if (controller.signal.aborted) return;
    const reason = parentSignal.reason ?? new DOMException('Aborted', 'AbortError');
    controller.abort(reason);
    rejectAbandoned(reason);
  };
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });

  let preparation: Promise<T>;
  try {
    preparation = Promise.resolve(factory(controller.signal));
  } catch (error) {
    preparation = Promise.reject(error);
  }
  // Keep the original promise observed without changing the error consume() receives.
  void preparation.catch(() => undefined);
  const settled = Promise.race([preparation, abandoned]);
  // abandon() may settle this before a caller reaches consume().
  void settled.catch(() => undefined);
  const removeParentAbortListener = () => parentSignal.removeEventListener('abort', abort);
  void settled.then(removeParentAbortListener, removeParentAbortListener);

  return { consume: () => settled, abandon: abort };
}
type ContextValue = CompletionNotificationsHookApi & { registerDescriptors: (descriptors: readonly CompletionNotificationDescriptor[]) => () => void };
export const CompletionNotificationsContext = createContext<ContextValue | null>(null);

export function CompletionNotificationsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(completionNotificationReducer, initialState);
  const stateRef = useRef(state);
  const descriptorsRef = useRef(new Map<string, CompletionNotificationDescriptor>());
  const versionsRef = useRef(new Map<string, number>());
  const deviceSnapshotVersionRef = useRef(0);
  const operationsRef = useRef(new Map<string, AbortController>());
  const passiveReadsRef = useRef(new Map<string, { controller: AbortController; epoch: number }>());
  const passiveEpochsRef = useRef(new Map<string, number>());
  const registrationsRef = useRef(new Map<number, string[]>());
  const nextRegistrationRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  stateRef.current = state;

  const current = useCallback((key: string, version: number, controller?: AbortController) =>
    versionsRef.current.get(key) === version && !controller?.signal.aborted, []);
  const abortPassiveRead = useCallback((key: string) => {
    passiveReadsRef.current.get(key)?.controller.abort();
    passiveReadsRef.current.delete(key);
    passiveEpochsRef.current.set(key, (passiveEpochsRef.current.get(key) ?? 0) + 1);
  }, []);


  const passiveSubscription = useCallback(async (isLive: () => boolean) => {
    if (!isLive() || !('serviceWorker' in navigator)) return undefined;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!isLive() || !registration) return undefined;
    const subscription = await registration.pushManager.getSubscription();
    if (!isLive() || !subscription) return undefined;
    return {
      endpoint: subscription.endpoint,
      applicationServerKey: subscription.options.applicationServerKey,
    };
  }, []);

  const requestStatus = useCallback(async (
    entries: readonly [string, CompletionNotificationDescriptor][],
    signal?: AbortSignal,
    endpoint?: string,
    clearPending = false,
    reason: CompletionNotificationReason | null = null,
  ) => {
    const versions = new Map(entries.map(([key]) => [key, versionsRef.current.get(key) ?? 0]));
    const snapshotVersion = deviceSnapshotVersionRef.current;
    const passive = !signal;
    const requestController = passive ? new AbortController() : undefined;
    const reads = new Map<string, { controller: AbortController; epoch: number }>();
    if (passive) {
      for (const [key] of entries) {
        abortPassiveRead(key);
        const read = {
          controller: new AbortController(),
          epoch: (passiveEpochsRef.current.get(key) ?? 0) + 1,
        };
        passiveEpochsRef.current.set(key, read.epoch);
        passiveReadsRef.current.set(key, read);
        reads.set(key, read);
      }
    }
    const isCurrent = (key: string) => {
      const versionCurrent = (versionsRef.current.get(key) ?? 0) === versions.get(key);
      if (signal) return versionCurrent && !signal.aborted;
      return canCommitPassiveCompletionNotificationStatus(
        versionCurrent,
        passiveReadsRef.current.get(key) === reads.get(key)
          && passiveEpochsRef.current.get(key) === reads.get(key)?.epoch
          && !reads.get(key)?.controller.signal.aborted,
        operationsRef.current.has(key),
        deviceSnapshotVersionRef.current === snapshotVersion,
      );
    };
    const requestSignal = signal ?? requestController!.signal;
    const hasLiveEntry = () => entries.some(([key]) => isCurrent(key));
    if (passive) {
      for (const { controller } of reads.values()) {
        controller.signal.addEventListener('abort', () => {
          if (!hasLiveEntry()) requestController!.abort();
        }, { once: true });
      }
    }
    try {
      const localSubscription = endpoint === undefined
        ? await bounded(passiveSubscription(hasLiveEntry), requestSignal, 'Push subscription lookup timed out.')
        : undefined;
      const resolvedEndpoint = endpoint ?? localSubscription?.endpoint;
      if (!entries.some(([key]) => isCurrent(key))) return undefined;
      const result = await deadline((networkSignal) => json<CompletionNotificationStatus>(
        api.completionNotifications.status(entries.map(([, descriptor]) => descriptor), resolvedEndpoint, { signal: networkSignal }),
      ), requestSignal);
      if (!entries.some(([key]) => isCurrent(key))) return undefined;
      const records = new Map<string, Pick<StoredRecord, 'item' | 'target'>>();
      entries.forEach(([key], index) => {
        if (!isCurrent(key)) return;
        const item = result.targets[index] ?? null;
        records.set(key, { item, target: item?.target ?? null });
      });
      let hasWatchedTarget = false;
      for (const record of records.values()) {
        if (record.target?.watched === true) {
          hasWatchedTarget = true;
          break;
        }
      }
      const deviceRequiresRegistration = result.device.setupRequired || !result.device.registered;
      let deviceRepairRequired: boolean | undefined = hasWatchedTarget && deviceRequiresRegistration
        ? true
        : passive && localSubscription && hasWatchedTarget
          ? undefined
          : false;
      if (passive && localSubscription && hasWatchedTarget) {
        try {
          const vapid = await deadline((networkSignal) => json<{ publicKey: string }>(
            api.completionNotifications.vapidPublicKey({ signal: networkSignal }),
          ), requestSignal);
          if (!entries.some(([key]) => isCurrent(key))) return undefined;
          deviceRepairRequired = deviceRepairRequired === true || !applicationServerKeysEqual(
            localSubscription.applicationServerKey,
            vapidKey(vapid.publicKey),
          );
        } catch {
          // Status remains useful when a passive VAPID comparison cannot complete.
          if (!entries.some(([key]) => isCurrent(key))) return undefined;
        }
      }
      if (records.size && entries.some(([key]) => isCurrent(key))) {
        const statusReason = reason ?? (typeof Notification !== 'undefined' && Notification.permission === 'denied'
          ? 'permission_denied' as const
          : null);
        dispatch({
          type: 'status',
          records,
          globalPaused: result.globalPaused,
          device: result.device,
          reason: statusReason,
          clearPending,
          deviceRepairRequired,
        });
      }
      return { result, records, endpoint: resolvedEndpoint };
    } catch (error) {
      if (!passive) throw error;
      for (const [key] of entries) {
        if (isCurrent(key)) {
          dispatch({ type: 'error', key, error: reasonFor(error, 'refresh_failed') });
        }
      }
      return undefined;
    }
  }, [abortPassiveRead, passiveSubscription]);
  const refresh = useCallback(async () => {
    const entries = uniqueDescriptors(descriptorsRef.current.values());
    for (let index = 0; index < entries.length; index += STATUS_BATCH_LIMIT) {
      await requestStatus(entries.slice(index, index + STATUS_BATCH_LIMIT));
    }
  }, [requestStatus]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void refresh(); }, 0);
  }, [refresh]);

  const registerDescriptors = useCallback((descriptors: readonly CompletionNotificationDescriptor[]) => {
    const id = ++nextRegistrationRef.current;
    const entries = uniqueDescriptors(descriptors);
    registrationsRef.current.set(id, entries.map(([key]) => key));
    for (const [key, descriptor] of entries) {
      abortPassiveRead(key);
      descriptorsRef.current.set(key, descriptor);
    }
    scheduleRefresh();
    return () => {
      const keys = registrationsRef.current.get(id) ?? [];
      registrationsRef.current.delete(id);
      for (const key of keys) {
        if (![...registrationsRef.current.values()].some((registered) => registered.includes(key))) {
          descriptorsRef.current.delete(key);
          versionsRef.current.set(key, (versionsRef.current.get(key) ?? 0) + 1);
          operationsRef.current.get(key)?.abort();
          operationsRef.current.delete(key);
          abortPassiveRead(key);
          dispatch({ type: 'remove', key });
        }
      }
    };
  }, [abortPassiveRead, scheduleRefresh]);

  const prepareDevice = useCallback(async (signal: AbortSignal) => {
    requirePushEnvironment();
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (permission !== 'granted') throw new CompletionNotificationError(permission === 'denied' ? 'permission_denied' : 'permission_not_granted');
    const registration = await bounded(navigator.serviceWorker.ready, signal, 'Service worker readiness timed out.', SERVICE_WORKER_READY_TIMEOUT_MS);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const vapid = await deadline((requestSignal) => json<{ publicKey: string }>(api.completionNotifications.vapidPublicKey({ signal: requestSignal })), signal);
    const expectedApplicationServerKey = vapidKey(vapid.publicKey);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let subscription = await bounded(registration.pushManager.getSubscription(), signal, 'Push subscription lookup timed out.');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (subscription && !applicationServerKeysEqual(
      subscription.options.applicationServerKey,
      expectedApplicationServerKey,
    )) {
      const removed = await bounded(subscription.unsubscribe(), signal, 'Stale push subscription removal timed out.');
      if (!removed) throw new CompletionNotificationError('invalid_subscription');
      subscription = null;
    }
    if (!subscription) {
      subscription = await bounded(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedApplicationServerKey }), signal, 'Push subscription setup timed out.');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    return payload(subscription);
  }, []);

  const setWatch = useCallback(async (descriptor: CompletionNotificationDescriptor, watched: boolean, repair = false) => {
    const key = completionNotificationDescriptorKey(descriptor);
    operationsRef.current.get(key)?.abort();
    abortPassiveRead(key);
    const controller = new AbortController();
    operationsRef.current.set(key, controller);
    const version = (versionsRef.current.get(key) ?? 0) + 1;
    versionsRef.current.set(key, version);
    deviceSnapshotVersionRef.current += 1;
    descriptorsRef.current.set(key, descriptor);
    dispatch({ type: 'pending', key, pending: true });
    let devicePreparation: ClickGatedPreparation<ReturnType<typeof payload>> | null = null;
    try {
      // Start click-gated browser preparation before awaiting status or any network work.
      devicePreparation = watched || repair
        ? startClickGatedPreparation((signal) => prepareDevice(signal), controller.signal)
        : null;
      const initial = await requestStatus([[key, descriptor]], controller.signal);
      if (!initial || !current(key, version, controller)) return;
      const target = initial.records.get(key)?.target;
      if (!target) throw new CompletionNotificationError('target_unavailable');
      const desiredWatched = repair ? target.watched : watched;
      let endpoint = initial.endpoint;
      if (devicePreparation) {
        const subscription = await devicePreparation.consume();
        if (!current(key, version, controller)) return;
        endpoint = subscription.endpoint;
        const latest = await requestStatus([[key, descriptor]], controller.signal, endpoint);
        if (!latest || !current(key, version, controller)) return;
        // Required setup is explicit; silent registration only applies to a configured device missing an endpoint.
        if (latest.result.device.setupRequired) {
          await deadline((requestSignal) => json(
            api.completionNotifications.subscribe(subscription, { signal: requestSignal }),
          ), controller.signal);
          if (!current(key, version, controller)) return;
        } else if (!latest.result.device.registered) {
          await deadline((requestSignal) => json(
            api.completionNotifications.register(subscription, { signal: requestSignal }),
          ), controller.signal);
          if (!current(key, version, controller)) return;
        }
      }
      const snapshot = target;
      const result = await deadline((requestSignal) => json<CompletionNotificationMutationSuccess>(
        api.completionNotifications.setWatch({ alias: snapshot.alias, expectedRevision: snapshot.revision, mutationId: mutationId(), watched: desiredWatched }, endpoint, { signal: requestSignal }),
      ), controller.signal);
      if (!current(key, version, controller)) return;
      deviceSnapshotVersionRef.current += 1;
      dispatch({ type: 'status', records: new Map([[key, { item: { alias: result.target.alias, mappingState: 'one_active', reason: 'eligible', target: result.target }, target: result.target }]]), globalPaused: result.globalPaused, device: result.device, reason: typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'permission_denied' : null, clearPending: true });
      // Multiple live panes can point at the same provider conversation. Their
      // opaque generation aliases share one app-scoped watch, so refresh every
      // registered descriptor after a successful toggle to keep all bells in sync.
      scheduleRefresh();
    } catch (error) {
      devicePreparation?.abandon();
      if (!current(key, version, controller)) return;
      let failure: unknown = error;
      if (error instanceof CompletionNotificationError && error.reason === 'settings_changed') {
        try {
          const refreshed = await requestStatus([[key, descriptor]], controller.signal, undefined, true, 'settings_changed');
          if (refreshed) return;
        } catch (refreshError) {
          failure = refreshError;
        }
      }
      if (current(key, version, controller)) dispatch({ type: 'error', key, error: reasonFor(failure, 'request_failed') });
    } finally {
      devicePreparation?.abandon();
      if (operationsRef.current.get(key) === controller) operationsRef.current.delete(key);
    }
  }, [abortPassiveRead, current, prepareDevice, requestStatus, scheduleRefresh]);

  const repairDevice = useCallback((descriptor: CompletionNotificationDescriptor) => {
    const key = completionNotificationDescriptorKey(descriptor);
    return setWatch(descriptor, stateRef.current.records.get(key)?.target?.watched ?? false, true);
  }, [setWatch]);

  useEffect(() => {
    const operations = operationsRef.current;
    const passiveReads = passiveReadsRef.current;
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      for (const controller of operations.values()) controller.abort();
      for (const { controller } of passiveReads.values()) controller.abort();
      passiveReads.clear();
    };
  }, [refresh]);

  const statuses = useMemo(() => new Map([...state.records].map(([key, record]) => [key, {
    ...record, device: state.device, globalPaused: state.globalPaused,
  }])), [state]);
  const value = useMemo<ContextValue>(() => ({
    registerDescriptors, status: null, statuses, setWatch, repairDevice, refresh,
  }), [refresh, registerDescriptors, repairDevice, setWatch, statuses]);
  return <CompletionNotificationsContext.Provider value={value}>{children}</CompletionNotificationsContext.Provider>;
}
