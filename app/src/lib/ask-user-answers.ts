/**
 * The answers of a `question` form, as the agent reads them. A question with
 * no options is an open question: its answer is the text typed in its single
 * field. A question with options also ends with a free-text field: the text
 * typed there rides inside the answer of THAT question, beside the pick — or
 * alone, which is the only way to answer it without ticking anything.
 */
import { sourceText, t } from '@/lib/i18n';

/** Who carries an option out when it is an action. Anything else shows no badge. */
export type AskUserActor = 'agent' | 'user';
/**
 * `labelKey` / `descriptionKey` / `headerKey`: the locale key of a word the
 * daemon wrote on the card itself (the plan card's "Approve the plan"), shown
 * in the person's language. The label stays what the answer carries.
 */
export type AskUserOption = { label: string; description?: string; actor?: AskUserActor; labelKey?: string; descriptionKey?: string };
export type AskUserQuestion = {
  question: string;
  header?: string;
  headerKey?: string;
  /** Absent or empty: a free-text question, answered in one text field. */
  options?: AskUserOption[];
  /** Free-text question only: hint shown in the empty field. */
  placeholder?: string;
  multiSelect?: boolean;
};

/**
 * One question's answer. The common case stays a bare label (or a list of
 * labels on a multi-select); the object form appears only when the user typed
 * in the question's free-text field.
 */
export type AskAnswerValue =
  | string
  | string[]
  | { choice?: string; choices?: string[]; text: string };

const CARD_KEY_PREFIX = 'askCard.';

/**
 * What the card shows for `text`: its translation when `key` names the
 * daemon's own wording of that very text, `text` as written otherwise. The key
 * comes in the card's payload, which an agent may also write: a key whose
 * English is not `text` would show the person one choice while the agent reads
 * another, so it is ignored.
 */
export function cardText(text: string, key: unknown): string {
  if (typeof key !== 'string' || !key.startsWith(CARD_KEY_PREFIX)) return text;
  return sourceText(key) === text ? t(key) : text;
}

export function isFreeTextQuestion(q: AskUserQuestion): boolean {
  return !q.options || q.options.length === 0;
}

/** The badge an option carries: only the two values the tool schema lists. */
export function optionActor(o: AskUserOption): AskUserActor | null {
  return o.actor === 'agent' || o.actor === 'user' ? o.actor : null;
}

function pickedLabels(q: AskUserQuestion, pick: string | string[] | undefined): string[] {
  const labels = new Set((q.options ?? []).map((o) => o.label));
  const raw = Array.isArray(pick) ? pick : pick ? [pick] : [];
  return raw.filter((label) => labels.has(label));
}

/**
 * Whether one question has an answer: a ticked option, or text in its field.
 * An open question has only its field, so its text is mandatory.
 */
export function askQuestionAnswered(
  q: AskUserQuestion,
  picks: Record<string, string | string[]>,
  custom: Record<string, string>,
): boolean {
  if ((custom[q.question] ?? '').trim() !== '') return true;
  return !isFreeTextQuestion(q) && pickedLabels(q, picks[q.question]).length > 0;
}

/** False while one question still has neither a ticked option nor text. */
export function askFormComplete(
  questions: AskUserQuestion[],
  picks: Record<string, string | string[]>,
  custom: Record<string, string>,
): boolean {
  return questions.every((q) => askQuestionAnswered(q, picks, custom));
}

/** The answers, keyed by the text of each question (cf. `AskAnswerValue`). */
export function buildAskAnswers(
  questions: AskUserQuestion[],
  picks: Record<string, string | string[]>,
  custom: Record<string, string>,
): Record<string, AskAnswerValue> {
  const answers: Record<string, AskAnswerValue> = {};
  for (const q of questions) {
    const text = (custom[q.question] ?? '').trim();
    if (isFreeTextQuestion(q)) {
      answers[q.question] = text;
      continue;
    }
    const picked = pickedLabels(q, picks[q.question]);
    if (q.multiSelect) {
      if (!text) answers[q.question] = picked;
      else answers[q.question] = picked.length ? { choices: picked, text } : { text };
    } else {
      const choice = picked[0];
      if (!text) answers[q.question] = choice ?? '';
      else answers[q.question] = choice ? { choice, text } : { text };
    }
  }
  return answers;
}
