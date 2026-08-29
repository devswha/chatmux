function parsePersistedJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export function parsePersistedObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : null;
}

export function parsePersistedRecord(raw: string): Readonly<Record<string, unknown>> | null {
  return parsePersistedObject(parsePersistedJson(raw));
}

export function parsePersistedArray(raw: string): readonly unknown[] | null {
  const parsed = parsePersistedJson(raw);
  return Array.isArray(parsed) ? parsed : null;
}
