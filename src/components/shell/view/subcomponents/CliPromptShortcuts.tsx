import type { CliPromptOption } from '../../hooks/useCliPromptOptions';

type CliPromptShortcutsProps = Readonly<{
  readonly options: readonly CliPromptOption[];
  readonly onInput: (data: string) => void;
}>;

export function CliPromptShortcuts({ options, onInput }: CliPromptShortcutsProps) {
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10 border-t border-gray-700/80 bg-gray-800/95 px-3 py-2 backdrop-blur-sm md:hidden"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex flex-wrap items-center gap-2">
        {options.map((option) => (
          <button
            type="button"
            key={option.number}
            onClick={() => onInput(option.number)}
            className="max-w-36 truncate rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
            title={`${option.number}. ${option.label}`}
          >
            {option.number}. {option.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onInput('\x1b')}
          className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-600"
        >
          Esc
        </button>
      </div>
    </div>
  );
}
