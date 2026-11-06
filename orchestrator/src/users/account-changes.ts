/**
 * Changes of an account's status, told to whoever holds account data elsewhere
 * (the account provider plugin, through `ctx.accountProvider.onAccountChanged`).
 * Its tables live in its own database, with no foreign key towards `users`:
 * this is how it learns that an account was disabled or enabled again.
 */
import type { UserStatus } from '../db.js';

export type AccountChange = { userId: string; status: UserStatus; previous: UserStatus };

const listeners = new Set<(change: AccountChange) => void>();

export function onAccountChange(fn: (change: AccountChange) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A listener that throws never undoes the change nor stops the others. */
export function emitAccountChange(change: AccountChange): void {
  for (const fn of [...listeners]) {
    try { fn(change); } catch (err) { console.warn(`[accounts] a change listener failed: ${(err as Error).message}`); }
  }
}
