import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

import {
  PROMPT_BUFFER_SCAN_LINES,
  PROMPT_DEBOUNCE_MS,
  PROMPT_MAX_OPTIONS,
  PROMPT_MIN_OPTIONS,
  PROMPT_OPTION_SCAN_LINES,
} from '../constants/constants';

export type CliPromptOption = Readonly<{
  readonly number: string;
  readonly label: string;
}>;

type UseCliPromptOptionsOptions = Readonly<{
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly isConnected: boolean;
  readonly onOutputRef: MutableRefObject<(() => void) | null>;
}>;

type UseCliPromptOptionsResult = Readonly<{
  readonly options: readonly CliPromptOption[] | null;
  readonly dismiss: () => void;
}>;

export function parseCliPromptOptions(lines: readonly string[]): readonly CliPromptOption[] | null {
  let footerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && (/esc to cancel/i.test(line) || /enter to select/i.test(line))) {
      footerIndex = index;
      break;
    }
  }

  if (footerIndex === -1) {
    return null;
  }

  const optionLabels = new Map<string, string>();
  const scanStart = Math.max(0, footerIndex - PROMPT_OPTION_SCAN_LINES);
  for (let index = footerIndex - 1; index >= scanStart; index -= 1) {
    const match = lines[index]?.match(/^\s*[❯›>]?\s*(\d+)\.\s+(.+)/);
    const number = match?.[1];
    const label = match?.[2]?.trim();
    if (
      number &&
      label &&
      Number.parseInt(number, 10) <= PROMPT_MAX_OPTIONS &&
      !optionLabels.has(number)
    ) {
      optionLabels.set(number, label);
    }
  }

  const options: CliPromptOption[] = [];
  for (let index = 1; index <= optionLabels.size; index += 1) {
    const number = String(index);
    const label = optionLabels.get(number);
    if (!label) {
      break;
    }
    options.push({ number, label });
  }

  return options.length >= PROMPT_MIN_OPTIONS ? options : null;
}

export function useCliPromptOptions({
  terminalRef,
  isConnected,
  onOutputRef,
}: UseCliPromptOptionsOptions): UseCliPromptOptionsResult {
  const [options, setOptions] = useState<readonly CliPromptOption[] | null>(null);
  const promptCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPrompt = useCallback(() => {
    if (promptCheckTimerRef.current) {
      clearTimeout(promptCheckTimerRef.current);
      promptCheckTimerRef.current = null;
    }
    setOptions(null);
  }, []);

  const checkBuffer = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const buffer = terminal.buffer.active;
    const lastContentRow = buffer.baseY + buffer.cursorY;
    const scanStart = Math.max(0, lastContentRow - PROMPT_BUFFER_SCAN_LINES);
    const scanEnd = Math.min(buffer.baseY + buffer.length - 1, lastContentRow + 10);
    const lines: string[] = [];
    for (let index = scanStart; index <= scanEnd; index += 1) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(line.translateToString().trimEnd());
      }
    }
    setOptions(parseCliPromptOptions(lines));
  }, [terminalRef]);

  const scheduleCheck = useCallback(() => {
    if (promptCheckTimerRef.current) {
      clearTimeout(promptCheckTimerRef.current);
    }
    promptCheckTimerRef.current = setTimeout(checkBuffer, PROMPT_DEBOUNCE_MS);
  }, [checkBuffer]);

  useEffect(() => {
    onOutputRef.current = scheduleCheck;
    return () => {
      if (onOutputRef.current === scheduleCheck) {
        onOutputRef.current = null;
      }
    };
  }, [onOutputRef, scheduleCheck]);

  useEffect(() => clearPrompt, [clearPrompt]);

  useEffect(() => {
    if (!isConnected) {
      clearPrompt();
    }
  }, [clearPrompt, isConnected]);

  return { options, dismiss: clearPrompt };
}
