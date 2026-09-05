import { useEffect, useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FleetSettingsRequestError } from '../../../fleet/fleetApi';
import { FLEET_SSH_ENROLLMENT_ERROR_CODES } from '../../../fleet/types';
import type {
  FleetEnrollmentInput,
  FleetSshEnrollmentErrorCode,
  FleetSshEnrollmentErrorDetails,
  FleetSshEnrollmentInput,
  FleetSshEnrollmentResult,
  FleetTransportMode,
} from '../../../fleet/types';

import { FleetSshCandidatePicker } from './FleetSshCandidatePicker';

type EnrollmentMode = FleetTransportMode | 'ssh-easy';
type SshError = Readonly<{ code: FleetSshEnrollmentErrorCode; details: FleetSshEnrollmentErrorDetails }>;

type Props = Readonly<{
  readonly pending: boolean;
  readonly onEnroll: (input: FleetEnrollmentInput) => Promise<void>;
  readonly onSshEnroll: (input: FleetSshEnrollmentInput) => Promise<FleetSshEnrollmentResult>;
}>;

const SSH_TARGET_PATTERN = /^[^\s@]+@(?:\[[0-9a-fA-F:]+\]|[^\s@:]+)(?::([0-9]{1,5}))?$/;
const PROGRESS_KEYS = ['stepConnect', 'stepKey', 'stepToken', 'stepEnroll'] as const;
// The remote install is the long pole, so the progress indicator holds on that step.
const INSTALL_PROGRESS_KEYS = ['stepConnect', 'stepKey', 'stepInstall'] as const;
const INSTALL_HINT_CODES: readonly FleetSshEnrollmentErrorCode[] = ['REMOTE_CLI_MISSING'];
export const REMOTE_INSTALL_COMMAND = 'curl -fsSL https://github.com/devswha/chatmux/releases/latest/download/install.sh | bash -s -- --port 3001';

