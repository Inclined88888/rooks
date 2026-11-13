// Types of i18n-usage.mjs, for the TypeScript tests that import it.

export const DEFAULT_CODE_DIR: string;

export interface KeyCall {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  /** Argument names of an object literal; `[]` without arguments; `null` when unreadable. */
  readonly vars: string[] | null;
}

export interface KeyUsage {
  readonly calls: KeyCall[];
  readonly prefixes: Set<string>;
  readonly quoted: Set<string>;
}

export function codeFiles(dir?: string): string[];
export function objectKeys(source: string, start: number): string[] | null;
export function scanUsage(files?: string[], options?: { root?: string }): KeyUsage;
export function probablyUnused(keys: string[], usage: KeyUsage): string[];
