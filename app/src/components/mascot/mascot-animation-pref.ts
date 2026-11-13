/**
 * "Animate mascots" (Settings → Appearance), on by default. Off, a mascot
 * still shows its state by its eyes, without moving — as under
 * `prefers-reduced-motion`. Stored per account in the daemon's layout scopes
 * (`/api/ui/layout?scope=mascot.animation`), read once per page.
 */
import { useSyncExternalStore } from 'react';
import { loadLayout, saveLayout, type LayoutIo } from '@/lib/ui-layout-store';

export const MASCOT_ANIMATION_SCOPE = 'mascot.animation';

/** What the scope holds; anything but an explicit `false` animates. */
export function readMascotAnimation(raw: unknown): boolean {
  return !(raw && typeof raw === 'object' && (raw as { animate?: unknown }).animate === false);
}

export type MascotAnimationPref = {
  subscribe(fn: () => void): () => void;
  get(): boolean;
  /** `false` when the daemon did not take it; the page keeps the choice anyway. */
  set(animate: boolean): Promise<boolean>;
};

export function createMascotAnimationPref(io: Pick<LayoutIo, 'fetchImpl'> = {}): MascotAnimationPref {
  const listeners = new Set<() => void>();
  let value = true;
  let requested = false;
  /** A choice made on this page wins over a read still in flight. */
  let chosen = false;
  const layoutIo: LayoutIo = { ...io, scope: MASCOT_ANIMATION_SCOPE, storage: null };
  const emit = () => { for (const fn of listeners) fn(); };
  const load = () => {
    if (requested) return;
    requested = true;
    void loadLayout(layoutIo).then((r) => {
      if (!r.ok || chosen) return;
      const next = readMascotAnimation(r.raw);
      if (next === value) return;
      value = next;
      emit();
    });
  };
  return {
    subscribe(fn) {
      listeners.add(fn);
      load();
      return () => { listeners.delete(fn); };
    },
    get: () => value,
    set(animate) {
      chosen = true;
      if (animate !== value) { value = animate; emit(); }
      return saveLayout({ animate }, layoutIo);
    },
  };
}

let shared: MascotAnimationPref | null = null;

export function mascotAnimationPref(): MascotAnimationPref {
  shared ??= createMascotAnimationPref();
  return shared;
}

const serverValue = (): boolean => true;

/** `true` while the user lets the mascots move. */
export function useMascotAnimation(pref: MascotAnimationPref = mascotAnimationPref()): boolean {
  return useSyncExternalStore(pref.subscribe, pref.get, serverValue);
}
