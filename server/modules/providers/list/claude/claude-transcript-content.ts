const CLAUDE_PASTED_CONTENT_BLOCK = /<pasted_content id="([A-Za-z0-9_-]{1,64})">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="\1">/g;

/**
 * Claude stores terminal paste input inside an XML-like transcript wrapper.
 * The CLI hides that envelope, so ChatMux should expose only the pasted text.
 *
 * Match the narrow native shape and require the closing id to equal the opening
 * id. Malformed, partial, or user-authored lookalikes remain untouched.
 */
export function unwrapClaudePastedContent(content: string): string {
  let unwrapped = false;
  const visible = content.replace(
    CLAUDE_PASTED_CONTENT_BLOCK,
    (_block, _id: string, body: string) => {
      unwrapped = true;
      return body;
    },
  );

  return unwrapped ? visible.trim() : content;
}
