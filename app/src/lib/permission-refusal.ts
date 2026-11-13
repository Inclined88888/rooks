/**
 * What to show for a failed daemon call, a 403 above all.
 *
 * A refusal answers `{ error: 'forbidden', code, permission, reason, hint }`
 * (`forbiddenBody`, orchestrator/src/users/identity.ts). Showing `error` alone
 * printed the word "forbidden" and nothing to do about it (TODO #560). The
 * common case — the account lacks a permission — is translated; any other
 * refusal shows the daemon's own reason and hint, which it words for a person.
 */

import { t } from '@/lib/i18n';

/** The sentence a greyed control and a refused call share. */
export function missingPermissionText(permission: string): string {
  return t('permissionRefusal.accountLacks', { permission });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The message of a refusal body, or `null` when the body is not one. */
export function refusalText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.error !== 'forbidden') return null;
  const permission = text(b.permission);
  if (b.code === 'account_lacks_permission' && permission) return missingPermissionText(permission);
  const reason = text(b.reason);
  const hint = text(b.hint);
  if (!reason) return hint ?? t('permissionRefusal.generic');
  return hint ? `${reason} — ${hint}` : reason;
}

/** The message of any failed response body: its refusal, else its `error`,
 *  else `fallback`. */
export function responseErrorText(body: unknown, fallback: string): string {
  const refusal = refusalText(body);
  if (refusal) return refusal;
  const error = body && typeof body === 'object' ? text((body as Record<string, unknown>).error) : null;
  return error ?? fallback;
}

/** A control gated on a permission: enabled only once it is known to be held,
 *  explained only once it is known to be missing. */
export type PermissionAccess = { allowed: boolean; denied: string | null };

export function permissionAccess(can: boolean | null, permission: string): PermissionAccess {
  return { allowed: can === true, denied: can === false ? missingPermissionText(permission) : null };
}
