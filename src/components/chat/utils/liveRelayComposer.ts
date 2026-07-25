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
