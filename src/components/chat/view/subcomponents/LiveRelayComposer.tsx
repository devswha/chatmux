import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import type { PendingRelayAsk } from '../../utils/pendingRelayAsk';
import {
  buildPlainTextInsertion,
  filterCommands,
  filterMentionableFiles,
  flattenProjectFileTree,
  getActiveMentionToken,
  getActiveSlashToken,
  isRelayImagePathAllowed,
  normalizeWorkspacePath,
  type LiveGjcCommand,
  type MentionableFile,
  type ProjectFileNode,
} from '../../utils/liveRelayComposer';
export {
  filterMentionableFiles,
  flattenProjectFileTree,
  getActiveMentionToken,
} from '../../utils/liveRelayComposer';
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
} from '../../../../shared/view/ui';
import { QuestionAnswerContent } from '../../tools/components/ContentRenderers';

import CommandMenu from './CommandMenu';

type RelayStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'ok'; text: string }
  | { kind: 'queued'; text: string }
  | { kind: 'error'; text: string };

type InteractivePrompt = {
  id: string;
  kind: 'question' | 'approval' | 'plan';
  title: string;
  question: string;
  body: string | null;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  customOptionNumber: number | null;
  cancelNumber: 0;
};

type WorkspaceProject = {
  projectId?: string;
  fullPath?: string;
  path?: string;
};


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
  isProcessing = false,
  transcriptSessionId = null,
  pendingAsk = null,
  choiceSubmitRef,
}: {
  target: TmuxPaneTarget;
  model?: string | null;
  effort?: string | null;
  sessionName?: string | null;
  workspacePath?: string | null;
  relayKind?: 'gjc' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'omp';
  /** True while the target session is running a turn — enables the stop control. */
  isProcessing?: boolean;
  transcriptSessionId?: string | null;
  pendingAsk?: PendingRelayAsk | null;
  /**
   * Receives the composer's choice submitter so transcript-rendered ask cards
   * (which live outside this component) can deliver a tapped choice number
   * through the same validated relay path as typed answers.
   */
  choiceSubmitRef?: MutableRefObject<((choiceNumber: number) => void) | null>;
}) {
  const commandTrigger = relayKind === 'codex' ? '$' : '/';
  const { t } = useTranslation('chat');
  const displayName = sessionName?.trim() || t('relay.currentSession');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<RelayStatus>({ kind: 'idle' });
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [customInputToolId, setCustomInputToolId] = useState<string | null>(null);
  const [interactivePrompt, setInteractivePrompt] = useState<InteractivePrompt | null>(null);
  const [customInputPromptId, setCustomInputPromptId] = useState<string | null>(null);
  const [assetStatus, setAssetStatus] = useState<
    { kind: 'idle' } | { kind: 'uploading' } | { kind: 'error'; text: string }
  >({ kind: 'idle' });
  const canInterrupt = relayKind === 'gjc'
    || relayKind === 'codex'
    || relayKind === 'claude'
    || relayKind === 'cursor'
    || relayKind === 'opencode'
    || relayKind === 'omp';

  const [commands, setCommands] = useState<LiveGjcCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<LiveGjcCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const slashTokenStartRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<MentionableFile[]>([]);
  const [mentionToken, setMentionToken] = useState<{ start: number; query: string } | null>(null);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const mentionTokenStartRef = useRef(-1);
  const loadedFileWorkspaceRef = useRef<string | null>(null);
  const fileWorkspaceRequestRef = useRef<string | null>(null);
  const workspacePathRef = useRef(workspacePath);
  const isMountedRef = useRef(true);
  const mentionQuery = mentionToken?.query ?? null;
  workspacePathRef.current = workspacePath;
  const isAwaitingCustomInput = Boolean(
    pendingAsk && customInputToolId === pendingAsk.toolId,
  );
  const isAwaitingInteractiveCustom = Boolean(
    interactivePrompt && customInputPromptId === interactivePrompt.id,
  );

  useEffect(() => {
    if (!pendingAsk || pendingAsk.toolId !== customInputToolId) {
      setCustomInputToolId(null);
    }
  }, [pendingAsk, customInputToolId]);

  useEffect(() => {
    if (!interactivePrompt || interactivePrompt.id !== customInputPromptId) {
      setCustomInputPromptId(null);
    }
  }, [interactivePrompt, customInputPromptId]);

  useEffect(() => {
    if (
      relayKind !== 'gjc'
      && relayKind !== 'codex'
      && relayKind !== 'omp'
      && relayKind !== 'claude'
    ) {
      setInteractivePrompt(null);
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = relayKind === 'gjc'
          ? await api.liveSessionInteractivePrompt(target.tmux, target.process)
          : await api.externalCliSessionInteractivePrompt(target.tmux, target.process);
        const body = await response.json().catch(() => null);
        if (cancelled || !response.ok) return;
        const prompt = body?.data?.prompt;
        setInteractivePrompt(
          prompt
          && typeof prompt.id === 'string'
          && typeof prompt.question === 'string'
          && Array.isArray(prompt.options)
            ? prompt as InteractivePrompt
            : null,
        );
      } catch {
        // Best effort. Free-text relay remains available if prompt polling fails.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [relayKind, target]);

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
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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

  const syncFileMenu = useCallback(
    (nextValue: string, caret: number) => {
      const token = workspacePath ? getActiveMentionToken(nextValue, caret) : null;
      setMentionToken(token);
      if (!token) {
        closeFileMenu();
        return;
      }

      mentionTokenStartRef.current = token.start;
      const filtered = filterMentionableFiles(files, token.query.slice(1));
      setFilteredFiles(filtered);
      setShowFileMenu(filtered.length > 0);
      setSelectedFileIndex(0);
      if (filtered.length > 0) {
        closeCommandMenu();
      }
    },
    [workspacePath, files, closeFileMenu, closeCommandMenu],
  );

  useEffect(() => {
    if (!mentionToken) {
      return;
    }

    const filtered = filterMentionableFiles(files, mentionToken.query.slice(1));
    setFilteredFiles(filtered);
    setShowFileMenu(filtered.length > 0);
    setSelectedFileIndex(0);
    if (filtered.length > 0) {
      closeCommandMenu();
    }
  }, [mentionToken, files, closeCommandMenu]);

  useEffect(() => {
    if (
      !workspacePath
      || !mentionQuery
      || loadedFileWorkspaceRef.current === workspacePath
      || fileWorkspaceRequestRef.current === workspacePath
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (
        loadedFileWorkspaceRef.current === workspacePath
        || fileWorkspaceRequestRef.current === workspacePath
      ) {
        return;
      }

      fileWorkspaceRequestRef.current = workspacePath;
      void (async () => {
        try {
          const projectsResponse = await api.projects();
          if (!projectsResponse.ok || workspacePathRef.current !== workspacePath) {
            return;
          }

          const projects = (await projectsResponse.json()) as WorkspaceProject[];
          if (!Array.isArray(projects)) {
            return;
          }

          const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
          const project = projects.find((candidate) =>
            [candidate.fullPath, candidate.path]
              .filter((path): path is string => typeof path === 'string')
              .some((path) => normalizeWorkspacePath(path) === normalizedWorkspacePath),
          );
          if (!project?.projectId) {
            return;
          }

          const filesResponse = await api.getFiles(project.projectId);
          if (!filesResponse.ok || workspacePathRef.current !== workspacePath) {
            return;
          }

          const tree = (await filesResponse.json()) as ProjectFileNode[];
          if (!Array.isArray(tree) || workspacePathRef.current !== workspacePath || !isMountedRef.current) {
            return;
          }

          loadedFileWorkspaceRef.current = workspacePath;
          setFiles(flattenProjectFileTree(tree));
        } catch {
          // File mentions are optional; the relay remains usable without them.
        } finally {
          if (fileWorkspaceRequestRef.current === workspacePath) {
            fileWorkspaceRequestRef.current = null;
          }
        }
      })();
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [workspacePath, mentionQuery]);

  useEffect(() => {
    setFiles([]);
    setFilteredFiles([]);
    loadedFileWorkspaceRef.current = null;
    fileWorkspaceRequestRef.current = null;
    closeFileMenu();
  }, [workspacePath, closeFileMenu]);

  const syncCommandMenu = useCallback(
    (nextValue: string, caret: number) => {
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
    },
    [commands, showCommandMenu, closeCommandMenu, closeFileMenu, commandTrigger],
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
  const insertFile = useCallback(
    (file: MentionableFile) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? input.length;
      const start = mentionTokenStartRef.current >= 0 ? mentionTokenStartRef.current : caret;
      const before = input.slice(0, start);
      const after = input.slice(caret);
      const needsGap = after.length > 0 && !after.startsWith(' ');
      const nextValue = `${before}${file.path} ${needsGap ? after.trimStart() : after}`;
      setInput(nextValue);
      closeFileMenu();

      const nextCaret = before.length + file.path.length + 1;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.focus();
          node.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [input, closeFileMenu],
  );
  const insertPlainPath = useCallback((filePath: string) => {
    setInput((current) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? current.length;
      const { text, caretOffset } = buildPlainTextInsertion(current.slice(0, caret), current.slice(caret), filePath);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.focus();
          node.setSelectionRange(caretOffset, caretOffset);
        }
      });
      return text;
    });
  }, []);

  // B10: pasted/dropped images upload once through the shared asset store
  // and only the resulting plain-text path is inserted — no upload API is
  // mocked and no new send path is introduced; the inserted text leaves
  // through the existing `send` below like any other typed text.
  const handleImageUpload = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }
    setAssetStatus({ kind: 'uploading' });
    try {
      const response = await api.uploadImageAssets(imageFiles);
      const body = await response.json().catch(() => null);
      const images = Array.isArray(body?.images)
        ? (body.images as Array<{ path?: unknown; name?: unknown }>)
        : null;
      if (!response.ok || !images || images.length === 0) {
        setAssetStatus({ kind: 'error', text: t('relay.imageUploadFailed', { defaultValue: 'Image upload failed' }) });
        return;
      }
      let rejected = false;
      for (const image of images) {
        if (typeof image.path !== 'string' || !isRelayImagePathAllowed(image.path, workspacePath)) {
          rejected = true;
          continue;
        }
        insertPlainPath(image.path);
      }
      setAssetStatus(rejected
        ? { kind: 'error', text: t('relay.imagePathRejected', { defaultValue: 'Rejected image path outside the project or home directory' }) }
        : { kind: 'idle' });
    } catch {
      setAssetStatus({ kind: 'error', text: t('relay.imageUploadFailed', { defaultValue: 'Image upload failed' }) });
    }
  }, [insertPlainPath, t, workspacePath]);

  const handleComposerPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void handleImageUpload(imageFiles);
  }, [handleImageUpload]);

  const handleComposerDrop = useCallback((event: DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void handleImageUpload(imageFiles);
  }, [handleImageUpload]);

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) {
      event.preventDefault();
    }
  }, []);

  const send = useCallback(async (overrideMessage?: string) => {
    const message = (overrideMessage ?? input).trim();
    if (!message || status.kind === 'sending') {
      return;
    }
    setStatus({ kind: 'sending' });
    try {
      let response: Response;
      // When both the screen-parsed interactive prompt and a transcript
      // pending ask describe the question, the composer renders the pendingAsk
      // card (see the `interactivePrompt && !pendingAsk` block below), so
      // numeric answers must follow the displayed pendingAsk numbering — not
      // the hidden interactive prompt. A custom-input continuation stays on
      // the interactive route that initiated it.
      const interactiveRoute = interactivePrompt !== null
        && (isAwaitingInteractiveCustom || !pendingAsk);
      const interactiveNumbers = !isAwaitingInteractiveCustom
        && interactiveRoute
        && interactivePrompt
        && /^\d+(?:\s*,\s*\d+)*$/.test(message)
          ? message.split(',').map((value) => Number.parseInt(value.trim(), 10))
          : null;
      if (interactiveRoute && interactivePrompt && !isAwaitingInteractiveCustom && !interactiveNumbers) {
        setStatus({
          kind: 'error',
          text: interactivePrompt.multiSelect
            ? t('relay.multiSelectionNumberRequired', {
                defaultValue: 'Enter one or more displayed numbers separated by commas.',
              })
            : t('relay.selectionNumberRequired', {
                max: interactivePrompt.customOptionNumber ?? interactivePrompt.options.length,
                defaultValue: 'Enter a displayed number (0-{{max}}).',
              }),
        });
        return;
      }
      if (interactiveNumbers) {
        const maximum = interactivePrompt?.customOptionNumber
          ?? interactivePrompt?.options.length
          ?? 0;
        if (
          interactiveNumbers.some((number) => number < 0 || number > maximum)
          || (interactiveNumbers.includes(0) && interactiveNumbers.length !== 1)
          || (!interactivePrompt?.multiSelect && interactiveNumbers.length !== 1)
          || new Set(interactiveNumbers).size !== interactiveNumbers.length
        ) {
          setStatus({
            kind: 'error',
            text: interactivePrompt?.multiSelect
              ? t('relay.multiSelectionNumberRequired', {
                  defaultValue: 'Enter one or more displayed numbers separated by commas.',
                })
              : t('relay.selectionNumberRequired', {
                  max: maximum,
                  defaultValue: 'Enter a displayed number (0-{{max}}).',
                }),
          });
          return;
        }
        // The server intentionally rejects Claude multi-select toggling until
        // the real key sequence is verified (TMUX_INTERACTIVE_CHOICE_UNSUPPORTED);
        // only cancel (0) is deliverable. Surface that up front instead of
        // letting every submission round-trip into a 400.
        if (
          relayKind === 'claude'
          && interactivePrompt?.multiSelect
          && !(interactiveNumbers.length === 1 && interactiveNumbers[0] === 0)
        ) {
          setStatus({
            kind: 'error',
            text: t('relay.claudeMultiSelectUnsupported', {
              defaultValue: 'Claude multi-select answers must be made in the terminal. Enter 0 to cancel the prompt.',
            }),
          });
          return;
        }
      }
      if (interactivePrompt && isAwaitingInteractiveCustom) {
        response = relayKind === 'gjc'
          ? await api.liveSessionInteractiveCustom(
              target.tmux,
              target.process,
              interactivePrompt.id,
              message,
            )
          : await api.externalCliSessionInteractiveCustom(
              target.tmux,
              target.process,
              interactivePrompt.id,
              message,
            );
      } else if (interactivePrompt && interactiveNumbers) {
        response = relayKind === 'gjc'
          ? await api.liveSessionInteractiveRespond(
              target.tmux,
              target.process,
              interactivePrompt.id,
              interactiveNumbers,
            )
          : await api.externalCliSessionInteractiveRespond(
              target.tmux,
              target.process,
              interactivePrompt.id,
              interactiveNumbers,
            );
      } else if (pendingAsk && transcriptSessionId) {
        if (isAwaitingCustomInput) {
          response = relayKind !== 'gjc'
            ? await api.externalCliSessionAskCustom(
                target.tmux,
                target.process,
                transcriptSessionId,
                pendingAsk.toolId,
                message,
              )
            : await api.liveSessionAskCustom(
                target.tmux,
                target.process,
                transcriptSessionId,
                pendingAsk.toolId,
                message,
              );
        } else {
          if (!/^\d+$/.test(message)) {
            setStatus({
              kind: 'error',
              text: t('relay.selectionNumberRequired', {
                max: pendingAsk.maxChoiceNumber,
                defaultValue: 'Enter a displayed number (0-{{max}}).',
              }),
            });
            return;
          }
          const number = Number.parseInt(message, 10);
          if (number < 0 || number > pendingAsk.maxChoiceNumber) {
            setStatus({
              kind: 'error',
              text: t('relay.selectionNumberRequired', {
                max: pendingAsk.maxChoiceNumber,
                defaultValue: 'Enter a displayed number (0-{{max}}).',
              }),
            });
            return;
          }
          response = relayKind !== 'gjc'
            ? await api.externalCliSessionAskSelect(
                target.tmux,
                target.process,
                transcriptSessionId,
                pendingAsk.toolId,
                number === 0 ? -1 : number - 1,
              )
            : await api.liveSessionAskSelect(
                target.tmux,
                target.process,
                transcriptSessionId,
                pendingAsk.toolId,
                number === 0 ? -1 : number - 1,
              );
        }
      } else {
        response = relayKind !== 'gjc'
          ? await api.externalCliSessionSend(target.tmux, target.process, message)
          : await api.liveSessionSend(target.tmux, target.process, message);
      }
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as {
        ok?: boolean;
        reachable?: boolean;
        queued?: boolean;
        detail?: string;
        action?: 'option' | 'other' | 'cancel';
      };
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
            ? t('relay.towerUnavailable')
            : data.detail || apiError || t('relay.sendFailed'),
        });
        return;
      }
      // A tapped choice must not discard an unrelated typed draft.
      if (overrideMessage === undefined) setInput('');
      if (interactiveRoute && interactivePrompt && !isAwaitingInteractiveCustom && data.action === 'other') {
        setCustomInputPromptId(interactivePrompt.id);
        setStatus({
          kind: 'ok',
          text: t('relay.customInputReady', { defaultValue: 'Type the custom answer.' }),
        });
      } else if (interactiveRoute && interactivePrompt) {
        setInteractivePrompt(null);
        setCustomInputPromptId(null);
        setStatus({
          kind: 'ok',
          text: t('relay.selectionDelivered', { defaultValue: 'Selection delivered.' }),
        });
      } else if (pendingAsk && !isAwaitingCustomInput && data.action === 'other') {
        setCustomInputToolId(pendingAsk.toolId);
        setStatus({
          kind: 'ok',
          text: t('relay.customInputReady', { defaultValue: 'Type the custom answer.' }),
        });
      } else {
        setCustomInputToolId(null);
        setStatus(data.queued
          ? { kind: 'queued', text: t('relay.queued') }
          : { kind: 'ok', text: t('relay.delivered') });
      }
    } catch {
      setStatus({ kind: 'error', text: t('relay.sendFailed') });
    }
  }, [
    input,
    status.kind,
    pendingAsk,
    interactivePrompt,
    isAwaitingInteractiveCustom,
    transcriptSessionId,
    isAwaitingCustomInput,
    target,
    relayKind,
    t,
  ]);

  // Expose the choice submitter to the transcript-rendered pending ask card.
  useEffect(() => {
    if (!choiceSubmitRef) return undefined;
    choiceSubmitRef.current = (choiceNumber: number) => {
      void send(String(choiceNumber));
    };
    return () => {
      choiceSubmitRef.current = null;
    };
  }, [choiceSubmitRef, send]);
  const interrupt = useCallback(async () => {
    if (!canInterrupt || isInterrupting) {
      return;
    }

    setIsInterrupting(true);
    try {
      const response = relayKind !== 'gjc'
        ? await api.externalCliSessionAction(target.tmux, target.process, 'interrupt')
        : await api.liveSessionAction(target.tmux, target.process, 'interrupt');
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as { ok?: boolean };
      if (!response.ok || data.ok === false) {
        setStatus({ kind: 'error', text: t('relay.interruptFailed', { defaultValue: 'Unable to interrupt' }) });
        return;
      }
      setStatus({ kind: 'ok', text: t('relay.interruptSent', { defaultValue: 'Interrupt sent' }) });
    } catch {
      setStatus({ kind: 'error', text: t('relay.interruptFailed', { defaultValue: 'Unable to interrupt' }) });
    } finally {
      setIsInterrupting(false);
    }
  }, [canInterrupt, isInterrupting, relayKind, t, target]);

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
      if (showFileMenu && filteredFiles.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedFileIndex((index) => (index + 1) % filteredFiles.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedFileIndex((index) => (index - 1 + filteredFiles.length) % filteredFiles.length);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeFileMenu();
          return;
        }
        if ((event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === 'Tab') {
          event.preventDefault();
          const index = selectedFileIndex >= 0 && selectedFileIndex < filteredFiles.length ? selectedFileIndex : 0;
          insertFile(filteredFiles[index]);
          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void send();
      }
    },
    [showCommandMenu, filteredCommands, selectedCommandIndex, closeCommandMenu, insertCommand, showFileMenu, filteredFiles, selectedFileIndex, closeFileMenu, insertFile, send],
  );

  const menuPosition = (() => {
    const rect = textareaRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') {
      return { top: 0, left: 0, bottom: 90 };
    }
    return { top: rect.top, left: rect.left, bottom: Math.max(16, window.innerHeight - rect.top + 8) };
  })();

  // ccui-style single control: the round submit button sends when a draft
  // exists and becomes a stop control while the session runs a turn. The
  // stop path is the only way to reach interrupt, so an idle CLI can never
  // receive a stray Ctrl+C that would terminate it.
  const hasDraft = input.trim().length > 0;
  const showStop = isProcessing && canInterrupt && !hasDraft;
  const submitLabel = showStop
    ? t('input.stop', { defaultValue: 'Stop' })
    : status.kind === 'sending'
      ? t('relay.sending')
      : t('relay.send');
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };
  const handleStopClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    void interrupt();
  };

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-3 pt-2 sm:px-4">
      <div className="mx-auto max-w-[54.25rem] space-y-1.5">
        {interactivePrompt && !pendingAsk && (
          <div className="space-y-2">
            {interactivePrompt.body && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                {interactivePrompt.body}
              </pre>
            )}
            <QuestionAnswerContent
              questions={[{
                header: interactivePrompt.title,
                question: interactivePrompt.question,
                options: interactivePrompt.options,
                multiSelect: interactivePrompt.multiSelect,
              }]}
              answers={{}}
              pending
              allowDirectInput={interactivePrompt.customOptionNumber !== null}
              directInputNumber={interactivePrompt.customOptionNumber ?? undefined}
              onSelectChoice={interactivePrompt.multiSelect
                ? undefined
                : (choiceNumber) => { void send(String(choiceNumber)); }}
            />
          </div>
        )}
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
            <span aria-live="polite" className={status.kind === 'error' ? 'text-red-500' : 'text-muted-foreground'}>· {status.text}</span>
          )}
          {assetStatus.kind === 'uploading' && (
            <span aria-live="polite" className="text-muted-foreground">· {t('relay.imageUploading', { defaultValue: 'Uploading image…' })}</span>
          )}
          {assetStatus.kind === 'error' && (
            <span aria-live="polite" className="text-red-500">· {assetStatus.text}</span>
          )}
        </div>
        <PromptInput
          status={isProcessing ? 'streaming' : 'ready'}
          onSubmit={handleSubmit}
          onDrop={handleComposerDrop}
          onDragOver={handleComposerDragOver}
        >
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                const nextValue = event.target.value;
                setInput(nextValue);
                syncCommandMenu(nextValue, event.target.selectionStart ?? nextValue.length);
                syncFileMenu(nextValue, event.target.selectionStart ?? nextValue.length);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handleComposerPaste}
              onClick={(event) => {
                const caret = event.currentTarget.selectionStart ?? input.length;
                syncCommandMenu(input, caret);
                syncFileMenu(input, caret);
              }}
              rows={1}
              placeholder={
                isAwaitingInteractiveCustom || isAwaitingCustomInput
                  ? t('relay.customInputPlaceholder', { defaultValue: 'Type the custom answer…' })
                  : interactivePrompt && !pendingAsk
                    ? interactivePrompt.multiSelect
                      ? t('relay.multiSelectionPlaceholder', {
                          defaultValue: 'Enter choice numbers separated by commas…',
                        })
                      : t('relay.selectionPlaceholder', {
                          max: interactivePrompt.customOptionNumber ?? interactivePrompt.options.length,
                          defaultValue: 'Enter a choice number (0-{{max}})…',
                        })
                    : pendingAsk
                    ? t('relay.selectionPlaceholder', {
                        max: pendingAsk.maxChoiceNumber,
                        defaultValue: 'Enter a choice number (0-{{max}})…',
                      })
                    : t('relay.placeholder', { name: displayName, trigger: commandTrigger })
              }
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools className="min-w-0" />
            <PromptInputSubmit
              status={showStop ? 'streaming' : 'ready'}
              onClick={showStop ? handleStopClick : undefined}
              disabled={showStop ? isInterrupting : (!hasDraft || status.kind === 'sending')}
              aria-label={submitLabel}
              title={submitLabel}
              className="h-9 w-9"
            />
          </PromptInputFooter>
        </PromptInput>
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
      <CommandMenu
        isOpen={showFileMenu}
        commands={filteredFiles.map((file) => ({ name: file.path, path: file.path, namespace: 'project' }))}
        selectedIndex={selectedFileIndex}
        onSelect={(file, index, isHover) => {
          if (isHover) {
            setSelectedFileIndex(index);
            return;
          }
          insertFile({ name: file.name, path: file.path ?? file.name });
        }}
        onClose={closeFileMenu}
        position={menuPosition}
      />
    </div>
  );
}
