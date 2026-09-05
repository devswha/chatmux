import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CommandGroup, CommandItem } from '../../../shared/view/ui';
import { resolvePinnedSession, type PinInventory } from '../pins/pinnedSessionInventory';
import { pinnedSessionKey, type PinnedSession } from '../pins/pinnedSessions';

import SessionPinButton from './SessionPinButton';

type PinnedSessionGroupProps = {
  pins: readonly PinnedSession[];
  inventory: PinInventory;
  onOpen: (pin: PinnedSession) => void;
  onUnpin: (pin: PinnedSession) => void;
};

export default function PinnedSessionGroup({ pins, inventory, onOpen, onUnpin }: PinnedSessionGroupProps) {
  const { t } = useTranslation('common');
  if (pins.length === 0) return null;
  return (
    <CommandGroup heading={t('sessionPins.heading')}>
      {pins.map((pin) => {
        const resolved = resolvePinnedSession(pin, inventory);
        const key = pinnedSessionKey(pin);
        const label = resolved?.label ?? `${t('sessionPins.unavailable')} · ${pin.sessionId}`;
        // Unknown targets expose only their identity, never a cached title.
        const host = `${resolved?.hostLabel || t('sessionPins.host')} · ${pin.hostId}`;
        const project = resolved?.project.displayName || pin.projectId;
        const detail = `${project} · ${host}`;
        const name = `${label} · ${detail}`;
        return (
          <div key={key} className="flex items-center gap-1 [&:not(:has([cmdk-item]))]:hidden">
            <CommandItem
              value={key}
              keywords={[label, project, host, pin.sessionId]}
              disabled={resolved === null}
              onSelect={() => onOpen(pin)}
              className="min-h-11 min-w-0 flex-1"
              aria-label={name}
            >
              <Pin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{label}</span>
                <span className="truncate text-xs text-muted-foreground">{detail}</span>
              </span>
            </CommandItem>
            <SessionPinButton pinned name={name} onToggle={() => onUnpin(pin)} />
          </div>
        );
      })}
    </CommandGroup>
  );
}
