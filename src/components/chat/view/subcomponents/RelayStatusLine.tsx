/**
 * The relay composer's status line: which session and model the draft is going
 * to, plus the last delivery and image-upload result. Split from
 * `LiveRelayComposer.tsx`.
 */

import { useTranslation } from 'react-i18next';

import type { RelayAssetStatus } from '../../hooks/useRelayImageAssets';

export type RelayDeliveryStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'queued'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

type RelayStatusLineProps = {
  displayName: string;
  model: string | null;
  effort: string | null;
  status: RelayDeliveryStatus;
  assetStatus: RelayAssetStatus;
};

export default function RelayStatusLine({
  displayName,
  model,
  effort,
  status,
  assetStatus,
}: RelayStatusLineProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-blue-600 dark:text-blue-400">
      <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden />
      {model ? (
        <span>
          <span className="font-semibold">{model.split('/').pop()}</span>
          {effort && <span className="text-muted-foreground"> · {effort} effort</span>}
          <span className="text-muted-foreground"> · {displayName}</span>
        </span>
      ) : (
        <span className="font-semibold">{displayName}</span>
      )}
      {status.kind !== 'idle' && status.kind !== 'sending' && (
        <span aria-live="polite" className={status.kind === 'error' ? 'text-red-500' : 'text-muted-foreground'}>· {status.text}</span>
      )}
      {assetStatus.kind === 'uploading' && (
        <span aria-live="polite" className="text-muted-foreground">· {t('relay.imageUploading', { defaultValue: 'Uploading image…' })}</span>
      )}
      {assetStatus.kind === 'error' && (
        <span aria-live="polite" className="text-red-500">· {assetStatus.text}</span>
      )}
    </div>
  );
}
