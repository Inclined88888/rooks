/**
 * Path rules that only Windows enforces, as pure checks every OS can run.
 *
 * A name Linux and macOS accept can still be refused by Windows at write time
 * (`CON`, `aux.txt`, `a:b`), and the error then surfaces raw from `fs`. Readers
 * that take names from the outside (plugin archives) check them up front, so
 * the refusal carries a code and the same archive fails the same way on the
 * author's machine as on a tester's.
 */
import { sep } from 'node:path';

/** `:` would open an NTFS alternate data stream; the rest are refused by Win32. */
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\u0001-\u001f]/;
/** Device names, with or without an extension, any case; `¹²³` count as digits there. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Why Windows would refuse this single path segment, or null when it is portable. */
export function windowsSegmentProblem(segment: string): string | null {
  if (WINDOWS_FORBIDDEN_CHARS.test(segment)) return 'a character Windows refuses in a file name (<>:"|?* or a control character)';
  // Win32 drops a trailing dot or space: `a.` and `a` would be one file.
  if (/[. ]$/.test(segment) && segment !== '.' && segment !== '..') return 'a name ending with a dot or a space';
  const stem = (segment.split('.')[0] ?? '').trimEnd();
  if (WINDOWS_DEVICE.test(stem)) return 'a reserved Windows device name (CON, PRN, AUX, NUL, COM1…, LPT1…)';
  return null;
}

/** A host-relative path in the forward-slash form the API speaks on every OS. */
export function toPosixRelative(rel: string, separator: string = sep): string {
  return separator === '/' ? rel : rel.split(separator).join('/');
}
