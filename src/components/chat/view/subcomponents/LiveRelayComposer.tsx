import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { api } from '../../../../utils/api';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';

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

/** The active trigger token (`/…` for gjc, `$…` for codex) under the caret, or null. */
function getActiveSlashToken(text: string, caret: number, trigger: string): { start: number; query: string } | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === trigger) {
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

function filterCommands(commands: LiveGjcCommand[], query: string, trigger: string): LiveGjcCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized === trigger) {
    return commands;
  }
  const prefix = normalized.startsWith(trigger) ? normalized : `${trigger}${normalized}`;
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
 * conversation. GJC relays through the control tower; native Codex and Claude
 * sessions relay through their verified tmux target. The composer shows
 * delivered / queued / error feedback from the selected transport.
 *
 * GJC `/` commands and Codex `$` skills are loaded dynamically. Claude remains
 * a plain-text relay because its interactive slash-command catalog is owned by
 * the native TUI and is not exposed as a stable external API.
 *
 * The status line leads with the session's current model when available. The
 * human-readable tmux session name identifies the send target; internal tmux
 * coordinates remain transport-only.
 */
export default function LiveRelayComposer({
  target,
  model = null,
  effort = null,
  sessionName = null,
  workspacePath = null,
  relayKind = 'gjc',
}: {
  target: TmuxPaneTarget;
  model?: string | null;
  effort?: string | null;
  sessionName?: string | null;
  workspacePath?: string | null;
  relayKind?: 'gjc' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'omp';
}) {
  const commandTrigger = relayKind === 'codex' ? '$' : '/';
  const displayName = sessionName?.trim() || '현재 세션';
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<RelayStatus>({ kind: 'idle' });

  const [commands, setCommands] = useState<LiveGjcCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<LiveGjcCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const slashTokenStartRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // GJC exposes its live command catalog; native external agents expose their
  // provider skills. Failure is non-fatal because free-text relay still works.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = relayKind === 'gjc'
          ? await api.liveSessionCommands(workspacePath ?? undefined)
          : await api.providerSkills(relayKind, workspacePath ?? undefined);
        if (!response.ok) {
          return;
        }
        const body = await response.json().catch(() => null);
        if (cancelled) {
          return;
        }
        if (relayKind !== 'gjc') {
          const skills = (body?.data?.skills ?? body?.skills ?? []) as Array<{ command?: string; name?: string; description?: string }>;
          setCommands(skills
            .filter((skill) => skill?.command || skill?.name)
            .map((skill) => ({
              name: skill.command || `${commandTrigger}${skill.name}`,
              description: skill.description,
              namespace: 'skill',
            })));
        } else {
          const list = (body?.data?.commands ?? body?.commands ?? []) as LiveGjcCommand[];
          if (Array.isArray(list)) {
            setCommands(list);
          }
        }
      } catch {
        // Non-fatal — the composer still relays free text.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, relayKind, commandTrigger]);

  const closeCommandMenu = useCallback(() => {
    setShowCommandMenu(false);
    slashTokenStartRef.current = -1;
    setSelectedCommandIndex(0);
  }, []);

  const syncCommandMenu = useCallback(
    (nextValue: string, caret: number) => {
      const token = commands.length > 0 ? getActiveSlashToken(nextValue, caret, commandTrigger) : null;
      if (!token) {
        if (showCommandMenu) {
          closeCommandMenu();
        }
        return;
      }
      const filtered = filterCommands(commands, token.query, commandTrigger);
      slashTokenStartRef.current = token.start;
      setFilteredCommands(filtered);
      setShowCommandMenu(filtered.length > 0);
      setSelectedCommandIndex(0);
    },
    [commands, showCommandMenu, closeCommandMenu, commandTrigger],
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
      const response = relayKind !== 'gjc'
        ? await api.externalCliSessionSend(target.tmux, target.process, message)
        : await api.liveSessionSend(target.tmux, target.process, message);
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as { ok?: boolean; reachable?: boolean; queued?: boolean; detail?: string };
      const apiError = typeof body?.error?.message === 'string'
        ? body.error.message
        : typeof body?.message === 'string'
          ? body.message
          : null;
      // ok === false covers "tower reachable but refused/failed" (server wraps a
      // tower non-2xx in HTTP 200) — without it a failed relay showed 전달됨 and
      // silently discarded the draft.
      if (!response.ok || data.reachable === false || data.ok === false) {
        setStatus({
          kind: 'error',
          text: data.reachable === false
            ? '관제탑 미가동 — 전송 불가'
            : data.detail || apiError || '전송 실패',
        });
        return;
      }
      setInput('');
      setStatus(data.queued ? { kind: 'queued', text: '대기열 적재됨' } : { kind: 'ok', text: '전달됨' });
    } catch {
      setStatus({ kind: 'error', text: '전송 실패' });
    }
  }, [input, status.kind, target, relayKind]);

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
              {effort && <span className="text-muted-foreground"> · {effort} effort</span>}
              <span className="text-muted-foreground"> · {displayName}</span>
            </span>
          ) : (
            <span className="font-semibold">{displayName}</span>
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
            placeholder={`${displayName}에 지시… (${commandTrigger} 명령, Enter 전송, Shift+Enter 줄바꿈)`}
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
