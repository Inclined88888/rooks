'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { machineLocalStorage } from '@/lib/machines/machine-storage';

/**
 * The prompts already sent to an agent, recalled with ↑ / ↓ like a shell
 * history (SUG-0021).
 *
 * Kept in this browser only: nothing is sent to the daemon for it. A hook
 * rather than code inside the product's composer, because the composer is the
 * occupant of a replaceable slot (`chat.composer`) — a composer that takes its
 * place reuses the same history through `@rooks/ui`.
 */

const PREFIX = 'rooks.prompt-history.v1:';

/** Enough to scroll back through a working session, small enough to stay a
 *  few kilobytes per agent in `localStorage`. */
export const PROMPT_HISTORY_MAX = 50;

export type PromptHistoryDirection = 'older' | 'newer';

export function promptHistoryKey(agentId: string): string {
  return `${PREFIX}${agentId}`;
}

function storage(): Storage | null {
  try {
    return machineLocalStorage();
  } catch {
    return null;
  }
}

/** Newest first. Anything unreadable counts as an empty history. */
export function loadPromptHistory(key: string): string[] {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The list once `text` is sent: trimmed like the turn itself, a blank prompt
 * ignored, the same prompt sent twice in a row kept once, the oldest dropped
 * past the bound.
 */
export function pushPromptEntry(list: readonly string[], text: string, max = PROMPT_HISTORY_MAX): string[] {
  const entry = text.trim();
  if (!entry) return [...list];
  if (list[0] === entry) return [...list];
  return [entry, ...list].slice(0, max);
}

/**
 * Whether an arrow key belongs to the history rather than to the caret.
 *
 * A selection, or a caret in the middle of a multi-line text, keeps the
 * native movement: ↑ only recalls from the start of the text, ↓ only from its
 * end — a text on one line counts as both. `wrapped` says the field shows the
 * text on several lines without a line break in it: a long paragraph wrapped
 * by the box is multi-line to the person editing it.
 */
export function canRecallPrompt(
  direction: PromptHistoryDirection,
  value: string,
  selectionStart: number,
  selectionEnd: number,
  wrapped = false,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  if (!wrapped && !value.includes('\n')) return true;
  return direction === 'older' ? selectionStart === 0 : selectionStart === value.length;
}

/**
 * Whether a field shows more than one line of text, line breaks or not. The
 * caller of `canRecallPrompt` cannot see the wrapping in the string alone.
 */
export function isTextareaWrapped(el: HTMLTextAreaElement): boolean {
  const style = window.getComputedStyle(el);
  const line = parseFloat(style.lineHeight);
  if (!Number.isFinite(line) || line <= 0) return false;
  const content = el.scrollHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
  return content > line * 1.5;
}

export type PromptHistory = {
  /** Stores a sent prompt and leaves the browsing. */
  record: (text: string) => void;
  /** The text to show for one step, or `null` when there is nowhere to go
   *  (the key is then left to the browser). Going past the newest entry
   *  gives back the draft that was in the field when browsing started. */
  step: (direction: PromptHistoryDirection, current: string) => string | null;
  /** Leaves the browsing: what is in the field becomes the draft again. */
  reset: () => void;
};

/**
 * One history per agent (`key` = the agent's id; `null` = no conversation,
 * the hook then does nothing).
 */
export function usePromptHistory(key: string | null): PromptHistory {
  const storageKey = key ? promptHistoryKey(key) : null;
  const keyRef = useRef(storageKey);
  /** -1 = on the draft; otherwise the index of the entry shown. */
  const index = useRef(-1);
  const draft = useRef('');
  /** The list as read when browsing started. Read then, not at mount: two
   *  multichat cells on the same agent each record into storage, and a copy
   *  taken at mount would miss what the other one sent. */
  const entries = useRef<string[]>([]);

  const reset = useCallback(() => {
    index.current = -1;
    draft.current = '';
    entries.current = [];
  }, []);

  useEffect(() => {
    keyRef.current = storageKey;
    reset();
  }, [storageKey, reset]);

  const record = useCallback((text: string) => {
    const k = keyRef.current;
    reset();
    if (!k) return;
    const store = storage();
    if (!store) return;
    const before = loadPromptHistory(k);
    const next = pushPromptEntry(before, text);
    if (next.length === before.length && next[0] === before[0]) return;
    try {
      store.setItem(k, JSON.stringify(next));
    } catch {
      /* quota or disabled storage: the prompt is simply not remembered */
    }
  }, [reset]);

  const step = useCallback((direction: PromptHistoryDirection, current: string): string | null => {
    const k = keyRef.current;
    if (!k) return null;
    if (direction === 'older') {
      if (index.current === -1) entries.current = loadPromptHistory(k);
      const next = index.current + 1;
      if (next >= entries.current.length) return null;
      if (index.current === -1) draft.current = current;
      index.current = next;
      return entries.current[next]!;
    }
    if (index.current === -1) return null;
    index.current -= 1;
    if (index.current === -1) {
      const back = draft.current;
      reset();
      return back;
    }
    return entries.current[index.current]!;
  }, [reset]);

  return useMemo(() => ({ record, step, reset }), [record, step, reset]);
}
