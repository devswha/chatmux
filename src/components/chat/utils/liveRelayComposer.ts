export type LiveGjcCommand = {
  name: string;
  description?: string;
  namespace?: string;
  scope?: string;
  sourcePath?: string;
};

export type MentionableFile = {
  name: string;
  path: string;
};

export type ProjectFileNode = {
  name: string;
  type: 'file' | 'directory';
  children?: ProjectFileNode[];
};

export const getActiveMentionToken = (text: string, caret: number): { start: number; query: string } | null => {
  return getActiveSlashToken(text, caret, '@');
};

export const filterMentionableFiles = (files: MentionableFile[], query: string): MentionableFile[] => {
  const normalized = query.toLowerCase();
  return files
    .filter((file) => file.name.toLowerCase().includes(normalized) || file.path.toLowerCase().includes(normalized))
    .slice(0, 10);
};

export const flattenProjectFileTree = (files: ProjectFileNode[], basePath = ''): MentionableFile[] => {
  return files.flatMap((file) => {
    const path = basePath ? `${basePath}/${file.name}` : file.name;
    if (file.type === 'directory') {
      return file.children ? flattenProjectFileTree(file.children, path) : [];
    }
    return [{ name: file.name, path }];
  });
};

export const normalizeWorkspacePath = (path: string): string => path.replace(/\/+$/, '');

/**
 * B10: relay image paths must come from the shared asset store
 * (`~/.chatmux/assets`, marked by this fixed path segment since the browser
 * has no direct HOME value) or from inside the active project workspace.
 * Anything else is refused rather than inserted as plain text.
 */
const ASSET_STORE_PATH_MARKER = '/.chatmux/assets/';

export const isRelayImagePathAllowed = (
  assetPath: string,
  workspacePath: string | null | undefined,
): boolean => {
  const normalized = assetPath.replace(/\\/g, '/');
  if (!normalized.startsWith('/') || normalized.includes('..')) {
    return false;
  }
  if (normalized.includes(ASSET_STORE_PATH_MARKER)) {
    return true;
  }
  if (!workspacePath) {
    return false;
  }
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath.replace(/\\/g, '/'));
  return normalized === normalizedWorkspace || normalized.startsWith(`${normalizedWorkspace}/`);
};

/**
 * Splices a plain-text token (a relay image path) at the caret, adding
 * surrounding spaces only where the neighboring text needs them. Shared by
 * the composer's paste/drop handler so the exact insertion text is testable
 * without simulating a DOM paste event.
 */
export const buildPlainTextInsertion = (
  before: string,
  after: string,
  token: string,
): { text: string; caretOffset: number } => {
  const needsLeadingGap = before.length > 0 && !/\s$/.test(before);
  const needsTrailingGap = after.length > 0 && !after.startsWith(' ');
  const inserted = `${needsLeadingGap ? ' ' : ''}${token}${needsTrailingGap ? ' ' : ''}`;
  return { text: `${before}${inserted}${after}`, caretOffset: before.length + inserted.length };
};
/** The active trigger token (`/…` for gjc, `$…` for codex) under the caret, or null. */
export const getActiveSlashToken = (text: string, caret: number, trigger: string): { start: number; query: string } | null => {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === trigger) {
      const precededByBoundary = index === 0 || /\s/.test(text[index - 1]);
      if (!precededByBoundary) {
        return null;
      }
      const query = text.slice(index, caret);
      return /\s/.test(query) ? null : { start: index, query };
    }
    if (/\s/.test(char)) {
      return null;
    }
  }
  return null;
};

export const filterCommands = (commands: LiveGjcCommand[], query: string, trigger: string): LiveGjcCommand[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized === trigger) {
    return commands;
  }
  const prefix = normalized.startsWith(trigger) ? normalized : `${trigger}${normalized}`;
  const bare = prefix.slice(1);

  const byPrefix = commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
  if (byPrefix.length > 0) {
    return byPrefix;
  }
  const bySubstring = commands.filter((command) => command.name.toLowerCase().includes(bare));
  if (bySubstring.length > 0) {
    return bySubstring;
  }
  return commands.filter((command) => command.description?.toLowerCase().includes(bare));
};
