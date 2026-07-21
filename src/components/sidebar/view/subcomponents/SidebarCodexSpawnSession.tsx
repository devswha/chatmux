import { useState } from 'react';
import { Plus } from 'lucide-react';

import HomeDirInput from '../../../../shared/view/HomeDirInput';
import { api } from '../../../../utils/api';

type SpawnStatus = 'idle' | 'spawning' | 'error';

export default function SidebarCodexSpawnSession({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [status, setStatus] = useState<SpawnStatus>('idle');
  const [error, setError] = useState('');

  const close = () => {
    setOpen(false);
    setName('');
    setCwd('');
    setStatus('idle');
    setError('');
  };

  const spawn = async () => {
    const trimmedName = name.trim();
    const trimmedCwd = cwd.trim();
    if (!trimmedName || !trimmedCwd || status === 'spawning') return;

    setStatus('spawning');
    setError('');
    try {
      const response = await api.externalCodexSessionSpawn(trimmedName, trimmedCwd);
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data?.ok) {
        close();
        onCreated();
        return;
      }
      setError(body?.error?.message ?? body?.message ?? 'Codex 세션 생성 실패');
    } catch {
      setError('Codex 세션 생성 실패');
    }
    setStatus('error');
  };

  if (!open) {
    return (
      <div className="px-2 pb-1 pt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-emerald-500/50 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />새 Codex 세션
        </button>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-1 mt-2 space-y-2 rounded-lg border border-border bg-card p-2">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="tmux 세션 이름 (예: codex-work)"
        className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-emerald-500/60"
      />
      <HomeDirInput
        value={cwd}
        onChange={setCwd}
        onSubmit={() => void spawn()}
        placeholder="작업 폴더 (홈 하위)"
      />
      {error && <p className="text-[11px] text-red-500">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={close}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void spawn()}
          disabled={!name.trim() || !cwd.trim() || status === 'spawning'}
          className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'spawning' ? '생성 중…' : '만들기'}
        </button>
      </div>
    </div>
  );
}
