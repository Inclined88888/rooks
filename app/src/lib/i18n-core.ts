/**
 * The core of Rooks's i18n: dictionary merge, key lookup, ICU MessageFormat
 * messages and BCP 47 negotiation. No DOM, no Node API, no state but caches;
 * one dependency, `intl-messageformat` (plurals and selects inside one
 * message: `{count, plural, one {# file} other {# files}}`).
 *
 * Why it stands alone: the desktop shell needs the very same plurals and
 * negotiation as the webview, and `app/` and `desktop/` are independent
 * packages. The shell carries a copy of this file, which a test holds
 * byte-for-byte identical (docs/I18N.md).
 */

import { IntlMessageFormat } from 'intl-messageformat';

export type Dictionary = { [key: string]: unknown };

export type TextDirection = 'ltr' | 'rtl';

/** One language present in the product, as the locale build describes it. */
export interface LocaleInfo {
  /** Canonical BCP 47 tag, the name of its folder (`pt-BR`). */
  readonly tag: string;
  /** Native name, shown as is in the language selector. */
  readonly name: string;
  readonly dir: TextDirection;
  /** Share of the English messages this language translates, 0 to 1 — a report, never a gate. */
  readonly coverage: number;
  /** Content hash of its merged dictionary: an immutable URL. */
  readonly hash: string;
  /** Wins over its siblings when a reader asks for the bare language. */
  readonly default?: boolean;
  /** Languages read before English when a key is missing. */
  readonly fallback?: readonly string[];
}

/** What negotiation needs to know about a language on offer. */
export interface LocaleOffer {
  readonly tag: string;
  readonly default?: boolean;
}

/** One language of a lookup chain and its dictionary. */
export interface LocaleLayer {
  readonly tag: string;
  readonly dictionary: Dictionary;
}

export type MessageVars = Record<string, string | number>;

/** The source language: every key exists in it, every chain ends with it. */
export const SOURCE_LOCALE = 'en';

