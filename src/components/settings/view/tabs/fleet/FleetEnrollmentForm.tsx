import { useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FleetEnrollmentInput, FleetTransportMode } from '../../../fleet/types';

type Props = Readonly<{
  readonly pending: boolean;
  readonly onEnroll: (input: FleetEnrollmentInput) => Promise<void>;
}>;

export function FleetEnrollmentForm({ pending, onEnroll }: Props) {
  const { t } = useTranslation('settings');
  const [transportMode, setTransportMode] = useState<FleetTransportMode>('direct-wss');
  const [peerUrl, setPeerUrl] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onEnroll({ peerUrl: peerUrl.trim(), token: token.trim(), label: label.trim(), transportMode });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm font-medium text-foreground">
          <span>{t('fleet.enroll.label')}</span>
          <input required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          <span>{t('fleet.enroll.mode')}</span>
          <select value={transportMode} onChange={(event) => setTransportMode(event.target.value === 'ssh-loopback' ? 'ssh-loopback' : 'direct-wss')}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring">
            <option value="direct-wss">{t('fleet.modes.direct')}</option>
            <option value="ssh-loopback">{t('fleet.modes.ssh')}</option>
          </select>
        </label>
      </div>
      <label className="block space-y-2 text-sm font-medium text-foreground">
        <span>{t('fleet.enroll.url')}</span>
        <input required value={peerUrl} onChange={(event) => setPeerUrl(event.target.value)} placeholder={transportMode === 'direct-wss' ? 'wss://peer.example.ts.net/fleet-ws' : 'ws://127.0.0.1:8022/fleet-ws'}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring" />
      </label>
      <label className="block space-y-2 text-sm font-medium text-foreground">
        <span>{t('fleet.enroll.token')}</span>
        <input required type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring" />
      </label>
      <p className="break-keep text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {transportMode === 'direct-wss' ? t('fleet.modes.directHelp') : t('fleet.modes.sshHelp')}
      </p>
      <button type="submit" disabled={pending || !peerUrl.trim() || !token.trim() || !label.trim()}
        className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        <Link2 className="h-4 w-4" />{t('fleet.enroll.submit')}
      </button>
    </form>
  );
}
