import { useState, useSyncExternalStore } from 'react';
import { MonitorDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getInstallAvailability,
  isIosDevice,
  isSecurePwaContext,
  promptInstall,
  subscribeInstallAvailability,
} from '../../../../utils/pwaInstall';

/**
 * Sidebar entry that triggers the browser's PWA install dialog.
 * Always visible unless already running as an installed app. When the
 * browser cannot offer a native prompt (plain http://, iOS, unsupported),
 * clicking reveals an inline hint explaining how to install instead.
 */
export default function SidebarInstallButton() {
  const { t } = useTranslation(['sidebar', 'settings']);
  const availability = useSyncExternalStore(
    subscribeInstallAvailability,
    getInstallAvailability,
    () => 'unavailable' as const,
  );
  const [prompting, setPrompting] = useState(false);
  const [showHint, setShowHint] = useState(false);

  if (availability === 'installed') return null;

  const hint = isIosDevice()
    ? t('settings:appearanceSettings.installApp.iosHint')
    : isSecurePwaContext()
      ? t('settings:appearanceSettings.installApp.browserMenuHint')
      : t('settings:appearanceSettings.installApp.insecureHint');

  const handleInstall = async () => {
    if (availability !== 'installable') {
      setShowHint((previous) => !previous);
      return;
    }
    setPrompting(true);
    try {
      await promptInstall();
    } finally {
      setPrompting(false);
    }
  };

  const hintPanel = showHint && availability !== 'installable' && (
    <p className="mt-1 rounded-lg bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
      {hint}
    </p>
  );

  return (
    <>
      {/* Desktop */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-60"
          onClick={handleInstall}
          disabled={prompting}
        >
          <MonitorDown className="h-3.5 w-3.5" />
          <span className="text-sm">{t('sidebar:actions.installApp')}</span>
        </button>
        {hintPanel}
      </div>

      {/* Mobile */}
      <div className="px-3 pt-2 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98] disabled:opacity-60"
          onClick={handleInstall}
          disabled={prompting}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <MonitorDown className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('sidebar:actions.installApp')}</span>
        </button>
        {hintPanel}
      </div>
    </>
  );
}
