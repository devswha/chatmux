import { useContext, useEffect, useMemo, useRef } from 'react';

import type { CompletionNotificationDescriptor } from '../../../../shared/completion-notifications';
import { CompletionNotificationsContext, completionNotificationDescriptorKey } from '../context/CompletionNotificationsContext';
import type { CompletionNotificationsHookApi } from '../types/types';

export function useCompletionNotifications(
  descriptors: CompletionNotificationDescriptor | readonly CompletionNotificationDescriptor[],
): CompletionNotificationsHookApi {
  const context = useContext(CompletionNotificationsContext);
  if (!context) throw new Error('useCompletionNotifications must be used inside CompletionNotificationsProvider.');

  const descriptorList = useMemo(
    () => Array.isArray(descriptors) ? descriptors : [descriptors],
    [descriptors],
  );
  const descriptorIdentity = useMemo(
    () => JSON.stringify(descriptorList.map(completionNotificationDescriptorKey)),
    [descriptorList],
  );

  const descriptorListRef = useRef(descriptorList);
  useEffect(() => {
    descriptorListRef.current = descriptorList;
  }, [descriptorList]);

  const { registerDescriptors } = context;
  useEffect(() => {
    const registeredDescriptors = descriptorListRef.current;
    return registerDescriptors(registeredDescriptors);
  }, [descriptorIdentity, registerDescriptors]);

  const statuses = useMemo(() => {
    const selected = new Map();
    for (const descriptor of descriptorList) {
      const key = completionNotificationDescriptorKey(descriptor);
      const status = context.statuses.get(key);
      if (status) selected.set(key, status);
    }
    return selected;
  }, [context.statuses, descriptorList]);

  return {
    status: descriptorList.length === 1 ? statuses.get(completionNotificationDescriptorKey(descriptorList[0])) ?? null : null,
    statuses,
    setWatch: context.setWatch,
    repairDevice: context.repairDevice,
    refresh: context.refresh,
  };
}
