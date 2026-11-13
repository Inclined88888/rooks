/**
 * Dates, times, numbers, sizes, relative times and lists in the interface
 * language. The one place of `app/src/` that builds `Intl` formatters: every
 * other module goes through these functions, so a language added as a folder
 * of `src/locales/` formats its dates and numbers without a line of code
 * (`intl-guard.test.ts` refuses a `toLocale*String`, a `new Intl.` or a
 * `'fr' ? 'fr-FR'` branch anywhere else). Contract: docs/I18N.md.
 *
 * The language is the active tag (`getLocale()`) unless a caller passes one:
 * the server renders with the tag of the request, and the tests pin theirs.
 * `fr` formats like `fr-FR` and `en` like `en-US`, so the tags the catalog
 * holds go to `Intl` as they are. Time zone: the system's, unless the options
 * name one.
 */
import { getLocale, type Locale } from './i18n';

/** A tag `Intl` refuses (forged cookie, typo) must not throw in a render. */
const supported = new Map<string, string>();

/** The tag handed to `Intl`: the one given, else the interface language. */
export function intlLocale(locale?: Locale): string {
  const tag = locale ?? getLocale();
  let resolved = supported.get(tag);
  if (resolved === undefined) {
    try {
      resolved = Intl.getCanonicalLocales(tag)[0] ?? 'en';
    } catch {
      resolved = 'en';
    }
    supported.set(tag, resolved);
  }
  return resolved;
}

// Formatters are costly to build and these functions run in list renders:
// one instance per (kind, language, options).
const cache = new Map<string, unknown>();

function cached<T>(kind: string, locale: string, options: object | undefined, build: () => T): T {
  const key = `${kind}|${locale}|${options ? JSON.stringify(options) : ''}`;
  let value = cache.get(key) as T | undefined;
  if (value === undefined) {
    value = build();
    cache.set(key, value);
  }
  return value;
}

export function dateTimeFormat(options?: Intl.DateTimeFormatOptions, locale?: Locale): Intl.DateTimeFormat {
  const tag = intlLocale(locale);
  return cached('dt', tag, options, () => new Intl.DateTimeFormat(tag, options));
}

export function numberFormat(options?: Intl.NumberFormatOptions, locale?: Locale): Intl.NumberFormat {
  const tag = intlLocale(locale);
  return cached('nf', tag, options, () => new Intl.NumberFormat(tag, options));
}

function relativeTimeFormat(options: Intl.RelativeTimeFormatOptions, locale?: Locale): Intl.RelativeTimeFormat {
  const tag = intlLocale(locale);
  return cached('rt', tag, options, () => new Intl.RelativeTimeFormat(tag, options));
}

function collator(locale?: Locale): Intl.Collator {
  const tag = intlLocale(locale);
  return cached('co', tag, undefined, () => new Intl.Collator(tag));
}

/** The system's IANA time zone (`Europe/Paris`), `UTC` when the runtime has none. */
export function systemTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** True when `Intl` knows the IANA zone `tz`. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    dateTimeFormat({ timeZone: tz }, 'en');
    return true;
  } catch {
    return false;
  }
}

/**
 * The tag with its likely region (`fr` → `fr-FR`, `ja` → `ja-JP`): Web Speech
 * and some engines want a region, the catalog stores a language.
 */
export function regionalTag(locale?: Locale): string {
  const tag = intlLocale(locale);
  try {
    const full = new Intl.Locale(tag);
    if (full.region) return tag;
    const region = full.maximize().region;
    return region ? `${full.language}-${region}` : tag;
  } catch {
    return tag;
  }
}

export type DateInput = Date | number | string;

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type DateStyle = 'short' | 'medium' | 'long' | 'full';

function dateOptions(style: DateStyle | Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return typeof style === 'string' ? { dateStyle: style } : style;
}

/** A calendar date (`4 nov. 2026` in French, "Nov 4, 2026"); '' for an unreadable value. */
export function formatDate(value: DateInput, style: DateStyle | Intl.DateTimeFormatOptions = 'medium', locale?: Locale): string {
  const date = toDate(value);
  return date ? dateTimeFormat(dateOptions(style), locale).format(date) : '';
}

/** A time of day; two-digit hour and minute by default (`14:05` in French, "02:05 PM"). */
export function formatTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
  locale?: Locale,
): string {
  const date = toDate(value);
  return date ? dateTimeFormat(options, locale).format(date) : '';
}

