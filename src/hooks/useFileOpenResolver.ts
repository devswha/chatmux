import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { api } from '../utils/api';
import { useFleetHost } from '../fleet/FleetSessionRoute';
import { localProjectIdForScope } from '../fleet/hostApi/urls';
import type { Project } from '../types/app';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

type FlatFile = {
  name: string;
  path: string;
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

const flatten = (nodes: FileNode[], out: FlatFile[]): void => {
  for (const node of nodes) {
    if (node.type === 'file') {
      out.push({ name: node.name, path: node.path });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
};

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality.
const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalize(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const { storeScope } = useFleetHost();
  const projectId = localProjectIdForScope(storeScope, selectedProject);
  const selection = useMemo(() => ({ projectId }), [projectId]);
  const currentSelection = useRef<typeof selection | null>(selection);
  currentSelection.current = selection;
  useLayoutEffect(() => {
    currentSelection.current = selection;
    return () => { currentSelection.current = null; };
  }, [selection]);
  const cacheRef = useRef<{ selection?: typeof selection; files: Promise<FlatFile[]> | null }>({
    selection: undefined,
    files: null,
  });

  const loadFiles = useCallback((): Promise<FlatFile[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    if (cacheRef.current.selection === selection && cacheRef.current.files) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        const tree: FileNode[] = Array.isArray(data) ? data : [];
        const flat: FlatFile[] = [];
        flatten(tree, flat);
        return flat;
      } catch {
        return [];
      }
    })();

    cacheRef.current = { selection, files: filesPromise };
    return filesPromise;
  }, [projectId, selection]);

  return useCallback(
    (filePath: string, diffInfo?: any) => {
      if (!projectId || currentSelection.current !== selection) return;
      const ref = normalize(filePath).trim();
      void loadFiles().then((files) => {
        if (currentSelection.current !== selection) return;
        const match = findBestMatch(files, ref);
        onFileOpen(match ?? filePath, diffInfo);
      });
    },
    [loadFiles, onFileOpen, projectId, selection],
  );
}
