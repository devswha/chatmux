import React from 'react'
import ReactDOM from 'react-dom/client'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import 'katex/dist/katex.min.css'

import App from './App.tsx'
import './index.css'
import './i18n/config.js'
import './utils/pwaInstall.ts'
import { registerServiceWorker } from './services/serviceWorkerUpdate'

// Pretendard is self-hosted with Korean/Latin glyphs so Hangul does not fall
// back to a serif font. The imports above load it before the application CSS.
// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  registerServiceWorker().catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
