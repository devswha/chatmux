import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fleetApi } from '../../../fleet/fleetApi';
import type { FleetSshCandidate, FleetSshCandidatesPayload } from '../../../fleet/types';

type Props = Readonly<{
  readonly disabled: boolean;
  readonly onPick: (candidate: FleetSshCandidate, defaultUser: string) => void;
}>;

/**
 * Optional shortcut: lists the hub's tailnet peers so the owner can pre-fill `user@100.x.y.z`
 * instead of looking addresses up by hand. Renders nothing when the hub has no Tailscale CLI.
 */
export function FleetSshCandidatePicker({ disabled, onPick }: Props) {
  const { t } = useTranslation('settings');
  const [payload, setPayload] = useState<FleetSshCandidatesPayload | null>(null);
  const [picked, setPicked] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fleetApi.sshCandidates(controller.signal)
      .then((value) => { if (!controller.signal.aborted) setPayload(value); })
      // Discovery is a convenience layered on the manual target field; when it fails the picker stays hidden.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (payload === null || !payload.available || payload.candidates.length === 0) return null;
  const selected = payload.candidates.find((candidate) => candidate.address === picked);
  return (
    <label className="block space-y-2 text-sm font-medium text-foreground">
      <span>{t('fleet.sshEasy.candidates')}</span>
      <select name="sshCandidate" disabled={disabled} value={picked} onChange={(event) => {
        const value = event.target.value;
        setPicked(value);
        const candidate = payload.candidates.find((entry) => entry.address === value);
        if (candidate !== undefined) onPick(candidate, payload.defaultUser);
      }} className="h-10 w-full rounded-lg border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring">
        <option value="">{t('fleet.sshEasy.candidatesPick')}</option>
        {payload.candidates.map((candidate) => (
          <option key={candidate.address} value={candidate.address}>
            {[candidate.hostName, candidate.os, candidate.address, ...(candidate.online ? [] : [t('fleet.sshEasy.candidateOffline')])].join(' · ')}
          </option>
        ))}
      </select>
      {selected !== undefined && !selected.supported && (
        <span className="block text-xs font-normal text-amber-600 dark:text-amber-400">{t('fleet.sshEasy.candidateUnsupported', { os: selected.os })}</span>
      )}
    </label>
  );
}
