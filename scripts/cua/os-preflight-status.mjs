export const DEFAULT_TARGET_UBUNTU_VERSION = '24.04';

function versionParts(version) {
  return String(version ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function ubuntuVersionAtLeast(currentVersion, targetVersion) {
  const current = versionParts(currentVersion);
  const target = versionParts(targetVersion);
  const length = Math.max(current.length, target.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = current[index] ?? 0;
    const targetPart = target[index] ?? 0;
    if (currentPart > targetPart) return true;
    if (currentPart < targetPart) return false;
  }
  return true;
}

export function deriveUpgradeStatus({
  currentVersion,
  desiredVersion = DEFAULT_TARGET_UBUNTU_VERSION,
  targetAvailable,
  gates,
}) {
  const reachedTarget = ubuntuVersionAtLeast(currentVersion, desiredVersion);
  const healthy = (
    gates.freeBytes >= 20 * 1024 * 1024 * 1024
    && gates.packageHolds === 0
    && gates.dpkgAuditEntries === 0
    && gates.failedSystemUnits === 0
    && !gates.rebootRequired
  );
  const blocked = !reachedTarget && !gates.nonInteractiveSudo;
  return {
    desiredVersion,
    reachedTarget,
    readyForAuthorizedUpgrade: !reachedTarget && targetAvailable && healthy,
    upgradeComplete: reachedTarget && healthy,
    blocked,
    blocker: blocked
      ? 'An administrator must enter the sudo password and remain available for reboot prompts.'
      : null,
  };
}
