/**
 * The palette's action groups: one-shot commands, navigation, git and settings.
 * Split from `CommandPalette.tsx`, which now owns only paging and search state.
 */

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  MessageSquarePlus,
  RefreshCw,
  Settings,
  SunMoon,
} from 'lucide-react';

import { CommandGroup, CommandItem } from '../../../shared/view/ui';
import { SETTINGS_MAIN_TABS } from '../../settings/constants/constants';
import type { AppTab, Project } from '../../../types/app';
import type { useGitActions } from '../sources/useGitActions';

// Chat is the only destination tab; Git actions below operate without switching
// the main surface.
const NAV_TABS: ReadonlyArray<{ readonly id: AppTab; readonly label: string; readonly keywords: string }> = [
  { id: 'chat', label: 'Go to Chat', keywords: 'chat messages conversation' },
];

type PaletteActionGroupsProps = {
  selectedProject: Project | null;
  projectId: string | undefined;
  git: ReturnType<typeof useGitActions>;
  run: (action: () => void) => void;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
  onToggleDarkMode: () => void;
};

export default function PaletteActionGroups({
  selectedProject,
  projectId,
  git,
  run,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
  onToggleDarkMode,
}: PaletteActionGroupsProps) {
  const startNewChatDisabled = !selectedProject;

  return (
    <>
      <CommandGroup heading="Actions">
        <CommandItem
          value="Start new chat"
          disabled={startNewChatDisabled}
          onSelect={() => {
            if (!selectedProject) return;
            run(() => onStartNewChat(selectedProject));
          }}
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">Start new chat</span>
          {startNewChatDisabled && (
            <span className="text-xs text-muted-foreground">Select a project first</span>
          )}
        </CommandItem>
        <CommandItem value="Open settings" onSelect={() => run(() => onOpenSettings())}>
          <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">Open settings</span>
        </CommandItem>
        <CommandItem value="Toggle theme dark light mode" onSelect={() => run(onToggleDarkMode)}>
          <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">Toggle theme</span>
        </CommandItem>
      </CommandGroup>

      <CommandGroup heading="Navigate">
        {NAV_TABS.map((tab) => (
          <CommandItem
            key={tab.id as string}
            value={`${tab.label} ${tab.keywords}`}
            onSelect={() => run(() => onShowTab?.(tab.id))}
          >
            <span className="flex-1">{tab.label}</span>
          </CommandItem>
        ))}
      </CommandGroup>

      {projectId && (
        <CommandGroup heading="Git">
          <CommandItem value="Git Fetch remote" onSelect={() => run(() => { void git.fetch(); })}>
            <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">Git: Fetch</span>
          </CommandItem>
          <CommandItem value="Git Pull merge upstream" onSelect={() => run(() => { void git.pull(); })}>
            <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">Git: Pull</span>
          </CommandItem>
          <CommandItem value="Git Push origin remote" onSelect={() => run(() => { void git.push(); })}>
            <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">Git: Push</span>
          </CommandItem>
        </CommandGroup>
      )}

      <CommandGroup heading="Settings">
        {SETTINGS_MAIN_TABS.map(({ id, label, keywords, icon: Icon }) => (
          <CommandItem
            key={id}
            value={`Settings ${label} ${keywords}`}
            onSelect={() => run(() => onOpenSettings(id))}
          >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1">Settings: {label}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}
