// Types of build-locales.mjs, for the TypeScript tests and modules that import it.
import type { Dictionary, LocaleInfo } from '../src/lib/i18n-core';

export const SOURCE_LOCALE: 'en';
export const PSEUDO_LOCALE: 'en-XA';
export const LOCALE_TAG_PATTERN: RegExp;
export const DEFAULT_PATHS: { readonly sourceDir: string; readonly publicDir: string; readonly generatedDir: string };

export interface SourceLocale {
  readonly tag: string;
  readonly dir: string;
  readonly meta: { name: string; dir?: 'ltr' | 'rtl'; fallback?: string[]; default?: boolean };
}

export function mergeDictionaries(...dictionaries: Dictionary[]): Dictionary;
export function lookup(dictionary: Dictionary, key: string): unknown;
export function leafKeys(dictionary: Dictionary, prefix?: string): string[];
export function coverageOf(source: Dictionary, dictionary: Dictionary): number;
export function canonicalTag(value: unknown): string | null;
export function metaProblems(meta: unknown): string[];
export function discoverLocales(sourceDir?: string): SourceLocale[];
export function namespaceFiles(dir: string): string[];
export function readLocaleDictionary(dir: string): Dictionary;
export function pseudoLocalize(text: string): string;
export function buildLocales(options?: { sourceDir?: string; pseudo?: boolean }): {
  manifest: LocaleInfo[];
  files: Map<string, string>;
  generated: Map<string, string>;
};
export function writeLocales(options?: {
  sourceDir?: string;
  publicDir?: string;
  generatedDir?: string;
  pseudo?: boolean;
}): { manifest: LocaleInfo[]; written: number };
