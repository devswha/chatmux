import { PanelLeftClose, RefreshCw } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { DiscoveryFreshness } from '../../../../hooks/useDiscoveryStream';
import { Button } from '../../../../shared/view/ui';
import { CHATMUX_WORDMARK_FONT_FAMILY } from '../../../../constants/branding';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
  discoveryFreshness?: DiscoveryFreshness;
  onCollapseSidebar: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  onRefresh,
  isRefreshing,
  discoveryFreshness = 'unavailable',
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const logo = (
    <div className="flex min-w-0 items-center gap-2.5">
      <img src="/logo.png" alt="" aria-hidden className="h-7 w-7 flex-shrink-0 object-contain" />
      <h1
        className="truncate text-sm font-bold tracking-tight text-foreground"
        style={{ fontFamily: CHATMUX_WORDMARK_FONT_FAMILY }}
      >
        ChatMux
      </h1>
    </div>
  );

  return (
    <div className="flex-shrink-0">
      <div className="hidden px-3 pb-2 pt-3 md:block">
        <div className="flex items-center justify-between gap-2">
          {logo}
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('tooltips.refresh')}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="p-3 pb-2 md:hidden" style={isPWA && isMobile ? { paddingTop: '16px' } : {}}>
        <div className="flex items-center justify-between">
          {logo}
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={t('tooltips.refresh')}
          >
            <RefreshCw className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex min-w-0 items-center gap-2 px-3 pb-2 text-xs text-muted-foreground"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${discoveryFreshness === 'current' ? 'bg-emerald-500' : 'bg-amber-500'}`}
        />
        <span className="min-w-0 break-words">{t(`common:discoveryFreshness.${discoveryFreshness}`)}</span>
      </div>
      <div className="nav-divider" />
    </div>
  );
}
