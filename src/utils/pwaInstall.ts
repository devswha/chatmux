// Captures the browser's PWA install prompt at module load time.
//
// Chrome fires `beforeinstallprompt` once, early in the page lifecycle —
// usually before any settings UI mounts. This module is imported from
// `main.jsx` so the event is captured eagerly and replayed to whichever
// component subscribes later (Settings > Appearance > Install as App).

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress Chrome's mini-infobar; the in-app button triggers it instead.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installedThisSession = true;
    notify();
  });
}

/** Snapshot for useSyncExternalStore: 'installable' | 'installed' | 'unavailable'. */
export function getInstallAvailability(): 'installable' | 'installed' | 'unavailable' {
  if (installedThisSession || isStandaloneDisplay()) return 'installed';
  return deferredPrompt ? 'installable' : 'unavailable';
}

export function subscribeInstallAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the browser install dialog captured earlier; resolves with the user's choice. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const prompt = deferredPrompt;
  if (!prompt) return 'unavailable';
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  if (choice.outcome === 'accepted') {
    deferredPrompt = null;
    notify();
  }
  return choice.outcome;
}

/** True when already launched from an installed PWA window/home-screen icon. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari exposes a non-standard flag instead of display-mode.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iOS/iPadOS never fires beforeinstallprompt; install goes via Share → Add to Home Screen. */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true;
  // iPadOS 13+ masquerades as macOS but reports touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** Install prompts require a secure context (HTTPS or localhost). */
export function isSecurePwaContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}
