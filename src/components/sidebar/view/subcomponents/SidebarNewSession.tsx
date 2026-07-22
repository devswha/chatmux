import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import HomeDirInput from '../../../../shared/view/HomeDirInput';
import { cn } from '../../../../lib/utils';

type SpawnProvider = 'gjc' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'omp';

type SpawnStatus =
  | { kind: 'idle' }
  | { kind: 'spawning' }
  | { kind: 'error'; text: string };

const PROVIDERS: { id: SpawnProvider; label: string }[] = [
  { id: 'gjc', label: 'GJC' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'omp', label: 'Oh My Pi' },
];

/**
 * Unified new-session form. GJC boots through the control tower; every other
 * provider boots its native CLI in tmux through /sessions/external/spawn.
 */
export default function SidebarNewSession({
  onCreated,
  initiallyOpen = false,
}: {
  onCreated: () => void;
  initiallyOpen?: boolean;
}) {
  const { t } = useTranslation('sidebar');
  const [open, setOpen] = useState(initiallyOpen);
  const [provider, setProvider] = useState<SpawnProvider>('gjc');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [status, setStatus] = useState<SpawnStatus>({ kind: 'idle' });

  const reset = () => {
    setName('');
    setCwd('');
    setStatus({ kind: 'idle' });
  };

  const spawn = async () => {
    const trimmedName = name.trim();
    const trimmedCwd = cwd.trim();
    if (!trimmedName || !trimmedCwd || status.kind === 'spawning') {
      return;
    }
    setStatus({ kind: 'spawning' });
    try {
      if (provider === 'gjc') {
        const response = await api.liveSessionSpawn(trimmedName, trimmedCwd);
        const body = await response.json().catch(() => null);
        const data = (body?.data ?? body ?? {}) as {
          reachable?: boolean;
          conflict?: boolean;
          ok?: boolean;
          detail?: string;
        };
        if (response.ok && data.ok) {
          setOpen(false);
          reset();
          return;
        }
        const text = data.reachable === false
          ? t('newSessionForm.errors.towerUnavailable')
          : data.conflict
            ? t('newSessionForm.errors.nameConflict')
            : (typeof body?.error === 'string' && body.error)
              || data.detail
              || t('newSessionForm.errors.createFailed');
        setStatus({ kind: 'error', text });
        return;
      }

      const response = await api.externalCliSessionSpawn(provider, trimmedName, trimmedCwd);
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data?.ok) {
        setOpen(false);
        reset();
        onCreated();
        return;
      }
      setStatus({
        kind: 'error',
        text: body?.error?.message ?? body?.message ?? t('newSessionForm.errors.createFailed'),
      });
    } catch {
      setStatus({ kind: 'error', text: t('newSessionForm.errors.createFailed') });
    }
  };

  if (!open) {
    return (
      <div className="px-2 pb-1 pt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />{t('newSessionForm.open')}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-1 mt-2 space-y-2 rounded-lg border border-border bg-card p-2">
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted/50 p-0.5">
        {PROVIDERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setProvider(item.id)}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              provider === item.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('newSessionForm.sessionNamePlaceholder')}
        className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/60"
      />
      <HomeDirInput
        value={cwd}
        onChange={setCwd}
        onSubmit={() => void spawn()}
        placeholder={t('newSessionForm.workingDirectoryPlaceholder')}
      />
      {status.kind === 'error' && <p className="text-[11px] text-red-500">{status.text}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => { setOpen(false); reset(); }}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('newSessionForm.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void spawn()}
          disabled={!name.trim() || !cwd.trim() || status.kind === 'spawning'}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status.kind === 'spawning'
            ? t('newSessionForm.creating')
            : t('newSessionForm.create')}
        </button>
      </div>
    </div>
  );
}
