'use client';

import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { machineLocalStorage } from '@/lib/machines/machine-storage';

const PREFIX = 'timon.composer-draft.v1:';

/** One draft per conversation: the agent, plus the pinned mission when the
 *  host embeds the chat on a specific thread. */
export function draftKey(agentId: string, missionId?: string | null): string {
  return `${PREFIX}${agentId}${missionId ? `#${missionId}` : ''}`;
}

function storage(): Storage | null {
  try {
    return machineLocalStorage();
  } catch {
    return null;
  }
}

export function loadDraft(key: string): string {
  try {
    return storage()?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** An empty draft removes its entry: sending must leave nothing behind. */
export function saveDraft(key: string, text: string): void {
  const store = storage();
  if (!store) return;
  try {
    if (text === '') store.removeItem(key);
    else store.setItem(key, text);
  } catch {
    /* quota or disabled storage: the draft simply stays in memory */
  }
}

/**
 * Sets the composer's text. `store: false` shows a text without making it the
 * stored draft: a prompt recalled from the history is not what the person was
 * writing, and leaving the page on it used to replace their draft for good.
 */
export type ComposerDraftSetter = (value: SetStateAction<string>, opts?: { store?: boolean }) => void;

/**
 * The composer's text, kept across unmounts (page or window switch, reload).
 * Starts empty and hydrates in an effect so the server render and the first
 * client render agree; the write is synchronous so a draft typed right before
 * the page goes away is already stored.
 */
export function useComposerDraft(key: string): [string, ComposerDraftSetter] {
  const [text, setText] = useState('');
  const textRef = useRef('');
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
    textRef.current = loadDraft(key);
    setText(textRef.current);
  }, [key]);

  const setDraft = useCallback<ComposerDraftSetter>((value, opts) => {
    const next = typeof value === 'function' ? value(textRef.current) : value;
    textRef.current = next;
    setText(next);
    if (opts?.store !== false) saveDraft(keyRef.current, next);
  }, []);

  return [text, setDraft];
}
