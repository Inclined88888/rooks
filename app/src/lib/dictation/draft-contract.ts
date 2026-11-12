/**
 * The contract between a dictation and the draft it writes into, for every
 * recognizer (Web Speech or the desktop's local engine):
 *
 *  - the transcript EDITS the draft, it never submits it;
 *  - who owns the draft (the conversation's draft key) and what it held are
 *    captured when the recording starts;
 *  - the dictation only writes over its own last write: once the user typed
 *    in the field, or the field now belongs to another conversation, a
 *    transcript that arrives late is dropped rather than overwrite them;
 *  - Escape cancels the dictation and puts the draft back as it was.
 *
 * Pure, so it is tested without React; the chat holds one in a ref.
 */

export type DictationDraft = {
  /** Draft key of the conversation the recording started in. */
  readonly owner: string;
  /** The draft when the recording started: what Escape restores. */
  readonly original: string;
  /** The draft as the dictation last left it: its revision. */
  readonly written: string;
};

export type DraftView = { owner: string; text: string };

export function beginDictationDraft(owner: string, text: string): DictationDraft {
  return { owner, original: text, written: text };
}

/**
 * The draft after writing `next`, or null when the dictation lost the right to
 * write: another conversation is on screen, or the user edited the field.
 */
export function writeDictationDraft(draft: DictationDraft, current: DraftView, next: string): DictationDraft | null {
  if (current.owner !== draft.owner || current.text !== draft.written) return null;
  return { ...draft, written: next };
}

/** The text Escape puts back, or null when the field is no longer this dictation's. */
export function cancelDictationDraft(draft: DictationDraft, current: DraftView): string | null {
  if (current.owner !== draft.owner) return null;
  return draft.original;
}
