/**
 * The interactive prompt the relayed session is currently showing, rendered as
 * the answer card. Split from `LiveRelayComposer.tsx`.
 *
 * Answering goes back through the composer's single validated relay path, so a
 * tapped choice and a typed number are indistinguishable downstream.
 */

import type { RelayInteractivePrompt } from '../../hooks/useRelayInteractivePrompt';
import { QuestionAnswerContent } from '../../tools/components/ContentRenderers';

type RelayPromptCardProps = {
  prompt: RelayInteractivePrompt;
  onAnswer: (message: string) => void;
};

export default function RelayPromptCard({ prompt, onAnswer }: RelayPromptCardProps) {
  return (
    <div className="space-y-2">
      {prompt.body && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-foreground">
          {prompt.body}
        </pre>
      )}
      <QuestionAnswerContent
        key={`${prompt.id}:${(prompt.checkedChoiceNumbers ?? []).join(',')}`}
        questions={[{
          header: prompt.title,
          question: prompt.question,
          options: prompt.options,
          multiSelect: prompt.multiSelect,
        }]}
        answers={{}}
        pending
        allowDirectInput={prompt.customOptionNumber !== null}
        directInputNumber={prompt.customOptionNumber ?? undefined}
        initialChoiceNumbers={prompt.checkedChoiceNumbers}
        onSelectChoice={prompt.multiSelect
          ? undefined
          : (choiceNumber) => { onAnswer(String(choiceNumber)); }}
        onSubmitChoices={prompt.multiSelect
          ? (choiceNumbers) => { onAnswer(choiceNumbers.join(',')); }
          : undefined}
      />
    </div>
  );
}
