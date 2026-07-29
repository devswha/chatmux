import { Settings, ArrowUpCircle } from 'lucide-react';
import type { TFunction } from 'i18next';


import SidebarInstallButton from './SidebarInstallButton';

const GITHUB_REPO_URL = 'https://github.com/devswha/chatmux';

type SidebarFooterProps = {
  clientRefreshAvailable: boolean;
  serverUpdateAvailable: boolean;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  clientRefreshAvailable,
  serverUpdateAvailable,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {(clientRefreshAvailable || serverUpdateAvailable) && (
        <>
          <div className="nav-divider" />
          <div className="hidden px-2 py-1.5 md:block">
            <button
              className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-blue-50/80 dark:hover:bg-blue-900/15"
              onClick={onShowVersionModal}
              aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')}
              title={t('common:versionUpdate.ariaLabels.updateAvailable')}
            >
              <div className="relative flex-shrink-0">
                <ArrowUpCircle className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-normal text-blue-600 dark:text-blue-300">
                  {serverUpdateAvailable && latestVersion ? `v${latestVersion}` : t('common:versionUpdate.newVersionReady')}
                </span>
                <span className="text-[10px] text-blue-500/70 dark:text-blue-400/60">
                  {t('version.updateAvailable')}
                </span>
              </div>
            </button>
          </div>

          <div className="px-3 py-2 md:hidden">
            <button
              className="flex h-11 w-full items-center gap-3 rounded-xl border border-blue-200/60 bg-blue-50/80 px-3.5 transition-all active:scale-[0.98] dark:border-blue-700/40 dark:bg-blue-900/15"
              onClick={onShowVersionModal}
              aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')}
              title={t('common:versionUpdate.ariaLabels.updateAvailable')}
            >
              <div className="relative flex-shrink-0">
                <ArrowUpCircle className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              </div>
              <div className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-normal text-blue-600 dark:text-blue-300">
                  {serverUpdateAvailable && latestVersion ? `v${latestVersion}` : t('common:versionUpdate.newVersionReady')}
                </span>
                <span className="text-xs text-blue-500/70 dark:text-blue-400/60">
                  {t('version.updateAvailable')}
                </span>
              </div>
            </button>
          </div>
        </>
      )}

      {/* Settings */}
      <div className="nav-divider" />

      {/* PWA install (renders only when the browser offers the prompt) */}
      <SidebarInstallButton />

      {/* Desktop settings */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Desktop version brand line */}
      <div className="hidden px-3 py-2 text-center md:block">
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        >
          ChatMux v{currentVersion} – {t('branding.openSource')}
        </a>
      </div>

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-2 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
        </button>
      </div>
    </div>
  );
}
