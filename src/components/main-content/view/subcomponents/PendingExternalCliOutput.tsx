import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

export type AnsiTerminalToken = {
  text: string;
  style: CSSProperties;
};

type AnsiTerminalState = {
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  hidden?: boolean;
  strike?: boolean;
};

const TERMINAL_FOREGROUND = '#d4d4d4';
const TERMINAL_BACKGROUND = '#1e1e1e';
const ANSI_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
] as const;
const ANSI_SGR_RE = /\u001B\[([0-9;]*)m/g;
const ANSI_UNSUPPORTED_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|.)/g;
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function byteToHex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

function rgbColor(red: number, green: number, blue: number): string {
  return `#${byteToHex(red)}${byteToHex(green)}${byteToHex(blue)}`;
}

function ansi256Color(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < ANSI_COLORS.length) return ANSI_COLORS[index];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgbColor(level, level, level);
  }
  const offset = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return rgbColor(
    levels[Math.floor(offset / 36)]!,
    levels[Math.floor((offset % 36) / 6)]!,
    levels[offset % 6]!,
  );
}

function applyExtendedColor(
  state: AnsiTerminalState,
  codes: number[],
  index: number,
  target: 'foreground' | 'background',
): number {
  const mode = codes[index + 1];
  if (mode === 5) {
    const color = ansi256Color(codes[index + 2]!);
    if (color) state[target] = color;
    return index + 2;
  }
  if (mode === 2) {
    const colorValues = codes.slice(index + 2, index + 5);
    if (colorValues.length === 3 && colorValues.every(Number.isFinite)) {
      state[target] = rgbColor(colorValues[0]!, colorValues[1]!, colorValues[2]!);
    }
    return index + 4;
  }
  return index;
}

function applySgr(previous: AnsiTerminalState, parameters: string): AnsiTerminalState {
  const codes = parameters === ''
    ? [0]
    : parameters.split(';').map((value) => Number.parseInt(value, 10));
  let state = { ...previous };

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      state = {};
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 7) {
      state.inverse = true;
    } else if (code === 8) {
      state.hidden = true;
    } else if (code === 9) {
      state.strike = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 27) {
      state.inverse = false;
    } else if (code === 28) {
      state.hidden = false;
    } else if (code === 29) {
      state.strike = false;
    } else if (code >= 30 && code <= 37) {
      state.foreground = ANSI_COLORS[code - 30];
    } else if (code === 38) {
      index = applyExtendedColor(state, codes, index, 'foreground');
    } else if (code === 39) {
      delete state.foreground;
    } else if (code >= 40 && code <= 47) {
      state.background = ANSI_COLORS[code - 40];
    } else if (code === 48) {
      index = applyExtendedColor(state, codes, index, 'background');
    } else if (code === 49) {
      delete state.background;
    } else if (code >= 90 && code <= 97) {
      state.foreground = ANSI_COLORS[code - 90 + 8];
    } else if (code >= 100 && code <= 107) {
      state.background = ANSI_COLORS[code - 100 + 8];
    }
  }

  return state;
}

function terminalStyle(state: AnsiTerminalState): CSSProperties {
  const foreground = state.inverse
    ? state.background ?? TERMINAL_BACKGROUND
    : state.foreground;
  const background = state.inverse
    ? state.foreground ?? TERMINAL_FOREGROUND
    : state.background;
  const decorations = [
    state.underline ? 'underline' : '',
    state.strike ? 'line-through' : '',
  ].filter(Boolean).join(' ');

  return {
    ...(foreground ? { color: foreground } : {}),
    ...(background ? { backgroundColor: background } : {}),
    ...(state.bold ? { fontWeight: 700 } : {}),
    ...(state.dim ? { opacity: 0.65 } : {}),
    ...(state.italic ? { fontStyle: 'italic' } : {}),
    ...(decorations ? { textDecorationLine: decorations } : {}),
    ...(state.hidden ? { visibility: 'hidden' } : {}),
  };
}

function cleanTerminalText(text: string): string {
  return text
    .replace(ANSI_UNSUPPORTED_RE, '')
    .replace(TERMINAL_CONTROL_RE, '');
}

export function parseAnsiTerminalOutput(output: string): AnsiTerminalToken[] {
  const tokens: AnsiTerminalToken[] = [];
  let state: AnsiTerminalState = {};
  let cursor = 0;

  for (const match of output.matchAll(ANSI_SGR_RE)) {
    const index = match.index;
    const text = cleanTerminalText(output.slice(cursor, index));
    if (text) tokens.push({ text, style: terminalStyle(state) });
    state = applySgr(state, match[1] ?? '');
    cursor = index + match[0].length;
  }

  const tail = cleanTerminalText(output.slice(cursor));
  if (tail) tokens.push({ text: tail, style: terminalStyle(state) });
  return tokens;
}

type PendingExternalCliOutputProps = {
  providerLabel: string;
  output: string;
  emptyMessage?: string;
};

export default function PendingExternalCliOutput({
  providerLabel,
  output,
  emptyMessage,
}: PendingExternalCliOutputProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);

  useEffect(() => {
    if (!output) {
      followTailRef.current = true;
      return;
    }
    const viewport = viewportRef.current;
    if (viewport && followTailRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (!output) return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const keepTailVisible = () => {
      if (followTailRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    };
    const observer = new ResizeObserver(keepTailVisible);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [output]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followTailRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
  };

  if (!output) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto flex h-full max-w-[54.25rem] items-center justify-center text-center text-sm text-muted-foreground">
          {emptyMessage ?? `첫 지시를 보내면 ${providerLabel} transcript가 생성되어 이 화면에 자동으로 연결됩니다.`}
        </div>
      </div>
    );
  }

  const tokens = parseAnsiTerminalOutput(output);

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-auto bg-[#1e1e1e] px-4 py-3 text-left"
    >
      <pre
        aria-label={`${providerLabel} live terminal output`}
        className="mx-auto w-max min-w-full whitespace-pre font-mono text-xs leading-relaxed text-zinc-100"
      >
        {tokens.map((token, index) => (
          <span key={`${index}-${token.text.length}`} style={token.style}>{token.text}</span>
        ))}
      </pre>
    </div>
  );
}
