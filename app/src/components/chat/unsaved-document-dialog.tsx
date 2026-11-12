'use client';

/**
 * The question asked before a document with unsaved changes closes
 * (TIM-0128): Save, Don't save, Cancel.
 *
 * It is asked from the island workspace's `beforeClose`, outside any
 * component: the tab being closed may be an inactive one, unmounted. Hence a
 * module-level queue and one host for the whole app, mounted beside the
 * toaster (`app/layout.tsx`).
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

export type UnsavedChoice = 'saved' | 'discarded' | 'cancelled';

type Question = {
  id: number;
  /** What the dialog names: the file, the skill. */
  name: string;
  /** Writes the document; `false` when it failed (the source says why in a toast). */
  save: () => Promise<boolean>;
  answer: (choice: UnsavedChoice) => void;
};

let queue: readonly Question[] = [];
let hosts = 0;
let nextId = 0;
const listeners = new Set<() => void>();

function publish(next: readonly Question[]): void {
  queue = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Asks whether to save `name` before it closes. `saved` once the save
 * succeeded, `discarded` when the user gives the changes up, `cancelled` when
 * the document must stay open. Without a host to ask, the document stays open:
 * no change is ever dropped without the user's word.
 */
export function askToSaveDocument(name: string, save: () => Promise<boolean>): Promise<UnsavedChoice> {
  if (hosts === 0) return Promise.resolve('cancelled');
  return new Promise((resolve) => {
    const question: Question = {
      id: nextId += 1,
      name,
      save,
      answer: (choice) => {
        publish(queue.filter((x) => x !== question));
        resolve(choice);
      },
    };
    publish([...queue, question]);
  });
}

export function UnsavedDocumentDialog(): ReactElement | null {
  const current = useSyncExternalStore(subscribe, () => queue[0], () => undefined);
  useEffect(() => {
    hosts += 1;
    return () => { hosts -= 1; };
  }, []);
  if (!current) return null;
  return <UnsavedQuestion key={current.id} question={current} />;
}

function UnsavedQuestion({ question }: { question: Question }): ReactElement {
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    let ok = false;
    try {
      ok = await question.save();
    } catch {
      ok = false;
    }
    // A failed save keeps the question: the user still chooses between
    // trying again, giving the changes up, or keeping the document open.
    if (ok) question.answer('saved');
    else setSaving(false);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) question.answer('cancelled'); }}>
      <DialogContent
        role="alertdialog"
        hideClose
        data-unsaved-document=""
        className="max-w-md"
        // Enter on the first button must not throw the changes away.
        onOpenAutoFocus={(e) => { e.preventDefault(); saveButton.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{t('islands.unsaved.title', { name: question.name })}</DialogTitle>
          <DialogDescription>{t('islands.unsaved.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="ghost" data-unsaved-choice="discard" disabled={saving} onClick={() => question.answer('discarded')}>
            {t('islands.unsaved.discard')}
          </Button>
          <Button variant="outline" data-unsaved-choice="cancel" disabled={saving} onClick={() => question.answer('cancelled')}>
            {t('islands.unsaved.cancel')}
          </Button>
          <Button ref={saveButton} data-unsaved-choice="save" disabled={saving} onClick={() => void save()}>
            {saving ? t('islands.unsaved.saving') : t('islands.unsaved.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
