/**
 * Minimal surface of `jsdom`, used by the DOM tests only.
 *
 * jsdom is not declared in `package.json`: it is a direct dependency of
 * `isomorphic-dompurify` (an app dependency), pinned by the lockfile, so it
 * is always installed. It ships no types of its own, hence this file. Should
 * the package ever leave the tree, the import breaks loudly in the tests
 * rather than degrading silently.
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}
