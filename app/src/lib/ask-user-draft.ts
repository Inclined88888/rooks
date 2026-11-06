/**
 * What the user had already ticked and typed in a `question` form, kept for the
 * length of the browser session. On an autonomous mission a form expires; the
 * agent then asks again, in a NEW card — and the choices of the old one were
 * lost (SUG-0014). A new card asking the same questions in the same mission
 * starts from that draft.
 */
import type { AskUserQuestion } from './ask-user-answers';
import { machineSessionStorage } from '@/lib/machines/machine-storage';

type Picks = Record<string, string | string[]>;
export type AskDraft = { picks: Picks; custom: Record<string, string> };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Same mission, same questions in the same order: the same draft. */
export function askDraftKey(missionId: string, questions: AskUserQuestion[]): string {
  return `timon.askDraft:${missionId}:${JSON.stringify(questions.map((q) => q.question))}`;
}

/** A draft holds something worth restoring: a tick or some text. */
function hasContent(draft: AskDraft): boolean {
  return Object.values(draft.picks).some((p) => (Array.isArray(p) ? p.length > 0 : p !== ''))
    || Object.values(draft.custom).some((text) => text.trim() !== '');
}

/**
 * The draft of these questions, reduced to what still fits them: an option
 * the new card no longer offers is dropped, not sent back to the agent.
 */
export function loadAskDraft(storage: DraftStorage | null, missionId: string | null, questions: AskUserQuestion[]): AskDraft | null {
  if (!storage || !missionId || questions.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(askDraftKey(missionId, questions)) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as { picks?: Record<string, unknown>; custom?: Record<string, unknown> };
  const draft: AskDraft = { picks: {}, custom: {} };
  for (const q of questions) {
    const labels = new Set((q.options ?? []).map((o) => o.label));
    const pick = stored.picks?.[q.question];
    if (q.multiSelect) {
      draft.picks[q.question] = Array.isArray(pick) ? pick.filter((l): l is string => typeof l === 'string' && labels.has(l)) : [];
    } else {
      draft.picks[q.question] = typeof pick === 'string' && labels.has(pick) ? pick : '';
    }
    const text = stored.custom?.[q.question];
    if (typeof text === 'string' && text !== '') draft.custom[q.question] = text;
  }
  return hasContent(draft) ? draft : null;
}

export function saveAskDraft(storage: DraftStorage | null, missionId: string | null, questions: AskUserQuestion[], draft: AskDraft): void {
  if (!storage || !missionId || questions.length === 0) return;
  const key = askDraftKey(missionId, questions);
  try {
    if (hasContent(draft)) storage.setItem(key, JSON.stringify(draft));
    else storage.removeItem(key);
  } catch {
    // A full or blocked storage costs the draft, never the form.
  }
}

export function clearAskDraft(storage: DraftStorage | null, missionId: string | null, questions: AskUserQuestion[]): void {
  if (!storage || !missionId || questions.length === 0) return;
  try { storage.removeItem(askDraftKey(missionId, questions)); } catch { /* same as above */ }
}

/** `sessionStorage` when the page has one (absent on the server, blocked in some private modes). */
export function sessionDraftStorage(): DraftStorage | null {
  try {
    return machineSessionStorage();
  } catch {
    return null;
  }
}
