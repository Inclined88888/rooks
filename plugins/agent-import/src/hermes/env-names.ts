/**
 * The NAMES of the variables a Hermes profile keeps in its `.env`, so the
 * import can say "enter these again in the vault" — never their values.
 *
 * The folder reader refuses every `.env*` file, and that stays true: this is
 * a separate, deliberately narrow reading of ONE file per profile. It is
 * `lstat`ed and refused when it is a link, a junction, a special file or a
 * file with a second hard link (any of which may lead to a secret elsewhere),
 * reopened without following links, checked to be the file that was listed,
 * and capped in size. The bytes are scanned in place: only the key of each
 * `KEY=…` line is ever turned into a string, the values never are, and the
 * buffer is zeroed before it is released. Nothing here logs, and the file
 * never enters a `SourceTree`.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

/** A `.env` is a few dozen lines; past this it is not one, and it is not read. */
export const ENV_FILE_MAX_BYTES = 256 * 1024;
/** What a manifest carries per agent (`secretNames`). */
export const ENV_NAMES_MAX = 64;
const ENV_NAME_MAX_LENGTH = 100;

// Absent on Windows, where `lstat` + the identity check carry the guarantee.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type EnvNamesSkip = 'link' | 'hard-link' | 'special' | 'too-large' | 'unreadable';

export type EnvNames = {
  names: string[];
  /** Why the file was not read, when it exists and was not. */
  skipped: EnvNamesSkip | null;
  /** More names than a manifest holds: the first ones are kept. */
  truncated: boolean;
};

const isNameStart = (b: number): boolean => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f;
const isNamePart = (b: number): boolean => isNameStart(b) || (b >= 0x30 && b <= 0x39);
const isBlank = (b: number | undefined): boolean => b === 0x20 || b === 0x09;
const EXPORT = [0x65, 0x78, 0x70, 0x6f, 0x72, 0x74];

/**
 * The keys of the `KEY=value` lines of a `.env`, in order, without
 * duplicates. `export KEY=…` and blanks around the key are tolerated;
 * comments and anything else are not lines that name a variable. A value is
 * skipped byte by byte and never decoded.
 */
export function parseEnvNames(bytes: Uint8Array): { names: string[]; truncated: boolean } {
  const names: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length) {
    let j = i;
    while (isBlank(bytes[j])) j++;
    if (EXPORT.every((b, k) => bytes[j + k] === b) && isBlank(bytes[j + EXPORT.length])) {
      j += EXPORT.length;
      while (isBlank(bytes[j])) j++;
    }
    const start = j;
    if (j < bytes.length && isNameStart(bytes[j]!)) {
      j++;
      while (j < bytes.length && isNamePart(bytes[j]!)) j++;
      const end = j;
      while (isBlank(bytes[j])) j++;
      if (bytes[j] === 0x3d && end - start <= ENV_NAME_MAX_LENGTH) {
        let name = '';
        for (let k = start; k < end; k++) name += String.fromCharCode(bytes[k]!);
        if (!seen.has(name)) {
          if (names.length < ENV_NAMES_MAX) {
            seen.add(name);
            names.push(name);
          } else {
            truncated = true;
          }
        }
      }
    }
    // The rest of the line — the value — is stepped over, never read into a string.
    while (j < bytes.length && bytes[j] !== 0x0a) j++;
    i = j + 1;
  }
  return { names, truncated };
}

/** The variable names of `<profileRoot>/.env`; no file means no names. */
export async function readEnvNames(profileRoot: string): Promise<EnvNames> {
  const path = join(profileRoot, '.env');
  let st;
  try {
    st = await lstat(path);
  } catch {
    return { names: [], skipped: null, truncated: false };
  }
  if (st.isSymbolicLink()) return { names: [], skipped: 'link', truncated: false };
  if (!st.isFile()) return { names: [], skipped: 'special', truncated: false };
  if (st.nlink > 1) return { names: [], skipped: 'hard-link', truncated: false };
  if (st.size > ENV_FILE_MAX_BYTES) return { names: [], skipped: 'too-large', truncated: false };

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return { names: [], skipped: 'unreadable', truncated: false };
  }
  const bytes = new Uint8Array(st.size);
  try {
    const now = await handle.stat();
    // An inode of 0 means the platform does not report one: type, size and links are compared.
    const same = now.isFile() && now.size === st.size && now.nlink <= 1
      && (st.ino === 0 || (now.ino === st.ino && now.dev === st.dev));
    if (!same) return { names: [], skipped: 'unreadable', truncated: false };
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const parsed = parseEnvNames(bytes.subarray(0, offset));
    return { names: parsed.names, skipped: null, truncated: parsed.truncated };
  } catch {
    return { names: [], skipped: 'unreadable', truncated: false };
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}
