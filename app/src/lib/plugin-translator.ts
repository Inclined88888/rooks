/**
 * `createTranslator` of `@rooks/ui`: the translator a plugin builds over its
 * OWN messages, shipped in its package (`locales/<tag>.json`). Contract:
 * docs/PLUGINS.md (section `Langues d'un plugin`), docs/I18N.md.
 *
 * Same messages as the product (ICU MessageFormat, `{count, plural, …}`),
 * same negotiation, same fallback key by key — but only over the languages
 * the plugin ships: the reader's language, the ones it falls back on, then
 * the plugin's English, then the key itself. A plugin never writes into the
 * product dictionary, so its keys can never collide with the product's or
 * another plugin's.
 *
 * Written so the translators of client API 2 to 14 keep working: `{ en, fr }`
 * with flat keys (`'cockpit.mail.title'`) reads as before, a message that
 * does not parse as ICU still gets the old `{name}` interpolation instead of
 * showing raw, and the object passed in is read live, as those translators
 * did: a plugin may create its translator over `{}` and fill its languages
 * afterwards, even asynchronously (TODO #888).
 */
import { availableLocales, getLocale } from './i18n';
import {
  SOURCE_LOCALE, canonicalTag, compileMessage, formatMessage, isDictionary, localeChain, lookup, negotiate,
  type Dictionary, type LocaleLayer, type MessageVars,
} from './i18n-core';

/** A plugin's messages for one language: flat dotted keys, nested objects, or both. */
export type TranslatorMessages = { readonly [key: string]: string | TranslatorMessages };

/** The messages of a plugin, by BCP 47 tag: `{ en: {…}, fr: {…}, 'pt-BR': {…} }`. */
export type TranslatorLocales = { readonly [tag: string]: TranslatorMessages | undefined };

export type Translator = (key: string, vars?: MessageVars) => string;

/** The languages the reader asks for, best first: the product's own chain without its English. */
function requestedTags(locale: string): string[] {
  return localeChain(locale, availableLocales()).filter((tag) => tag !== SOURCE_LOCALE);
}

/**
 * The plugin's layers to read for `locale`: each requested language
 * negotiated among the ones the plugin ships (`pt-PT` finds its `pt-BR`),
 * then its English. A language the plugin lacks adds nothing.
 */
export function pluginChain(locale: string, offered: readonly LocaleLayer[]): LocaleLayer[] {
  const chain: LocaleLayer[] = [];
  const add = (tag: string | null): void => {
    if (!tag || chain.some((layer) => layer.tag === tag)) return;
    const layer = offered.find((candidate) => candidate.tag === tag);
    if (layer) chain.push(layer);
  };
  for (const tag of requestedTags(locale)) add(negotiate([tag], offered));
  add(SOURCE_LOCALE);
  return chain;
}

/** The plugin's languages, under their canonical tag; a malformed tag is ignored. */
function offeredLayers(messages: TranslatorLocales): LocaleLayer[] {
  const layers: LocaleLayer[] = [];
  for (const [raw, dictionary] of Object.entries(messages)) {
    const tag = canonicalTag(raw);
    if (!tag || !isDictionary(dictionary) || layers.some((layer) => layer.tag === tag)) continue;
    layers.push({ tag, dictionary: dictionary as Dictionary });
  }
  return layers;
}

/** A flat key first (`'cockpit.mail.title'` as one key, client API 2), then the dotted path. */
function messageOf(dictionary: Dictionary, key: string): string | null {
  const flat = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : undefined;
  if (typeof flat === 'string') return flat;
  const nested = lookup(dictionary, key);
  return typeof nested === 'string' ? nested : null;
}

/** The interpolation of client API 2 to 14, for a message ICU cannot read. */
function interpolate(message: string, vars?: MessageVars): string {
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

/**
 * A translator over the plugin's own messages. The reader's language is read
 * at each call: a language switched after the plugin loaded is honoured.
 */
export function createTranslator(messages: TranslatorLocales): Translator {
  /**
   * What `offered` was built from: each own key of `messages` with the
   * dictionary it held. Compared at each call, so a language added, removed
   * or replaced after creation is seen without freezing a copy.
   */
  let seen: Array<readonly [string, unknown]> = [];
  let offered: LocaleLayer[] = [];
  let chainFor: { locale: string; chain: LocaleLayer[] } | null = null;
  /** Messages that do not parse as ICU, by language then key. */
  const legacy = new Map<string, boolean>();

  const refresh = (): void => {
    const tags = Object.keys(messages);
    const same = tags.length === seen.length
      && tags.every((tag, i) => seen[i]?.[0] === tag && seen[i]?.[1] === messages[tag]);
    if (same) return;
    seen = tags.map((tag) => [tag, messages[tag]] as const);
    offered = offeredLayers(messages);
    chainFor = null;
    legacy.clear();
  };

  const parses = (layer: LocaleLayer, key: string, message: string): boolean => {
    const id = `${layer.tag}\u0000${key}`;
    let ok = legacy.get(id);
    if (ok === undefined) {
      try {
        compileMessage(layer.tag, message);
        ok = true;
      } catch {
        ok = false;
      }
      legacy.set(id, ok);
    }
    return ok;
  };

  return (key, vars) => {
    refresh();
    const locale = getLocale();
    if (chainFor?.locale !== locale) chainFor = { locale, chain: pluginChain(locale, offered) };
    for (const layer of chainFor.chain) {
      const message = messageOf(layer.dictionary, key);
      if (message === null) continue;
      if (/^[^{}']*$/.test(message)) return message;
      return parses(layer, key, message)
        ? formatMessage(layer, key, message, vars)
        : interpolate(message, vars);
    }
    return key;
  };
}
