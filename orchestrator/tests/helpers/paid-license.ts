import { setLicenseState } from '../../src/license/runtime.js';
import type { LicenseState } from '../../src/license/license.js';
import { serveTestAccounts } from './accounts.js';

/** Multi-user and mutable-plugin tests explicitly exercise paid entitlements.
 * Free admission and cryptographic verification have their own suites. A paid
 * test install also serves its accounts, as the Multi-user plugin would. */
export const paidTestLicense = (): LicenseState => ({
  status: 'valid', reason: null, plan: 'Test paid', planId: 'test-paid', edition: 'expert',
  lifetime: true, modules: '*', plugins: '*', users: null, expiresAt: null,
  subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
});
setLicenseState(paidTestLicense());
serveTestAccounts();