/**
 * A date and its time. With no options, what `toLocaleString()` printed
 * (numeric date, time with seconds), now in the interface language rather
 * than the browser's.
 */
export function formatDateTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  },
  locale?: Locale,
): string {
  const date = toDate(value);
  return date ? dateTimeFormat(options, locale).format(date) : '';
}

/** A number with the language's separators (`1 234,5` in French, "1,234.5"). */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions, locale?: Locale): string {
  return numberFormat(options, locale).format(n);
}

/** A ratio as a percentage: 0.42 → `42 %` in French, "42%". */
export function formatPercent(ratio: number, options?: Intl.NumberFormatOptions, locale?: Locale): string {
  return numberFormat({ style: 'percent', maximumFractionDigits: 0, ...options }, locale).format(ratio);
}

/**
 * A byte count in decimal units and the language's own unit words ("1.2 MB",
 * `1,2 Mo` in French), like the size a browser shows for a download.
 */
export function formatBytes(bytes: number, locale?: Locale): string {
  const [value, unit] = bytes < 1000
    ? [bytes, 'byte']
    : bytes < 1_000_000
      ? [bytes / 1000, 'kilobyte']
      : bytes < 1_000_000_000
        ? [bytes / 1_000_000, 'megabyte']
        : [bytes / 1_000_000_000, 'gigabyte'];
  return numberFormat(
    { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: value < 10 ? 1 : 0 },
    locale,
  ).format(value);
}

type AgeUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** The largest unit that fits, counted down (`3 h`, never `2.9 h`). */
function ageParts(ms: number): { unit: AgeUnit; n: number } {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return { unit: 'second', n: Math.floor(abs / SECOND) };
  if (abs < HOUR) return { unit: 'minute', n: Math.floor(abs / MINUTE) };
  if (abs < DAY) return { unit: 'hour', n: Math.floor(abs / HOUR) };
  if (abs < MONTH) return { unit: 'day', n: Math.floor(abs / DAY) };
  if (abs < YEAR) return { unit: 'month', n: Math.floor(abs / MONTH) };
  return { unit: 'year', n: Math.floor(abs / YEAR) };
}

/**
 * How long ago (or how far ahead) `value` is from `now`: `il y a 3 min` in French,
 * "3 hr. ago", "in 2 days"; under a minute, the language's "now". `style`
 * goes to `Intl.RelativeTimeFormat` (`short` by default, `long` spells the
 * units out).
 */
export function formatRelativeTime(
  value: DateInput,
  now: number = Date.now(),
  style: Intl.RelativeTimeFormatStyle = 'short',
  locale?: Locale,
): string {
  const date = toDate(value);
  if (!date) return '';
  const delta = date.getTime() - now;
  const { unit, n } = ageParts(delta);
  const format = relativeTimeFormat({ numeric: 'auto', style }, locale);
  if (unit === 'second') return format.format(0, 'second');
  return format.format(delta < 0 ? -n : n, unit);
}

/**
 * An age in its narrowest form, for a line of metadata (`12m`, `3h`, `3j` in French):
 * the largest unit that fits, no "ago".
 */
export function formatAgeShort(ms: number, locale?: Locale): string {
  const { unit, n } = ageParts(ms);
  return numberFormat({ style: 'unit', unit, unitDisplay: 'narrow' }, locale).format(n);
}

/** A list joined the language's way: "a, b, and c", `a, b et c` in French. */
export function formatList(items: readonly string[], type: 'and' | 'or' = 'and', locale?: Locale): string {
  const tag = intlLocale(locale);
  const options: Intl.ListFormatOptions = { type: type === 'and' ? 'conjunction' : 'disjunction' };
  return cached('lf', tag, options, () => new Intl.ListFormat(tag, options)).format(items);
}

/** A language's name in the interface language (`fr` → "French", `français` in French); null when unknown. */
export function languageDisplayName(code: string, locale?: Locale): string | null {
  const tag = intlLocale(locale);
  try {
    const names = cached('dn', tag, undefined, () => new Intl.DisplayNames([tag], { type: 'language' }));
    const name = names.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** Text order of the language, for sorting titles and names. */
export function compareText(a: string, b: string, locale?: Locale): number {
  return collator(locale).compare(a, b);
}
