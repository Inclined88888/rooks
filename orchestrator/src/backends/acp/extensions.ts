/**
 * An ACP agent's OWN blocking requests (`docs/PROVIDERS-SDK.md` § 13): methods
 * outside the protocol that the agent sends and then waits on — Cursor's
 * `cursor/ask_question` and `cursor/create_plan`. Without a hook, the transport
 * answers "method not found" and what the agent does next is its own guess.
 *
 * The provider names each method it handles (`AcpAgentSpec.extensionRequests`)
 * and translates it, both ways, with the cards the daemon lends it: a question
 * card, or a plan put to the person for approval. Which card, which words, which
 * reply shape: the provider's. The card, its rules (an unattended mission never
 * asks a person), its life (retired when the agent stops waiting) and the reply
 * on the wire: the daemon's. Nothing here names an agent.
 *
 * Leaf: types, validation and the card adapter over `SessionHost.ask`, so the
 * SDK's testing kit runs the same code a mission does.
 */
import type { SessionAskOutcome, SessionAskRequest, SessionHost, SessionQuestion } from '../types.js';
import {
  askRequestProblem,
  PLAN_APPROVE_DESCRIPTION,
  PLAN_APPROVE_LABEL,
  PLAN_CARD_HEADER,
  PLAN_REJECT_DESCRIPTION,
  PLAN_REJECT_LABEL,
  SESSION_QUESTION_MAX_CHARS,
} from '../session-questions.js';

/** One question of a card, with the ids the agent uses for it and its options. */
export type AcpCardQuestion = {
  /** The agent's id of the question: the answer comes back under it. */
  readonly id: string;
  /** The text shown (line breaks kept). Distinct texts within a card. */
  readonly question: string;
  readonly header?: string;
  /** 2 to 4, distinct ids and labels; absent or empty = free text. */
  readonly options?: readonly AcpCardOption[];
  readonly multiSelect?: boolean;
  readonly placeholder?: string;
};

export type AcpCardOption = {
  /** The agent's id of the option: what `selected` holds. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};

/** One question's answer: the ids of the options picked, and the text typed (`null` when none). */
export type AcpCardAnswer = {
  readonly selected: readonly string[];
  readonly text: string | null;
};

/** A plan put to the person: a title, the plan itself (plain text or Markdown, line breaks kept) and its steps. */
export type AcpPlanApproval = {
  readonly title: string;
  readonly plan: string;
  readonly steps?: readonly string[];
};

/** `note`: what the person typed beside their verdict, `null` when nothing. */
export type AcpPlanVerdict = {
  readonly approved: boolean;
  readonly note: string | null;
};

/**
 * How a card ended:
 *   - `answered`: the person answered;
 *   - `unanswered`: no answer — they closed it, nobody may be asked on this
 *     mission (an unattended one: `reason` says who to ask instead), the card
 *     could not be shown (`reason` names why) — a sentence written for the agent;
 *   - `cancelled`: the agent stopped waiting (its turn was cancelled, the
 *     session ended); whatever is returned now is not read.
 */
export type AcpCardOutcome<T> =
  | { readonly outcome: 'answered'; readonly value: T }
  | { readonly outcome: 'unanswered'; readonly reason: string }
  | { readonly outcome: 'cancelled' };

/** What a handler is lent: the cards, and the signal of the agent's wait. */
export type AcpExtensionCards = {
  /** Aborted when the agent no longer waits for this request. */
  readonly signal: AbortSignal;
  /** Opens a question card. `id` ties the card to the request (the agent's own call id, when it sends one). */
  ask(questions: readonly AcpCardQuestion[], options?: { readonly id?: string | null }): Promise<AcpCardOutcome<Readonly<Record<string, AcpCardAnswer>>>>;
  /** Puts a plan to the person: a card with the plan and two choices, approve or reject, plus a remark. */
  approvePlan(plan: AcpPlanApproval, options?: { readonly id?: string | null }): Promise<AcpCardOutcome<AcpPlanVerdict>>;
};

/**
 * Answers one request of the agent. `params` is what the agent sent, unchecked:
 * validate it. The value returned is the JSON-RPC `result`; a throw is answered
 * with a generic internal error (its message never reaches the agent). Return
 * promptly once `cards.signal` aborts: the agent is answered with an error a few
 * seconds later otherwise.
 */
export type AcpExtensionHandler = (params: unknown, cards: AcpExtensionCards) => Promise<unknown>;

export const ACP_EXTENSION_METHOD_MAX_CHARS = 120;
/** The protocol's own methods: a provider extends the protocol, it does not take it over. */
const RESERVED_PREFIXES = ['session/', 'fs/', 'terminal/'] as const;
const RESERVED_METHODS = new Set(['initialize', 'authenticate']);
const METHOD_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$./-]*$/;

