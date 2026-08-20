import React from 'react'
import ReactDOM from 'react-dom/client'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import 'katex/dist/katex.min.css'

import { version as clientVersion } from '../package.json'

import App from './App.tsx'
import './index.css'
import './i18n/config.js'
import './utils/pwaInstall.ts'
import { refreshAfterServerUpdate, registerServiceWorker } from './services/serviceWorkerUpdate'
import { applyInterfaceFontSize, readInterfaceFontSize } from './utils/interfaceFontSize.ts'

applyInterfaceFontSize(readInterfaceFontSize())

// Pretendard is self-hosted with Korean/Latin glyphs so Hangul does not fall
// back to a serif font. The imports above load it before the application CSS.
// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  registerServiceWorker().catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// Mobile browsers (especially installed PWAs) restore fully live documents
// from the back/forward cache — after a server update, the back button can
// resurface a working page from a PREVIOUS bundle. Nothing else runs on that
// path (no navigation, no fetch), so validate the served version on every
// bfcache restore and reload once when this bundle is stale. The refresh
// coordinator's per-version session guard keeps this loop-safe.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  void (async () => {
    try {
      const response = await fetch('/health');
      const health = await response.json();
      if (typeof health?.version === 'string' && health.version !== clientVersion) {
        await refreshAfterServerUpdate({ serverVersion: health.version });
      }
    } catch {
      // Offline restore: keep the live page rather than replacing it with an error.
    }
  })();
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
