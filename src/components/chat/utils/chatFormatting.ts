export function decodeHtmlEntities(text: string) {
  if (!text) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```[ \t]*([^\n\r]+?)[ \t]*```/g, '`$1`');
  } catch {
    return text;
  }
}

type MarkdownFence = {
  marker: '`' | '~';
  length: number;
};

function backtickRunLength(text: string, index: number): number {
  let cursor = index;
  while (text[cursor] === '`') cursor += 1;
  return cursor - index;
}

function isMathBoundaryLine(line: string): boolean {
  return /^[ \t]*$/.test(line)
    || /^ {0,3}(?:`{3,}|~{3,})/.test(line);
}

function displayMathShouldNormalize(args: {
  text: string;
  closeIndex: number;
  prefixOnlyWhitespace: boolean;
  strongMathSyntax: boolean;
}): boolean {
  if (args.strongMathSyntax) return true;
  if (!args.prefixOnlyWhitespace) return false;
  const lineEnd = args.text.indexOf('\n', args.closeIndex + 2);
  const suffix = args.text.slice(args.closeIndex + 2, lineEnd < 0 ? args.text.length : lineEnd);
  return /^[ \t\r]*$/.test(suffix);
}

function inlineMathShouldNormalize(text: string, openIndex: number, closeIndex: number): boolean {
  const before = text[openIndex - 1] ?? '';
  if (before === "'" || before === '"') return false;

  // BRE postfix operators follow the closing group. Read them in place so a
  // long interval cannot be truncated and repeated math does not copy the
  // remainder of the message on every match.
  let cursor = closeIndex + 2;
  if (text[cursor] !== '\\') return true;
  cursor += 1;

  const operator = text[cursor];
  if (operator === '+' || operator === '?' || /^[1-9]$/.test(operator ?? '')) return false;
  if (operator !== '{') return true;

  cursor += 1;
  const minimumStart = cursor;
  while (/^[0-9]$/.test(text[cursor] ?? '')) cursor += 1;
  if (cursor === minimumStart) return true;
  if (text[cursor] === ',') {
    cursor += 1;
    while (/^[0-9]$/.test(text[cursor] ?? '')) cursor += 1;
  }
  return !(text[cursor] === '\\' && text[cursor + 1] === '}');
}

function findClosingBacktickRun(text: string, start: number, length: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const next = text.indexOf('`', cursor);
    if (next < 0) return -1;
    const runLength = backtickRunLength(text, next);
    if (runLength === length) return next;
    cursor = next + runLength;
  }
  return -1;
}

/**
 * remark-math recognizes dollar delimiters, while Codex and Claude commonly
 * emit LaTeX's `\\(...\\)` and `\\[...\\]` forms. Normalize only paired
 * delimiters outside Markdown code so the Markdown parser cannot consume the
 * backslashes before remark-math sees them.
 */
