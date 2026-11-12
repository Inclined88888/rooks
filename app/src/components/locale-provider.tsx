'use client';

import { lazy, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { DEFAULT_LOCALE, isLocaleLoaded, loadLocale, setLocale, type Locale } from '@/lib/i18n';

type ScopeProps = { locale: Locale; children: ReactNode };

/**
 * Set during render, not in an effect: every `t()` below must read the
 * language on its FIRST render, the one that hydrates the server's HTML. On
 * the server this also resets the shared module to the language of the
 * request being rendered.
 */
function LocaleScope({ locale, children }: ScopeProps): ReactElement {
  setLocale(isLocaleLoaded(locale) ? locale : DEFAULT_LOCALE);
  return <>{children}</>;
}

const GATES = new Map<Locale, ComponentType<ScopeProps>>();

/**
 * `React.lazy` around the dictionary's chunk: a tree that hydrates before the
 * chunk arrives keeps the server's HTML (already in the right language) under
 * the nearest Suspense boundary, then hydrates in that language. A chunk that
 * fails to load leaves the interface in English rather than an error screen.
 */
function gateFor(locale: Locale): ComponentType<ScopeProps> {
  let gate = GATES.get(locale);
  if (!gate) {
    gate = lazy(async () => {
      await loadLocale(locale).catch(() => undefined);
      return { default: LocaleScope };
    });
    GATES.set(locale, gate);
  }
  return gate;
}

/** The interface language resolved for this request (`locale-server.ts`). Under a Suspense boundary. */
export function LocaleProvider({ locale, children }: ScopeProps): ReactElement {
  if (isLocaleLoaded(locale)) return <LocaleScope locale={locale}>{children}</LocaleScope>;
  const Gate = gateFor(locale);
  return <Gate locale={locale}>{children}</Gate>;
}
