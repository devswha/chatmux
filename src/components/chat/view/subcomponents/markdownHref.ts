/**
 * Transcript and editor markdown is untrusted model/tool text. Only these
 * schemes may become an href; `data:`, `javascript:`, and unknown schemes stay
 * inert so a chat line cannot open an attacker document.
 */
const SAFE_HREF = /^(https?:|mailto:|tel:)/i;

export function safeMarkdownHref(href: string | undefined): string | null {
  if (!href || href.includes('\0')) return null;
  if (href.startsWith('#')) return href;
  return SAFE_HREF.test(href) ? href : null;
}
