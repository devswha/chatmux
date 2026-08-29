import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useFleetHostCatalog } from '../../../../fleet/discovery/FleetHostCatalogContext';
import { EMPTY_HOST_ROW_SET } from '../../../../fleet/discovery/hostRows';
import { spawnableHosts, type SpawnHostChoice } from '../../../../fleet/hostAvailability';
import HomeDirInput from '../../../../shared/view/HomeDirInput';
import { cn } from '../../../../lib/utils';

import PeerDirInput from './newSession/PeerDirInput';
import SpawnHostFields from './newSession/SpawnHostFields';
import { canDispatchSpawn, PEER_SPAWN_PROVIDERS } from './newSession/spawnTarget';
import { useSessionSpawn, type SpawnStatus } from './newSession/useSessionSpawn';

type SpawnProvider = 'gjc' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'omp' | 'omo';

const PROVIDERS: { id: SpawnProvider; label: string }[] = [
  { id: 'omo', label: 'Oh My OpenAgent' },
  { id: 'gjc', label: 'GJC' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'omp', label: 'Oh My Pi' },
];

// Working directories of successful spawns, most recent first. Typing an
// absolute path once is enough — later sessions pick it from the dropdown.
const RECENT_CWDS_KEY = 'chatmux-recent-spawn-cwds';
const RECENT_CWDS_MAX = 5;

function readRecentCwds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_CWDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, RECENT_CWDS_MAX)
      : [];
  } catch {
    // localStorage unavailable (SSR/tests) or corrupted payload.
    return [];
  }
}

/**
 * Unified new-session form. GJC boots through the control tower; every other
 * provider boots its native CLI in tmux through /sessions/external/spawn.
 *
 * A session may also be created on an enrolled peer. Only an online, synchronized,
 * spawn-capable peer is offered; its path suggestions and its project list come
 * from that peer, and the request carries a peer-home-relative path — this
 * machine's own paths are never sent. A dispatched peer spawn whose answer never
 * arrived reports an unresolved outcome that must be acknowledged against the
 * refreshed roster; it is never retried automatically.
 */
