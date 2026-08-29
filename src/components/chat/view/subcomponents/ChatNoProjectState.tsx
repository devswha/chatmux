import { useTranslation } from 'react-i18next';

import type { LLMProvider } from '../../../../types/app';

/**
 * Empty state shown until a project is selected: a plain invitation naming the
 * active provider. Split from the former `ChatInterface.tsx`.
 */
export default function ChatNoProjectState({ provider }: { provider: LLMProvider }) {
  const { t } = useTranslation('chat');
  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
          ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : provider === 'gjc'
            ? t('messageTypes.gjc', { defaultValue: 'Gajae Code' })
            : provider === 'omp'
              ? t('messageTypes.omp', { defaultValue: 'Oh My Pi' })
              : t('messageTypes.claude');

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center text-muted-foreground">
        <p className="text-sm">
          {t('projectSelection.startChatWithProvider', {
            provider: selectedProviderLabel,
            defaultValue: 'Select a project to start chatting with {{provider}}',
          })}
        </p>
      </div>
    </div>
  );
}
