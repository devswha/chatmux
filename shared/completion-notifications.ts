export const COMPLETION_NOTIFICATION_MAPPING_STATES = [
  'none',
  'one_active',
  'ambiguous_active',
  'inactive_match',
] as const;

export type CompletionNotificationMappingState =
  (typeof COMPLETION_NOTIFICATION_MAPPING_STATES)[number];

export const COMPLETION_NOTIFICATION_DELIVERY_STATES = [
  'pending',
  'claimed',
  'transient_retry',
  'paused_global',
  'acknowledged',
  'endpoint_removed',
  'permanent_failed',
] as const;

export type CompletionNotificationDeliveryState =
  (typeof COMPLETION_NOTIFICATION_DELIVERY_STATES)[number];

export const COMPLETION_NOTIFICATION_EVENT_CODES = ['reply_ready'] as const;
export type CompletionNotificationEventCode =
  (typeof COMPLETION_NOTIFICATION_EVENT_CODES)[number];

export type CompletionNotificationTargetKind = 'app' | 'external_generation';

export type CompletionNotificationDescriptor =
  | { kind: 'app'; provider: string; sessionId: string }
  | { kind: 'external_generation'; session: Record<string, unknown> };

/** Browser-safe target identity only; raw process, path, and transcript identity stay server-side. */
export type CompletionNotificationTarget = {
  alias: string;
  kind: CompletionNotificationTargetKind;
  revision: number;
  watched: boolean;
};

export type CompletionNotificationStatusReason =
  | 'eligible'
  | 'identity_ambiguous'
  | 'identity_inactive'
  | 'not_found';

export type CompletionNotificationStatusItem =
  | {
    alias: string;
    mappingState: 'one_active' | 'none';
    reason: 'eligible';
    target: CompletionNotificationTarget;
  }
  | {
    alias: string;
    mappingState: 'none';
    reason: 'not_found';
    target?: never;
  }
  | {
    alias: string;
    mappingState: 'ambiguous_active';
    reason: 'identity_ambiguous';
    target?: never;
  }
  | {
    alias: string;
    mappingState: 'inactive_match';
    reason: 'identity_inactive';
    target?: never;
  };

export type CompletionNotificationDeviceReason =
  | 'device_endpoint_missing'
  | 'endpoint_not_registered';

export type CompletionNotificationDevice = {
  supported: boolean;
  registered: boolean;
  setupRequired: boolean;
  reason: CompletionNotificationDeviceReason | null;
};

export type CompletionNotificationStatus = {
  globalPaused: boolean;
  targets: CompletionNotificationStatusItem[];
  device: CompletionNotificationDevice;
};

export type CompletionNotificationMutation = {
  alias: string;
  expectedRevision: number;
  mutationId: string;
  watched: boolean;
};

export type CompletionNotificationMutationSuccess = {
  target: CompletionNotificationTarget;
  globalPaused: boolean;
  device: CompletionNotificationDevice;
};

export type CompletionNotificationMutationConflict =
  | {
    error: 'revision_conflict';
    target: CompletionNotificationTarget;
    globalPaused: boolean;
    device: CompletionNotificationDevice;
  }
  | {
    error: 'identity_ambiguous' | 'identity_inactive' | 'mutation_replay_conflict';
    target: null;
    globalPaused: boolean;
    device: CompletionNotificationDevice;
  };

export type CompletionNotificationMutationResult =
  | { ok: true; target: CompletionNotificationTarget; globalPaused: boolean }
  | {
    ok: false;
    reason: 'revision_conflict';
    target: CompletionNotificationTarget;
  }
  | {
    ok: false;
    reason: 'not_found' | 'identity_ambiguous' | 'identity_inactive' | 'mutation_replay_conflict';
  };

export type CompletionNotificationNavigation = {
  readonly href: string;
  readonly title: string;
  readonly hostId?: string | null;
  readonly sessionId?: string | null;
};

export type CompletionNotificationPayload = {
  title: string;
  body: string;
  tag: string;
  navigation: CompletionNotificationNavigation;
};
