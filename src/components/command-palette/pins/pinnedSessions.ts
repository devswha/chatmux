import { hostQualifiedKey, parseHostId, parseLocalId } from '../../../fleet/references';

export const PINNED_SESSIONS_KEY = 'chatmux.pinnedSessions.v1';
export const MAX_PINNED_SESSIONS = 12;
// Enough for twelve maximum-length identities, including JSON escaping.
export const MAX_PINNED_STORAGE_LENGTH = 48 * 1024;

/** Navigation pointers only. Never persist labels, paths or action targets. */
export type PinnedSession = Readonly<{
  hostId: string;
  projectId: string;
  sessionId: string;
}>;

export type PinStorage = Pick<Storage, 'getItem' | 'setItem'>;

function pinLocalId(value: unknown): string | null {
  const id = parseLocalId(value);
  // Lone surrogates encode as replacement characters and would collide in keys.
  return id !== null && Array.from(id).every((character) => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  }) ? id : null;
}

export function parsePinnedSession(value: unknown): PinnedSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hostId = parseHostId(record.hostId);
  const projectId = pinLocalId(record.projectId);
  const sessionId = pinLocalId(record.sessionId);
  return hostId === null || projectId === null || sessionId === null
    ? null
    : { hostId, projectId, sessionId };
}

export function pinnedSessionKey(pin: PinnedSession): string {
  return hostQualifiedKey('pinned-session', [pin.hostId, pin.projectId, pin.sessionId]);
}

function validatedPins(values: readonly unknown[]): readonly PinnedSession[] {
  const pins = new Map<string, PinnedSession>();
  for (const value of values) {
    const pin = parsePinnedSession(value);
    if (pin !== null) pins.set(pinnedSessionKey(pin), pin);
    if (pins.size === MAX_PINNED_SESSIONS) break;
  }
  return [...pins.values()];
}

export function parsePinnedSessions(raw: string | null): readonly PinnedSession[] {
  if (raw === null || raw.length > MAX_PINNED_STORAGE_LENGTH) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
    const record = data as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.pins)) return [];
    // Reject an oversized list before walking attacker-controlled entries.
    return record.pins.length > MAX_PINNED_SESSIONS ? [] : validatedPins(record.pins);
  } catch {
    return [];
  }
}

export function browserPinStorage(): PinStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPinnedSessions(storage: PinStorage | null): readonly PinnedSession[] {
  try {
    return parsePinnedSessions(storage?.getItem(PINNED_SESSIONS_KEY) ?? null);
  } catch {
    return [];
  }
}

/** Rebuild every record at the write boundary so extra fields never reach disk. */
export function writePinnedSessions(storage: PinStorage | null, pins: readonly PinnedSession[]): boolean {
  try {
    if (storage === null) return false;
    storage.setItem(PINNED_SESSIONS_KEY, JSON.stringify({ version: 1, pins: validatedPins(pins) }));
    return true;
  } catch {
    return false;
  }
}

export function togglePinnedSession(pins: readonly PinnedSession[], value: unknown): readonly PinnedSession[] {
  const pin = parsePinnedSession(value);
  if (pin === null) return pins;
  const key = pinnedSessionKey(pin);
  if (pins.some((candidate) => pinnedSessionKey(candidate) === key)) {
    return pins.filter((candidate) => pinnedSessionKey(candidate) !== key);
  }
  return pins.length >= MAX_PINNED_SESSIONS ? pins : [...pins, pin];
}
