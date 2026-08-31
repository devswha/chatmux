import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../shared/view/ui';
import { useTheme } from '../../contexts/ThemeContext';
import { usePaletteOps } from '../../contexts/PaletteOpsContext';
import { useFleetHostCatalog } from '../../fleet/discovery/FleetHostCatalogContext';
import { EMPTY_HOST_ROW_SET } from '../../fleet/discovery/hostRows';
import type { AppTab, Project } from '../../types/app';

import { buildPaletteSessionRows } from './sources/paletteSessionRows';
import { useSessionsSource } from './sources/useSessionsSource';
import { useFilesSource } from './sources/useFilesSource';
import { useCommitsSource } from './sources/useCommitsSource';
import { useSessionMessageSearch } from './sources/useSessionMessageSearch';
import { useBranchesSource } from './sources/useBranchesSource';
import { useGitActions } from './sources/useGitActions';
import PaletteActionGroups from './view/PaletteActionGroups';
import PaletteBrowseGroups, { type PaletteBrowsePage } from './view/PaletteBrowseGroups';

type Page = 'actions' | PaletteBrowsePage;

const PAGE_LABELS: Record<Page, string> = {
  actions: 'Actions',
  files: 'Files',
  sessions: 'Sessions',
  commits: 'Commits',
  branches: 'Branches',
};

const BROWSE_LIMIT = 5;

type CommandPaletteProps = {
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
};

export default function CommandPalette({
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
}: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [pages, setPages] = React.useState<Page[]>([]);
  const { toggleDarkMode } = useTheme();
  const navigate = useNavigate();
  const ops = usePaletteOps();
  const { catalog } = useFleetHostCatalog();

  const page = pages.at(-1);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
    }
  }, [open]);

  const projectId = selectedProject?.projectId;
  const hostId = selectedProject?.hostId ?? null;
  const isRemoteProject = hostId !== null && hostId !== catalog.localHostId;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';
  const showFiles = !page || page === 'files';
  const showCommits = !page || page === 'commits';
  const showBranches = !page || page === 'branches' || page === 'actions';

  // A peer's roster arrives on the discovery stream; the hub's project route
  // would answer with its own sessions under the same project id.
  const localSessions = useSessionsSource(projectId, open && showSessions && !isRemoteProject);
  const messageMatches = useSessionMessageSearch({ project: selectedProject ?? undefined, query: search, enabled: open && showSessions });
  const localProjectId = isRemoteProject ? undefined : projectId;
  const files = useFilesSource(localProjectId, open && showFiles);
  const commits = useCommitsSource(localProjectId, open && showCommits);
  const branches = useBranchesSource(localProjectId, open && showBranches);
  const git = useGitActions(localProjectId);

  const peerRows = (hostId === null ? undefined : catalog.hosts.get(hostId))?.rows ?? EMPTY_HOST_ROW_SET;
  const sessionRows = React.useMemo(() => (
    showSessions && projectId !== undefined
      ? buildPaletteSessionRows({
        hostId,
        localHostId: catalog.localHostId,
        localSessions,
        peerSessions: peerRows.sessions.filter((row) => row.projectLocalId === projectId),
        matches: messageMatches,
      })
      : []
  ), [catalog.localHostId, hostId, localSessions, messageMatches, peerRows, projectId, showSessions]);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>Command palette</DialogTitle>
        <Command label="Command palette" onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {PAGE_LABELS[page]}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label="Back to all"
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-xs text-muted-foreground">Backspace to go back</span>
            </div>
          )}
          <CommandInput
            placeholder={page ? `Search ${PAGE_LABELS[page].toLowerCase()}…` : 'Type to search anything…'}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>

            {showActions && (
              <PaletteActionGroups
                selectedProject={selectedProject}
          projectId={localProjectId}
                git={git}
                run={run}
                onStartNewChat={onStartNewChat}
                onOpenSettings={onOpenSettings}
                onShowTab={onShowTab}
                onToggleDarkMode={toggleDarkMode}
              />
            )}

            {projectId && (
              <PaletteBrowseGroups
                page={page === 'actions' || page === undefined ? null : page}
                browseLimit={BROWSE_LIMIT}
                sessions={sessionRows}
                files={showFiles ? files : []}
                commits={showCommits ? commits : []}
                branches={showBranches ? branches : []}
                onOpenSession={(route) => run(() => navigate(route))}
                onOpenFile={(path) => run(() => ops.openFile(path))}
                onCheckoutBranch={(name) => run(() => { void git.checkout(name); })}
                onBrowseAll={pushPage}
              />
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
