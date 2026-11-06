/**
 * The contract of a source adapter, and the small helpers every adapter needs.
 *
 * An adapter never reads a disk or a network: it declares which files it
 * recognises a source by (`detect`) and which ones it needs (`wants`), the
 * engine reads the archive with its deny list and ceilings, and hands the
 * filtered tree to `toManifest`, a pure function. What it returns is checked
 * again against the `timon-agent-import` v1 schema before anything is planned.
 *
 * Nothing here depends on Node: the same adapter can run in a browser half.
 */
import type { AgentImportManifest } from '../manifest.js';

/** The tree an adapter receives: relative POSIX path → bytes, after the deny list and `wants`. */
export type AdapterTree = {
  files: ReadonlyMap<string, Uint8Array>;
  /** Names the reader left out (secret, link, too large…), with why. */
  skipped: ReadonlyArray<{ path: string; reason: string }>;
};

/** A manifest without its `warnings`: the engine merges them with the adapter's own. */
export type AdapterManifest = Omit<AgentImportManifest, 'warnings'>;

export type SourceAdapterResult = {
  manifest: AdapterManifest;
  /** What the source held that Timon does not take, in words for the user. */
  warnings: string[];
};

export type SourceAdapter = {
  /** Unique among sources; also what `ImportOptions.source` names. */
  id: string;
  label: string;
  accepts: ReadonlyArray<'dir' | 'zip'>;
  /** Globs of the files that identify this source (`openbot-import.json`). */
  detect: readonly string[];
  /** Globs of every file `toManifest` reads; nothing else reaches it. */
  wants: readonly string[];
  /** Throws a `ManifestError` when the source is not one it can read. */
  toManifest(tree: AdapterTree): SourceAdapterResult;
};

/** Text of a file: UTF-8 (a BOM dropped), `\r\n` and lone `\r` turned into `\n`. `null` when it is not UTF-8. */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return normalizeNewlines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * `Research Bot_2` → `research-bot-2`: a key the manifest admits
 * (`[a-z0-9-]`, 64 at most, no dash at either end). Empty when nothing is left.
 */
export function slugKey(raw: string, max = 64): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** A free key among `taken`: `key`, then `key-2`, `key-3`… within the length limit. */
export function uniqueKey(base: string, taken: Set<string>, max = 64): string {
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    const tail = `-${n}`;
    key = base.slice(0, max - tail.length).replace(/-+$/, '') + tail;
  }
  taken.add(key);
  return key;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding, without `Buffer` or `btoa` (both differ between Node and browsers). */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

export type PictureMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** The type a picture's first bytes prove, whatever its name says; `null` for anything else. */
export function sniffPicture(bytes: Uint8Array): PictureMime | null {
  const at = (i: number): number => bytes[i] ?? -1;
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** At most `max` names, then an ellipsis. */
export function listNames(names: readonly string[], max = 10): string {
  return names.slice(0, max).join(', ') + (names.length > max ? ', …' : '');
}
