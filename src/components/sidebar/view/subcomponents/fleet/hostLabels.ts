/**
 * Display naming for host groups.
 *
 * Two enrolled machines may carry the same owner-chosen label. When they do, the
 * label alone cannot identify a row's owner, so the installation id prefix is
 * appended — the id is the only identity the fleet contract guarantees to be
 * unique.
 */

import type { TFunction } from 'i18next';

import type { HostGroup } from '../../../../../fleet/discovery/hostGroups';

const HOST_ID_PREFIX_LENGTH = 8;

export function hostDisplayLabel(group: HostGroup, t: TFunction): string {
  return group.labelDuplicated
    ? t('hostGroups.hostLabelDisambiguated', {
      label: group.label,
      suffix: group.hostId.slice(0, HOST_ID_PREFIX_LENGTH),
    })
    : group.label;
}
