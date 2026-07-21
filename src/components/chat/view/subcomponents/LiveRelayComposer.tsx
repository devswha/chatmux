import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { api } from '../../../../utils/api';

import CommandMenu from './CommandMenu';

type RelayStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'ok'; text: string }
  | { kind: 'queued'; text: string }
  | { kind: 'error'; text: string };

type LiveGjcCommand = {
  name: string;
  description?: string;
  namespace?: string;
  scope?: string;
  sourcePath?: string;
};

/** The active `/…` token under the caret, or null when none applies. */
function getActiveSlashToken(text: string, caret: number): { start: number; query: string } | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '/') {
      const precededByBoundary = index === 0 || /\s/.test(text[index - 1]);
      if (!precededByBoundary) {
        return null;
      }
      const query = text.slice(index, caret);
      // A whitespace inside the token means the command is already fully typed.
      return /\s/.test(query) ? null : { start: index, query };
    }
    if (/\s/.test(char)) {
      return null;
    }
  }
  return null;
}

function filterCommands(commands: LiveGjcCommand[], query: string): LiveGjcCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized === '/') {
    return commands;
  }
  const prefix = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const bare = prefix.slice(1);

  const byPrefix = commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
  if (byPrefix.length > 0) {
    return byPrefix;
  }
  const bySubstring = commands.filter((command) => command.name.toLowerCase().includes(bare));
  if (bySubstring.length > 0) {
    return bySubstring;
  }
  return commands.filter((command) => command.description?.toLowerCase().includes(bare));
}

/**
 * Composer for a live (read-only) session. It does NOT inject into the
 * conversation — it relays the message to the control tower's /send (via the
 * server proxy), which owns outbox/queueing + injection + verification. Shows
 * delivered / queued / error feedback based on the tower's response.
 *
 * A `/` at the start of a word opens a command palette of the slash commands
 * that live gjc session can run — native commands (`~/.gjc/agent/commands`),
 * project commands (`<cwd>/.gjc/commands`), and installed skills — loaded
 * dynamically from the server. Selecting one inserts it into the draft; the
 * command text itself is relayed through the same tower /send path (the tower
 * injects it into the tmux TUI), so no separate execution channel is needed.
 *
 * The status line leads with the session's CURRENT MODEL (from the gjc
 * transcript's last model_change, threaded through the live poll) — the tmux
 * name stays as a muted suffix so the send target remains identifiable.
 */
