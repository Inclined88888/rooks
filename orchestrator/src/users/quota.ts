/**
 * Per-machine profile quota — the `users` claim of the licence contract v4
 * (`rooks-site` `docs/PRD-S0.md` §4, fixture `fixtures/token-claims.json`).
 *
 * The licence server decides and signs the number but cannot apply it: it
 * never sees the profiles of an installation. So the daemon is the only place
 * where "3 users on this machine" can mean anything, and this module is that
 * place.
 *
 * What it deliberately does NOT do: lock anything. The quota is checked when
 * a NEW profile is created, never on sign-in, never on a profile that already
 * exists. An install that ends up above its quota (a licence changed for a
 * smaller one) keeps every account working — only the next creation is
 * refused. Anything else would lock a customer out of their own instance over
 * a billing change. Free has a separate account-access guard: surplus accounts
 * are retained but suspended until paid rights return.
 *
 * No quota at all — claim absent (a token issued before v4), `null`
 * (unlimited) — restricts nothing on paid plans. Local Free allows one owner.
 */
import { dbApi } from '../db.js';
import { licenseState } from '../license/runtime.js';
import type { LicenseState } from '../license/license.js';

export type QuotaVerdict =
  | { allowed: true }
  /** `limit` profiles allowed, `count` already in use (`count >= limit`). */
  | { allowed: false; limit: number; count: number };

/** How many profiles this licence allows, `null` for "no restriction". */
export function userQuota(state: LicenseState = licenseState()): number | null {
  return state.users;
}

/** Whether one more profile may be created right now. */
export function checkUserQuota(state: LicenseState = licenseState()): QuotaVerdict {
  const limit = userQuota(state);
  if (limit === null) return { allowed: true };
  const count = dbApi.countUsersInUse();
  return count < limit ? { allowed: true } : { allowed: false, limit, count };
}
