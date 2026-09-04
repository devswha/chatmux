import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent, MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { RelayTransportTarget } from '../../utils/relayTransport';
import type { PendingRelayAsk } from '../../utils/pendingRelayAsk';
import type { LiveGjcCommand } from '../../utils/liveRelayComposer';
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputSubmit,
} from '../../../../shared/view/ui';
import { useFleetHost } from '../../../../fleet/FleetSessionRoute';
import { useChatComposerHeight } from '../../hooks/useChatComposerHeight';
import { useRelayCommandInventory } from '../../hooks/useRelayCommandInventory';
import { useRelayComposerMenus } from '../../hooks/useRelayComposerMenus';
import { useRelayDelivery } from '../../hooks/useRelayDelivery';
import { useRelayFileCatalog } from '../../hooks/useRelayFileCatalog';
import { useRelayImageAssets } from '../../hooks/useRelayImageAssets';
import { useRelayInteractivePrompt } from '../../hooks/useRelayInteractivePrompt';

import CommandMenu from './CommandMenu';
import ChatComposerResizeHandle from './ChatComposerResizeHandle';
import RelayPromptCard from './RelayPromptCard';
import RelayStatusLine from './RelayStatusLine';

const INTERRUPTIBLE = new Set(['gjc', 'codex', 'claude', 'cursor', 'opencode', 'omp']);

