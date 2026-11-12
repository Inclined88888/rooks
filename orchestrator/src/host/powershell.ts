/**
 * PowerShell 7 (`pwsh`) detection. It installs next to Windows PowerShell 5.1
 * rather than replacing it, and only 7+ parses `&&` / `||` (TIM-0085): where it
 * exists, the integrated terminal prefers it.
 */
import { findExecutableBinary, type BinarySearchOptions } from './binary-path.js';

/** Absolute path of `pwsh` on Windows, `null` when absent or on another OS. */
export function findPwsh(options: BinarySearchOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  return findExecutableBinary('pwsh', options);
}
