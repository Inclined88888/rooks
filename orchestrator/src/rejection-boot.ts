/**
 * Second import of `boot.ts`, right after the log: from here on, a promise
 * rejection nobody handled is logged under its owner instead of ending the
 * daemon (TODO #614, `kernel/rejection-guard.ts`). Daemon-only.
 */
import { installRejectionGuard } from './kernel/rejection-guard.js';

installRejectionGuard();
