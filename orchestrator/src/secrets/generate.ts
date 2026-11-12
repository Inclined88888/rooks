/**
 * Random secret values for `POST /api/secrets/provision` (an agent asks the
 * daemon to mint a password or token it never gets to see).
 *
 * Bytes come from `node:crypto`; characters are drawn by rejection sampling so
 * no symbol is likelier than another (a plain `byte % alphabet.length` skews
 * towards the first symbols).
 */
import { randomBytes } from 'node:crypto';

export const GENERATE_ALPHABETS = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
  base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  // No quote, backslash, space or `$`/backtick: a generated password must
  // survive a shell, a .env line and a URL userinfo without escaping.
  symbols: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%*+-.:=?@^_~',
} as const;

export type GenerateAlphabet = keyof typeof GENERATE_ALPHABETS;

export const GENERATE_MIN_LENGTH = 16;
export const GENERATE_MAX_LENGTH = 128;
export const GENERATE_DEFAULT_LENGTH = 32;

export function generateSecretValue(
  length: number = GENERATE_DEFAULT_LENGTH,
  alphabet: GenerateAlphabet = 'alnum',
): string {
  if (!Number.isInteger(length) || length < GENERATE_MIN_LENGTH || length > GENERATE_MAX_LENGTH) {
    throw new RangeError(`length must be an integer between ${GENERATE_MIN_LENGTH} and ${GENERATE_MAX_LENGTH}`);
  }
  const symbols = GENERATE_ALPHABETS[alphabet];
  if (!symbols) throw new RangeError(`unknown alphabet: ${String(alphabet)}`);
  // Largest multiple of the alphabet size that fits in a byte: bytes above it
  // are thrown away.
  const limit = 256 - (256 % symbols.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += symbols[byte % symbols.length];
      if (out.length === length) break;
    }
  }
  return out;
}
