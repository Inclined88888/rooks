'use client';

/**
 * Attachments waiting for a conversation's next message, deposited from
 * outside the chat (TODO #468, shared with #168).
 *
 * The composer's own state (`pendingImages`, `pendingFiles`) lives in its
 * chat's React tree, and every chat has its own: the browser panel, a
 * plugin's drawer or an image annotator sit in another tree, sometimes in
 * another window, and cannot reach it. They drop what they captured here
 * instead, in the box of ONE conversation — the key is the composer draft's
 * (`draftKey(agent, mission)`), so a deposit never lands in another chat. The
 * composer shows the box next to its own attachments and empties it at the
 * next send: images join the turn's images, everything else becomes one text
 * block after what the user typed.
 *
 * Nothing here knows who deposits. A depositor that carries text it did not
 * write itself — a web page's content, a file's — formats it as untrusted
 * data before the deposit: this module sends the text as it receives it.
 *
 * The box is kept like the draft it goes with: per machine in localStorage,
 * so it survives a reload, and the `storage` event carries a deposit made in
 * another window. A box the storage refuses (quota) stays in memory.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { MAX_TURN_BYTES } from '@/lib/attachments';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload';
import { machineKey, machineLocalStorage } from '@/lib/machines/machine-storage';

const PREFIX = 'rooks.pending-attachments.v1:';

/** A box is not a backlog: past this, a deposit is refused. */
export const MAX_BOX_ITEMS = 20;
/** Per text attachment, in characters. */
export const MAX_TEXT_ATTACHMENT_CHARS = 200_000;
/** What fits a turn: the user's own attachments are budgeted at send. */
export const MAX_BOX_BYTES = MAX_TURN_BYTES;

/** The formats every backend takes inline. SVG is not one, and is script. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Common = {
  id: string;
  /** Short name shown on the chip. */
  label: string;
  /** Plugin (or surface) that deposited it, for display only. */
  source?: string;
  createdAt: number;
};

export type PendingAttachment =
  | (Common & { kind: 'image'; mediaType: string; base64: string; size: number })
  | (Common & { kind: 'text'; text: string; size: number });

export type AttachmentDeposit =
  | { kind: 'image'; label: string; source?: string; mediaType: string; base64: string }
  | { kind: 'text'; label: string; source?: string; text: string };

export type DepositRefusal = 'invalid' | 'too-large' | 'box-full';
export type DepositResult = { ok: true; id: string } | { ok: false; reason: DepositRefusal };

const EMPTY: readonly PendingAttachment[] = Object.freeze([]);

/** The box's content, by key. Arrays are replaced, never mutated: they are
 *  `useSyncExternalStore` snapshots. */
const boxes = new Map<string, readonly PendingAttachment[]>();
const listeners = new Map<string, Set<() => void>>();
let storageListening = false;

function storageKey(box: string): string {
  return `${PREFIX}${box}`;
}

function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isAttachment(value: unknown): value is PendingAttachment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.label !== 'string' || typeof v.createdAt !== 'number') return false;
  if (v.source !== undefined && typeof v.source !== 'string') return false;
  if (typeof v.size !== 'number') return false;
  if (v.kind === 'image') {
    return typeof v.mediaType === 'string' && IMAGE_TYPES.has(v.mediaType)
      && typeof v.base64 === 'string' && BASE64.test(v.base64);
  }
  return v.kind === 'text' && typeof v.text === 'string';
}

/** Whatever another tab wrote is read as data: a malformed entry is dropped. */
function parse(raw: string | null): readonly PendingAttachment[] {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    const items = parsed.filter(isAttachment).slice(0, MAX_BOX_ITEMS);
    return items.length ? items : EMPTY;
  } catch {
    return EMPTY;
  }
}

function notify(box: string): void {
  for (const listener of listeners.get(box) ?? []) listener();
}

/** Another window deposited or sent: its write is the new truth here. */
function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    // `clear()`: every box is gone.
    for (const box of [...boxes.keys()]) {
      boxes.set(box, EMPTY);
      notify(box);
    }
    return;
  }
  for (const box of boxes.keys()) {
    if (event.key !== machineKey(storageKey(box))) continue;
    boxes.set(box, parse(event.newValue));
    notify(box);
  }
}

function listenToStorage(): void {
  if (storageListening || typeof window === 'undefined') return;
  storageListening = true;
  window.addEventListener('storage', onStorage);
}

function read(box: string): readonly PendingAttachment[] {
  const known = boxes.get(box);
  if (known) return known;
  let items = EMPTY;
  try {
    items = parse(machineLocalStorage()?.getItem(storageKey(box)) ?? null);
  } catch {
    /* blocked storage: the box starts empty */
  }
  boxes.set(box, items);
  listenToStorage();
  return items;
}

