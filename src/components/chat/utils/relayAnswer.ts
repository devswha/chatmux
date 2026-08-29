/**
 * Which question a relayed answer belongs to, and whether it is a valid answer.
 *
 * Two descriptions of the same question can be on screen at once: the transcript's
 * pending ask card and the prompt parsed from the live pane. Only one of them is
 * rendered, so a typed number must be interpreted with that one's numbering — the
 * other's option count would silently map the answer to a different choice. This
 * module makes that choice explicit and testable, separately from the transport.
 */

export type RelayAnswerQuestion = {
  readonly optionCount: number;
  readonly customOptionNumber: number | null;
  readonly multiSelect: boolean;
};

export type RelayAnswerRoute =
  /** Continuation of a custom ("other") answer already started. */
  | { readonly kind: 'interactive-custom' }
  | { readonly kind: 'interactive-choices'; readonly choices: readonly number[] }
  | { readonly kind: 'ask-custom' }
  | { readonly kind: 'ask-choice'; readonly choiceIndex: number }
  | { readonly kind: 'text' }
  | { readonly kind: 'invalid'; readonly max: number; readonly multiSelect: boolean };

export type RelayAnswerContext = {
  readonly message: string;
  /** Live-pane prompt, when one is being shown. */
  readonly prompt: RelayAnswerQuestion | null;
  /** True while the user is typing the custom answer for the live-pane prompt. */
  readonly awaitingPromptCustom: boolean;
  /** Transcript ask card, when one is pending. */
  readonly ask: { readonly maxChoiceNumber: number } | null;
  /** True while the user is typing the custom answer for the ask card. */
  readonly awaitingAskCustom: boolean;
};

const NUMBER_LIST = /^\d+(?:\s*,\s*\d+)*$/;

function maxChoice(question: RelayAnswerQuestion): number {
  return question.customOptionNumber ?? question.optionCount;
}

function parseChoices(message: string): readonly number[] | null {
  return NUMBER_LIST.test(message)
    ? message.split(',').map((value) => Number.parseInt(value.trim(), 10))
    : null;
}

function choicesValid(choices: readonly number[], question: RelayAnswerQuestion): boolean {
  const max = maxChoice(question);
  return !choices.some((number) => number < 0 || number > max)
    && !(choices.includes(0) && choices.length !== 1)
    && (question.multiSelect || choices.length === 1)
    && new Set(choices).size === choices.length;
}

/**
 * The live-pane prompt owns the answer only when the ask card is not the thing on
 * screen, or when it started the custom-answer continuation.
 */
export function routeRelayAnswer(context: RelayAnswerContext): RelayAnswerRoute {
  const prompt = context.prompt;
  const promptOwns = prompt !== null && (context.awaitingPromptCustom || context.ask === null);
  if (promptOwns && prompt !== null) {
    if (context.awaitingPromptCustom) {
      return { kind: 'interactive-custom' };
    }
    const choices = parseChoices(context.message);
    if (choices === null || !choicesValid(choices, prompt)) {
      return { kind: 'invalid', max: maxChoice(prompt), multiSelect: prompt.multiSelect };
    }
    return { kind: 'interactive-choices', choices };
  }
  const ask = context.ask;
  if (ask === null) {
    return { kind: 'text' };
  }
  if (context.awaitingAskCustom) {
    return { kind: 'ask-custom' };
  }
  if (!/^\d+$/.test(context.message)) {
    return { kind: 'invalid', max: ask.maxChoiceNumber, multiSelect: false };
  }
  const number = Number.parseInt(context.message, 10);
  return number < 0 || number > ask.maxChoiceNumber
    ? { kind: 'invalid', max: ask.maxChoiceNumber, multiSelect: false }
    // 0 is the card's cancel entry; every other number is a 1-based option.
    : { kind: 'ask-choice', choiceIndex: number === 0 ? -1 : number - 1 };
}
