import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
// Pretendard (self-hosted, dynamic-subset) — Korean/Latin sans with real Hangul
// glyphs, so Korean no longer falls back to a serif (궁서체). Loaded before app CSS.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Capture the PWA install prompt before any UI mounts (Settings replays it).
import './utils/pwaInstall.ts'

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
