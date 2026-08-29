export const FLEET_PAIRING_FAILURE_LIMIT = 5 as const;
export const FLEET_PAIRING_FAILURE_WINDOW_MS = 60_000 as const;

type FailureWindow = {
  count: number;
  readonly resetAtMs: number;
};

type LimiterDependencies = Readonly<{
  now?: () => number;
}>;

export type FleetPairingAdmission =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export class FleetPairingFailureLimiter {
  /** Mutable counters are the limiter's state. */
  private readonly failures = new Map<string, FailureWindow>();

  constructor(private readonly dependencies: LimiterDependencies = {}) {}

  admit(key: string): FleetPairingAdmission {
    const nowMs = this.dependencies.now?.() ?? Date.now();
    const window = this.failures.get(key);
    if (window === undefined || window.resetAtMs <= nowMs) {
      if (window !== undefined) this.failures.delete(key);
      return { allowed: true };
    }
    if (window.count < FLEET_PAIRING_FAILURE_LIMIT) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((window.resetAtMs - nowMs) / 1_000),
    };
  }

  recordFailure(key: string): void {
    const nowMs = this.dependencies.now?.() ?? Date.now();
    const window = this.failures.get(key);
    if (window === undefined || window.resetAtMs <= nowMs) {
      this.failures.set(key, { count: 1, resetAtMs: nowMs + FLEET_PAIRING_FAILURE_WINDOW_MS });
      return;
    }
    window.count += 1;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}
