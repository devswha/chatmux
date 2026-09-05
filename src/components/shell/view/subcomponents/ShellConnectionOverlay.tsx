import { Loader2, RotateCcw } from 'lucide-react';

type ShellConnectionOverlayProps = {
  mode: 'loading' | 'connect' | 'connecting';
  description: string;
  loadingLabel: string;
  connectLabel: string;
  connectTitle: string;
  connectingLabel: string;
  onConnect: () => void;
};

export default function ShellConnectionOverlay({
  mode,
  description,
  loadingLabel,
  connectLabel,
  connectTitle,
  connectingLabel,
  onConnect,
}: ShellConnectionOverlayProps) {
  const statusLabel = mode === 'loading' ? loadingLabel : mode === 'connect' ? description : connectingLabel;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-950/90 p-6">
      <div className="flex w-full min-w-0 max-w-md flex-col items-center gap-3 text-center">
        {mode === 'connect' && (
          <button
            type="button"
            onClick={onConnect}
            className="pointer-events-auto inline-flex min-h-12 w-full max-w-xs cursor-pointer items-center justify-center gap-2 rounded-md bg-emerald-600 px-5 py-3 text-base font-semibold text-white shadow-lg shadow-emerald-950/30 transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-gray-950 active:bg-emerald-700"
            title={connectTitle}
          >
            <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 whitespace-normal break-words">{connectLabel}</span>
          </button>
        )}
        {/* Keep the same polite status node across modes, outside the connect button. */}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex w-full min-w-0 items-center justify-center gap-2"
        >
          {mode !== 'connect' && (
            <Loader2
              className={mode === 'loading'
                ? 'h-4 w-4 shrink-0 animate-spin text-blue-300'
                : 'h-5 w-5 shrink-0 animate-spin text-yellow-300'}
              aria-hidden="true"
            />
          )}
          <span className={mode === 'loading'
            ? 'min-w-0 break-words text-sm font-medium text-gray-100'
            : mode === 'connect'
              ? 'min-w-0 break-words px-2 text-sm leading-6 text-gray-300'
              : 'min-w-0 break-words text-base font-medium text-yellow-300'}
          >
            {statusLabel}
          </span>
        </p>
        {mode === 'connecting' && (
          <p className="max-w-full break-words px-2 text-sm leading-6 text-gray-300">{description}</p>
        )}
      </div>
    </div>
  );
}
