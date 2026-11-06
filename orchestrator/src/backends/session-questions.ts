/**
 * `SessionHost.ask` in and out of the `question` card: what a driver may ask,
 * the form the card is opened with, and the answer read back per question.
 *
 * Leaf on purpose (types only): the SDK's testing kit checks a provider's cards
 * with the same rules the daemon applies, and the daemon refuses a card here,
 * before `permissions.ts` — whose own refusal of a malformed form counts
 * towards closing the mission's question channel, a sanction meant for an agent
 * that writes the form itself, not for a provider's translation of it.
 */
import type { SessionAnswer, SessionAskRequest, SessionQuestion } from './types.js';

export const SESSION_ASK_MAX_QUESTIONS = 4;
export const SESSION_ASK_MIN_OPTIONS = 2;
export const SESSION_ASK_MAX_OPTIONS = 4;
/** A plan an agent submits for approval rides in the question's text. */
export const SESSION_QUESTION_MAX_CHARS = 8_000;
export const SESSION_LABEL_MAX_CHARS = 200;

function where(index: number): string {
  return `question ${index + 1}`;
}

/** Why the card cannot be shown, or `null`. Read by the agent: names the field. */
export function askRequestProblem(req: SessionAskRequest): string | null {
  const { questions } = req;
  if (!Array.isArray(questions) || questions.length === 0) return 'no question';
  if (questions.length > SESSION_ASK_MAX_QUESTIONS) return `${questions.length} questions (at most ${SESSION_ASK_MAX_QUESTIONS})`;
  const texts = new Set<string>();
  for (const [i, q] of questions.entries()) {
    if (typeof q?.question !== 'string' || !q.question.trim()) return `${where(i)}: no text`;
    if (q.question.length > SESSION_QUESTION_MAX_CHARS) return `${where(i)}: over ${SESSION_QUESTION_MAX_CHARS} characters`;
    // The answer is keyed by the text: two equal texts would share one answer.
    if (texts.has(q.question)) return `${where(i)}: the same text as an earlier question`;
    texts.add(q.question);
    const options = q.options ?? [];
    if (options.length === 0) {
      if (q.multiSelect) return `${where(i)}: a multiple choice needs ${SESSION_ASK_MIN_OPTIONS} to ${SESSION_ASK_MAX_OPTIONS} options`;
      continue;
    }
    if (options.length < SESSION_ASK_MIN_OPTIONS || options.length > SESSION_ASK_MAX_OPTIONS) {
      return `${where(i)}: ${options.length} options (${SESSION_ASK_MIN_OPTIONS} to ${SESSION_ASK_MAX_OPTIONS}, or none for free text)`;
    }
    const labels = new Set<string>();
    for (const [j, o] of options.entries()) {
      if (typeof o?.label !== 'string' || !o.label.trim()) return `${where(i)}, option ${j + 1}: no label`;
      if (o.label.length > SESSION_LABEL_MAX_CHARS) return `${where(i)}, option ${j + 1}: label over ${SESSION_LABEL_MAX_CHARS} characters`;
      // The card answers with the label: two equal labels could not be told apart.
      if (labels.has(o.label)) return `${where(i)}, option ${j + 1}: the same label as another option`;
      labels.add(o.label);
    }
  }
  return null;
}

/** The plan card's own words (`cards.approvePlan`). The answer is read back by label: they never change with the locale. */
export const PLAN_CARD_HEADER = 'Plan';
export const PLAN_APPROVE_LABEL = 'Approve the plan';
export const PLAN_APPROVE_DESCRIPTION = 'The agent carries it out.';
export const PLAN_REJECT_LABEL = 'Reject the plan';
export const PLAN_REJECT_DESCRIPTION = 'The agent does not; say why in the field below.';

/**
 * The words the daemon writes on a card itself, per field, and the webview
 * locale key of each: the card carries the key beside the text (`headerKey`,
 * `labelKey`, `descriptionKey`) and the webview shows the person's language.
 * The text stays what the card answers with. An agent's own words have no key:
 * they are shown as written.
 */
const CARD_TEXT_KEYS = {
  headerKey: { [PLAN_CARD_HEADER]: 'askCard.planHeader' },
  labelKey: { [PLAN_APPROVE_LABEL]: 'askCard.planApprove', [PLAN_REJECT_LABEL]: 'askCard.planReject' },
  descriptionKey: {
    [PLAN_APPROVE_DESCRIPTION]: 'askCard.planApproveDescription',
    [PLAN_REJECT_DESCRIPTION]: 'askCard.planRejectDescription',
  },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

function textKey(field: keyof typeof CARD_TEXT_KEYS, text: string): Record<string, string> {
  const keys: Readonly<Record<string, string>> = CARD_TEXT_KEYS[field];
  return Object.hasOwn(keys, text) ? { [field]: keys[text]! } : {};
}

/** The `question` card's payload (`ask_user`), fields the card does not know left out. */
export function askUserInput(req: SessionAskRequest): { questions: Array<Record<string, unknown>> } {
  return {
    questions: req.questions.map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header, ...textKey('headerKey', q.header) } : {}),
      ...(q.options?.length
        ? {
            options: q.options.map((o) => ({
              label: o.label,
              ...textKey('labelKey', o.label),
              ...(o.description ? { description: o.description, ...textKey('descriptionKey', o.description) } : {}),
            })),
          }
        : {}),
      ...(q.multiSelect ? { multiSelect: true } : {}),
      ...(q.placeholder ? { placeholder: q.placeholder } : {}),
    })),
  };
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * One question's answer as the card sends it — a label, labels, or
 * `{choice|choices, text}` — split into the labels it offered and the text.
 * A value that is not one of the labels (a plugin answering in words) is text.
 */
function readOne(q: SessionQuestion, raw: unknown): SessionAnswer {
  const labels = (q.options ?? []).map((o) => o.label);
  let given: string[];
  let typed: string[] = [];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as { choice?: unknown; choices?: unknown; text?: unknown };
    given = [...strings(r.choice), ...strings(r.choices)];
    if (typeof r.text === 'string') typed = [r.text];
  } else {
    given = strings(raw);
  }
  const picked = labels.filter((label) => given.includes(label));
  const text = [...given.filter((g) => !labels.includes(g)), ...typed].map((s) => s.trim()).filter(Boolean).join('\n');
  return { picked, text: text || null };
}

/** The answers of an allowed card (`updatedInput.answers`), one per question asked, keyed by its text. */
export function readSessionAnswers(questions: readonly SessionQuestion[], updatedInput: unknown): Record<string, SessionAnswer> {
  const answers = updatedInput !== null && typeof updatedInput === 'object'
    ? (updatedInput as { answers?: unknown }).answers
    : undefined;
  const byText = answers !== null && typeof answers === 'object' ? answers as Record<string, unknown> : {};
  const out: Record<string, SessionAnswer> = {};
  for (const q of questions) out[q.question] = readOne(q, Object.hasOwn(byText, q.question) ? byText[q.question] : undefined);
  return out;
}
