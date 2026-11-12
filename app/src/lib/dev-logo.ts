'use client';

/**
 * The development copy's "product logo" switch: the maintainer takes screenshots in
 * the development window, and its amber mark and DEV pill must not show on
 * them. Kept per browser (localStorage), read by `BrandLogo` and
 * `InstanceBadge` only when the instance is the development one: the product
 * never reads it, so a stray value cannot change a customer's window.
 */
import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'rooks.dev.productLogo';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another window of the same instance flipped it.
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) onChange(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function setDevProductLogo(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage refused (private mode): the switch simply does not stick.
  }
  for (const listener of listeners) listener();
}

/** Whether the development copy shows the product's logo; always `false` on the server. */
export function useDevProductLogo(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => setDevProductLogo(next), []);
  return [on, set];
}
