import { Fragment } from 'react';

export type SessionActivityState = 'running' | 'ready' | 'input' | 'error';

const STATUS_CONFIG = {
  running: {
    label: 'RUN',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    dotClassName: 'animate-pulse bg-emerald-500',
  },
  ready: {
    label: 'READY',
    className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    dotClassName: 'bg-blue-500',
  },
  input: {
    label: 'INPUT',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    dotClassName: 'animate-pulse bg-amber-500',
  },
  error: {
    label: 'ERROR',
    className: 'bg-red-500/15 text-red-600 dark:text-red-400',
    dotClassName: 'bg-red-500',
  },
} satisfies Record<SessionActivityState, {
  label: string;
  className: string;
  dotClassName: string;
}>;

type SessionActivityBadgeProps = {
  state: SessionActivityState;
};

export default function SessionActivityBadge({ state }: SessionActivityBadgeProps) {
  const config = STATUS_CONFIG[state];
  return (
    <Fragment>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${config.dotClassName}`} aria-hidden />
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${config.className}`}>
        {config.label}
      </span>
    </Fragment>
  );
}
