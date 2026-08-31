import ReactDOM from 'react-dom';

import Settings from '../../../settings/view/Settings';
import VersionUpgradeModal from '../../../version-upgrade/view';
import type { UpdateJob, InstallMode } from '../../../../hooks/useVersionCheck';

type SidebarModalsProps = {
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  currentVersion: string;
  runningVersion: string | null;
  latestVersion: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
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
  initialTab: string;
};

const SettingsComponent = Settings as (props: TypedSettingsProps) => JSX.Element;

function TypedSettings(props: TypedSettingsProps) {
  return <SettingsComponent {...props} />;
}

export default function SidebarModals({
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showVersionModal,
  onCloseVersionModal,
  currentVersion,
  runningVersion,
  latestVersion,
  releaseNotes,
  releaseUrl,
  installMode,
  clientRefreshAvailable,
  serverUpdateAvailable,
  canUpdate,
  bootId,
  activeJob,
  sourceUpdate,
  sourceUpdateInFlight,
}: SidebarModalsProps) {
  return (
    <>
      {showSettings &&
        ReactDOM.createPortal(
          <TypedSettings
            isOpen={showSettings}
            onClose={onCloseSettings}
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
        releaseNotes={releaseNotes}
        releaseUrl={releaseUrl}
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
