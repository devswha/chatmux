/**
 * Home-anchored path input normalization (새 세션 작업 폴더, 파일 패널 루트).
 *
 * Users type paths in three styles — bare home-relative ("workspace/x"),
 * tilde ("~/workspace/x"), and absolute ("/home/u/workspace/x") — but the
 * suggestion endpoint and both consumers operate on the HOME-RELATIVE form.
 * Before this normalizer, tilde and absolute input silently produced no
 * suggestions at all (the endpoint rejects absolute prefixes by design).
 */

/**
 * Any accepted style → home-relative path ('' = home itself).
 * null = cannot resolve: unknown home for an absolute/tilde-less path, or an
 * absolute path OUTSIDE home (the tower and the files panel only operate
 * under $HOME — fail closed rather than guess).
 */
export function toHomeRelative(value: string, home: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '~') {
    return '';
  }
  if (trimmed.startsWith('~/')) {
    return trimmed.slice(2);
  }
  if (trimmed.startsWith('/')) {
    if (!home) {
      return null;
    }
    const homeRoot = home.replace(/\/+$/, '');
    if (trimmed === homeRoot) {
      return '';
    }
    if (trimmed.startsWith(`${homeRoot}/`)) {
      return trimmed.slice(homeRoot.length + 1);
    }
    return null;
  }
  return trimmed;
}

/**
 * Renders a home-relative suggestion in the STYLE the user is currently
 * typing, so completion never rewrites their prefix convention: tilde input
 * gets '~/…', absolute input gets '<home>/…', bare input stays bare.
 */
export function formatSuggestionLike(inputValue: string, home: string | null, relativeSuggestion: string): string {
  const trimmed = inputValue.trim();
  if (trimmed.startsWith('~')) {
    return `~/${relativeSuggestion}`;
  }
  if (trimmed.startsWith('/') && home) {
    return `${home.replace(/\/+$/, '')}/${relativeSuggestion}`;
  }
  return relativeSuggestion;
}
