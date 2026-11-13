import { fixedComposition, singleSuperadmin } from './capabilities.js';
import type { LicenseState } from './license.js';

/**
 * A token that grants LESS than the licence currently installed. Installing
 * one is a legitimate move (a customer changing plan) but also the exact
 * shape of the attack in `docs/SECU-LICENCES.md` L-3: a lesser key activated
 * on someone else's daemon switches Kanban code, Dreams and the
 * browser off at once. So the routes refuse it unless the caller says
 * `force: true`, which the UI only sends after a confirmation.
 *
 * "Less" is narrower on any axis: a lower edition, a module or plugin grant
 * that no longer covers what the current one does. A different `plan` alone
 * is not a downgrade — plan ids are billing labels, not capability tiers.
 */
function narrower(current: readonly string[] | '*', next: readonly string[] | '*'): boolean {
  if (next === '*') return false;
  if (current === '*') return true;
  return current.some((id) => !next.includes(id));
}

export function isDowngrade(current: LicenseState, next: LicenseState): boolean {
  if (current.status !== 'valid') return false;
  if (next.status !== 'valid') return false;
  if ((!fixedComposition(current) && fixedComposition(next)) || (!singleSuperadmin(current) && singleSuperadmin(next))) return true;
  if (next.users !== null && (current.users === null || next.users < current.users)) return true;
  if (current.edition === 'expert' && next.edition === 'lite') return true;
  return narrower(current.modules, next.modules) || narrower(current.plugins, next.plugins);
}