export function normalizeLatexMathDelimiters(text: string) {
  if (!text || typeof text !== 'string') return text;

  const output: string[] = [];
  let cursor = 0;
  let atLineStart = true;
  let lineHasContent = false;
  let precedingBackslashes = 0;
  let fence: MarkdownFence | null = null;
  let math: {
    close: '\\)' | '\\]';
    replacement: '$' | '$$';
    outputIndex: number;
    openIndex: number;
    prefixOnlyWhitespace: boolean;
    strongMathSyntax: boolean;
  } | null = null;

  while (cursor < text.length) {
    if (math) {
      if (atLineStart) {
        const lineEnd = text.indexOf('\n', cursor);
        const end = lineEnd < 0 ? text.length : lineEnd;
        if (isMathBoundaryLine(text.slice(cursor, end))) {
          math = null;
          continue;
        }
      }

      if (text[cursor] === '`') {
        math = null;
        continue;
      }

      const backslashEscaped = precedingBackslashes % 2 === 1;
      if (text[cursor] === '\\' && !backslashEscaped && text.startsWith(math.close, cursor)) {
        const shouldNormalize = math.replacement === '$'
          ? inlineMathShouldNormalize(text, math.openIndex, cursor)
          : displayMathShouldNormalize({
            text,
            closeIndex: cursor,
            prefixOnlyWhitespace: math.prefixOnlyWhitespace,
            strongMathSyntax: math.strongMathSyntax,
          });
        if (shouldNormalize) {
          output[math.outputIndex] = math.replacement;
          output.push(math.replacement);
        } else {
          output.push(math.close);
        }
        cursor += math.close.length;
        math = null;
        atLineStart = false;
        lineHasContent = true;
        precedingBackslashes = 0;
        continue;
      }
      const char = text[cursor];
      if ((char === '\\' && /[A-Za-z]/.test(text[cursor + 1] ?? '')) || char === '^' || char === '_') {
        math.strongMathSyntax = true;
      }
      output.push(char);
      cursor += 1;
      atLineStart = char === '\n';
      if (atLineStart) {
        lineHasContent = false;
        precedingBackslashes = 0;
      } else {
        if (!/[ \t\r]/.test(char)) lineHasContent = true;
        precedingBackslashes = char === '\\' ? precedingBackslashes + 1 : 0;
      }
      continue;
    }

    if (atLineStart) {
      const lineEnd = text.indexOf('\n', cursor);
      const end = lineEnd < 0 ? text.length : lineEnd;
      const line = text.slice(cursor, end);
      if (fence) {
        const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
        if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
          fence = null;
        }
        output.push(text.slice(cursor, lineEnd < 0 ? end : end + 1));
        cursor = lineEnd < 0 ? end : end + 1;
        atLineStart = lineEnd >= 0;
        lineHasContent = !atLineStart;
        precedingBackslashes = 0;
        continue;
      }

      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) {
        fence = { marker: open[1][0] as '`' | '~', length: open[1].length };
        output.push(text.slice(cursor, lineEnd < 0 ? end : end + 1));
        cursor = lineEnd < 0 ? end : end + 1;
        atLineStart = lineEnd >= 0;
        lineHasContent = !atLineStart;
        precedingBackslashes = 0;
        continue;
      }

      // Four-space and tab-indented code lines are code even without fences.
      if (line.startsWith('    ') || line.startsWith('\t')) {
        output.push(text.slice(cursor, lineEnd < 0 ? end : end + 1));
        cursor = lineEnd < 0 ? end : end + 1;
        atLineStart = lineEnd >= 0;
        lineHasContent = !atLineStart;
        precedingBackslashes = 0;
        continue;
      }
    }

    if (text[cursor] === '`') {
      const runLength = backtickRunLength(text, cursor);
      const close = findClosingBacktickRun(text, cursor + runLength, runLength);
      if (close >= 0) {
        const end = close + runLength;
        const code = text.slice(cursor, end);
        output.push(code);
        atLineStart = code.endsWith('\n');
        lineHasContent = !atLineStart;
        precedingBackslashes = 0;
        cursor = end;
        continue;
      }
    }

    if (text[cursor] === '\\' && precedingBackslashes % 2 === 0) {
      const opening = text.startsWith('\\[', cursor)
        ? { token: '\\[', close: '\\]' as const, replacement: '$$' as const }
        : text.startsWith('\\(', cursor)
          ? { token: '\\(', close: '\\)' as const, replacement: '$' as const }
          : null;
      // BRE groups commonly appear as /\(...\)/. Preserve that syntax while
      // accepting ordinary inline math without requiring a LaTeX command.
      if (opening && (opening.replacement !== '$' || text[cursor - 1] !== '/')) {
        const outputIndex = output.length;
        output.push(opening.token);
        cursor += opening.token.length;
        math = {
          close: opening.close,
          replacement: opening.replacement,
          outputIndex,
          openIndex: cursor - opening.token.length,
          prefixOnlyWhitespace: !lineHasContent,
          strongMathSyntax: false,
        };
        atLineStart = false;
        lineHasContent = true;
        precedingBackslashes = 0;
        continue;
      }
    }

    const char = text[cursor];
    output.push(char);
    cursor += 1;
    atLineStart = char === '\n';
    if (atLineStart) {
      lineHasContent = false;
      precedingBackslashes = 0;
    } else {
      if (!/[ \t\r]/.test(char)) lineHasContent = true;
      precedingBackslashes = char === '\\' ? precedingBackslashes + 1 : 0;
    }
  }

  return output.join('');
}

export function unescapeWithMathProtection(text: string) {
  if (!text || typeof text !== 'string') return text;

  const mathBlocks: string[] = [];
  const placeholderPrefix = '__MATH_BLOCK_';
  const placeholderSuffix = '__';

  let processedText = text.replace(/\$\$([\s\S]*?)\$\$|\$([^\$\n]+?)\$/g, (match) => {
    const index = mathBlocks.length;
    mathBlocks.push(match);
    return `${placeholderPrefix}${index}${placeholderSuffix}`;
  });

  processedText = processedText.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');

  processedText = processedText.replace(
    new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'g'),
    (match, index) => {
      return mathBlocks[parseInt(index, 10)];
    },
  );

  return processedText;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Claude usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}
