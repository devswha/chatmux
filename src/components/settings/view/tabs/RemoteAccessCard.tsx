import { useEffect, useState } from 'react';
import { Copy, Globe, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';

export interface RemoteAccessInfo {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  httpsUrls: string[];
  suggestedCommand: string | null;
}

/**
 * "원격 접속 주소" card (관제탑 큐 #288, 1단계 — read-only). Promotes the
 * HTTPS `tailscale serve` front only: a bare 100.x IP over plain HTTP breaks
 * PWA install and is deliberately never suggested. When tailscale runs but no
 * front exists, shows the one-line setup command with a copy button — the app
 * never configures the tailnet itself (that would auto-expose an
 * unauthenticated shell-capable server; 2단계 opt-in territory).
 */
export function RemoteAccessCardView({ info }: { info: RemoteAccessInfo | null }) {
  const { t } = useTranslation('settings');
  if (!info || !info.installed || !info.running) {
    // Nothing useful to show — no tailscale, or logged out. Stay silent
    // rather than nagging users who chose SSH tunnels or plain loopback.
    return null;
  }

  return (
    <div className="rounded-lg border border-border/60 bg-background p-4">
      <div className="mb-2 flex items-center gap-2">
        <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium text-foreground">
          {t('about.remoteAccess.title', { defaultValue: 'Remote access address (tailscale)' })}
        </h3>
      </div>
      {info.httpsUrls.length > 0 ? (
        <div className="space-y-2">
          {info.httpsUrls.map((url) => (
            <div key={url} className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate font-mono text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                {url}
              </a>
              <button
                type="button"
                onClick={() => copyTextToClipboard(url)}
                title={t('about.remoteAccess.copy', { defaultValue: 'Copy address' })}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {t('about.remoteAccess.httpsHint', {
              defaultValue: 'Use this HTTPS address from other devices (including your phone) — browser app install (PWA) only works properly here.',
            })}
          </p>
        </div>
      ) : info.suggestedCommand ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t('about.remoteAccess.setupHint', {
              defaultValue: 'tailscale is running, but no HTTPS address points at this server yet. Run this one line in the server terminal to create one (visible to your tailnet only):',
            })}
          </p>
          <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
            <code className="truncate font-mono text-xs text-foreground">
              <TerminalSquare className="mr-1.5 inline h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              {info.suggestedCommand}
            </code>
            <button
              type="button"
              onClick={() => copyTextToClipboard(info.suggestedCommand ?? '')}
              title={t('about.remoteAccess.copyCommand', { defaultValue: 'Copy command' })}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Data-fetching wrapper; renders nothing until (and unless) there is something to show. */
export default function RemoteAccessCard() {
  const [info, setInfo] = useState<RemoteAccessInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/system/access-info');
        if (!response.ok) return;
        const body = (await response.json()) as RemoteAccessInfo;
        if (!cancelled) {
          setInfo(body);
        }
      } catch {
        // best-effort — the card just stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <RemoteAccessCardView info={info} />;
}
