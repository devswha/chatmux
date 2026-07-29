import { TERMINAL_FONT_FAMILY } from '../constants/constants';

const XTERM_STYLE_ELEMENT_ID = 'shell-xterm-style';

const XTERM_STYLES = `
  .xterm {
    font-family: ${TERMINAL_FONT_FAMILY};
  }
  .xterm .xterm-helper-textarea,
  .xterm .composition-view {
    font-family: ${TERMINAL_FONT_FAMILY} !important;
    font-size: var(--shell-terminal-font-size, 14px) !important;
    font-variant-ligatures: none;
  }
  .xterm .xterm-screen {
    outline: none !important;
  }
  .xterm:focus .xterm-screen {
    outline: none !important;
  }
  .xterm-screen:focus {
    outline: none !important;
  }
`;

export function ensureXtermFocusStyles(): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.getElementById(XTERM_STYLE_ELEMENT_ID)) {
    return;
  }

  const styleSheet = document.createElement('style');
  styleSheet.id = XTERM_STYLE_ELEMENT_ID;
  styleSheet.type = 'text/css';
  styleSheet.innerText = XTERM_STYLES;
  document.head.appendChild(styleSheet);
}