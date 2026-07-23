export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  tailscaleNotConfigured: 'Tailscale access is not configured on this server.',
  tailscaleAccessDenied: 'This Tailscale account is not allowed to access ChatMux.',
} as const;
