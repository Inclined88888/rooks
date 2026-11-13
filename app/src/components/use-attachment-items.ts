'use client';

/**
 * The state behind an `AttachmentsField`, for any owner (TODO #837-E): the
 * stored files of an existing owner, read once; a file dropped on an
 * existing owner is sent at once; a file dropped before the owner exists is
 * held (`queued`) and sent by `sendQueued(id)` once it has an id.
 *
 * Every refusal is shown with the interface's own sentence
 * (`attachmentRefusalText`), never with the daemon's text. The bounds are
 * checked before the bytes travel; the daemon's answer stays the authority.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import {
  attachmentRefusalText, precheckTaskAttachment, type StoredAttachment, type TaskAttachmentRefusal,
} from '@/lib/task-attachments';
import type { AttachmentItem } from './attachments-field';

type Refused = { ok: false; refusal: TaskAttachmentRefusal };

/** The daemon calls of one owner kind, as a form's host hands them. */
export type AttachmentGestures<A extends StoredAttachment, Id> = {
  list: (ownerId: Id) => Promise<A[]>;
  upload: (ownerId: Id, file: File) => Promise<{ ok: true; attachment: A } | Refused>;
  remove: (attachment: A) => Promise<{ ok: true } | Refused>;
};

export type AttachmentItems<A extends StoredAttachment, Id> = {
  items: AttachmentItem<A>[];
  errors: string[];
  /** A file is being sent: a form waits for it before closing. */
  uploading: boolean;
  add: (files: File[]) => void;
  remove: (item: AttachmentItem<A>) => void;
  dismissErrors: () => void;
  /** Sends the held files to the owner just created; resolves with the names that failed. */
  sendQueued: (ownerId: Id) => Promise<string[]>;
};

function heldBy<A extends StoredAttachment>(items: readonly AttachmentItem<A>[]): { count: number; bytes: number } {
  let bytes = 0;
  for (const item of items) bytes += item.state === 'stored' ? item.attachment.size : item.file.size;
  return { count: items.length, bytes };
}

function revokePreview<A extends StoredAttachment>(item: AttachmentItem<A>): void {
  if (item.state !== 'stored' && item.preview) URL.revokeObjectURL(item.preview);
}

export function useAttachmentItems<A extends StoredAttachment, Id>(
  ownerId: Id | null,
  gestures: AttachmentGestures<A, Id>,
  owner: 'task' | 'todo',
): AttachmentItems<A, Id> {
  const [items, setItems] = useState<AttachmentItem<A>[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // A host may hand a new object on every render: the calls are read when made.
  const calls = useRef(gestures);
  calls.current = gestures;

  useEffect(() => {
    setItems([]);
    if (ownerId === null) return;
    let cancelled = false;
    calls.current.list(ownerId).then((list) => {
      if (cancelled) return;
      setItems(list.map((attachment) => ({ key: attachment.id, state: 'stored', attachment, inherited: false })));
    }).catch(() => { if (!cancelled) setErrors([t('taskForm.attachments.loadFailed')]); });
    return () => { cancelled = true; };
  }, [ownerId]);

  // Local previews of files not sent yet are released with the form.
  useEffect(() => () => { itemsRef.current.forEach(revokePreview); }, []);

  const add = useCallback((files: File[]) => {
    const refused: string[] = [];
    const accepted: AttachmentItem<A>[] = [];
    let held = heldBy(itemsRef.current);
    for (const file of files) {
      const refusal = precheckTaskAttachment(file, held);
      if (refusal) { refused.push(attachmentRefusalText(file.name, refusal, owner)); continue; }
      held = { count: held.count + 1, bytes: held.bytes + file.size };
      const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      accepted.push({ key: `local-${crypto.randomUUID()}`, state: ownerId === null ? 'queued' : 'uploading', file, preview });
    }
    setErrors(refused);
    if (accepted.length === 0) return;
    // Counted at once: a second drop before the first render still sees these.
    itemsRef.current = [...itemsRef.current, ...accepted];
    setItems((list) => [...list, ...accepted]);
    if (ownerId === null) return;
    for (const item of accepted) {
      if (item.state === 'stored') continue;
      void calls.current.upload(ownerId, item.file).then((r) => {
        revokePreview(item);
        if (r.ok) {
          setItems((list) => list.map((x) => (x.key === item.key ? { key: r.attachment.id, state: 'stored', attachment: r.attachment, inherited: false } : x)));
        } else {
          setItems((list) => list.filter((x) => x.key !== item.key));
          setErrors((list) => [...list, attachmentRefusalText(item.file.name, r.refusal, owner)]);
        }
      });
    }
  }, [ownerId, owner]);

  const remove = useCallback((item: AttachmentItem<A>) => {
    if (item.state !== 'stored') {
      revokePreview(item);
      setItems((list) => list.filter((x) => x.key !== item.key));
      return;
    }
    const name = item.attachment.name;
    void calls.current.remove(item.attachment).then((r) => {
      if (r.ok) setItems((list) => list.filter((x) => x.key !== item.key));
      else setErrors((list) => [...list, t('taskForm.attachments.removeRefused', { name })]);
    });
  }, []);

  const sendQueued = useCallback(async (id: Id): Promise<string[]> => {
    const failed: string[] = [];
    for (const item of itemsRef.current) {
      if (item.state !== 'queued') continue;
      const r = await calls.current.upload(id, item.file);
      if (!r.ok) failed.push(item.file.name);
    }
    return failed;
  }, []);

  return {
    items,
    errors,
    uploading: items.some((item) => item.state === 'uploading'),
    add,
    remove,
    dismissErrors: useCallback(() => setErrors([]), []),
    sendQueued,
  };
}
