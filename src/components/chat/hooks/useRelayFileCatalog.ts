/**
 * Mentionable files for the relay composer's `@` menu.
 *
 * The tree is fetched lazily — only once an `@` mention is actually active — and
 * only for the workspace on screen. Every response is discarded if the workspace
 * changed while it was in flight, so a menu never offers another project's files.
 * Failure is non-fatal: the relay stays usable without file mentions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import {
  flattenProjectFileTree,
  normalizeWorkspacePath,
  type MentionableFile,
  type ProjectFileNode,
} from '../utils/liveRelayComposer';

type WorkspaceProject = {
  projectId?: string;
  fullPath?: string;
  path?: string;
};

const LOAD_DEBOUNCE_MS = 200;

async function loadFiles(workspacePath: string): Promise<readonly MentionableFile[] | null> {
  const projectsResponse = await api.projects();
  if (!projectsResponse.ok) {
    return null;
  }
  const projects = (await projectsResponse.json()) as WorkspaceProject[];
  if (!Array.isArray(projects)) {
    return null;
  }
  const normalized = normalizeWorkspacePath(workspacePath);
  const project = projects.find((candidate) =>
    [candidate.fullPath, candidate.path]
      .filter((path): path is string => typeof path === 'string')
      .some((path) => normalizeWorkspacePath(path) === normalized),
  );
  if (!project?.projectId) {
    return null;
  }
  const filesResponse = await api.getFiles(project.projectId);
  if (!filesResponse.ok) {
    return null;
  }
  const tree = (await filesResponse.json()) as ProjectFileNode[];
  return Array.isArray(tree) ? flattenProjectFileTree(tree) : null;
}

export type RelayFileCatalog = {
  readonly files: readonly MentionableFile[];
  /**
   * Asks for the workspace tree. Called when an `@` mention starts, so an
   * ordinary message costs no requests. Idempotent per workspace.
   */
  readonly request: () => void;
};

export function useRelayFileCatalog(workspacePath: string | null): RelayFileCatalog {
  const [files, setFiles] = useState<readonly MentionableFile[]>([]);
  const [wanted, setWanted] = useState(false);
  const loadedRef = useRef<string | null>(null);
  const requestedRef = useRef<string | null>(null);
  const workspaceRef = useRef(workspacePath);
  workspaceRef.current = workspacePath;

  useEffect(() => {
    setFiles([]);
    setWanted(false);
    loadedRef.current = null;
    requestedRef.current = null;
  }, [workspacePath]);

  useEffect(() => {
    if (
      workspacePath === null
      || !wanted
      || loadedRef.current === workspacePath
      || requestedRef.current === workspacePath
    ) {
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (loadedRef.current === workspacePath || requestedRef.current === workspacePath) {
        return;
      }
      requestedRef.current = workspacePath;
      void (async () => {
        try {
          const loaded = await loadFiles(workspacePath);
          if (loaded === null || cancelled || workspaceRef.current !== workspacePath) {
            return;
          }
          loadedRef.current = workspacePath;
          setFiles(loaded);
        } catch {
          // File mentions are optional; the relay remains usable without them.
        } finally {
          if (requestedRef.current === workspacePath) {
            requestedRef.current = null;
          }
        }
      })();
    }, LOAD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wanted, workspacePath]);

  const request = useCallback(() => setWanted(true), []);
  return { files, request };
}
