'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { DEFAULT_APPEARANCE, type NativeAppearance } from '@/plugins-client/ui-theme-variants';
import { DEFAULT_USER_PREFS, type ColorScheme } from '@/lib/auth';
import { FIRST_RUN_DEFAULT_SCHEME, chosenFirstRunScheme, schemeFollowsSystem, storeFirstRunScheme } from '@/lib/first-run-gate';
import { sharedGet } from '@/lib/shared-read';
import { schemeOfMe } from '@/lib/machines/acting-account';
import { reportWindowScheme } from '@/lib/window-scheme';
import { osScheme, readSchemeMode, storeSchemeMode, type SchemeMode } from '@/lib/scheme-mode';

type SchemeContextValue = {
  scheme: ColorScheme;
  initialAppearance: NativeAppearance;
  /** The theme plugin the account expects (`prefs.theme`), as the server read it. */
  initialTheme: string | null;
  setScheme: (scheme: ColorScheme) => void;
  /** What the page paints: the account's scheme, or on the onboarding surfaces the one picked there, else the OS one. */
  applied: ColorScheme;
  /** The onboarding's switch: overrides the default dark until the account exists and takes it (`firstRunScheme`). */
  chooseFirstRunScheme: (scheme: ColorScheme) => void;
  /** Customize: light, dark, or follow the OS (local preference). */
  schemeMode: SchemeMode;
  setSchemeMode: (mode: SchemeMode) => void;
};

const SchemeContext = createContext<SchemeContextValue | null>(null);

export function useInitialAppearance(): NativeAppearance { return useContext(SchemeContext)?.initialAppearance ?? DEFAULT_APPEARANCE; }

/** The theme plugin the page expects to paint it, or `null` outside a `ThemeProvider` (nothing said). */
export function useInitialTheme(): string | null { return useContext(SchemeContext)?.initialTheme ?? null; }

/** The same, or `null` outside a `ThemeProvider` (a surface that can live without it). */
export function useOptionalColorScheme(): SchemeContextValue | null { return useContext(SchemeContext); }

export function useColorScheme(): SchemeContextValue {
  const ctx = useContext(SchemeContext);
  if (!ctx) throw new Error('useColorScheme used outside ThemeProvider');
  return ctx;
}

/**
 * Light/dark still uses next-themes (class on `<html>`). Account prefs store
 * light|dark. Customize can also choose "system", kept locally so the daemon
 * schema stays light|dark only.
 */
export function ThemeProvider({
  children,
  initialScheme = DEFAULT_USER_PREFS.scheme,
  initialAppearance = DEFAULT_APPEARANCE,
  initialTheme = null,
}: {
  children: ReactNode;
  initialScheme?: ColorScheme;
  initialAppearance?: NativeAppearance;
  initialTheme?: string | null;
}) {
  const pathname = usePathname();
  const revision = useRef(0);
  const [scheme, setSchemeState] = useState<ColorScheme>(initialScheme);
  const [chosen, setChosen] = useState<ColorScheme | null>(null);
  const [schemeMode, setSchemeModeState] = useState<SchemeMode>('dark');
  const [os, setOs] = useState<ColorScheme>('dark');

  useEffect(() => {
    setChosen(chosenFirstRunScheme());
    setSchemeModeState(readSchemeMode());
    setOs(osScheme());
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setOs(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const onboardingFollow = schemeFollowsSystem(pathname ?? '/');
  const followOs = schemeMode === 'system' && !onboardingFollow;
  const applied: ColorScheme = onboardingFollow
    ? (chosen ?? FIRST_RUN_DEFAULT_SCHEME)
    : followOs
      ? os
      : scheme;

  useEffect(() => {
    try {
      localStorage.removeItem('rooks-theme');
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const started = revision.current;
    void sharedGet('/api/ui/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled || started !== revision.current) return;
        const next = schemeOfMe(body);
        if (next) setSchemeState(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => { reportWindowScheme(applied); }, [applied]);

  const setScheme = useCallback((next: ColorScheme) => {
    revision.current += 1;
    setSchemeState(next);
    setSchemeModeState(next);
    storeSchemeMode(next);
  }, []);

  const setSchemeMode = useCallback((mode: SchemeMode) => {
    setSchemeModeState(mode);
    storeSchemeMode(mode);
    if (mode === 'light' || mode === 'dark') {
      revision.current += 1;
      setSchemeState(mode);
    }
  }, []);

  const chooseFirstRunScheme = useCallback((next: ColorScheme) => {
    storeFirstRunScheme(next);
    setChosen(next);
  }, []);

  return (
    <SchemeContext.Provider value={{
      scheme, setScheme, initialAppearance, initialTheme, applied, chooseFirstRunScheme, schemeMode, setSchemeMode,
    }}>
      <NextThemesProvider
        attribute="class"
        defaultTheme="dark"
        forcedTheme={followOs ? undefined : applied}
        enableSystem={followOs}
        themes={['light', 'dark']}
      >
        {children}
      </NextThemesProvider>
    </SchemeContext.Provider>
  );
}