/**
 * Composer for a live (read-only) session. It does NOT inject into the
 * conversation. GJC relays through the control tower; native Codex and Claude
 * sessions relay through their verified tmux target. The composer shows
 * delivered / queued / error feedback from the selected transport.
 *
 * The command catalog and the interactive prompt belong to the machine running
 * the session, so both are read through the owning host — local or peer — rather
 * than from this installation's own provider state.
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
  target: RelayTransportTarget;
  model?: string | null;
  effort?: string | null;
  sessionName?: string | null;
  workspacePath?: string | null;
  relayKind?: 'gjc' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'omp' | 'omo';
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
  // Keyboard hints in the long placeholder wrap to a second line on phone
  // widths, making an empty composer look two rows tall. Coarse-pointer
  // devices use software keyboards, so the hints carry no information there.
  const compactPlaceholders = typeof window !== 'undefined'
    && window.matchMedia?.('(max-width: 640px)').matches === true;
  const commandTrigger = relayKind === 'codex' ? '$' : '/';
  const { t } = useTranslation('chat');
  const displayName = sessionName?.trim() || t('relay.currentSession');
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerHeight = useChatComposerHeight(textareaRef);

  const fleetHost = useFleetHost();
  const relaySession = {
    hostId: target.hostId ?? fleetHost.storeScope.hostId,
    localHostId: fleetHost.storeScope.localHostId,
    localId: transcriptSessionId ?? target.localId ?? null,
  };
  const commands = useRelayCommandInventory({ relayKind, workspacePath, commandTrigger, session: relaySession });
  const { prompt, dismiss: dismissPrompt } = useRelayInteractivePrompt({ relayKind, target, session: relaySession });

  const fileCatalog = useRelayFileCatalog(workspacePath);
  const menus = useRelayComposerMenus({
    commands,
    files: fileCatalog.files,
    requestFiles: fileCatalog.request,
    commandTrigger,
    workspacePath,
    input,
    setInput,
    textareaRef,
  });

  const delivery = useRelayDelivery({
    relayKind,
    target,
    transcriptSessionId,
    prompt,
    dismissPrompt,
    ask: pendingAsk,
    canInterrupt: INTERRUPTIBLE.has(relayKind),
    text: {
      selectionNumberRequired: (max) => t('relay.selectionNumberRequired', { max, defaultValue: 'Enter a displayed number (0-{{max}}).' }),
      multiSelectionNumberRequired: t('relay.multiSelectionNumberRequired', { defaultValue: 'Enter one or more displayed numbers separated by commas.' }),
      towerUnavailable: t('relay.towerUnavailable'),
      sendFailed: t('relay.sendFailed'),
      queued: t('relay.queued'),
      delivered: t('relay.delivered'),
      selectionDelivered: t('relay.selectionDelivered', { defaultValue: 'Selection delivered.' }),
      customInputReady: t('relay.customInputReady', { defaultValue: 'Type the custom answer.' }),
      interruptSent: t('relay.interruptSent', { defaultValue: 'Interrupt sent' }),
      interruptFailed: t('relay.interruptFailed', { defaultValue: 'Unable to interrupt' }),
    },
  });

  const assets = useRelayImageAssets({
    workspacePath,
    insertPath: menus.insertPlainPath,
    uploadFailedText: t('relay.imageUploadFailed', { defaultValue: 'Image upload failed' }),
    pathRejectedText: t('relay.imagePathRejected', { defaultValue: 'Rejected image path outside the project or home directory' }),
  });

  const send = useCallback(async (override?: string) => {
    if (await delivery.send(input, override)) {
      setInput('');
    }
  }, [delivery, input]);

  // Expose the choice submitter to the transcript-rendered pending ask card.
  useEffect(() => {
    if (!choiceSubmitRef) return undefined;
    choiceSubmitRef.current = (choiceNumber: number) => { void send(String(choiceNumber)); };
    return () => { choiceSubmitRef.current = null; };
  }, [choiceSubmitRef, send]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menus.handleMenuKey(event)) {
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }, [menus, send]);

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
  const showStop = isProcessing && INTERRUPTIBLE.has(relayKind) && !hasDraft;
  const submitLabel = showStop
    ? t('input.stop', { defaultValue: 'Stop' })
    : delivery.status.kind === 'sending' ? t('relay.sending') : t('relay.send');
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };
  const handleStopClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    void delivery.interrupt();
  };
  const showPromptCard = prompt !== null && pendingAsk === null;
  const placeholder = delivery.awaitingCustomInput
    ? t('relay.customInputPlaceholder', { defaultValue: 'Type the custom answer…' })
    : showPromptCard && prompt.multiSelect
      ? t('relay.multiSelectionPlaceholder', { defaultValue: 'Enter choice numbers separated by commas…' })
      : showPromptCard
        ? t('relay.selectionPlaceholder', { max: prompt.customOptionNumber ?? prompt.options.length, defaultValue: 'Enter a choice number (0-{{max}})…' })
        : pendingAsk
          ? t('relay.selectionPlaceholder', { max: pendingAsk.maxChoiceNumber, defaultValue: 'Enter a choice number (0-{{max}})…' })
          : compactPlaceholders
            ? t('relay.placeholderShort', { name: displayName, defaultValue: 'Message {{name}}…' })
            : t('relay.placeholder', { name: displayName, trigger: commandTrigger });

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-3 pt-2 sm:px-4">
      <div className="mx-auto max-w-[54.25rem] space-y-1.5">
        {showPromptCard && (
          <RelayPromptCard prompt={prompt} onAnswer={(message) => { void send(message); }} />
        )}
        <RelayStatusLine
          displayName={displayName}
          model={model}
          effort={effort}
          status={delivery.status}
          assetStatus={assets.status}
        />
        <PromptInput
          status={isProcessing ? 'streaming' : 'ready'}
          onSubmit={handleSubmit}
          onDrop={assets.handleDrop}
          onDragOver={assets.handleDragOver}
          className={composerHeight.manualHeight !== null ? 'chat-input-expanded' : ''}
        >
          <ChatComposerResizeHandle
            textareaRef={textareaRef}
            textareaHeight={composerHeight.manualHeight}
            onHeightChange={composerHeight.setManualHeight}
            onHeightReset={composerHeight.resetManualHeight}
          />
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                const nextValue = event.target.value;
                setInput(nextValue);
                menus.syncMenus(nextValue, event.target.selectionStart ?? nextValue.length);
              }}
              onKeyDown={handleKeyDown}
              onPaste={assets.handlePaste}
              onClick={(event) => {
                menus.syncMenus(input, event.currentTarget.selectionStart ?? input.length);
              }}
              rows={1}
              className="pr-14"
              placeholder={placeholder}
            />
            <PromptInputSubmit
              status={showStop ? 'streaming' : 'ready'}
              onClick={showStop ? handleStopClick : undefined}
              disabled={showStop ? delivery.isInterrupting : (!hasDraft || delivery.status.kind === 'sending')}
              aria-label={submitLabel}
              title={submitLabel}
              className="absolute bottom-2 right-2 h-9 w-9"
            />
          </PromptInputBody>
        </PromptInput>
      </div>

      <CommandMenu
        isOpen={menus.commandMenu.isOpen}
        commands={menus.commandMenu.items}
        selectedIndex={menus.commandMenu.selectedIndex}
        onSelect={(command, index, isHover) => {
          if (isHover) {
            menus.commandMenu.select(index);
            return;
          }
          menus.commandMenu.insert(command as LiveGjcCommand);
        }}
        onClose={menus.commandMenu.close}
        position={menuPosition}
      />
      <CommandMenu
        isOpen={menus.fileMenu.isOpen}
        commands={menus.fileMenu.items.map((file) => ({ name: file.path, path: file.path, namespace: 'project' }))}
        selectedIndex={menus.fileMenu.selectedIndex}
        onSelect={(file, index, isHover) => {
          if (isHover) {
            menus.fileMenu.select(index);
            return;
          }
          menus.fileMenu.insert({ name: file.name, path: file.path ?? file.name });
        }}
        onClose={menus.fileMenu.close}
        position={menuPosition}
      />
    </div>
  );
}
