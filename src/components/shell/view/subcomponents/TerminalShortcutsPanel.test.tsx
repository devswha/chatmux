import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import TerminalShortcutsPanel from './TerminalShortcutsPanel';

test('mobile terminal shortcuts reserve layout space instead of covering CLI output', () => {
  const markup = renderToStaticMarkup(
    <TerminalShortcutsPanel
      wsRef={{ current: null }}
      terminalRef={{ current: null }}
      isConnected
    />,
  );

  assert.match(markup, /pointer-events-none z-20 shrink-0/);
  assert.match(markup, /pb-safe-area-inset-bottom/);
  assert.doesNotMatch(markup, /\bfixed\b/);
  assert.doesNotMatch(markup, /\binset-x-0\b/);
  assert.match(markup, />Esc</);
  assert.match(markup, />Tab</);
});
