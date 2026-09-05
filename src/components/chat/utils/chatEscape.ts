/** Keep native picker cancellation separate from the chat abort shortcut. */
export function createChatEscapeHandler(onAbort: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
    if ((event.target as Element | null)?.closest?.('select')) return;
    event.preventDefault();
    onAbort();
  };
}
