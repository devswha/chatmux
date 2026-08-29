/**
 * The palette's browsable result groups: sessions, files, commits and branches.
 * Split from `CommandPalette.tsx`.
 *
 * A session row opens the route its own host owns — the row carries it, so a
 * peer's transcript hit can never open the hub session that shares its id.
 */

import {
  ChevronRight,
  FileText,
  GitCommit,
  GitMerge,
  MessageSquare,
} from 'lucide-react';

import { CommandGroup, CommandItem } from '../../../shared/view/ui';
import type { PaletteSessionRow } from '../sources/paletteSessionRows';
import type { BranchResult } from '../sources/useBranchesSource';
import type { CommitResult } from '../sources/useCommitsSource';
import type { FileResult } from '../sources/useFilesSource';

export type PaletteBrowsePage = 'files' | 'sessions' | 'commits' | 'branches';

type PaletteBrowseGroupsProps = {
  /** Null while the palette shows every group at its browse limit. */
  page: PaletteBrowsePage | null;
  browseLimit: number;
  sessions: readonly PaletteSessionRow[];
  files: readonly FileResult[];
  commits: readonly CommitResult[];
  branches: readonly BranchResult[];
  onOpenSession: (route: string) => void;
  onOpenFile: (path: string) => void;
  onCheckoutBranch: (name: string) => void;
  onBrowseAll: (page: PaletteBrowsePage) => void;
};

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}

export default function PaletteBrowseGroups({
  page,
  browseLimit,
  sessions,
  files,
  commits,
  branches,
  onOpenSession,
  onOpenFile,
  onCheckoutBranch,
  onBrowseAll,
}: PaletteBrowseGroupsProps) {
  const shown = <T,>(rows: readonly T[], owner: PaletteBrowsePage): readonly T[] =>
    (page === owner ? rows : rows.slice(0, browseLimit));
  const sessionsShown = shown(sessions, 'sessions');
  const filesShown = shown(files, 'files');
  const commitsShown = shown(commits, 'commits');
  const branchesShown = shown(branches, 'branches');

  return (
    <>
      {sessionsShown.length > 0 && (
        <CommandGroup heading="Sessions">
          {sessionsShown.map((session) => (
            <CommandItem
              key={session.route}
              value={`${session.label} ${session.snippet ?? ''} ${session.id}`.trim()}
              onSelect={() => onOpenSession(session.route)}
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{session.label}</span>
                {session.snippet && (
                  <span className="truncate text-xs text-muted-foreground">{session.snippet}</span>
                )}
              </div>
              {session.provider && (
                <span className="text-xs text-muted-foreground">{session.provider}</span>
              )}
            </CommandItem>
          ))}
          {page === null && sessions.length > browseLimit && (
            <BrowseAllItem label={`Browse all sessions (${sessions.length})`} onSelect={() => onBrowseAll('sessions')} />
          )}
        </CommandGroup>
      )}

      {filesShown.length > 0 && (
        <CommandGroup heading="Files">
          {filesShown.map((file) => (
            <CommandItem key={file.path} value={file.path} onSelect={() => onOpenFile(file.path)}>
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">{file.name}</span>
              <span className="truncate text-xs text-muted-foreground">{file.path}</span>
            </CommandItem>
          ))}
          {page === null && files.length > browseLimit && (
            <BrowseAllItem label={`Browse all files (${files.length})`} onSelect={() => onBrowseAll('files')} />
          )}
        </CommandGroup>
      )}

      {commitsShown.length > 0 && (
        <CommandGroup heading="Commits">
          {commitsShown.map((commit) => (
            <CommandItem
              key={commit.hash}
              value={`${commit.message} ${commit.author} ${commit.shortHash}`}
              onSelect={() => undefined}
            >
              <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-mono text-xs text-muted-foreground">{commit.shortHash}</span>
              <span className="flex-1 truncate">{commit.message}</span>
              <span className="truncate text-xs text-muted-foreground">{commit.author}</span>
            </CommandItem>
          ))}
          {page === null && commits.length > browseLimit && (
            <BrowseAllItem label={`Browse all commits (${commits.length})`} onSelect={() => onBrowseAll('commits')} />
          )}
        </CommandGroup>
      )}

      {branchesShown.length > 0 && (
        <CommandGroup heading="Branches">
          {branchesShown.map((branch) => (
            <CommandItem
              key={`branch-${branch.name}`}
              value={branch.name}
              onSelect={() => onCheckoutBranch(branch.name)}
            >
              <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">Switch to: {branch.name}</span>
            </CommandItem>
          ))}
          {page === null && branches.length > browseLimit && (
            <BrowseAllItem label={`Browse all branches (${branches.length})`} onSelect={() => onBrowseAll('branches')} />
          )}
        </CommandGroup>
      )}
    </>
  );
}
