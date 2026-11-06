/**
 * The checks the account step and the forgotten password share, pure
 * (docs/EMAIL-CODE-UI.md). No complexity rule: two passwords that match, at
 * the length the daemon requires — nothing about digits, cases or symbols.
 */

/** The daemon refuses a shorter password (`MIN_PASSWORD`, users/routes.ts): said before a code is spent. */
export const MIN_PASSWORD = 8;

/** Enough to catch a typo before a code is mailed; the daemon validates for real. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export type PasswordProblem = 'mismatch' | 'short' | null;

/**
 * What to say under a password pair. Nothing until the confirmation is typed:
 * a sentence while the first field is being filled would only nag.
 */
export function passwordProblem(password: string, confirm: string): PasswordProblem {
  if (!confirm) return null;
  if (password !== confirm) return 'mismatch';
  if (password.length < MIN_PASSWORD) return 'short';
  return null;
}

export function passwordPairReady(password: string, confirm: string): boolean {
  return password.length >= MIN_PASSWORD && password === confirm;
}

/**
 * The account's name. The first name is optional on the form, the daemon
 * wants one: without it, the part of the address before the `@`.
 */
export function accountName(name: string, email: string): string {
  const typed = name.trim();
  if (typed) return typed;
  return email.trim().split('@')[0] || email.trim();
}
