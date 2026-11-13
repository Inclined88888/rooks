'use client';

/**
 * Settings is a dialog over whatever page is on screen, addressed by the
 * `?settings=<category>[/<tab>]` query parameter. The page underneath keeps
 * its own parameters (a chat's `?mission=`…), which is why every move starts
 * from the live URL instead of rebuilding one from the pathname.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { formatSettingsParam, type SettingsAccountView, type SettingsTarget } from './settings-layout';

export const SETTINGS_PARAM = 'settings';

const DEFAULT_TARGET: SettingsTarget = { category: 'interface', tab: null };

function currentUrl(): URL {
  return new URL(window.location.href);
}

function relative(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Href of the page on screen with the dialog opened on `target`. */
export function settingsHref(target: SettingsTarget = DEFAULT_TARGET): string {
  const url = currentUrl();
  url.searchParams.set(SETTINGS_PARAM, formatSettingsParam(target));
  return relative(url);
}

/**
 * Opens the dialog on `target` from where no router is at hand (a toast, a
 * surface rendered outside the app router): Next keeps `useSearchParams` in
 * step with `history.pushState`, which is what the dialog reads.
 */
export function openSettingsFromAnywhere(target: SettingsTarget = DEFAULT_TARGET): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(window.history.state, '', settingsHref(target));
}

export function useSettingsNavigation(): {
  open: (target?: SettingsTarget) => void;
  select: (target: SettingsTarget) => void;
  selectAccount: (view: SettingsAccountView) => void;
  close: () => void;
} {
  const router = useRouter();
  // Opening pushes, so Back closes the dialog; switching tabs replaces, so
  // Back does not replay every tab visited.
  const open = useCallback((target: SettingsTarget = DEFAULT_TARGET) => {
    router.push(settingsHref(target), { scroll: false });
  }, [router]);
  const select = useCallback((target: SettingsTarget) => {
    router.replace(settingsHref(target), { scroll: false });
  }, [router]);
  const selectAccount = useCallback((view: SettingsAccountView) => {
    const url = currentUrl();
    url.searchParams.set(SETTINGS_PARAM, view);
    router.replace(relative(url), { scroll: false });
  }, [router]);
  const close = useCallback(() => {
    const url = currentUrl();
    url.searchParams.delete(SETTINGS_PARAM);
    router.replace(relative(url), { scroll: false });
  }, [router]);
  return { open, select, selectAccount, close };
}
