'use client';

/**
 * Settings › Interface › Language. The choice is a cookie the server reads to
 * render the next page in it (`lib/locale-server.ts`), so a change reloads
 * the page: every string already on screen was rendered in the old language.
 *
 * The list is the catalog the locale build discovered (docs/I18N.md): "System
 * language", then every language present, each in its own name — someone
 * lost in a language they do not read finds theirs.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { availableLocales, t, type Locale } from '@/lib/i18n';
import {
  localeCookie, negotiateLocale, readLocaleChoice, resolveLocale, selectableLocales, type LocaleChoice,
} from '@/lib/locale-preference';

export function LanguageSettings(): ReactElement {
  const [choice, setChoice] = useState<LocaleChoice | null>(null);
  const [system, setSystem] = useState<Locale>('en');
  const languages = selectableLocales(availableLocales());

  useEffect(() => {
    const stored = readLocaleChoice(document.cookie);
    // A cookie may hold a tag that resolves to another one (`pt` → `pt-BR`): show the one in use.
    setChoice(stored === 'auto' ? 'auto' : resolveLocale(stored, null));
    setSystem(negotiateLocale(navigator.languages.length > 0 ? navigator.languages : navigator.language));
  }, []);

  const apply = (next: LocaleChoice): void => {
    if (next === choice) return;
    document.cookie = localeCookie(next);
    setChoice(next);
    window.location.reload();
  };

  const systemName = languages.find((info) => info.tag === system)?.name ?? system;

  return (
    <section className="max-w-2xl space-y-1.5">
      <p id="interface-language-label" className="text-[13px] font-medium">{t('languageSettings.label')}</p>
      {choice !== null && (
        <Select value={choice} onValueChange={(value) => apply(value)}>
          <SelectTrigger aria-labelledby="interface-language-label" className="min-w-60 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('languageSettings.auto', { language: systemName })}</SelectItem>
            {languages.map((info) => (
              <SelectItem key={info.tag} value={info.tag}>
                <span lang={info.tag} dir={info.dir}>{info.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('languageSettings.hint')}</p>
    </section>
  );
}