function validSshTarget(value: string): boolean {
  const match = SSH_TARGET_PATTERN.exec(value);
  if (match === null) return false;
  const port = match[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

export function FleetEnrollmentForm({ pending, onEnroll, onSshEnroll }: Props) {
  const { t } = useTranslation('settings');
  const [transportMode, setTransportMode] = useState<EnrollmentMode>('direct-wss');
  const [peerUrl, setPeerUrl] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRequired, setPasswordRequired] = useState(true);
  const [installCli, setInstallCli] = useState(false);
  const [sshPending, setSshPending] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [sshError, setSshError] = useState<SshError | null>(null);
  const [sshResult, setSshResult] = useState<FleetSshEnrollmentResult | null>(null);
  const [connectedLabel, setConnectedLabel] = useState('');
  const busy = pending || sshPending;
  const trimmedTarget = sshTarget.trim();
  const sshReady = validSshTarget(trimmedTarget) && (!passwordRequired || password.length > 0);
  const progressKeys = installCli ? INSTALL_PROGRESS_KEYS : PROGRESS_KEYS;

  useEffect(() => {
    if (!sshPending || progressStep >= progressKeys.length - 1) return undefined;
    const timer = setTimeout(() => setProgressStep((current) => current + 1), 650);
    return () => clearTimeout(timer);
  }, [progressKeys.length, progressStep, sshPending]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (transportMode !== 'ssh-easy') {
      void onEnroll({ peerUrl: peerUrl.trim(), token: token.trim(), label: label.trim(), transportMode });
      return;
    }
    if (!sshReady) return;
    const trimmedLabel = label.trim();
    const input: FleetSshEnrollmentInput = trimmedLabel.length === 0
      ? { sshTarget: trimmedTarget, password, installCli }
      : { sshTarget: trimmedTarget, password, label: trimmedLabel, installCli };
    setPassword('');
    setSshPending(true);
    setProgressStep(0);
    setSshError(null);
    setSshResult(null);
    void onSshEnroll(input).then((result) => {
      setConnectedLabel(trimmedLabel || trimmedTarget);
      setSshResult(result);
    }).catch((error: unknown) => {
      const requestError = error instanceof FleetSettingsRequestError ? error : null;
      const closedCode = FLEET_SSH_ENROLLMENT_ERROR_CODES.find((code) => code === requestError?.code);
      setSshError({ code: closedCode ?? 'ENROLL_FAILED', details: requestError?.details ?? {} });
      setPasswordRequired(true);
    }).finally(() => {
      setPassword('');
      setSshPending(false);
    });
  };

  const sshErrorMessage = (error: SshError): string => {
    if (error.code !== 'REMOTE_PLATFORM_UNSUPPORTED') return t(`fleet.sshEasy.errors.${error.code}`);
    const platform = [error.details.os, error.details.arch].filter((part) => part !== undefined).join(' ');
    return t('fleet.sshEasy.errors.REMOTE_PLATFORM_UNSUPPORTED', { platform: platform || t('fleet.unknown') });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm font-medium text-foreground">
          <span>{t('fleet.enroll.label')}</span>
          <input name="label" required={transportMode !== 'ssh-easy'} maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          <span>{t('fleet.enroll.mode')}</span>
          <select value={transportMode} onChange={(event) => {
            const value = event.target.value;
            setTransportMode(value === 'ssh-loopback' || value === 'ssh-easy' ? value : 'direct-wss');
            setSshError(null);
            setSshResult(null);
          }} className="h-10 w-full rounded-lg border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring">
            <option value="direct-wss">{t('fleet.modes.direct')}</option>
            <option value="ssh-loopback">{t('fleet.modes.ssh')}</option>
            <option value="ssh-easy">{t('fleet.sshEasy.title')}</option>
          </select>
        </label>
      </div>

      {transportMode === 'ssh-easy' ? (
        <>
          <p className="break-keep text-sm text-muted-foreground [overflow-wrap:anywhere]">{t('fleet.sshEasy.description')}</p>
          <FleetSshCandidatePicker disabled={busy} onPick={(candidate, defaultUser) => {
            setSshTarget(`${defaultUser}@${candidate.address}`);
            if (label.trim().length === 0) setLabel(candidate.hostName);
            setSshError(null);
          }} />
          <label className="block space-y-2 text-sm font-medium text-foreground">
            <span>{t('fleet.sshEasy.target')}</span>
            <input name="sshTarget" required pattern={SSH_TARGET_PATTERN.source} value={sshTarget} onChange={(event) => setSshTarget(event.target.value)} placeholder={t('fleet.sshEasy.targetPlaceholder')}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="block space-y-2 text-sm font-medium text-foreground">
            <span>{t('fleet.sshEasy.password')}</span>
            <input name="password" required={passwordRequired} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring" />
            <span className="block text-xs font-normal text-muted-foreground">{t('fleet.sshEasy.passwordHelp')}</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input name="installCli" type="checkbox" checked={installCli} disabled={busy} onChange={(event) => setInstallCli(event.target.checked)} className="mt-1 h-4 w-4 rounded border-input" />
            <span className="space-y-1">
              <span className="block font-medium">{t('fleet.sshEasy.installCli')}</span>
              <span className="block text-xs text-muted-foreground">{t('fleet.sshEasy.installCliHelp')}</span>
            </span>
          </label>
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            {t('fleet.sshEasy.keyDisclosure')}
          </p>
          {sshPending && <p role="status" className="text-sm font-medium text-primary">{t(`fleet.sshEasy.${progressKeys[progressStep] ?? progressKeys[0]}`)}</p>}
          {sshResult && <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">{t('fleet.sshEasy.success', { label: connectedLabel, port: sshResult.port })}</p>}
          {sshError && <p role="alert" className="text-sm text-destructive">{sshErrorMessage(sshError)}</p>}
          {sshError && INSTALL_HINT_CODES.includes(sshError.code) && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <span className="block">{t('fleet.sshEasy.installHint')}</span>
              <code className="block select-all overflow-x-auto rounded-md border border-border bg-muted/40 px-2 py-1 font-mono">{REMOTE_INSTALL_COMMAND}</code>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="block space-y-2 text-sm font-medium text-foreground">
            <span>{t('fleet.enroll.url')}</span>
            <input name="peerUrl" required value={peerUrl} onChange={(event) => setPeerUrl(event.target.value)} placeholder={transportMode === 'direct-wss' ? 'wss://peer.example.ts.net/fleet-ws' : 'ws://127.0.0.1:8022/fleet-ws'}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="block space-y-2 text-sm font-medium text-foreground">
            <span>{t('fleet.enroll.token')}</span>
            <input name="token" required type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <p className="break-keep text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {transportMode === 'direct-wss' ? t('fleet.modes.directHelp') : t('fleet.modes.sshHelp')}
          </p>
        </>
      )}
      <button type="submit" disabled={busy || (transportMode === 'ssh-easy' ? !sshReady : !peerUrl.trim() || !token.trim() || !label.trim())}
        className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        <Link2 className="h-4 w-4" />{transportMode === 'ssh-easy' ? t('fleet.sshEasy.submit') : t('fleet.enroll.submit')}
      </button>
    </form>
  );
}
