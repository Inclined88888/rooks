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
import { storeFirstRunScheme } from '@/lib/first-run-gate';
import { appliedScheme, readSchemeMode, type SchemeMode } from '@/lib/scheme-mode';
import { sharedGet } from '@/lib/shared-read';
import { schemeOfMe } from '@/lib/machines/acting-account';
import { reportWindowScheme } from '@/lib/window-scheme';

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
 * Light/dark still uses next-themes (class on `<html>`). The chosen
 * scheme travels with the account (`prefs.scheme`), not `localStorage` —
 * the account of the ACTIVE machine (`schemeOfMe`): it is stored where the
 * primary colour is, so each machine keeps its own mode.
 * `forcedTheme` is what stops next-themes from reading a storage key.
 *
 * One exception: the onboarding surfaces (`schemeFollowsSystem`) are shown
 * before any preference exists. They open dark for everyone, whatever the OS;
 * the onboarding's switch picks the other (`chooseFirstRunScheme`), and the
 * account takes that choice when it is created.
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
  const [mode, setMode] = useState<SchemeMode>('light');
  useEffect(() => { setMode(readSchemeMode()); }, [pathname]);
  useEffect(() => {
    const sync = () => setMode(readSchemeMode());
    window.addEventListener('rooks-scheme-mode', sync);
    return () => window.removeEventListener('rooks-scheme-mode', sync);
  }, []);
  const applied = appliedScheme(mode);

  useEffect(() => {
    try {
      localStorage.removeItem('timon-theme');
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

  // The chosen mode, not the OS one onboarding follows: what the shell
  // remembers for this machine's next window.
  useEffect(() => { reportWindowScheme(scheme); }, [scheme]);

  const setScheme = useCallback((next: ColorScheme) => {
    revision.current += 1;
    setSchemeState(next);
  }, []);

  const chooseFirstRunScheme = useCallback((next: ColorScheme) => {
    storeFirstRunScheme(next);
    setSchemeState(next);
  }, []);

  return (
    <SchemeContext.Provider value={{ scheme, setScheme, initialAppearance, initialTheme, applied, chooseFirstRunScheme }}>
      <NextThemesProvider
        attribute="class"
        defaultTheme="dark"
        forcedTheme={applied}
        enableSystem={false}
        themes={['light', 'dark']}
      >
        {children}
      </NextThemesProvider>
    </SchemeContext.Provider>
  );
}
