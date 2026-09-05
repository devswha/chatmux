import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '../../../contexts/PaletteOpsContext';

export default function CommandPaletteButton() {
  const { t } = useTranslation('common');
  const { openCommandPalette } = usePaletteOps();
  return (
    <button
      type="button"
      aria-label={t('sessionPins.openPalette')}
      aria-haspopup="dialog"
      title={t('sessionPins.openPalette')}
      onClick={openCommandPalette}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Search className="h-4 w-4" aria-hidden />
    </button>
  );
}