function write(box: string, items: readonly PendingAttachment[]): void {
  boxes.set(box, items.length ? items : EMPTY);
  try {
    const store = machineLocalStorage();
    if (store) {
      if (items.length === 0) store.removeItem(storageKey(box));
      else store.setItem(storageKey(box), JSON.stringify(items));
    }
  } catch {
    /* quota: the box stays in memory until the next send or reload */
  }
  notify(box);
}

function totalBytes(items: readonly PendingAttachment[]): number {
  return items.reduce((sum, item) => sum + item.size, 0);
}

/** Drops an attachment in a conversation's box (`draftKey(agent, mission)`). */
export function depositAttachment(box: string, deposit: AttachmentDeposit): DepositResult {
  const label = deposit.label.trim().slice(0, 120);
  if (!box || !label) return { ok: false, reason: 'invalid' };
  const source = deposit.source?.slice(0, 120);
  let item: PendingAttachment;
  const common = { id: crypto.randomUUID(), label, createdAt: Date.now(), ...(source ? { source } : {}) };
  if (deposit.kind === 'image') {
    if (!IMAGE_TYPES.has(deposit.mediaType) || !deposit.base64 || !BASE64.test(deposit.base64)) {
      return { ok: false, reason: 'invalid' };
    }
    const size = base64Bytes(deposit.base64);
    if (size > MAX_IMAGE_UPLOAD_BYTES) return { ok: false, reason: 'too-large' };
    item = { ...common, kind: 'image', mediaType: deposit.mediaType, base64: deposit.base64, size };
  } else {
    if (!deposit.text.trim()) return { ok: false, reason: 'invalid' };
    if (deposit.text.length > MAX_TEXT_ATTACHMENT_CHARS) return { ok: false, reason: 'too-large' };
    item = { ...common, kind: 'text', text: deposit.text, size: textBytes(deposit.text) };
  }
  const items = read(box);
  if (items.length >= MAX_BOX_ITEMS) return { ok: false, reason: 'box-full' };
  if (totalBytes(items) + item.size > MAX_BOX_BYTES) return { ok: false, reason: 'too-large' };
  write(box, [...items, item]);
  return { ok: true, id: item.id };
}

/** What waits in a box, oldest first. */
export function listPendingAttachments(box: string): readonly PendingAttachment[] {
  return box ? read(box) : EMPTY;
}

/** Takes attachments out of a box. Without ids, empties it. */
export function removePendingAttachments(box: string, ids?: readonly string[]): void {
  if (!box) return;
  const items = read(box);
  if (items.length === 0) return;
  const gone = ids ? new Set(ids) : null;
  const kept = gone ? items.filter((item) => !gone.has(item.id)) : EMPTY;
  if (kept.length !== items.length) write(box, kept);
}

export function subscribePendingAttachments(box: string, listener: () => void): () => void {
  read(box);
  let set = listeners.get(box);
  if (!set) {
    set = new Set();
    listeners.set(box, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(box);
  };
}

const noop = () => {};

/** The box of one conversation, live; `null` reads as empty. */
export function usePendingAttachments(box: string | null): readonly PendingAttachment[] {
  const subscribe = useCallback(
    (listener: () => void) => (box ? subscribePendingAttachments(box, listener) : noop),
    [box],
  );
  const snapshot = useCallback(() => (box ? read(box) : EMPTY), [box]);
  // The server has no storage: it renders the box empty, and so does the
  // hydration pass, before the stored box shows.
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/** Preview URL of an image attachment: inline, nothing to revoke. */
export function attachmentPreviewUrl(item: PendingAttachment & { kind: 'image' }): string {
  return `data:${item.mediaType};base64,${item.base64}`;
}

/**
 * The turn a box adds to: its images, and its text appended to the user's
 * own words, one paragraph per attachment.
 */
export function attachmentsForTurn(
  typed: string,
  items: readonly PendingAttachment[],
): { text: string; textBytes: number; images: Array<PendingAttachment & { kind: 'image' }> } {
  const images = items.filter((item): item is PendingAttachment & { kind: 'image' } => item.kind === 'image');
  const texts = items.filter((item): item is PendingAttachment & { kind: 'text' } => item.kind === 'text');
  const text = [typed, ...texts.map((item) => item.text.trim())].filter((part) => part !== '').join('\n\n');
  // Counted against the turn budget: the daemon's body cap does not care
  // whether the bytes came as a file or as text.
  return { text, textBytes: totalBytes(texts), images };
}

/** Test seam: forget every box held in memory (storage is left alone). */
export function resetPendingAttachmentsForTests(): void {
  boxes.clear();
  listeners.clear();
  if (storageListening && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  storageListening = false;
}