/** Why `method` cannot be an extension request a provider handles, or `null`. */
export function acpExtensionMethodProblem(method: string): string | null {
  if (typeof method !== 'string' || !method) return 'an empty method name';
  if (method.length > ACP_EXTENSION_METHOD_MAX_CHARS) return `\`${method.slice(0, 40)}…\` is over ${ACP_EXTENSION_METHOD_MAX_CHARS} characters`;
  if (!METHOD_RE.test(method)) return `\`${method}\` is not a method name (letters, digits, \`_ $ . / -\`)`;
  if (RESERVED_METHODS.has(method) || RESERVED_PREFIXES.some((p) => method.startsWith(p))) {
    return `\`${method}\` belongs to the protocol itself, which the daemon answers`;
  }
  return null;
}

/* ── The cards, over `SessionHost.ask` ─────────────────────────────────── */

const NOBODY = 'nobody can answer a question in this session';

/** The labels the plan card offers. Kept as constants: the answer is read back by label (the webview translates them, cf. `askUserInput`). */
export { PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL };

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function idsProblem(questions: readonly AcpCardQuestion[]): string | null {
  const ids = new Set<string>();
  for (const [i, q] of questions.entries()) {
    if (typeof q?.id !== 'string' || !q.id) return `question ${i + 1}: no id`;
    if (ids.has(q.id)) return `question ${i + 1}: the same id as an earlier question`;
    ids.add(q.id);
    const optionIds = new Set<string>();
    for (const [j, o] of (q.options ?? []).entries()) {
      if (typeof o?.id !== 'string' || !o.id) return `question ${i + 1}, option ${j + 1}: no id`;
      if (optionIds.has(o.id)) return `question ${i + 1}, option ${j + 1}: the same id as another option`;
      optionIds.add(o.id);
    }
  }
  return null;
}

function toSession(q: AcpCardQuestion): SessionQuestion {
  return {
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.options?.length ? { options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
    ...(q.multiSelect ? { multiSelect: true } : {}),
    ...(q.placeholder ? { placeholder: q.placeholder } : {}),
  };
}

/** The question carrying a plan: its title, the plan, then its steps; clipped to what a card holds. */
function planQuestion(plan: AcpPlanApproval): string {
  const title = (typeof plan.title === 'string' && plan.title.trim()) || 'Plan';
  const steps = (plan.steps ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => `- ${s.trim()}`);
  const body = [title, typeof plan.plan === 'string' ? plan.plan.trim() : '', steps.join('\n')].filter(Boolean).join('\n\n');
  return clipText(body, SESSION_QUESTION_MAX_CHARS);
}

/**
 * The cards lent to a handler. `ask` is the host's (absent on a host nobody can
 * answer); `signal` is the agent's wait. Never rejects.
 */
export function acpExtensionCards(ask: SessionHost['ask'], signal: AbortSignal): AcpExtensionCards {
  const open = async (req: SessionAskRequest): Promise<SessionAskOutcome | 'cancelled'> => {
    if (signal.aborted) return 'cancelled';
    if (!ask) return { answered: false, reason: NOBODY };
    let outcome: SessionAskOutcome;
    try {
      outcome = await ask(req, { signal });
    } catch {
      outcome = { answered: false, reason: 'the question could not be asked' };
    }
    return signal.aborted ? 'cancelled' : outcome;
  };
  return {
    signal,
    async ask(questions, options) {
      const defect = idsProblem(questions) ?? askRequestProblem({ id: null, questions: questions.map(toSession) });
      if (defect) return { outcome: 'unanswered', reason: `the question cannot be shown: ${defect}` };
      const got = await open({ id: options?.id ?? null, questions: questions.map(toSession) });
      if (got === 'cancelled') return { outcome: 'cancelled' };
      if (!got.answered) return { outcome: 'unanswered', reason: got.reason };
      const value: Record<string, AcpCardAnswer> = {};
      for (const q of questions) {
        const answer = got.answers[q.question] ?? { picked: [], text: null };
        const selected = (q.options ?? []).filter((o) => answer.picked.includes(o.label)).map((o) => o.id);
        value[q.id] = { selected, text: answer.text };
      }
      return { outcome: 'answered', value };
    },
    async approvePlan(plan, options) {
      const question: SessionQuestion = {
        question: planQuestion(plan),
        header: PLAN_CARD_HEADER,
        options: [
          { label: PLAN_APPROVE_LABEL, description: PLAN_APPROVE_DESCRIPTION },
          { label: PLAN_REJECT_LABEL, description: PLAN_REJECT_DESCRIPTION },
        ],
      };
      const got = await open({ id: options?.id ?? null, questions: [question] });
      if (got === 'cancelled') return { outcome: 'cancelled' };
      if (!got.answered) return { outcome: 'unanswered', reason: got.reason };
      const answer = got.answers[question.question] ?? { picked: [], text: null };
      // A remark with no choice ticked is not an approval: the plan waits on the person's yes.
      return { outcome: 'answered', value: { approved: answer.picked.includes(PLAN_APPROVE_LABEL), note: answer.text } };
    },
  };
}