export default function LiveRelayComposer({
  tmuxName,
  tmuxId = null,
  model = null,
  workspacePath = null,
  relayKind = 'gjc',
  sessionId = null,
}: {
  tmuxName: string;
  tmuxId?: string | null;
  model?: string | null;
  workspacePath?: string | null;
  relayKind?: 'gjc' | 'codex';
  sessionId?: string | null;
}) {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<RelayStatus>({ kind: 'idle' });

  const [commands, setCommands] = useState<LiveGjcCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<LiveGjcCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const slashTokenStartRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load the invokable slash commands for this session once per target. Failure
  // (no gjc home / tower / commands) degrades silently to a plain relay box.
  useEffect(() => {
    if (relayKind !== 'gjc') {
      setCommands([]);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.liveSessionCommands(workspacePath ?? undefined);
        if (!response.ok) {
          return;
        }
        const body = await response.json().catch(() => null);
        const list = (body?.data?.commands ?? body?.commands ?? []) as LiveGjcCommand[];
        if (!cancelled && Array.isArray(list)) {
          setCommands(list);
        }
      } catch {
        // Non-fatal — the composer still relays free text.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, relayKind]);

  const closeCommandMenu = useCallback(() => {
    setShowCommandMenu(false);
    slashTokenStartRef.current = -1;
    setSelectedCommandIndex(0);
  }, []);

  const syncCommandMenu = useCallback(
    (nextValue: string, caret: number) => {
      const token = commands.length > 0 ? getActiveSlashToken(nextValue, caret) : null;
      if (!token) {
        if (showCommandMenu) {
          closeCommandMenu();
        }
        return;
      }
      const filtered = filterCommands(commands, token.query);
      slashTokenStartRef.current = token.start;
      setFilteredCommands(filtered);
      setShowCommandMenu(filtered.length > 0);
      setSelectedCommandIndex(0);
    },
    [commands, showCommandMenu, closeCommandMenu],
  );

  const insertCommand = useCallback(
    (command: LiveGjcCommand) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? input.length;
      const start = slashTokenStartRef.current >= 0 ? slashTokenStartRef.current : caret;
      const before = input.slice(0, start);
      const after = input.slice(caret);
      const needsGap = after.length > 0 && !after.startsWith(' ');
      const nextValue = `${before}${command.name} ${needsGap ? after.trimStart() : after}`;
      setInput(nextValue);
      closeCommandMenu();

      const nextCaret = before.length + command.name.length + 1;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.focus();
          node.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [input, closeCommandMenu],
  );

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || status.kind === 'sending') {
      return;
    }
    setStatus({ kind: 'sending' });
    try {
      const response = relayKind === 'codex'
        ? await api.externalCodexSessionSend(tmuxName, sessionId, message)
        : await api.liveSessionSend(tmuxName, message, tmuxId);
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as { ok?: boolean; reachable?: boolean; queued?: boolean; detail?: string };
      // ok === false covers "tower reachable but refused/failed" (server wraps a
      // tower non-2xx in HTTP 200) — without it a failed relay showed 전달됨 and
      // silently discarded the draft.
      if (!response.ok || data.reachable === false || data.ok === false) {
        setStatus({
          kind: 'error',
          text: data.reachable === false ? '관제탑 미가동 — 전송 불가' : data.detail || '전송 실패',
        });
        return;
      }
      setInput('');
      setStatus(data.queued ? { kind: 'queued', text: '대기열 적재됨' } : { kind: 'ok', text: '전달됨' });
    } catch {
      setStatus({ kind: 'error', text: '전송 실패' });
    }
  }, [input, status.kind, tmuxName, tmuxId, relayKind, sessionId]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showCommandMenu && filteredCommands.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedCommandIndex((index) => (index + 1) % filteredCommands.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedCommandIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCommandMenu();
          return;
        }
        if ((event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === 'Tab') {
          event.preventDefault();
          const index = selectedCommandIndex >= 0 && selectedCommandIndex < filteredCommands.length ? selectedCommandIndex : 0;
          insertCommand(filteredCommands[index]);
          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void send();
      }
    },
    [showCommandMenu, filteredCommands, selectedCommandIndex, closeCommandMenu, insertCommand, send],
  );

  const menuPosition = (() => {
    const rect = textareaRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') {
      return { top: 0, left: 0, bottom: 90 };
    }
    return { top: rect.top, left: rect.left, bottom: Math.max(16, window.innerHeight - rect.top + 8) };
  })();

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-3 pt-2 sm:px-4">
      <div className="mx-auto max-w-[54.25rem] space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-blue-600 dark:text-blue-400">
          <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden />
          {model ? (
            <span>
              <span className="font-semibold">{model.split('/').pop()}</span>
              <span className="text-muted-foreground"> · {tmuxName}</span>
            </span>
          ) : (
            <span><span className="font-semibold">{tmuxName}</span> 세션</span>
          )}
          {status.kind !== 'idle' && status.kind !== 'sending' && (
            <span className={status.kind === 'error' ? 'text-red-500' : 'text-muted-foreground'}>· {status.text}</span>
          )}
        </div>
        <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              const nextValue = event.target.value;
              setInput(nextValue);
              syncCommandMenu(nextValue, event.target.selectionStart ?? nextValue.length);
            }}
            onKeyDown={handleKeyDown}
            onClick={(event) => syncCommandMenu(input, event.currentTarget.selectionStart ?? input.length)}
            rows={1}
            placeholder={`${tmuxName}에 지시… (${relayKind === 'gjc' ? ' / 명령, ' : ''}Enter 전송, Shift+Enter 줄바꿈)`}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || status.kind === 'sending'}
            className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status.kind === 'sending' ? '전송 중…' : '전송'}
          </button>
        </div>
      </div>

      <CommandMenu
        isOpen={showCommandMenu}
        commands={filteredCommands}
        selectedIndex={selectedCommandIndex}
        onSelect={(command, index, isHover) => {
          if (isHover) {
            setSelectedCommandIndex(index);
            return;
          }
          insertCommand(command as LiveGjcCommand);
        }}
        onClose={closeCommandMenu}
        position={menuPosition}
      />
    </div>
  );
}
