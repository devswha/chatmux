/**
 * The relay composer's two completion menus: slash commands / skills, and `@`
 * file mentions.
 *
 * They live in one hook because they are mutually exclusive by design — opening
 * one closes the other — and splitting them would need a callback cycle between
 * two hooks to express that single rule.
 *
 * Both menus only rewrite the draft: neither can send. The caret is restored
 * after an insertion so typing continues where the user was.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import {
  buildPlainTextInsertion,
  filterCommands,
  filterMentionableFiles,
  getActiveMentionToken,
  getActiveSlashToken,
  type LiveGjcCommand,
  type MentionableFile,
} from '../utils/liveRelayComposer';

export type RelayComposerMenusInput = {
  readonly commands: readonly LiveGjcCommand[];
  readonly files: readonly MentionableFile[];
  readonly commandTrigger: string;
  readonly workspacePath: string | null;
  readonly input: string;
  readonly setInput: (next: string | ((current: string) => string)) => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement>;
  /** Asks the file catalog to load; called only once a mention actually starts. */
  readonly requestFiles: () => void;
};

function restoreCaret(textareaRef: React.RefObject<HTMLTextAreaElement>, caret: number): void {
  requestAnimationFrame(() => {
    const node = textareaRef.current;
    if (node) {
      node.focus();
      node.setSelectionRange(caret, caret);
    }
  });
}

export function useRelayComposerMenus(input: RelayComposerMenusInput) {
  const { commandTrigger, commands, files, requestFiles, setInput, textareaRef, workspacePath } = input;
  const draft = input.input;
  const [filteredCommands, setFilteredCommands] = useState<LiveGjcCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const slashTokenStartRef = useRef(-1);
  const [mentionToken, setMentionToken] = useState<{ start: number; query: string } | null>(null);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const mentionTokenStartRef = useRef(-1);

  const closeCommandMenu = useCallback(() => {
    setShowCommandMenu(false);
    slashTokenStartRef.current = -1;
    setSelectedCommandIndex(0);
  }, []);
  const closeFileMenu = useCallback(() => {
    setShowFileMenu(false);
    setSelectedFileIndex(0);
    mentionTokenStartRef.current = -1;
  }, []);

  const applyMentionFilter = useCallback((query: string) => {
    const filtered = filterMentionableFiles(files, query);
    setFilteredFiles(filtered);
    setShowFileMenu(filtered.length > 0);
    setSelectedFileIndex(0);
    if (filtered.length > 0) {
      closeCommandMenu();
    }
  }, [closeCommandMenu, files]);

  const syncFileMenu = useCallback((nextValue: string, caret: number) => {
    const token = workspacePath ? getActiveMentionToken(nextValue, caret) : null;
    setMentionToken(token);
    if (!token) {
      closeFileMenu();
      return;
    }
    mentionTokenStartRef.current = token.start;
    requestFiles();
    applyMentionFilter(token.query.slice(1));
  }, [applyMentionFilter, closeFileMenu, requestFiles, workspacePath]);

  // A tree that arrives after the mention was typed must still populate the menu.
  useEffect(() => {
    if (mentionToken) {
      applyMentionFilter(mentionToken.query.slice(1));
    }
  }, [applyMentionFilter, mentionToken]);

  useEffect(() => {
    setFilteredFiles([]);
    closeFileMenu();
  }, [closeFileMenu, workspacePath]);

  const syncCommandMenu = useCallback((nextValue: string, caret: number) => {
    const token = commands.length > 0 ? getActiveSlashToken(nextValue, caret, commandTrigger) : null;
    if (!token) {
      if (showCommandMenu) {
        closeCommandMenu();
      }
      closeFileMenu();
      return;
    }
    const filtered = filterCommands(commands, token.query, commandTrigger);
    slashTokenStartRef.current = token.start;
    setFilteredCommands(filtered);
    setShowCommandMenu(filtered.length > 0);
    setSelectedCommandIndex(0);
    closeFileMenu();
  }, [closeCommandMenu, closeFileMenu, commandTrigger, commands, showCommandMenu]);

  const syncMenus = useCallback((nextValue: string, caret: number) => {
    syncCommandMenu(nextValue, caret);
    syncFileMenu(nextValue, caret);
  }, [syncCommandMenu, syncFileMenu]);

  const insertToken = useCallback((token: string, start: number, close: () => void) => {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const from = start >= 0 ? start : caret;
    const before = draft.slice(0, from);
    const after = draft.slice(caret);
    const needsGap = after.length > 0 && !after.startsWith(' ');
    setInput(`${before}${token} ${needsGap ? after.trimStart() : after}`);
    close();
    restoreCaret(textareaRef, before.length + token.length + 1);
  }, [draft, setInput, textareaRef]);

  const insertCommand = useCallback((command: LiveGjcCommand) => {
    insertToken(command.name, slashTokenStartRef.current, closeCommandMenu);
  }, [closeCommandMenu, insertToken]);

  const insertFile = useCallback((file: MentionableFile) => {
    insertToken(file.path, mentionTokenStartRef.current, closeFileMenu);
  }, [closeFileMenu, insertToken]);

  const insertPlainPath = useCallback((filePath: string) => {
    setInput((current) => {
      const caret = textareaRef.current?.selectionStart ?? current.length;
      const { text, caretOffset } = buildPlainTextInsertion(current.slice(0, caret), current.slice(caret), filePath);
      restoreCaret(textareaRef, caretOffset);
      return text;
    });
  }, [setInput, textareaRef]);

  /** Menu navigation. Returns true when the key belonged to an open menu. */
  const handleMenuKey = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const menus = [
      { open: showCommandMenu, items: filteredCommands, index: selectedCommandIndex, setIndex: setSelectedCommandIndex, close: closeCommandMenu, insert: insertCommand },
      { open: showFileMenu, items: filteredFiles, index: selectedFileIndex, setIndex: setSelectedFileIndex, close: closeFileMenu, insert: insertFile },
    ] as const;
    for (const menu of menus) {
      if (!menu.open || menu.items.length === 0) continue;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        menu.setIndex((current) => (current + 1) % menu.items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        menu.setIndex((current) => (current - 1 + menu.items.length) % menu.items.length);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        menu.close();
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === 'Tab') {
        event.preventDefault();
        const at = menu.index >= 0 && menu.index < menu.items.length ? menu.index : 0;
        // The two menus carry different item types; each closure inserts its own.
        (menu.insert as (item: typeof menu.items[number]) => void)(menu.items[at]);
        return true;
      }
    }
    return false;
  }, [closeCommandMenu, closeFileMenu, filteredCommands, filteredFiles, insertCommand, insertFile, selectedCommandIndex, selectedFileIndex, showCommandMenu, showFileMenu]);

  return {
    commandMenu: {
      isOpen: showCommandMenu,
      items: filteredCommands,
      selectedIndex: selectedCommandIndex,
      select: setSelectedCommandIndex,
      close: closeCommandMenu,
      insert: insertCommand,
    },
    fileMenu: {
      isOpen: showFileMenu,
      items: filteredFiles,
      selectedIndex: selectedFileIndex,
      select: setSelectedFileIndex,
      close: closeFileMenu,
      insert: insertFile,
    },
    syncMenus,
    insertPlainPath,
    handleMenuKey,
  };
}
