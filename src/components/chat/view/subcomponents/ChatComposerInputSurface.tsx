import { useMemo } from 'react';

import {
  PromptInput,
  PromptInputBody,
  PromptInputHeader,
  PromptInputTextarea,
} from '../../../../shared/view/ui';

import type { ChatComposerProps } from './chatComposerTypes';
import ChatComposerControls from './ChatComposerControls';
import CommandMenu from './CommandMenu';
import ImageAttachment from './ImageAttachment';

type ChatComposerInputSurfaceProps = ChatComposerProps & {
  readonly hasActivityIndicator: boolean;
};

export default function ChatComposerInputSurface(props: ChatComposerInputSurfaceProps) {
  const commandMenuPosition = useMemo(() => {
    if (!props.isCommandMenuOpen) return { top: 0, left: 16, bottom: 90 };
    const textareaRect = props.textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [props.isCommandMenuOpen, props.textareaRef]);

  return (
    <div className="relative mx-auto max-w-[54.25rem]">
      {props.showFileDropdown && props.filteredFiles.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
          {props.filteredFiles.map((file, index) => (
            <div
              key={file.path}
              className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${index === props.selectedFileIndex ? 'bg-primary/8 text-primary' : 'text-foreground hover:bg-accent/50'}`}
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); props.onSelectFile(file); }}
            >
              <div className="text-sm font-medium">{file.name}</div>
              <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
            </div>
          ))}
        </div>
      )}

      <CommandMenu
        commands={props.filteredCommands}
        selectedIndex={props.selectedCommandIndex}
        onSelect={props.onCommandSelect}
        onClose={props.onCloseCommandMenu}
        position={commandMenuPosition}
        isOpen={props.isCommandMenuOpen}
        frequentCommands={props.frequentCommands}
      />

      <PromptInput
        onSubmit={(event) => props.onSubmit(event)}
        status={props.isLoading ? 'streaming' : 'ready'}
        className={[
          props.isTextareaExpanded ? 'chat-input-expanded' : '',
          props.hasActivityIndicator ? 'rounded-t-none' : '',
        ].filter(Boolean).join(' ')}
        {...props.getRootProps()}
      >
        {props.isDragActive && (
          <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
            <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
              <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm font-medium">Drop images here</p>
            </div>
          </div>
        )}

        {props.attachedImages.length > 0 && (
          <PromptInputHeader>
            <div className="rounded-xl bg-muted/40 p-2">
              <div className="flex flex-wrap gap-2">
                {props.attachedImages.map((file, index) => (
                  <ImageAttachment
                    key={index}
                    file={file}
                    onRemove={() => props.onRemoveImage(index)}
                    uploadProgress={props.uploadingImages.get(file.name)}
                    error={props.imageErrors.get(file.name)}
                  />
                ))}
              </div>
            </div>
          </PromptInputHeader>
        )}

        <input {...props.getInputProps()} />
        <PromptInputBody>
          <div ref={props.inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
            <div className="chat-input-placeholder block min-h-14 w-full whitespace-pre-wrap break-words px-4 py-2.5 text-sm leading-6 text-transparent">
              {props.renderInputWithMentions(props.input)}
            </div>
          </div>
          <PromptInputTextarea
            ref={props.textareaRef}
            dir="auto"
            value={props.input}
            onChange={props.onInputChange}
            onClick={props.onTextareaClick}
            onKeyDown={props.onTextareaKeyDown}
            onPaste={props.onTextareaPaste}
            onScroll={(event) => props.onTextareaScrollSync(event.currentTarget)}
            onFocus={() => props.onInputFocusChange?.(true)}
            onBlur={() => props.onInputFocusChange?.(false)}
            onInput={props.onTextareaInput}
            placeholder={props.placeholder}
          />
        </PromptInputBody>
        <ChatComposerControls {...props} />
      </PromptInput>
    </div>
  );
}