/** Language, then subtags; what a cookie or a folder name may hold. */
export const LOCALE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isDictionary(value: unknown): value is Dictionary {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge, later dictionaries win; nested objects merge key by key. */
export function mergeDictionaries(...dictionaries: Dictionary[]): Dictionary {
  const merged: Dictionary = {};
  for (const dictionary of dictionaries) {
    for (const [key, value] of Object.entries(dictionary)) {
      const previous = merged[key];
      merged[key] = isDictionary(previous) && isDictionary(value)
        ? mergeDictionaries(previous, value)
        : value;
    }
  }
  return merged;
}

/** The value at a dotted path (`taskForm.create`), or `undefined`. */
export function lookup(dictionary: Dictionary, key: string): unknown {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (!isDictionary(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** The canonical form of a well-formed tag (`pt-br` → `pt-BR`), else `null`. */
export function canonicalTag(value: string | null | undefined): string | null {
  if (!value || !LOCALE_TAG_PATTERN.test(value)) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The tags of an `Accept-Language` header, by weight then order. A weight
 * of 0 means "not this one", and `*` names no language.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.weight > 0 && entry.tag !== '' && entry.tag !== '*')
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.tag);
}

function primaryLanguage(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

/** Chinese never crosses between Simplified and Traditional; other languages always may. */
function sameScript(requested: string, offered: string): boolean {
  if (primaryLanguage(requested) !== 'zh') return true;
  try {
    return new Intl.Locale(requested).maximize().script === new Intl.Locale(offered).maximize().script;
  } catch {
    return false;
  }
}

function byTag(a: LocaleOffer, b: LocaleOffer): number {
  return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

function matchOne(tag: string, offers: readonly LocaleOffer[]): string | null {
  // 1 and 2: the tag itself, then without its last subtags (`zh-Hant-TW` → `zh-Hant` → `zh`).
  for (let parts = tag.split('-'); parts.length > 0; parts = parts.slice(0, -1)) {
    const candidate = parts.join('-').toLowerCase();
    const hit = offers.find((offer) => offer.tag.toLowerCase() === candidate && sameScript(tag, offer.tag));
    if (hit) return hit.tag;
  }
  // 3: another variant of the same language beats English (`pt-PT` → `pt-BR`).
  const language = primaryLanguage(tag);
  const siblings = offers
    .filter((offer) => primaryLanguage(offer.tag) === language && sameScript(tag, offer.tag))
    .sort((a, b) => Number(b.default === true) - Number(a.default === true) || byTag(a, b));
  return siblings[0]?.tag ?? null;
}

/**
 * The first requested tag that resolves among `offers`, in the order asked;
 * `null` when none does (the caller falls back to English).
 */
export function negotiate(requested: readonly string[], offers: readonly LocaleOffer[]): string | null {
  for (const raw of requested) {
    const tag = canonicalTag(raw);
    if (!tag) continue;
    const match = matchOne(tag, offers);
    if (match) return match;
  }
  return null;
}

interface Compiled {
  readonly format: IntlMessageFormat;
  /** Every argument the message names, plural and select ones included. */
  readonly args: readonly string[];
  /** The arguments that need a value of their kind (number, date, plural, select). */
  readonly typed: readonly string[];
}

/**
 * Walks an ICU syntax tree for the names of its arguments. Read
 * structurally: the parser's node types are not part of the package's API.
 */
function collectArguments(nodes: readonly unknown[], into: Set<string>, typed: Set<string>): Set<string> {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const { type, value, options, children } = node as { type?: unknown; value?: unknown; options?: unknown; children?: unknown };
    // 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural; 0 literal, 7 `#`, 8 tag.
    if (typeof type === 'number' && type >= 1 && type <= 6 && typeof value === 'string') {
      into.add(value);
      if (type >= 2) typed.add(value);
    }
    if (typeof options === 'object' && options !== null) {
      for (const option of Object.values(options)) {
        const branch = (option as { value?: unknown }).value;
        if (Array.isArray(branch)) collectArguments(branch, into, typed);
      }
    }
    if (Array.isArray(children)) collectArguments(children, into, typed);
  }
  return into;
}

/** Compiles an ICU message; throws on a syntax error. Tags stay plain text. */
export function compileMessage(tag: string, message: string): Compiled {
  const format = new IntlMessageFormat(message, tag, undefined, { ignoreTag: true });
  const typed = new Set<string>();
  return { format, args: [...collectArguments(format.getAst(), new Set(), typed)], typed: [...typed] };
}

/** The argument names of an ICU message (`{name}`, `{count, plural, …}`); throws on a syntax error. */
export function messageArguments(message: string, tag: string = SOURCE_LOCALE): readonly string[] {
  return compileMessage(tag, message).args;
}

/**
 * Compiled messages, per language dictionary then per key: a dictionary
 * replaced by a new load starts a fresh cache with it. `null` marks a
 * message that does not parse.
 */
const COMPILED = new WeakMap<Dictionary, Map<string, Compiled | null>>();

function compiledFor(layer: LocaleLayer, key: string, message: string): Compiled | null {
  let byKey = COMPILED.get(layer.dictionary);
  if (!byKey) {
    byKey = new Map();
    COMPILED.set(layer.dictionary, byKey);
  }
  let compiled = byKey.get(key);
  if (compiled === undefined) {
    try {
      compiled = compileMessage(layer.tag, message);
    } catch {
      compiled = null;
    }
    byKey.set(key, compiled);
  }
  return compiled;
}

/** Text with no ICU syntax at all reads as written, uncompiled. */
const PLAIN = /^[^{}']*$/;

/**
 * Formats one message of `layer`. A plain variable not given stays visible
 * as `{name}`; a message that does not parse, misses the value of a plural,
 * select, number or date argument, or cannot be formatted with the values
 * given, shows its raw text rather than nothing.
 */
export function formatMessage(layer: LocaleLayer, key: string, message: string, vars?: MessageVars): string {
  if (PLAIN.test(message)) return message;
  const compiled = compiledFor(layer, key, message);
  if (!compiled) return message;
  const values: MessageVars = { ...vars };
  if (compiled.typed.some((name) => !Object.prototype.hasOwnProperty.call(values, name))) return message;
  for (const name of compiled.args) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) values[name] = `{${name}}`;
  }
  try {
    const out = compiled.format.format(values);
    return typeof out === 'string' ? out : Array.isArray(out) ? out.join('') : String(out);
  } catch {
    return message;
  }
}

/** The first layer of `chain` that has `key`, read key by key, and its message. */
export function resolveMessage(chain: readonly LocaleLayer[], key: string): { layer: LocaleLayer; message: string } | null {
  for (const layer of chain) {
    const value = lookup(layer.dictionary, key);
    if (typeof value === 'string') return { layer, message: value };
  }
  return null;
}

/**
 * `key` translated along `chain` (its first layer is the reader's language),
 * or `null` when no language has it. The message is formatted in the
 * language it comes from: its plural rules are that language's.
 */
export function translate(chain: readonly LocaleLayer[], key: string, vars?: MessageVars): string | null {
  const found = resolveMessage(chain, key);
  return found ? formatMessage(found.layer, key, found.message, vars) : null;
}

/** The languages read for `tag`, in order: itself, its declared fallbacks, then English. */
export function localeChain(tag: string, catalog: readonly LocaleInfo[]): string[] {
  const chain: string[] = [];
  const add = (next: string): void => {
    if (!chain.includes(next)) chain.push(next);
  };
  add(tag);
  for (const next of catalog.find((info) => info.tag === tag)?.fallback ?? []) add(next);
  add(SOURCE_LOCALE);
  return chain;
}
