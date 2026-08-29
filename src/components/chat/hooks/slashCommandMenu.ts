export type SlashCommandQuery = {
  readonly slashPosition: number;
  readonly query: string;
};

export type SlashCommandInputSelection = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly slashPosition: number;
};

export type SlashCommandInsertion = {
  readonly value: string;
  readonly cursorPosition: number;
};

export function findSlashCommandQuery(value: string, cursorPosition: number): SlashCommandQuery | null {
  if (!value.trim()) {
    return null;
  }

  const textBeforeCursor = value.slice(0, cursorPosition);
  const fencedCodeMarkers = textBeforeCursor.match(/```/g) ?? [];
  if (fencedCodeMarkers.length % 2 === 1) {
    return null;
  }

  const match = textBeforeCursor.match(/(?:^|\s)(\/\S*)$/);
  const matchedToken = match?.[1];
  if (match?.index === undefined || matchedToken === undefined) {
    return null;
  }

  return {
    slashPosition: match.index + match[0].length - matchedToken.length,
    query: matchedToken.slice(1),
  };
}

export function buildSlashCommandInsertion(
  selection: SlashCommandInputSelection,
  commandName: string,
): SlashCommandInsertion {
  const insertionStart = selection.slashPosition >= 0
    ? selection.slashPosition
    : selection.selectionStart;
  const textBeforeCommand = selection.value.slice(0, insertionStart);
  const textAfterCommandStart = selection.value.slice(insertionStart);
  const spaceIndex = textAfterCommandStart.indexOf(' ');
  const textAfterCommand = selection.slashPosition >= 0 && spaceIndex !== -1
    ? textAfterCommandStart.slice(spaceIndex).trimStart()
    : selection.value.slice(selection.selectionEnd);
  const separator = textBeforeCommand && !/\s$/.test(textBeforeCommand) ? ' ' : '';

  return {
    value: `${textBeforeCommand}${separator}${commandName}${textAfterCommand ? ` ${textAfterCommand}` : ' '}`,
    cursorPosition: `${textBeforeCommand}${separator}${commandName} `.length,
  };
}
