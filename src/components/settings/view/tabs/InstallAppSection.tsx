import { useState, useSyncExternalStore } from 'react';
import { CheckCircle2, MonitorDown, Share } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getInstallAvailability,
  isIosDevice,
  isSecurePwaContext,
  promptInstall,
  subscribeInstallAvailability,
} from '../../../../utils/pwaInstall';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

export default function InstallAppSection() {
  const { t } = useTranslation('settings');
  const availability = useSyncExternalStore(
    subscribeInstallAvailability,
    getInstallAvailability,
    () => 'unavailable' as const,
  );
  const [prompting, setPrompting] = useState(false);

  const handleInstall = async () => {
    setPrompting(true);
    try {
      await promptInstall();
    } finally {
      setPrompting(false);
    }
  };

  return (
    <SettingsSection
      title={t('appearanceSettings.installApp.title')}
      description={t('appearanceSettings.installApp.description')}
    >
      <SettingsCard className="p-4">
        {availability === 'installed' ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" aria-hidden />
            {t('appearanceSettings.installApp.installed')}
          </div>
        ) : availability === 'installable' ? (
          <button
            type="button"
            onClick={handleInstall}
            disabled={prompting}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            <MonitorDown className="h-4 w-4" aria-hidden />
            {t('appearanceSettings.installApp.installButton')}
          </button>
        ) : isIosDevice() ? (
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            <Share className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
            {t('appearanceSettings.installApp.iosHint')}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {isSecurePwaContext()
              ? t('appearanceSettings.installApp.browserMenuHint')
              : t('appearanceSettings.installApp.insecureHint')}
          </p>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
