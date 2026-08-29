import type { ReactNode } from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider, ProtectedRoute, useAuth } from './components/auth';
import type { AuthUser } from './components/auth/types';
import { WebSocketProvider } from './contexts/WebSocketContext';
import AppContent from './components/app/AppContent';
import FleetSessionRoute from './fleet/FleetSessionRoute';
import { FleetHostCatalogProvider } from './fleet/discovery/FleetHostCatalogContext';
import { LOCAL_SESSION_ROUTE, REMOTE_SESSION_ROUTE } from './fleet/sessionRoute';
import i18n from './i18n/config.js';
import { CompletionNotificationsProvider } from './components/sidebar/context/CompletionNotificationsContext';

const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);

/**
 * Detect the router basename from explicit runtime config or deployment hints.
 *
 * ChatMux can be served from a path prefix by a reverse proxy, for example:
 *   /ai/manifest.json
 *   /ai/assets/index-abc123.js
 *   /ai/icons/icon-192x192.png
 *
 * React Router needs that prefix as its basename, but the packaged app should
 * also keep working when served directly from the domain root. The direct-root
 * case is easy to misread because asset URLs such as /icons/icon-192x192.png
 * contain a directory even though there is no application basename.
 */
function detectRouterBasename() {
  const explicitBasename = typeof window !== 'undefined' ? window.__ROUTER_BASENAME__ || '' : '';
  if (explicitBasename) {
    // Keep the deployment escape hatch authoritative. A trailing slash is
    // harmless for humans but React Router expects a normalized basename.
    return explicitBasename.replace(/\/+$/, '');
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '';
  }

  const candidatePaths = [
    { kind: 'manifest' as const, value: document.querySelector('link[rel="manifest"]')?.getAttribute('href') },
    { kind: 'script' as const, value: document.querySelector('script[type="module"][src]')?.getAttribute('src') },
    ...Array.from(
      document.querySelectorAll(
        'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="apple-touch-icon-precomposed"][href], link[rel="mask-icon"][href]'
      )
    ).map((node) => ({
      kind: 'icon' as const,
      value: node.getAttribute('href'),
    })),
  ].filter((candidate): candidate is { kind: 'manifest' | 'script' | 'icon'; value: string } => Boolean(candidate.value));

  let detectedBasename = '';
  for (const candidate of candidatePaths) {
    try {
      const candidateUrl = new URL(candidate.value, document.baseURI || window.location.href);
      if (candidateUrl.origin !== window.location.origin) {
        continue;
      }

      const pathname = candidateUrl.pathname;
      const normalizedPathname = pathname.replace(/\/+$/, '');

      let normalized = '';
      if (candidate.kind === 'script') {
        const match = normalizedPathname.match(/^(.*)\/assets\//);
        normalized = match?.[1] ? match[1].replace(/\/+$/, '') : '';
      } else {
        const manifestMatch = normalizedPathname.match(/^(.*)\/(?:manifest\.json|site\.webmanifest)$/);
        const iconMatch = normalizedPathname.match(
          /^(.*)\/(?:favicon(?:\.[^/]+)?|apple-touch-icon(?:-[^/]+)?(?:\.[^/]+)?|mask-icon(?:\.[^/]+)?|[^/]*icon[^/]*)$/
        );
        const match = candidate.kind === 'manifest' ? manifestMatch : iconMatch;
        if (match?.[1]) {
          const segments = match[1].split('/').filter(Boolean);

          // Strip directories that describe where static files live, not where
          // the app is mounted. This must also run for a single segment:
          //   /icons/icon-192x192.png       -> ''
          //   /ai/icons/icon-192x192.png    -> '/ai'
          // The previous implementation only stripped while more than one
          // segment remained, which incorrectly turned root deployments into a
          // Router basename of /icons and caused a blank page after login.
          while (segments.length > 0 && DEPLOYMENT_ASSET_DIRECTORIES.has(segments[segments.length - 1])) {
            segments.pop();
          }

          normalized = segments.length > 0 ? `/${segments.join('/')}` : '';
        }
      }

      if (normalized.length > detectedBasename.length) {
        detectedBasename = normalized;
      }
    } catch {
      // Ignore invalid candidate URLs and continue checking other hints.
    }
  }

  return detectedBasename;
}

export function ownerProviderKey(user: AuthUser) {
  if (user.id !== undefined) {
    const id = String(user.id);
    return `id:${typeof user.id}:${id.length}:${id}`;
  }
  return `username:${user.username.length}:${user.username}`;
}

function OwnerCompletionNotifications({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <>{children}</>;
  return <CompletionNotificationsProvider key={ownerProviderKey(user)}>{children}</CompletionNotificationsProvider>;
}

export default function App() {
  const routerBasename = detectRouterBasename();

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AuthProvider>
          <WebSocketProvider>
            <ProtectedRoute>
              <FleetHostCatalogProvider>
                <OwnerCompletionNotifications>
                  <Router basename={routerBasename}>
                    <Routes>
                      <Route path="/" element={<FleetSessionRoute><AppContent /></FleetSessionRoute>} />
                      {/* Legacy deep link: local sessions only. */}
                      <Route
                        path={LOCAL_SESSION_ROUTE}
                        element={<FleetSessionRoute><AppContent /></FleetSessionRoute>}
                      />
                      {/* Host-qualified deep link for a session owned by any installation. */}
                      <Route
                        path={REMOTE_SESSION_ROUTE}
                        element={<FleetSessionRoute><AppContent /></FleetSessionRoute>}
                      />
                    </Routes>
                  </Router>
                </OwnerCompletionNotifications>
              </FleetHostCatalogProvider>
            </ProtectedRoute>
          </WebSocketProvider>
        </AuthProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}
