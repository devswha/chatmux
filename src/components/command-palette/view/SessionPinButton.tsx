import { Pin, PinOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type SessionPinButtonProps = {
  pinned: boolean;
  name: string;
  disabledReason?: string;
  onToggle: () => void;
};

/** A sibling of the navigation option, never an interactive child of it. */
export default function SessionPinButton({ pinned, name, disabledReason, onToggle }: SessionPinButtonProps) {
  const { t } = useTranslation('common');
  const label = t(pinned ? 'sessionPins.unpin' : 'sessionPins.pin', { name });
  const Icon = pinned ? PinOff : Pin;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pinned}
      title={disabledReason ?? label}
      disabled={disabledReason !== undefined}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={() => { if (disabledReason === undefined) onToggle(); }}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}
