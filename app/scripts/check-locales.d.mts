// Types of check-locales.mjs, for the TypeScript tests that import it.

export function parseMessage(message: string, tag: string): {
  args: Set<string>;
  plurals: { kind: 'cardinal' | 'ordinal'; options: string[] }[];
};

export function checkLocales(options?: { sourceDir?: string }): {
  errors: string[];
  warnings: string[];
  report: { tag: string; coverage: number }[];
  /** Coverage of each language's `desktop.json` (the desktop shell), for the languages that have one. */
  shellReport: { tag: string; coverage: number }[];
};
