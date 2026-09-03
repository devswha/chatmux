import { Copy, KeyRound, MonitorCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useFleetSettings } from '../../fleet/useFleetSettings';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

import { FleetEnrollmentForm } from './fleet/FleetEnrollmentForm';
import { FleetPeerRow } from './fleet/FleetPeerRow';

export function FleetSettingsTab() {
  const { t, i18n } = useTranslation('settings');
  const fleet = useFleetSettings();
  if (fleet.data === null) {
    return <p role="status" className="text-sm text-muted-foreground">{fleet.error ? t('fleet.errors.load', { code: fleet.error }) : t('fleet.loading')}</p>;
  }
  const enrolled = fleet.data.peers.filter((peer) => peer.enrollmentState === 'enrolled').length;
  return (
    <div className="space-y-8">
      <SettingsSection title={t('fleet.identity.title')} description={t('fleet.identity.description')}>
        <SettingsCard className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <MonitorCog className="mt-0.5 h-5 w-5 flex-none text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('fleet.identity.local')}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{fleet.data.local.publicKeyFingerprint}</p>
              <p className="mt-2 text-xs text-muted-foreground">{t('fleet.capacity', { current: enrolled + 1, total: fleet.data.capacity.totalInstallations })}</p>
            </div>
          </div>
          <button type="button" disabled={fleet.pending} onClick={() => void fleet.generateCode()}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-medium hover:bg-accent disabled:opacity-50">
            <KeyRound className="h-4 w-4" />{t('fleet.pairing.generate')}
          </button>
          {fleet.code && (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <code className="min-w-0 break-all text-xs text-foreground">{fleet.code.token}</code>
                <button type="button" onClick={() => void navigator.clipboard.writeText(fleet.code?.token ?? '')} aria-label={t('fleet.pairing.copy')} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t('fleet.pairing.expires', { time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(fleet.code.expiresAtMs) })}</p>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('fleet.enroll.title')} description={t('fleet.enroll.description')}>
        <SettingsCard className="p-4">
          {fleet.data.role === 'peer'
            ? <p role="status" className="text-sm text-muted-foreground">{t('fleet.enroll.roleConflict')}</p>
            : <FleetEnrollmentForm pending={fleet.pending} onEnroll={fleet.enroll} onSshEnroll={fleet.sshEnroll} />}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('fleet.hosts.title')} description={t('fleet.hosts.description')}>
        <SettingsCard divided>
          {fleet.data.peers.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('fleet.hosts.empty')}</p> : fleet.data.peers.map((peer) => (
            <FleetPeerRow key={peer.peerId} peer={peer} pending={fleet.pending} onReconnect={fleet.reconnect} onRevoke={fleet.revoke} onRemoveLocal={fleet.removeLocal} />
          ))}
        </SettingsCard>
      </SettingsSection>

      {fleet.lastRevocation && (
        <p role="status" className="text-sm text-muted-foreground">{t('fleet.revocationOutcome', { local: fleet.lastRevocation.localRemoval, peer: fleet.lastRevocation.peerRevocation })}</p>
      )}
      {fleet.error && <p role="alert" className="text-sm text-destructive">{t('fleet.errors.action', { code: fleet.error })}</p>}
      <p className="break-keep text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t('fleet.securityNote')}</p>
    </div>
  );
}
