/**
 * Where the caret sits in a `/token`, and what inserting it gives.
 *
 * The autocomplete popup only opened for an input equal to exactly `/xxx`:
 * typing `/` mid-sentence did nothing. The rule is now positional — a slash
 * that OPENS A WORD, wherever it is — and the insertion only touches the span
 * of that token.
 *
 * Worth knowing: opening the menu mid-sentence is a TYPING aid. The skill
 * expansion stays anchored at the start of the message
 * (`orchestrator/src/slash.ts`): a mid-sentence `/id` is written, not run.
 * That is deliberate — recognising a `/token` anywhere would run a skill's
 * gated `!`cmd`` blocks on a mere `and/or`.
 */

/** The token the caret is composing, if it is composing one. */
export type SlashSpan = {
  /** What follows the slash, lower-cased — the filter query. */
  query: string;
  /** Index of the slash itself, left bound of the replacement. */
  start: number;
};

export function slashSpanAt(input: string, caret: number): SlashSpan | null {
  const upto = input.slice(0, Math.max(0, Math.min(caret, input.length)));
  const m = /(?:^|\s)\/([a-z0-9._:-]*)$/i.exec(upto);
  if (!m) return null;
  return { query: m[1]!.toLowerCase(), start: upto.length - m[1]!.length - 1 };
}

/** The text after insertion, and where to put the caret. Replaces ONLY the
 *  token: the rest of the sentence, before and after, is left intact. */
export function applySlash(
  input: string, caret: number, span: SlashSpan, id: string,
): { text: string; caret: number } {
  const end = Math.max(0, Math.min(caret, input.length));
  const inserted = `/${id} `;
  return {
    text: input.slice(0, span.start) + inserted + input.slice(end),
    caret: span.start + inserted.length,
  };
}
