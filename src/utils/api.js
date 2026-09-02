const AUTH_BOOTSTRAP_TIMEOUT_MS = 10_000;

const withBootstrapTimeout = (request, externalSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, AUTH_BOOTSTRAP_TIMEOUT_MS);
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();

  return request(controller.signal).finally(() => {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  });
};

// Authenticated API calls carry the httpOnly session cookie (same-origin) and
// nothing else: the browser never holds the JWT, so there is no Bearer header
// to attach and the server slides the cookie itself while it is used.
export const authenticatedFetch = (url, options = {}) => {
  const defaultHeaders = {};

  // Add JSON content type only when a JSON-compatible body is actually present.
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  return fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  });
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: (options = {}) => withBootstrapTimeout(
      (signal) => fetch('/api/auth/status', { ...options, signal, credentials: 'same-origin' }),
      options.signal,
    ),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: (options = {}) => withBootstrapTimeout(
      (signal) => authenticatedFetch('/api/auth/user', { ...options, signal }),
      options.signal,
    ),
    logout: (options = {}) => authenticatedFetch('/api/auth/logout', { method: 'POST', ...options }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  access: {
    get: () => authenticatedFetch('/api/settings/access'),
    network: () => authenticatedFetch('/api/system/access-info'),
    allow: (login) => authenticatedFetch('/api/settings/access/users', {
      method: 'POST',
      body: JSON.stringify({ login }),
    }),
    revoke: (login) => authenticatedFetch(`/api/settings/access/users/${encodeURIComponent(login)}`, {
      method: 'DELETE',
    }),
  },
  projects: () => authenticatedFetch('/api/projects?skipSynchronization=1'),
  // Stores pasted/dropped relay images in the shared `~/.chatmux/assets`
  // store and returns their absolute paths — the only upload path the live
  // relay composer uses (B10: no bespoke upload endpoint).
  /**
   * @param {File[]} files
   */
  uploadImageAssets: (files) => {
    const formData = new FormData();
    files.forEach((file) => formData.append('images', file));
    return authenticatedFetch('/api/assets/images', {
      method: 'POST',
      body: formData,
    });
  },
  // Session ids currently live in a tmux gjc pane (tmux+lsof; [] when no tmux).
  liveSessions: (signal) => authenticatedFetch('/api/providers/sessions/live', signal === undefined ? undefined : { signal }),
  // Exact-pane actions carry both tmux identity and agent-process generation.
  liveSessionSend: (tmux, process, message) =>
    authenticatedFetch('/api/providers/sessions/live/send', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, message }),
    }),
  liveSessionInteractivePrompt: (tmux, process, options = {}) =>
    authenticatedFetch('/api/providers/sessions/live/interactive', {
      ...options,
      method: 'POST',
      body: JSON.stringify({ tmux, process }),
    }),
  liveSessionInteractiveRespond: (tmux, process, promptId, choices) =>
    authenticatedFetch('/api/providers/sessions/live/interactive/respond', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, promptId, choices }),
    }),
  liveSessionInteractiveCustom: (tmux, process, promptId, message) =>
    authenticatedFetch('/api/providers/sessions/live/interactive/custom', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, promptId, message }),
    }),
  liveSessionAskSelect: (tmux, process, sessionId, toolId, optionIndex) =>
    authenticatedFetch('/api/providers/sessions/live/ask', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, sessionId, toolId, optionIndex }),
    }),
  liveSessionAskCustom: (tmux, process, sessionId, toolId, message) =>
    authenticatedFetch('/api/providers/sessions/live/ask/custom', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, sessionId, toolId, message }),
    }),
  liveSessionAction: (tmux, process, action) =>
    authenticatedFetch('/api/providers/sessions/live/actions', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, action }),
    }),
  liveSessionOutput: (tmux, process, options = {}) =>
    authenticatedFetch('/api/providers/sessions/live/output', {
      ...options,
      method: 'POST',
      body: JSON.stringify({ tmux, process }),
    }),
  externalCliSessionSend: (tmux, process, message) =>
    authenticatedFetch('/api/providers/sessions/external/send', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, message }),
    }),
  externalCliSessionInteractivePrompt: (tmux, process, options = {}) =>
    authenticatedFetch('/api/providers/sessions/external/interactive', {
      ...options,
      method: 'POST',
      body: JSON.stringify({ tmux, process }),
    }),
  externalCliSessionInteractiveRespond: (tmux, process, promptId, choices) =>
    authenticatedFetch('/api/providers/sessions/external/interactive/respond', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, promptId, choices }),
    }),
  externalCliSessionInteractiveCustom: (tmux, process, promptId, message) =>
    authenticatedFetch('/api/providers/sessions/external/interactive/custom', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, promptId, message }),
    }),
  externalCliSessionAskSelect: (tmux, process, sessionId, toolId, optionIndex) =>
    authenticatedFetch('/api/providers/sessions/external/ask', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, sessionId, toolId, optionIndex }),
    }),
  externalCliSessionAskCustom: (tmux, process, sessionId, toolId, message) =>
    authenticatedFetch('/api/providers/sessions/external/ask/custom', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, sessionId, toolId, message }),
    }),
  externalCliSessionApproval: (tmux, process, sessionId) =>
    authenticatedFetch('/api/providers/sessions/external/approval', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, sessionId }),
    }),
  externalCliSessionApprovalRespond: (tmux, process, sessionId, decision) =>
    authenticatedFetch('/api/providers/sessions/external/approval/respond', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, sessionId, decision }),
    }),
  externalCliSessionAction: (tmux, process, action) =>
    authenticatedFetch('/api/providers/sessions/external/actions', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, action }),
    }),
  externalCliSessionOutput: (tmux, process, options = {}) =>
    authenticatedFetch('/api/providers/sessions/external/output', {
      ...options,
      method: 'POST',
      body: JSON.stringify({ tmux, process }),
    }),
  // Create a supported local coding-agent tmux session from the unified sessions tab.
  externalCliSessionSpawn: (cli, name, cwd) =>
    authenticatedFetch('/api/providers/sessions/external/spawn', {
      method: 'POST',
      body: JSON.stringify({ name, cwd, cli }),
    }),
  externalCliSessionKill: (tmux, process, mode = 'process') =>
    authenticatedFetch('/api/providers/sessions/external/kill', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, mode }),
    }),
  // Spawn a new tmux gjc session via the control tower (POST /spawn).
  liveSessionSpawn: (name, cwd) =>
    authenticatedFetch('/api/providers/sessions/live/spawn', {
      method: 'POST',
      body: JSON.stringify({ name, cwd }),
    }),
  // Process termination is the safe default; pane/session destruction is explicit.
  liveSessionKill: (tmux, process, mode = 'process') =>
    authenticatedFetch('/api/providers/sessions/live/kill', {
      method: 'POST',
      body: JSON.stringify({ tmux, process, mode }),
    }),
  // Slash commands a live tmux gjc session can execute (native + project +
  // skills) — powers the live relay composer's command palette.
  /**
   * @param {string} [workspacePath]
   */
  liveSessionCommands: (workspacePath) => {
    const params = new URLSearchParams();
    if (workspacePath) params.set('workspacePath', workspacePath);
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/live/commands${qs ? `?${qs}` : ''}`);
  },
  // Skills a provider can invoke (codex `$`-prefixed) — powers the codex relay palette.
  /**
   * @param {string} provider
   * @param {string} [workspacePath]
   */
  providerSkills: (provider, workspacePath) => {
    const params = new URLSearchParams();
    if (workspacePath) params.set('workspacePath', workspacePath);
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/skills${qs ? `?${qs}` : ''}`);
  },
  // Minimal persisted metadata used to open a live transcript even when its
  // project session page has not reached that older row yet.
  sessionDetails: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  // External CLI sessions enriched with structured transcript metadata when available.
  externalSessions: (signal) => authenticatedFetch('/api/providers/sessions/external', signal === undefined ? undefined : { signal }),
  // Home-relative directory autocomplete ({ home, suggestions }).
  dirSuggestions: (prefix) =>
    authenticatedFetch(`/api/providers/fs/dir-suggestions?prefix=${encodeURIComponent(prefix)}`),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
  searchConversationsUrl: (query, limit = 50) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectId, options = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, options),


  completionNotifications: {
    status: (descriptors, deviceEndpoint, options = {}) => authenticatedFetch('/api/settings/completion-notifications/status', {
      ...options,
      method: 'POST',
      body: JSON.stringify({
        descriptors,
        ...(deviceEndpoint ? { deviceEndpoint } : {}),
      }),
    }),
    setWatch: (mutation, deviceEndpoint, options = {}) => authenticatedFetch('/api/settings/completion-notifications', {
      ...options,
      method: 'PUT',
      body: JSON.stringify({
        ...mutation,
        ...(deviceEndpoint ? { deviceEndpoint } : {}),
      }),
    }),
    vapidPublicKey: (options = {}) => authenticatedFetch('/api/settings/push/vapid-public-key', options),
    subscribe: (subscription, options = {}) => authenticatedFetch('/api/settings/push/subscribe', {
      ...options,
      method: 'POST',
      body: JSON.stringify(subscription),
    }),
    register: (subscription, options = {}) => authenticatedFetch('/api/settings/push/register', {
      ...options,
      method: 'POST',
      body: JSON.stringify(subscription),
    }),
  },
  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: (options = {}) => withBootstrapTimeout(
      (signal) => authenticatedFetch('/api/user/onboarding-status', { ...options, signal }),
      options.signal,
    ),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
