import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';

import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { ProviderModelOption } from '../../../../types/app';
import type { QueuedDraft } from '../../hooks/useChatComposerState';
import type { PendingPermissionRequest, PermissionMode } from '../../types/types';

export interface MentionableFile {
  readonly name: string;
  readonly path: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly namespace?: string;
  readonly path?: string;
  readonly type?: string;
  readonly metadata?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface ChatComposerProps {
  readonly pendingPermissionRequests: PendingPermissionRequest[];
  readonly handlePermissionDecision: (
    requestIds: string | string[],
    decision: { readonly allow?: boolean; readonly message?: string; readonly rememberEntry?: string | null; readonly updatedInput?: unknown },
  ) => void;
  readonly handleGrantToolPermission: (suggestion: { readonly entry: string; readonly toolName: string }) => { readonly success: boolean };
  readonly activity: SessionActivity | null;
  readonly isLoading: boolean;
  readonly onAbortSession: () => void;
  readonly permissionMode: PermissionMode | string;
  readonly onModeSwitch: () => void;
  readonly effort: string;
  readonly availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  readonly onSelectEffort: (effort: string) => void;
  readonly tokenBudget: Record<string, unknown> | null;
  readonly onShowTokenUsage: () => void;
  readonly slashCommandsCount: number;
  readonly onToggleCommandMenu: () => void;
  readonly hasInput: boolean;
  readonly onClearInput: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  readonly commandError: string | null;
  readonly onClearCommandError: () => void;
  readonly isDragActive: boolean;
  readonly queuedDraft: QueuedDraft | null;
  readonly onEditQueuedDraft: () => void;
  readonly onDeleteQueuedDraft: () => void;
  readonly attachedImages: readonly File[];
  readonly onRemoveImage: (index: number) => void;
  readonly uploadingImages: ReadonlyMap<string, number>;
  readonly imageErrors: ReadonlyMap<string, string>;
  readonly showFileDropdown: boolean;
  readonly filteredFiles: readonly MentionableFile[];
  readonly selectedFileIndex: number;
  readonly onSelectFile: (file: MentionableFile) => void;
  readonly filteredCommands: SlashCommand[];
  readonly selectedCommandIndex: number;
  readonly onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  readonly onCloseCommandMenu: () => void;
  readonly isCommandMenuOpen: boolean;
  readonly frequentCommands: SlashCommand[];
  readonly getRootProps: (...args: unknown[]) => Record<string, unknown>;
  readonly getInputProps: (...args: unknown[]) => Record<string, unknown>;
  readonly openImagePicker: () => void;
  readonly inputHighlightRef: RefObject<HTMLDivElement>;
  readonly renderInputWithMentions: (text: string) => ReactNode;
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly input: string;
  readonly onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  readonly onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  readonly onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  readonly isInputFocused?: boolean;
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly placeholder: string;
  readonly isTextareaExpanded: boolean;
  readonly textareaHeight: number | null;
  readonly onTextareaHeightChange: (height: number) => void;
  readonly onTextareaHeightReset: () => void;
  readonly sendByCtrlEnter?: boolean;
}
