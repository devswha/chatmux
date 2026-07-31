export const PROVIDER_CONNECTION_ISSUE_CODES = [
  'agent_user_mismatch',
  'agent_home_mismatch',
  'agent_context_unreadable',
  'tmux_socket_owner_mismatch',
  'tmux_pane_ambiguous',
  'transcript_ambiguous',
  'transcript_permission_denied',
] as const;

export type ProviderConnectionIssue =
  typeof PROVIDER_CONNECTION_ISSUE_CODES[number];
