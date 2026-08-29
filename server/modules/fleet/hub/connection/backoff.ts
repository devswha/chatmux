const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export function reconnectDelayMs(attempt: number, random: number): number {
  const base = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * (2 ** Math.min(attempt, 5)));
  const jittered = Math.round(base * (0.5 + Math.min(1, Math.max(0, random))));
  return Math.min(MAX_RECONNECT_MS, Math.max(MIN_RECONNECT_MS, jittered));
}