export default function SidebarNewSession({
  onCreated,
  initiallyOpen = false,
}: {
  onCreated: () => void;
  initiallyOpen?: boolean;
}) {
  const { t } = useTranslation('sidebar');
  const { catalog, refresh } = useFleetHostCatalog();
  const [open, setOpen] = useState(initiallyOpen);
  const [provider, setProvider] = useState<SpawnProvider>('gjc');
  const [name, setName] = useState('');
  const [recentCwds, setRecentCwds] = useState<string[]>(readRecentCwds);
  // The most recent working directory is the best default: repeated spawns
  // in the same repo need no path input at all.
  const [cwd, setCwd] = useState(() => readRecentCwds()[0] ?? '');
  const [hostId, setHostId] = useState<string | null>(null);
  const [projectLocalId, setProjectLocalId] = useState<string | null>(null);

  const hosts = useMemo(
    () => spawnableHosts(catalog, t('newSessionForm.thisMachine')),
    [catalog, t],
  );
  const selectedHost: SpawnHostChoice = hosts.find((host) => host.hostId === hostId) ?? hosts[0];
  const isRemote = !selectedHost.isLocal;
  const peerProjects = (selectedHost.hostId === null ? undefined : catalog.hosts.get(selectedHost.hostId))?.rows.projects
    ?? EMPTY_HOST_ROW_SET.projects;

  const rememberCwd = (path: string) => {
    const next = [path, ...recentCwds.filter((entry) => entry !== path)].slice(0, RECENT_CWDS_MAX);
    setRecentCwds(next);
    try {
      localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(next));
    } catch {
      // best-effort persistence
    }
  };

  const { status, spawn, acknowledge } = useSessionSpawn((path: string) => {
    rememberCwd(path);
    setOpen(false);
    setName('');
    // Keep the path of least resistance: the next spawn most likely targets
    // the same repo, so the field reopens prefilled with the latest cwd.
    setCwd(readRecentCwds()[0] ?? '');
    onCreated();
  });

  const selectHost = (nextHostId: string | null) => {
    setHostId(nextHostId);
    setProjectLocalId(null);
    // A peer's path space is its own: keeping this machine's last path would
    // pre-fill a directory that does not exist there.
    setCwd(nextHostId === null || nextHostId === catalog.localHostId ? readRecentCwds()[0] ?? '' : '');
    acknowledge();
  };

  // An unresolved outcome is cleared only after the roster is re-read, so the
  // user decides from the peer's own state instead of guessing.
  const reconcileUnknown = () => {
    refresh();
    acknowledge();
  };

  const providers = isRemote
    ? PROVIDERS.filter((item) => (PEER_SPAWN_PROVIDERS as readonly string[]).includes(item.id))
    : PROVIDERS;
  const activeProvider = isRemote ? 'gjc' : provider;
  const ready = canDispatchSpawn({ host: selectedHost, name, cwd, projectLocalId });
  const submit = () => {
    if (!ready || status.kind === 'spawning' || status.kind === 'unknown') return;
    void spawn({
      host: selectedHost,
      localHostId: catalog.localHostId,
      projectLocalId,
      provider: activeProvider,
      name: name.trim(),
      cwd,
    });
  };

  if (!open) {
    return (
      <div className="px-2 pb-1 pt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-spawn-open
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />{t('newSessionForm.open')}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-1 mt-2 space-y-2 rounded-lg border border-border bg-card p-2">
      <SpawnHostFields
        hosts={hosts}
        selected={selectedHost}
        projects={peerProjects}
        projectLocalId={projectLocalId}
        onSelectHost={selectHost}
        onSelectProject={setProjectLocalId}
      />
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted/50 p-0.5">
        {providers.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setProvider(item.id)}
            data-spawn-provider={item.id}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              activeProvider === item.id
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
        data-spawn-name
        placeholder={t('newSessionForm.sessionNamePlaceholder')}
        className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/60"
      />
      {isRemote ? (
        <PeerDirInput
          scope={{ hostId: selectedHost.hostId, localHostId: catalog.localHostId }}
          projectLocalId={projectLocalId}
          value={cwd}
          onChange={setCwd}
          onSubmit={submit}
          placeholder={t('newSessionForm.hostWorkingDirectoryPlaceholder')}
          invalid={cwd.trim().length > 0 && !ready && projectLocalId !== null}
        />
      ) : (
        <HomeDirInput
          value={cwd}
          onChange={setCwd}
          onSubmit={submit}
          placeholder={t('newSessionForm.workingDirectoryPlaceholder')}
          quickPicks={recentCwds}
          quickPicksLabel={t('newSessionForm.recentPaths')}
        />
      )}
      <SpawnStatusLine status={status} onReconcile={reconcileUnknown} />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => { setOpen(false); setName(''); setCwd(readRecentCwds()[0] ?? ''); acknowledge(); }}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('newSessionForm.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          data-spawn-submit
          disabled={!ready || status.kind === 'spawning' || status.kind === 'unknown'}
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

function SpawnStatusLine({ status, onReconcile }: { status: SpawnStatus; onReconcile: () => void }) {
  const { t } = useTranslation('sidebar');
  switch (status.kind) {
    case 'idle':
    case 'spawning':
      return null;
    case 'rejected':
      return (
        <p className="text-[11px] text-red-500" data-spawn-status={`rejected:${status.reason}`} role="status">
          {status.reason === 'tower-unavailable'
            ? t('newSessionForm.errors.towerUnavailable')
            : status.reason === 'name-conflict'
              ? t('newSessionForm.errors.nameConflict')
              : status.detail ?? t('newSessionForm.errors.createFailed')}
        </p>
      );
    case 'unknown':
      return (
        <div className="space-y-1" data-spawn-status="unknown" role="status">
          <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('newSessionForm.errors.outcomeUnknown')}</p>
          <button
            type="button"
            onClick={onReconcile}
            data-spawn-reconcile
            className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            {t('newSessionForm.recheckHost')}
          </button>
        </div>
      );
  }
}
