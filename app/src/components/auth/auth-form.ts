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

/** Name filled, email/password left blank — Create synthesises a local identity. */
export function nameOnlyDraft(name: string, email: string, password: string, confirm: string): boolean {
  return name.trim() !== '' && email.trim() === '' && password === '' && confirm === '';
}

/** Local address the daemon accepts for a name-only first account (`EMAIL_RE`). */
export function localEmailForName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48);
  return `${slug || 'local'}@rooks.local`;
}

/** One-shot password for a name-only create; the setup response keeps the session. */
export function localSetupPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out.length >= MIN_PASSWORD ? out : `${out}rookslocal`;
}
