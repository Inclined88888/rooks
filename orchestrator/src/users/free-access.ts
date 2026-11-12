import { LicenseCapabilityError } from '../license/capabilities.js';
import { dbApi } from '../db.js';
import { mutationLicenseState } from '../license/runtime.js';
import { accountProviderHolder } from './account-provider-state.js';

/**
 * Whether accounts beyond the first superadmin can be served: an account
 * provider plugin (the Multi-user plugin) holds `ctx.accountProvider`. The core
 * administers no account itself.
 */
export function multiUserServed(): boolean {
  return accountProviderHolder() !== null;
}

/** Downgrades suspend access, never accounts or their data. The earliest active
 * superadmin retains recovery access. The other accounts need a paid licence
 * and multi-user served; both back, they get their access back as they were. */
export function freeAccountAllowed(userId: string): boolean {
  if (dbApi.getActiveSuperadmin()?.id === userId) return true;
  return !mutationLicenseState().localFree && multiUserServed();
}

/** Human text shared by the exception path and the auth middleware's bare 403. */
export const FREE_ACCOUNT_RESTRICTED_MESSAGE =
  'Accounts beyond the first superadmin need a pro licence and the Multi-user plugin. This account and its data are preserved; access comes back as soon as both are there.';

export function assertFreeAccountAccess(userId: string | null | undefined): void {
  if (userId && !freeAccountAllowed(userId)) {
    throw new LicenseCapabilityError('free_account_restricted', FREE_ACCOUNT_RESTRICTED_MESSAGE);
  }
}
