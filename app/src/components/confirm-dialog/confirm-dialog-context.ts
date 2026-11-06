'use client';

/**
 * The app's "Are you sure?" (TODO #781): `confirmAction()` asks it from
 * anywhere — a click handler, a helper outside any component (a Git checkout,
 * an agent stop) — and resolves `true` only on the user's explicit yes.
 *
 * Why not the browser's `confirm()`: it freezes the page, names the site
 * rather than Timon, cannot be themed, and a browser told to stop showing
 * dialogs answers it "no" without asking anyone.
 *
 * Hence a module-level queue and one host for the whole app, mounted beside
 * the toaster (`app/layout.tsx`, `ConfirmDialogHost`). The host paints the
 * `confirm.dialog` slot: the product's dialog (`fallback`, client half of
 * `@timon/settings`) unless a plugin took it. The slot passes no props — an
 * entry is registered once and painted for every question — so the host puts
 * the open question here and the occupant reads it with `useConfirmDialog()`.
 */

import { createContext, useContext } from 'react';

/** What a caller asks. A bare string is the title. */
export type ConfirmRequest = {
  /** The question itself, short: "Delete the secret GITHUB_TOKEN?". */
  title: string;
  /** What the answer changes, when the title alone does not say it. */
  description?: string;
  /** Label of the yes button; "Confirm" by default. */
  confirmLabel?: string;
  /** Label of the no button; "Cancel" by default. */
  cancelLabel?: string;
  /** The yes destroys or stops something: painted as a danger, and Enter does not reach it. */
  destructive?: boolean;
};

/** The open question, as the occupant of `confirm.dialog` paints it. */
export type ConfirmDialogValue = {
  title: string;
  /** `null` when the caller gave none. */
  description: string | null;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  /** Answers yes and closes. */
  confirm: () => void;
  /** Answers no and closes (Escape and a click outside do the same, through the host). */
  cancel: () => void;
};

export type ConfirmQuestion = {
  id: number;
  request: ConfirmRequest;
  /** Settles the caller once; later calls do nothing. */
  answer: (yes: boolean) => void;
};

let queue: readonly ConfirmQuestion[] = [];
let hosts = 0;
let nextId = 0;
let testAnswer: ((request: ConfirmRequest) => boolean) | null = null;
const listeners = new Set<() => void>();

function publish(next: readonly ConfirmQuestion[]): void {
  queue = next;
  for (const listener of listeners) listener();
}

export function subscribeConfirmQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The question the host shows now; the others wait their turn. */
export function currentConfirmQuestion(): ConfirmQuestion | undefined {
  return queue[0];
}

/**
 * Called by the host while it is mounted. When the last host goes, every
 * waiting question is answered no: a caller is never left hanging.
 */
export function registerConfirmHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    if (hosts === 0) for (const question of queue) question.answer(false);
  };
}

/**
 * Asks the user to confirm. Resolves `true` on an explicit yes, `false` on
 * no, Escape or a click outside. Questions asked while one is open wait in
 * line, in order. Without a host on the page, nothing is asked and the answer
 * is `false`: a destructive action is never taken without the user's word.
 */
export function confirmAction(request: ConfirmRequest | string): Promise<boolean> {
  const asked: ConfirmRequest = typeof request === 'string' ? { title: request } : request;
  if (testAnswer) return Promise.resolve(testAnswer(asked));
  if (hosts === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const question: ConfirmQuestion = {
      id: nextId += 1,
      request: asked,
      answer: (yes) => {
        if (settled) return;
        settled = true;
        publish(queue.filter((x) => x !== question));
        resolve(yes);
      },
    };
    publish([...queue, question]);
  });
}

/**
 * Tests answer every question with `answer` instead of a dialog; `null`
 * gives the host back. Also clears the queue.
 */
export function answerConfirmsForTests(answer: ((request: ConfirmRequest) => boolean) | null): void {
  testAnswer = answer;
  publish([]);
}

const ConfirmDialogContext = createContext<ConfirmDialogValue | null>(null);

export const ConfirmDialogProvider = ConfirmDialogContext.Provider;

/** Readable by a plugin that takes the `confirm.dialog` slot; `null` outside the host. */
export function useConfirmDialog(): ConfirmDialogValue | null {
  return useContext(ConfirmDialogContext);
}
