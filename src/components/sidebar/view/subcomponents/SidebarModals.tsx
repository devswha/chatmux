import { useMemo } from 'react';
import ReactDOM from 'react-dom';

import Settings from '../../../settings/view/Settings';
import VersionUpgradeModal from '../../../version-upgrade/view';
import type { Project } from '../../../../types/app';
import type { UpdateJob, InstallMode } from '../../../../hooks/useVersionCheck';
import { normalizeProjectForSettings } from '../../utils/utils';
import type { SettingsProject } from '../../types/types';

type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  currentVersion: string;
  runningVersion: string | null;
  latestVersion: string | null;
  installMode: InstallMode;
  clientRefreshAvailable: boolean;
  serverUpdateAvailable: boolean;
  canUpdate: boolean;
  bootId: string | null;
  activeJob: UpdateJob | null;
  sourceUpdate: { operationId: string; initialBootId: string } | null;
  sourceUpdateInFlight: boolean;
};

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent = Settings as (props: TypedSettingsProps) => JSX.Element;

function TypedSettings(props: TypedSettingsProps) {
  return <SettingsComponent {...props} />;
}

export default function SidebarModals({
  projects,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showVersionModal,
  onCloseVersionModal,
  currentVersion,
  runningVersion,
  latestVersion,
  installMode,
  clientRefreshAvailable,
  serverUpdateAvailable,
  canUpdate,
  bootId,
  activeJob,
  sourceUpdate,
  sourceUpdateInFlight,
}: SidebarModalsProps) {
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  return (
    <>
      {showSettings &&
        ReactDOM.createPortal(
          <TypedSettings
            isOpen={showSettings}
            onClose={onCloseSettings}
            projects={settingsProjects}
            initialTab={settingsInitialTab}
          />,
          document.body,
        )}

      <VersionUpgradeModal
        isOpen={showVersionModal}
        onClose={onCloseVersionModal}
        currentVersion={currentVersion}
        runningVersion={runningVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        clientRefreshAvailable={clientRefreshAvailable}
        serverUpdateAvailable={serverUpdateAvailable}
        canUpdate={canUpdate}
        bootId={bootId}
        activeJob={activeJob}
        sourceUpdateInFlight={sourceUpdateInFlight}
        sourceUpdate={sourceUpdate}
      />
    </>
  );
}
